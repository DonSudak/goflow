import {spawnSync} from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {SAMPLE_MANIFEST, buildSampleProject} from '../../exporters/data/sampleProject';
import {exportProjectDocument, parseProjectDocument} from '../../exporters/projectDocument';
import {GameManifest, parseGameManifest} from '../../gameManifest';
import godotManifest from '../../gameManifest/__tests__/godot_manifest.fixture.json';
import {importDialogue} from '../dialogueManagerImporter';

const GAME = parseGameManifest(godotManifest);

/** import -> JSON (as on disk) -> export */
const roundTrip = (source: string, slug: string, manifest?: GameManifest) => {
  const {doc, warnings} = importDialogue(source, {slug, manifest});
  const [file] = exportProjectDocument(parseProjectDocument(JSON.parse(JSON.stringify(doc))), slug, manifest);
  return {doc, warnings, content: file.content, exportWarnings: file.warnings};
};
const header = (name: string) => `# ${name} — exported from Go Flow (Dialogue Manager)\n\n`;
const nodesOf = (doc: any) => {
  const root = (Object.values(doc.graph.timelines)[0] as any).layers.root;
  return root.nodeIds.map((id: string) => root.nodes[id]);
};

// tests/fixtures/goflow/handwritten.dialogue of the game repo
const HANDWRITTEN = `~ start
set vars["seen.start"] = true
set vars["visits"] = vars.get("visits", 0) + 1
do set_flag("met_mira", true)
Мира: [PH] Привет.
- [PH] Комплимент [if vars.get("visits", 0) >= 1 /]
	do effect({"relationships.affection.mira": 5.0})
	set vars["complimented"] = true
	=> n_compliment
- [PH] Уйти [if flag("met_mira") /]
	=> n_leave
- [PH] Никогда [if chance(0.0) /]
	=> n_leave

~ n_compliment
set vars["seen.n_compliment"] = true
Мира: [PH] Льстец.
if vars.get("seen.n_leave", false)
	=> n_leave
elif state("relationships.affection.mira", 0.0) >= 5.0 and chance(1.0)
	=> n_close
else
	=> n_leave

~ n_close
Мира: [PH] Посиди со мной.
=> END

~ n_leave
set vars["seen.n_leave"] = true
Мира: [PH] Пока.
=> END
`;

// content/dialogue/bar.dialogue of the game repo
const BAR = `~ bar_meet
do stage.bg("bar", "fade")
do stage.show("center", "mira", "smile")
Мира: [PH] Привет. Я Мира, сегодня за стойкой.
- [PH] Сделать комплимент
	do effect({"relationships.affection.mira": 15.0, "inventory.alcohol": 1.0})
	Мира: [PH] Льстец. Держи напиток за счёт заведения.
- [PH] Заказать снеки
	do effect({"inventory.snacks": 1.0})
	Мира: [PH] Снеки так снеки.
if get("relationships.mira.stage") == "lover"
	Мира: [PH] Смена закончилась. Пойдём ко мне?
	do scene("mira_night")
else
	Мира: [PH] Заходи ещё.
=> END
`;

