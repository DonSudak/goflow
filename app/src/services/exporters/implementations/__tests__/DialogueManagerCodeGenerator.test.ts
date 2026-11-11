import {ChoiceNode, Condition, ConditionGroup, ConditionType, Link, NarrativeNode, Node} from '@types-folder/nodes';
import {Variable, VariableOperation} from '@types-folder/variables';
import * as fs from 'fs';
import * as path from 'path';

import {ExportFormat, ExportableStory} from '../../interfaces/exportInterfaces';
import {DialogueManagerCodeGenerator} from '../DialogueManagerCodeGenerator';

const config = {format: ExportFormat.DIALOGUE_MANAGER, includeComments: false, minifyOutput: false, generateReadme: false};

const story = (nodes: Node[], edges: Link[], variables: Variable[] = [], startNodeId = 'n1'): ExportableStory => ({
  title: 'Test',
  nodes,
  edges,
  variables,
  startNodeId,
  metadata: {originalLayers: [], exportedAt: '', version: '1.0'}
});

const narrative = (id: string, text: string, title = '', operations: VariableOperation[] = []): NarrativeNode => ({id, type: 'narrative', coordinates: {x: 0, y: 0}, data: {title, text}, operations});
const choice = (id: string, text: string, operations: VariableOperation[] = []): ChoiceNode => ({id, type: 'choice', coordinates: {x: 0, y: 0}, data: {text}, operations});
const link = (id: string, from: string, to: string, conditions: ConditionGroup[] = []): Link => ({id, type: 'link', startNodeId: from, endNodeId: to, conditions});
const group = (...conditions: Partial<Condition>[]): ConditionGroup[] => [{id: 'g', operator: 'AND', conditions: conditions.map((c, i) => ({id: `c${i}`, ...c}) as Condition)}];
const op = (variableId: string, operationType: VariableOperation['operationType'], value?: string | number | boolean, order = 0): VariableOperation => ({
  id: `op_${variableId}_${order}`,
  nodeId: '',
  variableId,
  operationType,
  target: value === undefined ? undefined : {type: 'custom', value},
  enabled: true,
  order
});

