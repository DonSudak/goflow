import {exportProjectDocument, parseProjectDocument} from '../../exporters/projectDocument';
import {parseGameManifest} from '../../gameManifest';
import {addNode, deleteNode, link, newProjectDocument, outline, setVariable, unlink, updateNode} from '../narrativeTools';

const manifest = parseGameManifest({
  game_keys: {'relationships.affection.mira': {type: 'float', initial: 0, module: 'relationships', read_key: 'relationships.mira.affection'}, 'relationships.mira.stage': {type: 'string', initial: ''}}
});
const exported = (doc: any) => exportProjectDocument(parseProjectDocument(doc), 'demo', manifest)[0].content;

describe('narrativeTools', () => {
  test('builds a graph that exports to the expected dialogue', () => {
    const doc = newProjectDocument('demo', '2026-01-01T00:00:00.000Z');
    const hello = addNode(doc, {type: 'narrative', title: 'hello', text: 'Привет.', stage: {speaker: 'mira'}}, manifest);
    const flirt = addNode(doc, {type: 'choice', text: 'Флирт', after: hello, operations: [{variable: 'relationships.affection.mira', op: 'addition', value: 5}]}, manifest);
    const secret = addNode(
      doc,
      {type: 'choice', text: 'Секрет', after: hello, conditions: [{variable: 'relationships.mira.stage', value: 'lover'}, {probability: 0.5}], conditions_any: true},
      manifest
    );
    setVariable(doc, {name: 'flags.met', type: 'boolean', value: false});
    const after = addNode(doc, {type: 'narrative', title: 'after', text: 'Мира: Ну.', after: flirt, operations: [{variable: 'flags.met', op: 'override', value: true}]}, manifest);
    link(doc, secret, after);

    const out = exported(doc);
    expect(out).toContain('~ hello\nmira: Привет.'); // no characters in this manifest → id as speaker
    expect(out).toContain('- Флирт\n\tdo effect({"relationships.affection.mira": 5.0})\n\t=> after');
    expect(out).toContain('- Секрет [if (state("relationships.mira.stage", "") == "lover" or chance(0.5)) /]');
    expect(out).toContain('do set_flag("met", true)');
    expect(outline(doc)).toContain(`[${hello}] narrative "hello" → ~ hello`);

    updateNode(doc, after, {text: 'Мира: Ладно.', stage: {speaker: 'mira'}});
    unlink(doc, {from: secret, to: after});
    deleteNode(doc, flirt);
    const out2 = exported(doc);
    expect(out2).not.toContain('Флирт');
    expect(out2).toContain('Мира: Ладно.');
  });

  test('rejects unknown variables and nodes', () => {
    const doc = newProjectDocument('demo');
    expect(() => addNode(doc, {type: 'narrative', text: 'x', operations: [{variable: 'nope', op: 'addition', value: 1}]})).toThrow(/Unknown variable/);
    expect(() => link(doc, 'a', 'b')).toThrow(/Unknown node/);
    expect(() => setVariable(doc, {name: 'x', type: 'integer', value: 1})).not.toThrow();
  });
});
