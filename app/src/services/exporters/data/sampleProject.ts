/**
 * Sample Useless Tycoon project (local edition document format) + matching game manifest.
 * Source of tests/fixtures/goflow/sample_project/project.json and sample_project.dialogue in the game repo.
 */
import {ConditionGroup, ConditionType, Link, Node} from '@types-folder/nodes';
import {Variable, VariableOperation} from '@types-folder/variables';

export const SAMPLE_MANIFEST = {
  version: 1,
  game_keys: [{key: 'relationships.affection.mira', type: 'float', initial: 0, module: 'relationships', writable: true}],
  flags: ['met_mira'],
  characters: [{id: 'mira', name: 'Мира', expressions: ['neutral', 'smile'], outfits: ['work']}],
  backgrounds: ['bar'],
  cgs: ['mira_toast'],
  slots: ['left', 'center', 'right'],
  scenes: [{id: 'mira_night', adult: true}],
  locations: [],
  items: [],
  activities: [],
  paths: [],
  dialogues: []
};

const op = (id: string, variableId: string, operationType: VariableOperation['operationType'], value: number | boolean): VariableOperation => ({
  id,
  nodeId: '',
  variableId,
  operationType,
  target: {type: 'custom', value},
  enabled: true,
  order: 0
});
const cond = (...conditions: object[]): ConditionGroup[] => [{id: 'g', operator: 'AND', conditions: conditions.map((c, i) => ({id: `c${i}`, ...c})) as any}];
const link = (id: string, startNodeId: string, endNodeId: string, conditions: ConditionGroup[] = []): Link => ({id, type: 'link', startNodeId, endNodeId, conditions});
const xy = {x: 0, y: 0};

export const buildSampleProject = () => {
  const variables: Variable[] = [
    {id: 'aff', name: 'Привязанность Миры', internalName: 'relationships.affection.mira', type: 'float', value: 0, source: 'game'},
    {id: 'met', name: 'flags.met_mira', type: 'boolean', value: false},
    {id: 'tips', name: 'tips', type: 'integer', value: 0}
  ];
  const nodes: Node[] = [
    {
      id: 'n1',
      type: 'narrative',
      coordinates: xy,
      data: {
        title: 'Бар',
        text: 'Привет. Я Мира, сегодня за стойкой.',
        stage: {speaker: 'mira', background: {id: 'bar', transition: 'fade'}, show: [{slot: 'center', character: 'mira', expression: 'smile', outfit: 'work'}]}
      },
      operations: [op('o1', 'met', 'override', true)]
    },
    {id: 'c1', type: 'choice', coordinates: xy, data: {text: 'Сделать комплимент'}, operations: [op('o2', 'aff', 'addition', 15)]},
    {id: 'c2', type: 'choice', coordinates: xy, data: {text: 'Оставить чаевые'}, operations: [op('o3', 'tips', 'addition', 1)]},
    {
      id: 'n2',
      type: 'narrative',
      coordinates: xy,
      data: {title: 'Комплимент', text: 'Льстец.\nМира: Но приятно.', stage: {speaker: 'mira', show: [{slot: 'center', character: 'mira', expression: 'neutral'}]}}
    },
    {id: 'n3', type: 'narrative', coordinates: xy, data: {title: 'Чаевые', text: 'Спасибо!', stage: {speaker: 'mira'}}},
    {
      id: 'n4',
      type: 'narrative',
      coordinates: xy,
      data: {title: 'Снова', text: 'Ты снова здесь? Тогда за тебя.', stage: {speaker: 'mira', cg: {id: 'mira_toast', transition: 'dissolve'}, scene: 'mira_night'}}
    },
    {id: 'n5', type: 'narrative', coordinates: xy, data: {title: 'Финал', text: 'Заходи ещё.', stage: {speaker: 'mira', cg: null, hide: [{slot: 'center'}]}}}
  ];
  const edges: Link[] = [
    link('e1', 'n1', 'c1', cond({type: ConditionType.VARIABLE_COMPARISON, varId: 'aff', operator: 'lt', value: 50, valType: 'custom'})),
    link('e2', 'n1', 'c2', cond({type: ConditionType.VARIABLE_COMPARISON, varId: 'tips', operator: 'lt', value: 3, valType: 'custom'})),
    link('e3', 'c1', 'n2'),
    link('e4', 'c2', 'n3'),
    link('e5', 'n2', 'n4', cond({type: ConditionType.NODE_HAPPENED, nodeId: 'n3'}, {type: ConditionType.VARIABLE_COMPARISON, varId: 'met', operator: 'eq', value: true, valType: 'custom'})),
    link('e6', 'n2', 'n5'),
    link('e7', 'n3', 'n5'),
    link('e8', 'n4', 'n5')
  ];
  const stamp = '2026-11-11T00:00:00.000Z';
  return {
    format: 1,
    id: '000000000000000000000001',
    name: 'goflow_sample',
    createdAt: stamp,
    updatedAt: stamp,
    graph: {
      timelines: {
        main: {
          layers: {
            root: {
              type: 'layer',
              id: 'root',
              name: 'root',
              depth: 0,
              nodeIds: nodes.map((n) => n.id),
              nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
              edges: Object.fromEntries(edges.map((e) => [e.id, e]))
            }
          },
          metadata: {},
          variables,
          lastLayerNumber: 0
        }
      },
      timelinesMetadata: [{id: 'main', name: 'Main Timeline', description: 'Default timeline', order: 1, isActive: true, createdAt: stamp, updatedAt: stamp}]
    },
    entityTypes: [],
    entityParameters: [],
    entities: [{id: 'mira', name: 'Мира', entityTypeId: 'character', description: null, values: []}]
  };
};
