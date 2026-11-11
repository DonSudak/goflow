/**
 * Batch export of Go Flow projects to Dialogue Manager `.dialogue` files.
 *
 *   npx tsx scripts/export-dialogue.ts --project-dir <dir> --out <godot>/content/dialogue [--manifest <path>] [--check]
 *
 * <dir> holds `<slug>/project.json` (local edition document or Go Flow JSON export).
 * --check writes nothing and exits 1 when any output is missing or differs (CI drift detection).
 */
import * as fs from 'fs';
import * as path from 'path';

import {exportProjectDocument, parseProjectDocument} from '../src/services/exporters/projectDocument';
import {parseGameManifest} from '../src/services/gameManifest';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const projectDir = opt('--project-dir');
const outDir = opt('--out');
const manifestPath = opt('--manifest');
const check = args.includes('--check');

if (!projectDir || !outDir) {
  console.error('Usage: export-dialogue --project-dir <dir> --out <dir> [--manifest <path>] [--check]');
  process.exit(2);
}

const manifest = manifestPath ? parseGameManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))) : undefined;
const slugs = fs
  .readdirSync(projectDir, {withFileTypes: true})
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(projectDir, d.name, 'project.json')))
  .map((d) => d.name)
  .sort();

let drift = 0;
if (!check) fs.mkdirSync(outDir, {recursive: true});
for (const slug of slugs) {
  const doc = parseProjectDocument(JSON.parse(fs.readFileSync(path.join(projectDir, slug, 'project.json'), 'utf8')));
  for (const file of exportProjectDocument(doc, slug, manifest)) {
    const target = path.join(outDir, file.filename);
    file.warnings.forEach((w) => console.warn(`warning: ${slug}/${file.filename}: ${w}`));
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (check) {
      if (current !== file.content) {
        drift++;
        console.error(`${current === null ? 'missing' : 'outdated'}: ${target}`);
      }
    } else if (current !== file.content) {
      fs.writeFileSync(target, file.content);
      console.log(`wrote ${target}`);
    }
  }
}
if (slugs.length === 0) console.warn(`warning: no <slug>/project.json under ${projectDir}`);
process.exit(drift ? 1 : 0);
