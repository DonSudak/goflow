import {GameManifest} from '@services/gameManifest';
import {create} from 'zustand';

interface GameManifestState {
  /** Manifest of the connected Godot project (desktop edition); null = none, free text in stage editors */
  manifest: GameManifest | null;
  /** Game keys the narrative may read but not change (writable=false) */
  readOnlyKeys: Set<string>;
  setManifest: (manifest: GameManifest | null) => void;
}

export const readOnlyKeysOf = (manifest: GameManifest | null): Set<string> => new Set((manifest?.game_keys || []).filter((k) => !k.writable).map((k) => k.key));

export const useGameManifestStore = create<GameManifestState>((set) => ({
  manifest: null,
  readOnlyKeys: new Set(),
  setManifest: (manifest) => set({manifest, readOnlyKeys: readOnlyKeysOf(manifest)})
}));
