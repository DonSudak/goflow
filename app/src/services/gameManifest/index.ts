/**
 * Useless Tycoon game manifest (schema v1), written by the Godot side to `narrative/game_manifest.json`.
 * Pure TS: no store/browser dependencies, used by the Dialogue Manager exporter and the CLI.
 */
import {Variable, VariableType} from '@types-folder/variables';

export interface ManifestGameKey {
  key: string;
  type: string;
  initial: string | number | boolean;
  module: string;
  writable: boolean;
}

export interface ManifestCharacter {
  id: string;
  name: string;
  expressions: string[];
  outfits: string[];
}

export interface GameManifest {
  version: number;
  game_keys: ManifestGameKey[];
  flags: string[];
  characters: ManifestCharacter[];
  backgrounds: string[];
  cgs: string[];
  slots: string[];
  scenes: Array<{id: string; name?: string; adult?: boolean}>;
  locations: unknown[];
  items: unknown[];
  activities: unknown[];
  paths: Array<{id: string; name: string}>;
  dialogues: Array<{path: string; cues: string[]}>;
}

const arr = <T>(v: unknown, map: (x: any) => T | null): T[] => (Array.isArray(v) ? v.map(map).filter((x): x is T => x !== null) : []);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as any).id === 'string' ? (v as any).id : null);

/** Normalizes raw manifest JSON: tolerates missing/extra fields, keeps only well-formed entries. */
export const parseGameManifest = (raw: unknown): GameManifest => {
  const m = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  return {
    version: typeof m.version === 'number' ? m.version : 1,
    game_keys: arr(m.game_keys, (k) =>
      k && typeof k.key === 'string'
        ? {key: k.key, type: String(k.type ?? typeof k.initial), initial: k.initial ?? 0, module: String(k.module ?? k.key.split('.')[0]), writable: k.writable !== false}
        : null
    ),
    flags: arr(m.flags, str),
    characters: arr(m.characters, (c) =>
      c && typeof c.id === 'string' ? {id: c.id, name: typeof c.name === 'string' ? c.name : c.id, expressions: arr(c.expressions, str), outfits: arr(c.outfits, str)} : null
    ),
    backgrounds: arr(m.backgrounds, str),
    cgs: arr(m.cgs, str),
    slots: arr(m.slots, str),
    scenes: arr(m.scenes, (s) => (typeof s === 'string' ? {id: s} : s && typeof s.id === 'string' ? {id: s.id, name: s.name, adult: s.adult} : null)),
    locations: Array.isArray(m.locations) ? m.locations : [],
    items: Array.isArray(m.items) ? m.items : [],
    activities: Array.isArray(m.activities) ? m.activities : [],
    paths: arr(m.paths, (p) => (p && typeof p.id === 'string' ? {id: p.id, name: typeof p.name === 'string' ? p.name : p.id} : null)),
    dialogues: arr(m.dialogues, (d) => (d && typeof d.path === 'string' ? {path: d.path, cues: arr(d.cues, str)} : null))
  };
};

/** Maps a manifest (Godot) type name to a Go Flow variable type. */
export const mapManifestType = (type: string, initial: unknown): VariableType => {
  switch (type.toLowerCase()) {
    case 'bool':
    case 'boolean':
      return 'boolean';
    case 'int':
    case 'integer':
      return 'integer';
    case 'float':
    case 'number':
      return 'float';
    case 'percent':
      return 'percent';
    case 'string':
    case 'stringname':
      return 'string';
    default:
      return typeof initial === 'boolean' ? 'boolean' : typeof initial === 'number' ? 'float' : 'string';
  }
};

const GAME_PREFIX = '[game] ';

/**
 * Adds missing manifest game keys as variables (source 'game'), refreshes type/initial of existing ones.
 * User variables are never removed; game variables no longer in the manifest are kept as-is.
 */
export const syncVariablesFromManifest = (variables: Variable[], manifest: GameManifest, makeId: (key: string) => string = (key) => `game_${key}`): Variable[] => {
  const result = variables.map((v) => ({...v}));
  for (const gk of manifest.game_keys) {
    const type = mapManifestType(gk.type, gk.initial);
    const existing = result.find((v) => v.internalName === gk.key || v.name === gk.key);
    if (existing) {
      existing.type = type;
      existing.value = gk.initial;
      existing.source = 'game';
      if (!existing.description) existing.description = `${GAME_PREFIX}${gk.module}`;
    } else {
      result.push({id: makeId(gk.key), name: gk.key, internalName: gk.key, type, value: gk.initial, description: `${GAME_PREFIX}${gk.module}`, source: 'game'});
    }
  }
  return result;
};
