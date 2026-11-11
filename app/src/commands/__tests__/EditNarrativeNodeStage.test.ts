import {useGraphStore} from '../../store/useGraphStore';
import {createEmptyProjectState} from '../../utils/projectStateHelpers';
import {EditNarrativeNodeCommand} from '../NarrativeNodeCommands';

jest.mock('../operationUtils', () => ({generateAndSaveOperation: jest.fn()}));

const node = () => useGraphStore.getState().layers.root.nodes.n1 as any;

describe('EditNarrativeNodeCommand with stage', () => {
  beforeEach(() => {
    const state = createEmptyProjectState();
    state.layers.root.nodes.n1 = {id: 'n1', type: 'narrative', coordinates: {x: 0, y: 0}, data: {title: 'T', text: 'Hi'}} as any;
    state.layers.root.nodeIds = ['n1'];
    useGraphStore.getState().initialize({...state, hasLoadedFromStorage: true});
    useGraphStore.setState({currentTimelineId: 'tl', currentGraphId: 'root'});
  });

  it('test_stage_is_set_and_undo_removes_it', () => {
    const stage = {speaker: 'mira', background: {id: 'bar'}};
    const command = new EditNarrativeNodeCommand('n1', {title: 'T', text: 'Hi', stage}, 'p1');
    command.execute();
    expect(node().data.stage).toEqual(stage);
    command.undo();
    expect(node().data.stage).toBeUndefined();
    expect(node().data.text).toBe('Hi');
  });

  it('test_text_edit_keeps_existing_stage', () => {
    new EditNarrativeNodeCommand('n1', {title: 'T', text: 'Hi', stage: {scene: 'mira_night'}}, 'p1').execute();
    new EditNarrativeNodeCommand('n1', {title: 'T', text: 'Changed'}, 'p1').execute();
    expect(node().data).toMatchObject({text: 'Changed', stage: {scene: 'mira_night'}});
  });
});