describe('DialogueManagerCodeGenerator', () => {
  let gen: DialogueManagerCodeGenerator;
  beforeEach(() => (gen = new DialogueManagerCodeGenerator()));

  test('format metadata', () => {
    expect(gen.getFileExtension()).toBe('.dialogue');
    expect(gen.getSupportedFormat()).toBe(ExportFormat.DIALOGUE_MANAGER);
  });

  test('linear story: start cue, verbatim text, jumps, END', () => {
    const code = gen.generateCode(story([narrative('n1', 'Мира: Привет.\ndo stage.bg("bar")', 'Intro'), narrative('n2', 'Пока.', 'Outro')], [link('e1', 'n1', 'n2')]), config);
    expect(code).toBe(['~ start', '=> intro', '', '~ intro', 'Мира: Привет.', 'do stage.bg("bar")', '=> outro', '', '~ outro', 'Пока.', '=> END', ''].join('\n'));
  });

  test('choices with conditions, ops and tab-indented bodies', () => {
    const vars: Variable[] = [{id: 'v', name: 'money', type: 'integer', value: 5}];
    const code = gen.generateCode(
      story(
        [narrative('n1', 'Q', 'Q'), choice('c1', 'Pay', [op('v', 'subtract', 3)]), choice('c2', 'Leave'), narrative('n2', 'A', 'A'), narrative('n3', 'B', 'B')],
        [
          link('e1', 'n1', 'c1', group({type: ConditionType.VARIABLE_COMPARISON, varId: 'v', operator: 'gte', value: 3, valType: 'custom'})),
          link('e2', 'n1', 'c2'),
          link('e3', 'c1', 'n2'),
          link('e4', 'c2', 'n3')
        ],
        vars
      ),
      config
    );
    expect(code).toContain('- Pay [if vars.get("money", 5) >= 3 /]\n\tset vars["money"] = vars.get("money", 5) - 3\n\t=> a\n');
    expect(code).toContain('- Leave\n\t=> b\n');
  });

  test('conditional direct links become if/elif/else', () => {
    const vars: Variable[] = [{id: 'v', name: 'x', type: 'integer', value: 0}];
    const code = gen.generateCode(
      story(
        [narrative('n1', 'S', 'S'), narrative('n2', 'A', 'A'), narrative('n3', 'B', 'B'), narrative('n4', 'C', 'C')],
        [
          link('e1', 'n1', 'n2', group({type: ConditionType.VARIABLE_COMPARISON, varId: 'v', operator: 'eq', value: 1, valType: 'custom'})),
          link('e2', 'n1', 'n3', group({type: ConditionType.VARIABLE_COMPARISON, varId: 'v', operator: 'lt', value: 0, valType: 'custom'})),
          link('e3', 'n1', 'n4')
        ],
        vars
      ),
      config
    );
    expect(code).toContain('if vars.get("x", 0) == 1\n\t=> a\nelif vars.get("x", 0) < 0\n\t=> b\nelse\n\t=> c\n');
  });

  test('game-key effects (addition/subtract) and reads', () => {
    const vars: Variable[] = [
      {id: 'a', name: 'Привязанность Миры', internalName: 'relationships.affection.mira', type: 'float', value: 0},
      {id: 'h', name: 'household.money', type: 'integer', value: 0}
    ];
    const code = gen.generateCode(
      story(
        [narrative('n1', 'S', 'S', [op('a', 'addition', 15), op('h', 'subtract', 2.5, 1)]), narrative('n2', 'Rich', 'R')],
        [link('e1', 'n1', 'n2', group({type: ConditionType.VARIABLE_COMPARISON, varId: 'h', operator: 'gt', value: 100, valType: 'custom'}))],
        vars
      ),
      config
    );
    expect(code).toContain('do effect({"relationships.affection.mira": 15.0})');
    expect(code).toContain('do effect({"household.money": -2.5})');
    expect(code).toContain('if state("household.money", 0) > 100\n\t=> r\nelse\n\t=> END');
    expect(gen.getWarnings()).toEqual([]);
  });

  test('warns on unsupported op on game key', () => {
    const vars: Variable[] = [{id: 'a', name: 'hero.mood', type: 'float', value: 0}];
    const code = gen.generateCode(story([narrative('n1', 'S', 'S', [op('a', 'override', 3)])], [], vars), config);
    expect(code).not.toContain('hero.mood');
    expect(gen.getWarnings()).toEqual([expect.stringContaining('Unsupported operation "override" on game key "hero.mood"')]);
    expect(gen.getFormatWarnings(story([narrative('n1', 'S', 'S', [op('a', 'multiply', 3)])], [], vars))).toHaveLength(1);
  });

  test('flags: set, invert, read', () => {
    const vars: Variable[] = [{id: 'f', name: 'flags.met_mira', type: 'boolean', value: false}];
    const code = gen.generateCode(
      story(
        [narrative('n1', 'S', 'S', [op('f', 'override', true), op('f', 'invert', undefined, 1)]), narrative('n2', 'M', 'M')],
        [link('e1', 'n1', 'n2', group({type: ConditionType.VARIABLE_COMPARISON, varId: 'f', operator: 'eq', value: true, valType: 'custom'}))],
        vars
      ),
      config
    );
    expect(code).toContain('do set_flag("met_mira", true)');
    expect(code).toContain('do set_flag("met_mira", not flag("met_mira"))');
    expect(code).toContain('if flag("met_mira") == true');
  });

  test('local vars: all operation kinds', () => {
    const vars: Variable[] = [
      {id: 'n', name: 'count', type: 'integer', value: 1},
      {id: 's', name: 'name', type: 'string', value: 'x'},
      {id: 'b', name: 'ok', type: 'boolean', value: false}
    ];
    const ops = [op('n', 'override', 2), op('n', 'multiply', 3, 1), op('s', 'join', '!', 2), op('b', 'invert', undefined, 3)];
    const code = gen.generateCode(story([narrative('n1', 'S', 'S', ops)], [], vars), config);
    expect(code).toContain('set vars["count"] = 2\nset vars["count"] = vars.get("count", 1) * 3\nset vars["name"] = vars.get("name", "x") + "!"\nset vars["ok"] = not vars.get("ok", false)\n');
  });

  test('probability condition uses StoryBridge.chance', () => {
    const code = gen.generateCode(story([narrative('n1', 'S', 'S'), narrative('n2', 'L', 'L')], [link('e1', 'n1', 'n2', group({type: ConditionType.PROBABILITY, probability: 0.25}))]), config);
    expect(code).toContain('if chance(0.25)\n\t=> l');
  });

  test('node happened / not happened marks target cue as seen', () => {
    const code = gen.generateCode(
      story(
        [narrative('n1', 'S', 'S'), narrative('n2', 'A', 'A'), narrative('n3', 'B', 'B')],
        [
          link('e1', 'n1', 'n2', group({type: ConditionType.NODE_HAPPENED, nodeId: 'n2'})),
          link('e2', 'n2', 'n3', [
            {
              id: 'g',
              operator: 'OR',
              conditions: [{id: 'c', type: ConditionType.NODE_NOT_HAPPENED, nodeId: 'n3'} as Condition, {id: 'd', type: ConditionType.PROBABILITY, probability: 1} as Condition]
            }
          ])
        ]
      ),
      config
    );
    expect(code).toContain('~ a\nset vars["seen.a"] = true\nA\n');
    expect(code).toContain('~ b\nset vars["seen.b"] = true\n');
    expect(code).toContain('if vars.get("seen.a", false)\n\t=> a');
    expect(code).toContain('if (not vars.get("seen.b", false) or chance(1))');
    expect(code).not.toContain('seen.s');
  });

  test('cue names: dedupe, reserved words, fallback id', () => {
    const code = gen.generateCode(
      story(
        [narrative('n1', 'S', 'Same'), narrative('n2', 'A', 'Same'), narrative('n3', 'B', 'start'), narrative('abcdefghijk', 'C'), narrative('n5', 'D', 'END')],
        [link('e1', 'n1', 'n2'), link('e2', 'n2', 'n3'), link('e3', 'n3', 'abcdefghijk'), link('e4', 'abcdefghijk', 'n5')]
      ),
      config
    );
    expect(code).toContain('~ same\n');
    expect(code).toContain('~ same_2\n');
    expect(code).toContain('~ start_2\n');
    expect(code).toContain('~ n_abcdefgh\n');
    expect(code).toContain('~ end_2\n');
  });

  test('cyrillic titles are transliterated to valid cue names', () => {
    const code = gen.generateCode(story([narrative('n1', 'S', 'Встреча в баре'), narrative('n2', 'A', '2 часть')], [link('e1', 'n1', 'n2')]), config);
    expect(code).toContain('~ vstrecha_v_bare\n');
    expect(code).toContain('~ var2_chast\n');
    expect(code).toMatch(/^~ start\n=> vstrecha_v_bare\n/);
  });

  test('sample export fixture for Useless Tycoon', () => {
    const vars: Variable[] = [
      {id: 'aff', name: 'Привязанность Миры', internalName: 'relationships.affection.mira', type: 'float', value: 0},
      {id: 'met', name: 'flags.met_mira', type: 'boolean', value: false},
      {id: 'tips', name: 'tips', type: 'integer', value: 0}
    ];
    const nodes: Node[] = [
      narrative('n1', 'do stage.bg("bar", "fade")\nМира: Привет. Я Мира, сегодня за стойкой.', 'Бар', [op('met', 'override', true)]),
      choice('c1', 'Сделать комплимент', [op('aff', 'addition', 15)]),
      choice('c2', 'Оставить чаевые', [op('tips', 'addition', 1)]),
      narrative('n2', 'Мира: Льстец.', 'Комплимент'),
      narrative('n3', 'Мира: Спасибо!', 'Чаевые'),
      narrative('n4', 'Мира: Ты снова здесь? Приятно.', 'Снова'),
      narrative('n5', 'Мира: Заходи ещё.', 'Финал')
    ];
    const edges: Link[] = [
      link('e1', 'n1', 'c1', group({type: ConditionType.VARIABLE_COMPARISON, varId: 'aff', operator: 'lt', value: 50, valType: 'custom'})),
      link('e2', 'n1', 'c2', group({type: ConditionType.VARIABLE_COMPARISON, varId: 'tips', operator: 'lt', value: 3, valType: 'custom'})),
      link('e3', 'c1', 'n2'),
      link('e4', 'c2', 'n3'),
      link('e5', 'n2', 'n4', group({type: ConditionType.NODE_HAPPENED, nodeId: 'n3'}, {type: ConditionType.VARIABLE_COMPARISON, varId: 'met', operator: 'eq', value: true, valType: 'custom'})),
      link('e6', 'n2', 'n5'),
      link('e7', 'n3', 'n5'),
      link('e8', 'n4', 'n5')
    ];
    const code = gen.generateCode({...story(nodes, edges, vars), title: 'goflow_sample'}, {...config, includeComments: true});
    expect(gen.getWarnings()).toEqual([]);
    expect(code).toContain('do effect({"relationships.affection.mira": 15.0})');
    expect(code).toContain('if (vars.get("seen.chaevye", false) and flag("met_mira") == true)');

    // DM_FIXTURE_OUT=<path> npx jest ... regenerates the Godot-side fixture.
    if (process.env.DM_FIXTURE_OUT) {
      fs.mkdirSync(path.dirname(process.env.DM_FIXTURE_OUT), {recursive: true});
      fs.writeFileSync(process.env.DM_FIXTURE_OUT, code);
    }
  });
});
