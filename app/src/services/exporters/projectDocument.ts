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
import {DialogueManagerCodeGenerator} from './implementations/DialogueManagerCodeGenerator';
import {StoryProcessor} from './implementations/StoryProcessor';
import {ExportFormat} from './interfaces/exportInterfaces';

export interface ProjectTimeline {
  id: string;
  name: string;
  layers: Record<string, any>;
  variables: Variable[];
}

export interface ProjectDocument {
  name: string;
  timelines: ProjectTimeline[];
  entities: Array<{id: string; name: string}>;
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
  return {name: raw.name ?? raw.title ?? '', timelines, entities};
};

/** One `.dialogue` per timeline: `<slug>.dialogue`, or `<slug>_<timeline-slug>.dialogue` when there are several. */
export const exportProjectDocument = (doc: ProjectDocument, slug: string, manifest?: GameManifest): DialogueFile[] => {
  const processor = new StoryProcessor();
  const used = new Set<string>();
  return doc.timelines.map((timeline) => {
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
      entities: doc.entities
    });
    return {filename: `${base}.dialogue`, content, warnings: generator.getWarnings()};
  });
};