describe('importDialogue: round trip', () => {
  test('exporter output (sample project) is reproduced byte for byte', () => {
    const manifest = parseGameManifest(SAMPLE_MANIFEST);
    const [original] = exportProjectDocument(parseProjectDocument(buildSampleProject()), 'sample_project', manifest);
    const {content, warnings, doc} = roundTrip(original.content, 'sample_project', manifest);
    expect(warnings).toEqual([]);
    expect(content).toBe(original.content);
    expect(doc.name).toBe('goflow_sample');
    const bar = nodesOf(doc)[0];
    expect(bar.data).toEqual({
      title: 'bar',
      text: 'Привет. Я Мира, сегодня за стойкой.',
      stage: {speaker: 'mira', background: {id: 'bar', transition: 'fade'}, show: [{slot: 'center', character: 'mira', expression: 'smile', outfit: 'work'}]}
    });
  });

  test('handwritten exporter-style file: identical except the header and `flag(x)` -> `flag(x) == true`', () => {
    const {content, warnings} = roundTrip(HANDWRITTEN, 'handwritten');
    expect(warnings).toEqual([]);
    expect(content).toBe(header('handwritten') + HANDWRITTEN.replace('[if flag("met_mira") /]', '[if flag("met_mira") == true /]'));
  });

  test('real game file (bar): structure, ops, speaker and conditions are recovered', () => {
    const {doc, warnings, content, exportWarnings} = roundTrip(BAR, 'bar', GAME);
    expect(warnings).toEqual([]);
    expect(exportWarnings).toEqual([]);
    const nodes = nodesOf(doc);
    const meet = nodes[0];
    expect(meet.data.stage).toEqual({speaker: 'mira', background: {id: 'bar', transition: 'fade'}, show: [{slot: 'center', character: 'mira', expression: 'smile'}]});
    expect(meet.data.text).toBe('[PH] Привет. Я Мира, сегодня за стойкой.');
    const compliment = nodes.find((n: any) => n.data.text === '[PH] Сделать комплимент');
    expect(compliment.operations.map((o: any) => [o.variableId, o.operationType, o.target.value])).toEqual([
      ['game_relationships.affection.mira', 'addition', 15],
      ['game_inventory.alcohol', 'addition', 1]
    ]);
    expect(content).toBe(
      [
        '# bar — exported from Go Flow (Dialogue Manager)',
        '',
        '~ start',
        '=> bar_meet',
        '',
        '~ bar_meet',
        'do stage.bg("bar", "fade")',
        'do stage.show("center", "mira", "smile")',
        'Мира: [PH] Привет. Я Мира, сегодня за стойкой.',
        '- [PH] Сделать комплимент',
        '\tdo effect({"relationships.affection.mira": 15.0})',
        '\tdo effect({"inventory.alcohol": 1.0})',
        '\t=> bar_meet_1',
        '- [PH] Заказать снеки',
        '\tdo effect({"inventory.snacks": 1.0})',
        '\t=> bar_meet_5',
        '',
        '~ bar_meet_1',
        'Мира: [PH] Льстец. Держи напиток за счёт заведения.',
        '=> bar_meet_2',
        '',
        '~ bar_meet_2',
        'if state("relationships.mira.stage", "") == "lover"',
        '\t=> bar_meet_3',
        'else',
        '\t=> bar_meet_4',
        '',
        '~ bar_meet_3',
        'Мира: [PH] Смена закончилась. Пойдём ко мне?',
        'do scene("mira_night")',
        '=> END',
        '',
        '~ bar_meet_4',
        'Мира: [PH] Заходи ещё.',
        '=> END',
        '',
        '~ bar_meet_5',
        'Мира: [PH] Снеки так снеки.',
        '=> bar_meet_2',
        ''
      ].join('\n')
    );
  });

  test('import is deterministic and produces sorted-key-safe edge ids', () => {
    const a = importDialogue(BAR, {slug: 'bar', manifest: GAME}).doc;
    const b = importDialogue(BAR, {slug: 'bar', manifest: GAME}).doc;
    expect(a).toEqual(b);
    const edges = Object.keys((Object.values(a.graph.timelines)[0] as any).layers.root.edges);
    expect(edges).toEqual([...edges].sort());
  });

  test('layout: columns by BFS depth from the start node', () => {
    const nodes = nodesOf(importDialogue(BAR, {slug: 'bar', manifest: GAME}).doc);
    expect(nodes[0].coordinates).toEqual({x: 0, y: 0});
    expect(nodes.find((n: any) => n.data.title === 'bar_meet_1').coordinates.x).toBe(640);
  });
});

