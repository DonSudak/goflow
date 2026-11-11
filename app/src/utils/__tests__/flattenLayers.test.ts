import {buildSampleProject} from '../../services/exporters/data/sampleProject';
import {prepareDataForHTML} from '../flattenLayers';

describe('prepareDataForHTML (flattenLayers)', () => {
  test('keeps narrative stage data and choice operations without mutating the input', () => {
    const layers = buildSampleProject().graph.timelines.main.layers;
    const before = JSON.stringify(layers);
    const {nodes} = prepareDataForHTML(layers);
    expect(nodes.find((n: any) => n.id === 'n1').data.stage.background).toEqual({id: 'bar', transition: 'fade'});
    expect(nodes.find((n: any) => n.id === 'c1').operations).toHaveLength(1);
    expect(JSON.stringify(layers)).toBe(before);
  });

  test('layer endpoints carry the full node data (stage survives)', () => {
    const inner = {id: 'n1', type: 'narrative', coordinates: {x: 0, y: 0}, data: {title: 'T', text: 'X', stage: {speaker: 'mira'}}};
    const layers = {
      root: {type: 'layer', id: 'root', nodeIds: ['L'], nodes: {L: {id: 'L', type: 'layer', coordinates: {x: 0, y: 0}, name: 'L', startingNodes: [inner], endingNodes: []}}, edges: {}},
      L: {type: 'layer', id: 'L', name: 'L', nodeIds: ['n1'], nodes: {n1: inner}, edges: {}}
    };
    const {nodes} = prepareDataForHTML(layers);
    expect(nodes.filter((n: any) => n.id === 'n1').every((n: any) => n.data.stage?.speaker === 'mira')).toBe(true);
  });
});
