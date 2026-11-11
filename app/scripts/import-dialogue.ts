/**
 * Import Dialogue Manager `.dialogue` files as Go Flow local-edition projects.
 *
 *   npx tsx scripts/import-dialogue.ts --in <file.dialogue|dir> --project-dir <narrative dir> [--manifest <path>]
 *
 * Each `<name>.dialogue` becomes `<project-dir>/<name>/project.json` (sorted keys, like the desktop app writes),
 * so `export-dialogue` writes it back as `<name>.dialogue`. Re-importing keeps the project id, name,
 * entities and localization of an existing project.json and only replaces the graph; unchanged graphs are not rewritten.
 */
import * as fs from 'fs';
import * as path from 'path';

import {parseGameManifest} from '../src/services/gameManifest';
import {importDialogue} from '../src/services/importers/dialogueManagerImporter';
import {stableStringify} from '../src/services/local/tauriFsProjectStore';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const input = opt('--in');
const projectDir = opt('--project-dir');
const manifestPath = opt('--manifest');

if (!input || !projectDir) {
  console.error('Usage: import-dialogue --in <file.dialogue|dir> --project-dir <dir> [--manifest <path>]');
  process.exit(2);
}

const manifest = manifestPath ? parseGameManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))) : undefined;
const files = fs.statSync(input).isDirectory()
  ? fs
      .readdirSync(input)
      .filter((f) => f.endsWith('.dialogue'))
      .sort()
      .map((f) => path.join(input, f))
  : [input];

for (const file of files) {
  const slug = path.basename(file, '.dialogue');
  const target = path.join(projectDir, slug, 'project.json');
  const existing = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : null;
  const now = new Date().toISOString();
  const {doc, warnings} = importDialogue(fs.readFileSync(file, 'utf8'), {
    slug,
    manifest,
    now,
    existing: existing ? {id: existing.id, createdAt: existing.createdAt, timelineId: Object.keys(existing.graph?.timelines ?? {})[0]} : undefined
  });
  warnings.forEach((w) => console.warn(`warning: ${path.basename(file)}: ${w}`));
  if (existing && stableStringify(existing.graph?.timelines) === stableStringify(doc.graph.timelines)) {
    console.log(`unchanged ${target}`);
    continue;
  }
  const out = existing ? {...existing, graph: {...doc.graph, timelinesMetadata: existing.graph?.timelinesMetadata ?? doc.graph.timelinesMetadata}, updatedAt: now} : doc;
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, stableStringify(out));
  console.log(`wrote ${target}`);
}
