/**
 * Godot integration of the desktop (Tauri) local edition: write `.dialogue` files into the Godot
 * project and launch Godot at a cue. Uses exporters/projectDocument.ts on the saved project document,
 * so the editor and `scripts/export-dialogue.ts` produce byte-identical files
 * (`<slug>.dialogue`, or `<slug>_<timeline-slug>.dialogue` for multi-timeline projects).
 */
import {DialogueManagerCodeGenerator} from '@services/exporters/implementations/DialogueManagerCodeGenerator';
import {StoryProcessor} from '@services/exporters/implementations/StoryProcessor';
import {exportProjectDocument, parseProjectDocument} from '@services/exporters/projectDocument';
import {GameManifest, parseGameManifest} from '@services/gameManifest';
import {ProjectDataService} from '@services/projectDataService';

import {useGraphStore} from '@store/useGraphStore';

import {prepareDataForHTML} from '../../utils/flattenLayers';
import {getProjectStore} from '../local/projectStore';
import {TauriFsProjectStore} from '../local/tauriFsProjectStore';
import {getSettings, launchGodot} from './settings';

/** `<godot>/narrative/game_manifest.json` (written by the game); pass the same file to the CLI via --manifest. */
export const loadManifest = async (manifestPath: string): Promise<GameManifest | undefined> => {
  if (!manifestPath) return undefined;
  const fs = await import('@tauri-apps/plugin-fs');
  return (await fs.exists(manifestPath)) ? parseGameManifest(JSON.parse(await fs.readTextFile(manifestPath))) : undefined;
};

/** `res://` path of a file inside the Godot project. */
export const toResPath = (godotProject: string, file: string) =>
  godotProject && file.startsWith(`${godotProject}/`) ? `res://${file.slice(godotProject.length + 1)}` : `res://content/dialogue/${file.split('/').pop()}`;

/** Writes every timeline of the project to `<dialogueDir>/`; returns the written paths. */
export const writeDialogueToGodot = async (projectId: string, flush = true) => {
  const settings = await getSettings();
  if (!settings.dialogueDir) throw new Error('Set the Godot project in Settings → Godot first');
  if (flush) await useGraphStore.getState().saveToDb(); // flush the editor into the project document

  const store = getProjectStore() as TauriFsProjectStore;
  const [raw, slug, manifest, fs] = await Promise.all([store.get(projectId), store.getSlug(projectId), loadManifest(settings.manifestPath), import('@tauri-apps/plugin-fs')]);
  if (!raw || !slug) throw new Error(`Project ${projectId} has no folder on disk`);

  const doc = parseProjectDocument(raw);
  const files = exportProjectDocument(doc, slug, manifest);
  await fs.mkdir(settings.dialogueDir, {recursive: true});
  const paths: string[] = [];
  for (const file of files) {
    const path = `${settings.dialogueDir}/${file.filename}`;
    await fs.writeTextFile(path, file.content);
    paths.push(path);
  }
  return {paths, doc, settings};
};

/** Exports, then starts `<godot> --path <project> -- --dialogue res://… --cue <cue>` at the node of the current timeline. */
export const playInGodot = async (projectId: string, nodeId?: string) => {
  const {paths, doc, settings} = await writeDialogueToGodot(projectId);
  if (!settings.godotProject) throw new Error('Set the Godot project in Settings → Godot first');

  // exportProjectDocument writes one file per timeline, in doc.timelines order
  const index = Math.max(
    0,
    doc.timelines.findIndex((t) => t.id === useGraphStore.getState().currentTimelineId)
  );
  const timeline = doc.timelines[index];
  let cue = 'start';
  if (nodeId && timeline) {
    const {nodes, edges} = prepareDataForHTML(timeline.layers);
    const story = new StoryProcessor().flattenLayers({title: doc.name, data: {nodes, edges, variables: timeline.variables}} as any);
    cue = new DialogueManagerCodeGenerator().cueNames(story).get(nodeId) || 'start';
  }
  const dialogueRes = toResPath(settings.godotProject, paths[index]);
  await launchGodot(dialogueRes, cue);
  return {cue, dialogueRes};
};

let autoExportTimer: ReturnType<typeof setTimeout> | undefined;
/** Auto-export on save (debounced; no flush, the save just happened); wired to `goflow:project-saved` of the fs store. */
export const onProjectSaved = async (projectId: string) => {
  // only the project open in the editor (the export flushes the editor stores)
  if (ProjectDataService.getStatus().currentProjectId !== projectId || !useGraphStore.getState().hasLoadedFromStorage) return;
  if (!(await getSettings()).autoExport) return;
  clearTimeout(autoExportTimer);
  autoExportTimer = setTimeout(() => writeDialogueToGodot(projectId, false).catch((e) => console.error('[auto-export]', e)), 1500);
};
