/**
 * Project document -> `.dialogue` files (pure, used by scripts/export-dialogue.ts and tests).
 *
 * Accepts:
 * - the local edition project document (`{format, name, graph: {timelines, timelinesMetadata}, entities}`,
 *   see app/docs/LOCAL_EDITION.md on branch ut/local-edition);
 * - the Go Flow JSON export (`{title, data: {timelines: {<id>: {name, layers, variables}}}}`).
 */
import {Variable} from '@types-folder/variables';

import {prepareDataForHTML} from '../../utils/flattenLayers';
import {generateInternalName} from '../../utils/transliteration';
import {GameManifest} from '../gameManifest';
import {DialogueManagerCodeGenerator, HAS_SPEAKER, LocalizableLine, dialogueLines} from './implementations/DialogueManagerCodeGenerator';
import {StoryProcessor} from './implementations/StoryProcessor';
import {ExportFormat} from './interfaces/exportInterfaces';

export interface ProjectTimeline {
  id: string;
  name: string;
  layers: Record<string, any>;
  variables: Variable[];
}

export interface ProjectLocalization {
  baseLanguage: string;
  targetLanguages: string[];
  /** NodeLocalization rows of the local edition (one per node field per target language) */
  entries: Array<{timelineId?: string; nodeId: string; fieldPath: string; targetLanguage: string; translatedText?: string | null}>;
}

export interface ProjectDocument {
  name: string;
  timelines: ProjectTimeline[];
  entities: Array<{id: string; name: string}>;
  /** Present only when the project has target languages: export then adds line IDs and `<slug>.csv` */
  localization?: ProjectLocalization;
}

export interface DialogueFile {
  filename: string;
  content: string;
  warnings: string[];
}

/** Reads either supported project format; throws on anything else. */
export const parseProjectDocument = (raw: any): ProjectDocument => {
  const graph = raw?.graph ?? raw?.data;
  if (!graph?.timelines || typeof graph.timelines !== 'object') {
    throw new Error('Not a Go Flow project: expected graph.timelines (local edition) or data.timelines (JSON export)');
  }
  const meta: Array<{id: string; name?: string; order?: number}> = graph.timelinesMetadata || [];
  const order = (id: string) => meta.find((m) => m.id === id)?.order ?? Number.MAX_SAFE_INTEGER;
  const timelines = Object.entries<any>(graph.timelines)
    .sort(([a], [b]) => order(a) - order(b))
    .map(([id, t]) => ({id, name: meta.find((m) => m.id === id)?.name || t.name || id, layers: t.layers || {}, variables: t.variables || []}));
  const entities = (Array.isArray(raw.entities) ? raw.entities : []).filter((e: any) => e && typeof e.id === 'string').map((e: any) => ({id: e.id, name: String(e.name ?? e.id)}));
  const cfg = raw.localization?.config;
  const localization: ProjectLocalization | undefined =
    cfg && Array.isArray(cfg.targetLanguages) && cfg.targetLanguages.length > 0
      ? {baseLanguage: String(cfg.baseLanguage || 'en'), targetLanguages: cfg.targetLanguages.map(String), entries: Array.isArray(raw.localization.entries) ? raw.localization.entries : []}
      : undefined;
  return {name: raw.name ?? raw.title ?? '', timelines, entities, ...(localization ? {localization} : {})};
};

/** RFC 4180 field quoting (what Godot's CSV translation importer reads). */
const csvField = (v: string) => (/[",\r\n]|^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * Dialogue Manager translation CSV (same layout as its "Simple CSV export"): `keys,<base>,<targets…>`,
 * keys = static line IDs, base column = the line text without `Name: `. Godot imports it as translations;
 * Dialogue Manager looks lines up by static ID.
 */
const buildTranslationCsv = (l10n: ProjectLocalization, rows: Array<{timelineId: string; line: LocalizableLine; nodeText: string}>, warn: (message: string) => void): string => {
  const out = [['keys', l10n.baseLanguage, ...l10n.targetLanguages].map(csvField).join(',')];
  const seen = new Set<string>();
  for (const {timelineId, line, nodeText} of rows) {
    if (seen.has(line.key)) {
      warn(`Duplicate line ID "${line.key}" (node "${line.nodeId}"); only the first one is in the CSV`);
      continue;
    }
    seen.add(line.key);
    const cells = [line.key, line.text];
    for (const lang of l10n.targetLanguages) {
      const entry = l10n.entries.find((e) => e.nodeId === line.nodeId && e.fieldPath === 'data.text' && e.targetLanguage === lang && (!e.timelineId || e.timelineId === timelineId));
      const translated = entry?.translatedText || '';
      let cell = '';
      if (translated && line.kind === 'choice') cell = translated.replace(/\s*\n\s*/g, ' ').trim();
      else if (translated) {
        const original = dialogueLines(nodeText);
        const lines = dialogueLines(translated);
        if (lines.length !== original.length) warn(`Translation (${lang}) of node "${line.nodeId}" has ${lines.length} dialogue lines, original has ${original.length}; left empty`);
        else cell = HAS_SPEAKER.test(original[line.index]) ? lines[line.index].replace(HAS_SPEAKER, '') : lines[line.index];
      }
      cells.push(cell.replace(/\s*\[ID:[^\]]*\]/, '').trim());
    }
    out.push(cells.map(csvField).join(','));
  }
  return out.join('\n') + '\n';
};

/**
 * One `.dialogue` per timeline: `<slug>.dialogue`, or `<slug>_<timeline-slug>.dialogue` when there are several.
 * Localized projects additionally get static line IDs and one `<slug>.csv` (all timelines, all languages) as the last file.
 */
export const exportProjectDocument = (doc: ProjectDocument, slug: string, manifest?: GameManifest): DialogueFile[] => {
  const processor = new StoryProcessor();
  const used = new Set<string>();
  const csvRows: Array<{timelineId: string; line: LocalizableLine; nodeText: string}> = [];
  const files = doc.timelines.map((timeline) => {
    let base = slug;
    if (doc.timelines.length > 1) {
      const tSlug = generateInternalName(timeline.name);
      base = `${slug}_${/[a-z0-9]/.test(tSlug) ? tSlug : timeline.id}`;
    }
    for (let i = 2; used.has(base); i++) base = `${base}_${i}`;
    used.add(base);

    const {nodes, edges} = prepareDataForHTML(timeline.layers);
    const story = processor.flattenLayers({title: doc.name || slug, data: {nodes, edges, variables: timeline.variables}} as any);
    const generator = new DialogueManagerCodeGenerator();
    const content = generator.generateCode(story, {
      format: ExportFormat.DIALOGUE_MANAGER,
      includeComments: true,
      minifyOutput: false,
      generateReadme: false,
      manifest,
      entities: doc.entities,
      lineIds: !!doc.localization
    });
    const texts = new Map(story.nodes.map((n: any) => [n.id, String(n.data?.text ?? '')]));
    for (const line of generator.getLocalizableLines()) csvRows.push({timelineId: timeline.id, line, nodeText: texts.get(line.nodeId) ?? ''});
    return {filename: `${base}.dialogue`, content, warnings: generator.getWarnings()};
  });
  if (doc.localization) {
    const warnings: string[] = [];
    const content = buildTranslationCsv(doc.localization, csvRows, (w) => warnings.includes(w) || warnings.push(w));
    files.push({filename: `${slug}.csv`, content, warnings});
  }
  return files;
};
