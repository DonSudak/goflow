/**
 * MCP server (stdio) for Go Flow projects on disk — lets an AI agent read and edit story graphs
 * and export them to the Godot game, without the desktop app running.
 *
 *   npx tsx scripts/mcp-server.ts --project-dir <narrative dir> [--godot-project <dir>]
 *
 * Projects: <project-dir>/<slug>/project.json (same files the desktop app edits; it re-reads them on focus).
 * Manifest: <project-dir>/game_manifest.json (optional). Export target: <godot-project>/content/dialogue.
 */
// eslint-disable-next-line import/no-unresolved -- package "exports" map, resolved by tsc/tsx
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
// eslint-disable-next-line import/no-unresolved
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {execFile} from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {z} from 'zod';

import {exportProjectDocument, parseProjectDocument} from '../src/services/exporters/projectDocument';
import {GameManifest, parseGameManifest} from '../src/services/gameManifest';
import {slugify, stableStringify} from '../src/services/local/tauriFsProjectStore';
import {addNode, deleteNode, link, newProjectDocument, outline, setVariable, syncGameVariables, unlink, updateNode} from '../src/services/mcp/narrativeTools';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const projectDir = path.resolve(opt('--project-dir') ?? '');
if (!opt('--project-dir') || !fs.existsSync(projectDir)) {
  console.error('Usage: mcp-server --project-dir <narrative dir> [--godot-project <dir>]');
  process.exit(2);
}
const godotProject = path.resolve(opt('--godot-project') ?? path.dirname(projectDir));
const hasGodot = fs.existsSync(path.join(godotProject, 'project.godot'));
const dialogueDir = path.join(godotProject, 'content', 'dialogue');
const manifestPath = path.join(projectDir, 'game_manifest.json');

const loadManifest = (): GameManifest | undefined => (fs.existsSync(manifestPath) ? parseGameManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))) : undefined);

const slugs = () =>
  fs
    .readdirSync(projectDir, {withFileTypes: true})
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(projectDir, d.name, 'project.json')))
    .map((d) => d.name)
    .sort();
const fileOf = (slug: string) => path.join(projectDir, slug, 'project.json');
const readDoc = (slug: string) => JSON.parse(fs.readFileSync(fileOf(slug), 'utf8'));

/** Folder slug from a slug, project name or id — only existing folders, so the path stays inside projectDir. */
const resolveProject = (ref: string): string => {
  const all = slugs();
  if (all.includes(ref)) return ref;
  const hit = all.find((s) => {
    const d = readDoc(s);
    return d.name === ref || d.id === ref;
  });
  if (!hit) throw new Error(`Unknown project "${ref}". Projects: ${all.join(', ') || '(none)'}`);
  return hit;
};

const exportFiles = (slug: string, doc: any, manifest = loadManifest()) => exportProjectDocument(parseProjectDocument(doc), slug, manifest);

/** Loads, mutates, saves (sorted JSON, atomic rename) and reports export warnings. */
const edit = (ref: string, fn: (doc: any, manifest?: GameManifest) => string) => {
  const slug = resolveProject(ref);
  const doc = readDoc(slug);
  const manifest = loadManifest();
  const result = fn(doc, manifest);
  doc.updatedAt = new Date().toISOString();
  const tmp = `${fileOf(slug)}.tmp`;
  fs.writeFileSync(tmp, stableStringify(doc));
  fs.renameSync(tmp, fileOf(slug));
  const warnings = exportFiles(slug, doc, manifest).flatMap((f) => f.warnings);
  return warnings.length ? `${result}\nExport warnings:\n${warnings.map((w) => `- ${w}`).join('\n')}` : result;
};

const text = (t: string) => ({content: [{type: 'text' as const, text: t}]});
const tool =
  <A>(fn: (a: A) => string | Promise<string>) =>
  async (a: A) => {
    try {
      return text(await fn(a));
    } catch (e) {
      return {...text(e instanceof Error ? e.message : String(e)), isError: true};
    }
  };

// ---------- schemas ----------
const value = z.union([z.string(), z.number(), z.boolean()]);
const operation = z.object({
  variable: z.string().describe('Variable name: game key "<module>.<key>" (see get_manifest), "flags.<x>", or a story variable'),
  op: z.enum(['override', 'addition', 'subtract', 'multiply', 'divide', 'invert', 'join']).describe('Game keys accept only addition/subtract'),
  value: value.optional(),
  value_variable: z.string().optional().describe('Use another variable as the right side')
});
const condition = z
  .object({
    variable: z.string().optional(),
    op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']).optional().describe('default eq'),
    value: value.optional(),
    compare_variable: z.string().optional(),
    probability: z.number().optional().describe('0..1 → chance(p)'),
    seen: z.string().optional().describe('node id that must have been shown'),
    not_seen: z.string().optional().describe('node id that must not have been shown')
  })
  .describe('One of: {variable, op, value|compare_variable} | {probability} | {seen} | {not_seen}');
