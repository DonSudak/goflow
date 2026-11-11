/**
 * Desktop (Tauri) settings of the local edition. Owned by Rust (src-tauri/src/lib.rs):
 * folders and the Godot executable are chosen in native dialogs opened by Rust and persisted in a
 * file the webview cannot write; `--godot-project` / `--project-dir` CLI args override.
 */

export const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface GodotSettings {
  /** Godot project root (folder with project.godot) */
  godotProject: string;
  /** Narrative projects folder; default `<godotProject>/narrative` */
  projectsDir: string;
  /** Dialogue output folder; default `<godotProject>/content/dialogue` */
  dialogueDir: string;
  /** `<godotProject>/narrative/game_manifest.json` (written by the game) */
  manifestPath: string;
  /** Godot executable chosen in Settings */
  godotExe: string;
  /** Write the `.dialogue` files after every save */
  autoExport: boolean;
}

export type GodotPathKind = 'godotProject' | 'projectsDir' | 'dialogueDir' | 'godotExe';

const invoke = async <T>(cmd: string, args?: Record<string, unknown>) => (await import('@tauri-apps/api/core')).invoke<T>(cmd, args);

let cached: Promise<GodotSettings> | null = null;

/** Effective settings (stored + CLI overrides + derived defaults). */
export const getSettings = (): Promise<GodotSettings> => (cached ??= invoke<GodotSettings>('get_godot_settings'));

const update = async (p: Promise<GodotSettings | null>) => {
  const settings = await p;
  if (settings) cached = Promise.resolve(settings);
  return settings;
};

/** Native dialog (opened by Rust); null when cancelled. Throws when the choice is invalid. */
export const pickGodotPath = (kind: GodotPathKind) => update(invoke<GodotSettings | null>('pick_godot_path', {kind}));

export const resetGodotPath = (kind: GodotPathKind) => update(invoke<GodotSettings>('reset_godot_path', {kind}));

export const setAutoExport = (enabled: boolean) => update(invoke<GodotSettings>('set_auto_export', {enabled}));

/** `--path <project> -- --dialogue <res> --cue <cue>` with the executable from Settings (argv built and validated in Rust). */
export const launchGodot = (project: string, dialogueRes: string, cue: string) => invoke<number>('play_in_godot', {project, dialogueRes, cue});
