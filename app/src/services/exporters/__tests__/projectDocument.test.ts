import {spawnSync} from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {parseGameManifest} from '../../gameManifest';
import {SAMPLE_MANIFEST, buildSampleProject} from '../data/sampleProject';
import {exportProjectDocument, parseProjectDocument} from '../projectDocument';

const EXPECTED_SAMPLE = `# goflow_sample — exported from Go Flow (Dialogue Manager)

~ start
=> bar

~ bar
do stage.bg("bar", "fade")
do stage.show("center", "mira", "smile", "work")
Мира: Привет. Я Мира, сегодня за стойкой.
do set_flag("met_mira", true)
- Сделать комплимент [if state("relationships.affection.mira", 0.0) < 50.0 /]
\tdo effect({"relationships.affection.mira": 15.0})
\t=> kompliment
- Оставить чаевые [if vars.get("tips", 0) < 3 /]
\tset vars["tips"] = vars.get("tips", 0) + 1
\t=> chaevye

~ kompliment
do stage.show("center", "mira", "neutral")
Мира: Льстец.
Мира: Но приятно.
if (vars.get("seen.chaevye", false) and flag("met_mira") == true)
\t=> snova
else
\t=> final

~ chaevye
set vars["seen.chaevye"] = true
Мира: Спасибо!
=> final

~ snova
do stage.cg("mira_toast", "dissolve")
Мира: Ты снова здесь? Тогда за тебя.
do scene("mira_night")
=> final

~ final
do stage.hide("center")
do stage.clear_cg()
Мира: Заходи ещё.
=> END
`;

describe('project document export', () => {
  test('sample project (local edition format) exports the expected .dialogue with no manifest warnings', () => {
    const [file] = exportProjectDocument(parseProjectDocument(buildSampleProject()), 'sample_project', parseGameManifest(SAMPLE_MANIFEST));
    expect(file.filename).toBe('sample_project.dialogue');
    expect(file.warnings).toEqual([]);
    expect(file.content).toBe(EXPECTED_SAMPLE);

    // DM_FIXTURE_DIR=<godot>/tests/fixtures/goflow npx jest projectDocument regenerates the game-side fixtures.
    const dir = process.env.DM_FIXTURE_DIR;
    if (dir) {
      fs.mkdirSync(path.join(dir, 'sample_project'), {recursive: true});
      fs.writeFileSync(path.join(dir, 'sample_project', 'project.json'), JSON.stringify(buildSampleProject(), null, 2) + '\n');
      fs.writeFileSync(path.join(dir, 'sample_project.dialogue'), file.content);
    }
  });

  test('output does not depend on the manifest when ids are valid (entity names give speakers)', () => {
    const [file] = exportProjectDocument(parseProjectDocument(buildSampleProject()), 'sample_project');
    expect(file.content).toBe(EXPECTED_SAMPLE);
  });

  test('Go Flow JSON export format is accepted', () => {
    const local = buildSampleProject();
    const jsonExport = {title: 'goflow_sample', data: {timelines: {main: {name: 'Main', ...local.graph.timelines.main}}}, metadata: {protocolVersion: 5}};
    const [file] = exportProjectDocument(parseProjectDocument(jsonExport), 'x');
    expect(file.filename).toBe('x.dialogue');
    // No entities in a JSON export: the speaker id is the display name; explicit `Мира:` lines stay.
    expect(file.content).toBe(EXPECTED_SAMPLE.replace(/Мира: /g, 'mira: ').replace('mira: Но приятно.', 'Мира: Но приятно.'));
  });

  test('several timelines -> <slug>_<timeline-slug>.dialogue in timeline order', () => {
    const doc = buildSampleProject();
    const main = doc.graph.timelines.main;
    const multi = {
      ...doc,
      graph: {
        timelines: {b: main, a: main, c: main},
        timelinesMetadata: [
          {id: 'a', name: 'Первый день', order: 1},
          {id: 'b', name: 'Первый день', order: 2},
          {id: 'c', name: '***', order: 3}
        ]
      }
    };
    expect(exportProjectDocument(parseProjectDocument(multi), 'bar').map((f) => f.filename)).toEqual(['bar_pervyy_den.dialogue', 'bar_pervyy_den_2.dialogue', 'bar_c.dialogue']);
  });

  test('rejects unknown documents', () => {
    expect(() => parseProjectDocument({foo: 1})).toThrow('Not a Go Flow project');
  });
});

describe('scripts/export-dialogue.ts', () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [require.resolve('tsx/cli'), 'scripts/export-dialogue.ts', ...args], {cwd: path.resolve(__dirname, '../../../..'), encoding: 'utf8'});

  test('writes <slug>.dialogue and --check detects drift', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-export-'));
    const projects = path.join(tmp, 'projects');
    const out = path.join(tmp, 'out');
    const manifest = path.join(tmp, 'game_manifest.json');
    fs.mkdirSync(path.join(projects, 'bar'), {recursive: true});
    fs.writeFileSync(path.join(projects, 'bar', 'project.json'), JSON.stringify(buildSampleProject()));
    fs.writeFileSync(manifest, JSON.stringify(SAMPLE_MANIFEST));

    expect(run('--project-dir', projects, '--out', out, '--check').status).toBe(1);
    const written = run('--project-dir', projects, '--out', out, '--manifest', manifest);
    expect(written.status).toBe(0);
    expect(fs.readFileSync(path.join(out, 'bar.dialogue'), 'utf8')).toBe(EXPECTED_SAMPLE);
    expect(run('--project-dir', projects, '--out', out, '--manifest', manifest, '--check').status).toBe(0);

    fs.appendFileSync(path.join(out, 'bar.dialogue'), '# edited\n');
    const drift = run('--project-dir', projects, '--out', out, '--check');
    expect(drift.status).toBe(1);
    expect(drift.stderr).toContain('outdated');
    fs.rmSync(tmp, {recursive: true, force: true});
  }, 60000);
});