const stage = z
  .object({
    speaker: z.string().optional().describe('character id; prefixes lines without "Name:"'),
    background: z.object({id: z.string(), transition: z.enum(['cut', 'fade', 'dissolve']).optional()}).optional(),
    show: z.array(z.object({slot: z.string(), character: z.string(), expression: z.string().optional(), outfit: z.string().optional(), transition: z.string().optional()})).optional(),
    hide: z.array(z.object({slot: z.string(), transition: z.string().optional()})).optional(),
    move: z.array(z.object({from: z.string(), to: z.string(), transition: z.string().optional()})).optional(),
    cg: z.object({id: z.string(), transition: z.string().optional()}).nullable().optional().describe('null clears the CG'),
    clear: z.boolean().optional(),
    scene: z.string().optional().describe('scene id, requested after the text')
  })
  .describe('Stage directions; ids from get_manifest (characters, backgrounds, cgs, slots, scenes)');
const project = z.string().describe('Project slug (folder), name or id — see list_projects');

const server = new McpServer(
  {name: 'goflow-useless-tycoon', version: '0.1.0'},
  {
    instructions:
      'Go Flow story graphs of the Useless Tycoon game. A narrative node is one cue of Dialogue Manager: text lines ("Name: text" or plain, speaker from stage), ' +
      'its outgoing choice nodes become the player choices. read_project before editing; get_manifest for valid game keys, characters, backgrounds. ' +
      'Edits are saved immediately; call export_dialogue to write content/dialogue/<slug>.dialogue for the game. Node ids come from read_project / add_node.'
  }
);

server.registerTool(
  'list_projects',
  {description: 'List story projects (slug, name, node count)'},
  tool(() => {
    const rows = slugs().map((s) => {
      const d = readDoc(s);
      const nodes = Object.values<any>(d.graph?.timelines ?? {}).reduce((n, t) => n + Object.values<any>(t.layers ?? {}).reduce((m, l) => m + (l?.nodeIds?.length ?? 0), 0), 0);
      return `- ${s}: "${d.name}" (${nodes} nodes)`;
    });
    return rows.join('\n') || '(no projects)';
  })
);

server.registerTool(
  'read_project',
  {description: 'Readable dump of a project: variables, nodes (id, cue, text, stage, ops) and links with conditions', inputSchema: {project}},
  tool(({project: p}) => outline(readDoc(resolveProject(p))))
);

server.registerTool(
  'get_manifest',
  {
    description: 'What the game offers: writable game keys, flags, characters (expressions/outfits), backgrounds, cgs, stage slots, scenes, existing cues',
    inputSchema: {section: z.enum(['game_keys', 'flags', 'characters', 'backgrounds', 'cgs', 'slots', 'scenes', 'dialogues', 'paths']).optional()}
  },
  tool(({section}) => {
    const m = loadManifest();
    if (!m) return `No manifest at ${manifestPath}; run refresh_manifest`;
    const sections = section ? [section] : ['game_keys', 'flags', 'characters', 'backgrounds', 'cgs', 'slots', 'scenes', 'dialogues'];
    return sections.map((s) => `## ${s}\n${JSON.stringify((m as any)[s])}`).join('\n\n');
  })
);

server.registerTool(
  'create_project',
  {description: 'Create an empty project; its first node becomes `~ start`', inputSchema: {name: z.string()}},
  tool(({name}) => {
    let slug = slugify(name);
    if (!/^[a-z0-9_-]+$/.test(slug)) throw new Error('Use a latin name (it becomes the .dialogue file name)');
    if (slugs().includes(slug)) throw new Error(`Project "${slug}" exists`);
    fs.mkdirSync(path.join(projectDir, slug));
    fs.writeFileSync(fileOf(slug), stableStringify(newProjectDocument(name)));
    return `Created ${slug} (export → content/dialogue/${slug}.dialogue)`;
  })
);

server.registerTool(
  'add_node',
  {
    description:
      'Add a node. narrative = a cue with dialogue text (title → cue name); choice = a player option (put it after a narrative node, then link it to the next narrative). ' +
      'With `after`, links after → new node (optionally with conditions).',
    inputSchema: {
      project,
      type: z.enum(['narrative', 'choice']),
      text: z.string().describe('Narrative: lines "Name: text" (or plain with stage.speaker); choice: the option label'),
      title: z.string().optional(),
      stage: stage.optional(),
      operations: z.array(operation).optional(),
      after: z.string().optional(),
      conditions: z.array(condition).optional(),
      conditions_any: z.boolean().optional().describe('OR the conditions (default AND)')
    }
  },
  tool(({project: p, ...input}) => edit(p, (doc, m) => `Added node ${addNode(doc, input as any, m)}`))
);

