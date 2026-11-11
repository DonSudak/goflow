import {exportProjectDocument, parseProjectDocument} from '@services/exporters/projectDocument';
import {parseGameManifest} from '@services/gameManifest';

import {withManifestFlags} from '../../services/godot/gameSync';
import {useGraphStore} from '../../store/useGraphStore';
import {ConditionType} from '../../types/nodes';
import {VariableOperation} from '../../types/variables';
import {supportsOperations} from '../../utils/nodeOperations';
import {createEmptyProjectState} from '../../utils/projectStateHelpers';
import {CreateOperationCommand, DeleteOperationCommand, ToggleOperationCommand} from '../OperationCommands';

jest.mock('../operationUtils', () => ({generateAndSaveOperation: jest.fn()}));
jest.mock('../../services/godot/godotExport', () => ({loadManifest: jest.fn()}));

const affection = (id = 'o1'): VariableOperation => ({
  id,
  nodeId: 'c1',
  variableId: 'aff',
  operationType: 'addition',
  target: {type: 'custom', value: 1},
  enabled: true,
  order: 0
});
const choice = () => useGraphStore.getState().layers.root.nodes.c1 as any;

describe('operations on choice nodes', () => {
  beforeEach(() => {
    const state = createEmptyProjectState();
    state.layers.root.nodes.c1 = {id: 'c1', type: 'choice', coordinates: {x: 0, y: 0}, data: {text: 'Compliment her'}} as any;
    state.layers.root.nodeIds = ['c1'];
    useGraphStore.getState().initialize({...state, hasLoadedFromStorage: true});
    useGraphStore.setState({currentTimelineId: 'tl', currentGraphId: 'root'});
  });

  it('test_supports_operations_for_narrative_and_choice_only', () => {
    expect(supportsOperations({type: 'choice'})).toBe(true);
    expect(supportsOperations({type: 'narrative'})).toBe(true);
    expect(supportsOperations({type: 'note'})).toBe(false);
    expect(supportsOperations(undefined)).toBe(false);
  });

  it('test_create_toggle_delete_and_undo_on_a_choice', () => {
    const create = new CreateOperationCommand('c1', affection(), 'p1');
    create.execute();
    expect(choice().operations).toHaveLength(1);

    new ToggleOperationCommand('c1', 'o1', 'p1').execute();
    expect(choice().operations[0].enabled).toBe(false);

    const del = new DeleteOperationCommand('o1', 'p1');
    del.execute();
    expect(choice().operations).toHaveLength(0);
    del.undo();
    expect(choice().operations.map((o: VariableOperation) => o.id)).toEqual(['o1']);
    create.undo();
    expect(choice().operations).toHaveLength(0);
  });
});

describe('export of choice operations and conditions', () => {
  const manifest = parseGameManifest({
    game_keys: {'relationships.affection.mira': {initial: 0, module: 'relationships', type: 'float', writable: true}},
    flags: ['met_mira']
  });
  const variables = withManifestFlags([{id: 'aff', name: 'relationships.affection.mira', internalName: 'relationships.affection.mira', type: 'float', value: 0, source: 'game'}], manifest.flags);
  const flagId = variables.find((v) => v.name === 'flags.met_mira')!.id;
  const op = (id: string, variableId: string, operationType: VariableOperation['operationType'], value: number | boolean): VariableOperation => ({
    id,
    nodeId: '',
    variableId,
    operationType,
    target: {type: 'custom', value},
    enabled: true,
    order: 0
  });
  const layers = {
    root: {
      type: 'layer',
      id: 'root',
      name: 'root',
      depth: 0,
      nodeIds: ['n1', 'c1', 'n2', 'n3'],
      nodes: {
        n1: {id: 'n1', type: 'narrative', coordinates: {x: 0, y: 0}, data: {title: 'Bar', text: 'Мира: Rough night?'}},
        c1: {id: 'c1', type: 'choice', coordinates: {x: 0, y: 0}, data: {text: 'Compliment her'}, operations: [op('o1', 'aff', 'addition', 1), op('o2', flagId, 'override', true)]},
        n2: {id: 'n2', type: 'narrative', coordinates: {x: 0, y: 0}, data: {title: 'Smile', text: 'Мира: Thanks.'}},
        n3: {id: 'n3', type: 'narrative', coordinates: {x: 0, y: 0}, data: {title: 'Again', text: 'Мира: You again.'}}
      },
      edges: {
        e1: {id: 'e1', type: 'link', startNodeId: 'n1', endNodeId: 'c1', conditions: []},
        e2: {id: 'e2', type: 'link', startNodeId: 'c1', endNodeId: 'n2', conditions: []},
        e3: {
          id: 'e3',
          type: 'link',
          startNodeId: 'n2',
          endNodeId: 'n3',
          conditions: [
            {
              id: 'g',
              operator: 'AND',
              conditions: [
                {id: 'k1', type: ConditionType.NODE_HAPPENED, nodeId: 'n1'},
                {id: 'k2', type: ConditionType.VARIABLE_COMPARISON, varId: flagId, operator: 'eq', valType: 'custom', value: true}
              ]
            }
          ]
        }
      }
    }
  };

  it('test_choice_ops_are_indented_under_the_response_and_conditions_use_seen_and_flags', () => {
    const doc = parseProjectDocument({name: 'Bar', graph: {timelines: {t1: {layers, variables}}, timelinesMetadata: [{id: 't1', name: 'Main', order: 1}]}});
    const [file] = exportProjectDocument(doc, 'bar', manifest);
    const text = file.content;
    const response = text.slice(text.indexOf('- Compliment her'));
    expect(response.split('\n').slice(0, 4)).toEqual(['- Compliment her', '\tdo effect({"relationships.affection.mira": 1.0})', '\tdo set_flag("met_mira", true)', '\t=> smile']);
    expect(text).toContain('set vars["seen.bar"] = true');
    expect(text).toMatch(/vars\.get\("seen\.bar", false\)/);
    expect(text).toMatch(/flag\("met_mira"\)/);
    expect(file.warnings).toEqual([]);
  });
});
