/**
 * Desktop (Tauri) settings of the local edition: where the Godot project, the narrative
 * projects and the exported dialogue live. Persisted with @tauri-apps/plugin-store;
 * `--project-dir` / `--godot-project` CLI args (passed by the Godot editor plugin) override.
 */

export const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface GodotSettings {
  /** Godot project root (folder with project.godot) */
  godotProject: string;
  /** Narrative projects folder; default `<godotProject>/narrative` */
  projectsDir: string;
  /** Dialogue output folder; default `<godotProject>/content/dialogue` */
  dialogueDir: string;
  /** Godot editor/engine executable */
  godotExe: string;
  /** Write `<dialogueDir>/<slug>.dialogue` after every save */
  autoExport: boolean;
}

const KEY = 'godot';
const DEFAULTS: GodotSettings = {godotProject: '', projectsDir: '', dialogueDir: '', godotExe: 'godot', autoExport: false};

/** Parses `--flag value` and `--flag=value` forms. */
export const parseCliArgs = (args: string[]): Partial<Pick<GodotSettings, 'projectsDir' | 'godotProject'>> => {
  const out: Record<string, string> = {};
  const names: Record<string, keyof GodotSettings> = {'--project-dir': 'projectsDir', '--godot-project': 'godotProject'};
  args.forEach((arg, i) => {
    const eq = arg.indexOf('=');
    const flag = eq < 0 ? arg : arg.slice(0, eq);
    const inline = eq < 0 ? undefined : arg.slice(eq + 1);
    if (names[flag]) out[names[flag]] = inline ?? args[i + 1] ?? '';
  });
  return out;
};

/** Fills derived defaults: projectsDir and dialogueDir from the Godot project. */
export const resolveSettings = (stored: Partial<GodotSettings>, cli: Partial<GodotSettings>, appDataDir: string): GodotSettings => {
  const s = {...DEFAULTS, ...stored, ...Object.fromEntries(Object.entries(cli).filter(([, v]) => v))};
  const godot = s.godotProject.replace(/\/+$/, '');
  return {
    ...s,
    godotProject: godot,
    projectsDir: s.projectsDir || (godot ? `${godot}/narrative` : `${appDataDir}/projects`),
    dialogueDir: s.dialogueDir || (godot ? `${godot}/content/dialogue` : '')
  };
};

let cached: Promise<GodotSettings> | null = null;

const store = async () => (await import('@tauri-apps/plugin-store')).load('settings.json', {autoSave: true, defaults: {}});

/** Stored values only (what the settings form edits). */
export const loadStoredSettings = async (): Promise<Partial<GodotSettings>> => ((await (await store()).get<Partial<GodotSettings>>(KEY)) as Partial<GodotSettings>) || {};

/** Effective settings: stored + CLI overrides + defaults. */
export const getSettings = (): Promise<GodotSettings> =>
  (cached ??= (async () => {
    const [{invoke}, {appDataDir}] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/path')]);
    const [stored, args, dataDir] = await Promise.all([loadStoredSettings(), invoke<string[]>('cli_args'), appDataDir()]);
    return resolveSettings(stored, parseCliArgs(args), dataDir.replace(/\/+$/, ''));
  })());

export const saveSettings = async (settings: Partial<GodotSettings>) => {
  const s = await store();
  await s.set(KEY, settings);
  await s.save();
  cached = null;
};