describe('importDialogue: lossy and verbatim cases', () => {
  const run = (source: string, manifest?: GameManifest) => roundTrip(source, 'x', manifest);

  test('unparseable choice condition stays in the choice text', () => {
    const {content, warnings} = run('~ a\nQ\n- Go [if some_global > 1 /]\n\t=> b\n~ b\nB\n');
    expect(warnings).toEqual(['line 3: choice condition "some_global > 1" kept verbatim in the choice text']);
    expect(content).toContain('- Go [if some_global > 1 /]\n\t=> b\n');
  });

  test('unparseable if-block is kept verbatim in the node text', () => {
    const src = '~ a\nif some_global\n\tHi\nelse\n\tBye\nAfter\n=> END\n';
    const {content, warnings} = run(src);
    expect(warnings).toEqual(['line 2: if-block with conditions the exporter cannot express kept verbatim']);
    expect(content).toContain('~ a\nif some_global\n\tHi\nelse\n\tBye\nAfter\n=> END\n');
  });

  test('random lines, comments, inline [if] and unknown mutations pass through', () => {
    const src = '~ a\n# note\n% One\n%2 Two\nHi [if vars.get("x", 0) > 1]there[/if]\ndo ui.choose("x")\n=> END\n';
    const {content, warnings} = run(src);
    expect(warnings).toEqual([]);
    expect(content).toContain('~ start\n=> a\n\n~ a\n# note\n% One\n%2 Two\nHi [if vars.get("x", 0) > 1]there[/if]\ndo ui.choose("x")\n=> END\n');
  });

  test('unknown jump kept verbatim; END! and unreachable lines warn', () => {
    const {content, warnings} = run('~ a\n=> other/cue\n~ b\nB\n=> END!\nDead\n\tDeader\n');
    expect(warnings).toEqual(['line 2: jump "=> other/cue" kept verbatim (unknown cue or jump-and-return)', 'line 5: `=> END!` becomes `=> END`', 'lines 6, 7: unreachable after a jump; dropped']);
    expect(content).toContain('~ a\n=> other/cue\n=> END\n');
  });

  test('cue names the exporter would change are reported', () => {
    const {warnings, content} = run('~ Встреча\nHi\n=> END\n');
    expect(warnings).toEqual(['line 1: cue "Встреча" will be exported as "vstrecha"; jumps from other files to it break']);
    expect(content).toContain('~ vstrecha\n');
  });

  test('nested responses and else-less if fall through to the continuation', () => {
    const src = ['~ a', 'Q', '- One', '\tInner', '\t- Deep', '\t\tDeepest', '- Two', 'if vars.get("x", 0) == 1', '\tX', 'Tail', '=> END', ''].join('\n');
    const {content, warnings} = run(src);
    expect(warnings).toEqual([]);
    // One -> a_1 (Inner + nested choice), Two -> a_3 (the continuation: if x -> a_4, else -> a_5 "Tail")
    expect(content).toContain('~ a\nQ\n- One\n\t=> a_1\n- Two\n\t=> a_3\n');
    expect(content).toContain('~ a_1\nInner\n- Deep\n\t=> a_2\n');
    expect(content).toContain('~ a_2\nDeepest\n=> a_3\n');
    expect(content).toContain('~ a_3\nif vars.get("x", 0) == 1\n\t=> a_4\nelse\n\t=> a_5\n');
    expect(content).toContain('~ a_4\nX\n=> a_5\n');
    expect(content).toContain('~ a_5\nTail\n=> END\n');
  });

  test('stage lines out of exporter order and ops before text stay verbatim', () => {
    const src = '~ a\ndo stage.show("center", "mira")\ndo stage.bg("bar")\nset vars["n"] = 1\nHi\n=> END\n';
    const {content, doc} = run(src);
    expect(nodesOf(doc)[0].data.stage).toEqual({show: [{slot: 'center', character: 'mira'}]});
    expect(content).toContain('~ a\ndo stage.show("center", "mira")\ndo stage.bg("bar")\nset vars["n"] = 1\nHi\n=> END\n');
  });

  test('mixed speakers are not inferred; read-only game keys in effects stay verbatim', () => {
    const src = '~ a\nМира: Hi\nСаша: Yo\ndo effect({"relationships.mira.affection": 1.0})\n=> END\n';
    const {doc, content} = run(src, GAME);
    const node = nodesOf(doc)[0];
    expect(node.data.stage).toBeUndefined();
    expect(node.operations).toEqual([]);
    expect(content).toContain('~ a\nМира: Hi\nСаша: Yo\ndo effect({"relationships.mira.affection": 1.0})\n=> END\n');
  });

  test('OR groups and mixed groups map to Go Flow condition groups', () => {
    const src = '~ a\nif (vars.get("x", 0) > 1 or chance(0.5)) and not flag("f")\n\t=> b\n=> END\n~ b\nB\n=> END\n';
    const {content, warnings} = run(src);
    expect(warnings).toEqual([]);
    expect(content).toContain('if (vars.get("x", 0) > 1 or chance(0.5)) and flag("f") == false\n\t=> b\nelse\n\t=> END\n');
  });
});

describe('scripts/import-dialogue.ts', () => {
  const cwd = path.resolve(__dirname, '../../../..');
  const tsx = (script: string, ...args: string[]) => spawnSync(process.execPath, [require.resolve('tsx/cli'), script, ...args], {cwd, encoding: 'utf8'});

  test('imports a directory into <slug>/project.json, re-import is a no-op, export reproduces the round trip', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-import-'));
    fs.mkdirSync(path.join(tmp, 'in'));
    fs.writeFileSync(path.join(tmp, 'in', 'handwritten.dialogue'), HANDWRITTEN);
    const projects = path.join(tmp, 'narrative');

    const first = tsx('scripts/import-dialogue.ts', '--in', path.join(tmp, 'in'), '--project-dir', projects);
    expect(first.status).toBe(0);
    const file = path.join(projects, 'handwritten', 'project.json');
    const json = fs.readFileSync(file, 'utf8');
    expect(Object.keys(JSON.parse(json))).toEqual([...Object.keys(JSON.parse(json))].sort());

    const second = tsx('scripts/import-dialogue.ts', '--in', path.join(tmp, 'in', 'handwritten.dialogue'), '--project-dir', projects);
    expect(second.stdout).toContain('unchanged');
    expect(fs.readFileSync(file, 'utf8')).toBe(json);

    expect(tsx('scripts/export-dialogue.ts', '--project-dir', projects, '--out', path.join(tmp, 'out')).status).toBe(0);
    expect(fs.readFileSync(path.join(tmp, 'out', 'handwritten.dialogue'), 'utf8')).toBe(roundTrip(HANDWRITTEN, 'handwritten').content);
    fs.rmSync(tmp, {recursive: true, force: true});
  }, 60000);
});