server.registerTool(
  'update_node',
  {
    description: 'Change text/title/stage/operations of a node (operations replace the whole list; stage: null removes it)',
    inputSchema: {project, node: z.string(), text: z.string().optional(), title: z.string().optional(), stage: stage.nullable().optional(), operations: z.array(operation).optional()}
  },
  tool(({project: p, node, ...patch}) =>
    edit(p, (doc, m) => {
      updateNode(doc, node, patch as any, m);
      return `Updated ${node}`;
    })
  )
);

server.registerTool(
  'delete_node',
  {description: 'Delete a node and its links', inputSchema: {project, node: z.string()}},
  tool(({project: p, node}) =>
    edit(p, (doc) => {
      deleteNode(doc, node);
      return `Deleted ${node}`;
    })
  )
);

server.registerTool(
  'link',
  {
    description: 'Link two nodes (same layer), optionally conditional',
    inputSchema: {project, from: z.string(), to: z.string(), conditions: z.array(condition).optional(), conditions_any: z.boolean().optional()}
  },
  tool(({project: p, from, to, conditions, conditions_any}) => edit(p, (doc, m) => `Linked, edge ${link(doc, from, to, conditions, m, conditions_any)}`))
);

server.registerTool(
  'unlink',
  {description: 'Remove an edge by id, or all edges from → to', inputSchema: {project, edge: z.string().optional(), from: z.string().optional(), to: z.string().optional()}},
  tool(({project: p, ...ref}) => edit(p, (doc) => `Removed ${unlink(doc, ref)} edge(s)`))
);

server.registerTool(
  'set_variable',
  {
    description: 'Create/update a story variable. Names "flags.<x>" (boolean) become game flags; other non-game names are story-local vars. Game keys come from the manifest automatically.',
    inputSchema: {project, name: z.string(), type: z.enum(['string', 'integer', 'float', 'boolean', 'percent']), value, description: z.string().optional()}
  },
  tool(({project: p, ...v}) =>
    edit(p, (doc) => {
      setVariable(doc, v);
      return `Set ${v.name}`;
    })
  )
);

server.registerTool(
  'sync_game_variables',
  {description: 'Add/refresh all game keys from the manifest as variables', inputSchema: {project}},
  tool(({project: p}) =>
    edit(p, (doc, m) => {
      if (!m) throw new Error('No manifest; run refresh_manifest');
      return `${syncGameVariables(doc, m)} variables`;
    })
  )
);

server.registerTool(
  'export_dialogue',
  {
    description: 'Export projects to Dialogue Manager files in <godot>/content/dialogue (all projects when `project` is omitted). write=false returns the text without writing.',
    inputSchema: {project: project.optional(), write: z.boolean().optional().describe('default true')}
  },
  tool(({project: p, write = true}) => {
    const manifest = loadManifest();
    const out: string[] = [];
    for (const slug of p ? [resolveProject(p)] : slugs()) {
      for (const f of exportFiles(slug, readDoc(slug), manifest)) {
        f.warnings.forEach((w) => out.push(`warning: ${f.filename}: ${w}`));
        if (!write) out.push(`--- ${f.filename}\n${f.content}`);
        else {
          if (!hasGodot) throw new Error(`No project.godot in ${godotProject}; pass --godot-project`);
          const target = path.join(dialogueDir, f.filename);
          const same = fs.existsSync(target) && fs.readFileSync(target, 'utf8') === f.content;
          if (!same) {
            fs.mkdirSync(dialogueDir, {recursive: true});
            fs.writeFileSync(target, f.content);
          }
          out.push(`${same ? 'unchanged' : 'wrote'} res://content/dialogue/${f.filename}`);
        }
      }
    }
    return out.join('\n') || '(nothing to export)';
  })
);

server.registerTool(
  'refresh_manifest',
  {description: 'Regenerate narrative/game_manifest.json from the game (runs Godot headless, ~10-60 s)'},
  tool(
    () =>
      new Promise<string>((resolve, reject) => {
        const script = path.join(godotProject, 'tools', 'goflow', 'manifest.sh');
        if (!fs.existsSync(script)) return reject(new Error(`Missing ${script}`));
        execFile(script, {cwd: godotProject, timeout: 180_000}, (err, stdout, stderr) =>
          err ? reject(new Error(`${err.message}\n${stderr}`.trim())) : resolve(stdout.trim() || 'Manifest refreshed')
        );
      })
  )
);

await server.connect(new StdioServerTransport());
