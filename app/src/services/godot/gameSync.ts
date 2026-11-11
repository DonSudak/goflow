/**
 * "Sync with game": pulls the Useless Tycoon game manifest into the open project —
 * game keys become (marked) story variables, manifest characters become "Character" entities.
 * Never deletes or renames user data.
 */
import {api} from '@services/api';
import {GameManifest, ManifestCharacter, syncVariablesFromManifest} from '@services/gameManifest';
import {Entity, EntityParameter, EntityType} from '@types-folder/entities';
import {Variable} from '@types-folder/variables';

import {useGameManifestStore} from '@store/useGameManifestStore';
import {useGraphStore} from '@store/useGraphStore';
import {useVariablesStore} from '@store/useVariablesStore';

import {loadManifest} from './godotExport';
import {getSettings} from './settings';

export const CHARACTER_TYPE = {name: 'Character', type: 'character'};
export const GAME_ID_PARAMETER = 'Game ID';

/** Characters without an entity carrying their game id (matched via the "Game ID" parameter value). */
export const charactersToCreate = (characters: ManifestCharacter[], entities: Entity[], gameIdParamId: string | undefined): ManifestCharacter[] => {
  const known = new Set(entities.flatMap((e) => (e.values || []).filter((v) => v.parameterId === gameIdParamId).map((v) => String(v.value))));
  return characters.filter((c) => !known.has(c.id));
};

/** Adds a boolean `flags.<x>` variable for every manifest flag that has none (the exporter maps them to set_flag/flag). */
export const withManifestFlags = (variables: Variable[], flags: string[]): Variable[] => {
  const known = new Set(variables.map((v) => v.internalName || v.name));
  const added = flags
    .filter((f) => !known.has(`flags.${f}`))
    .map((f): Variable => ({id: `game_flags.${f}`, name: `flags.${f}`, internalName: `flags.${f}`, type: 'boolean', value: false, description: '[game] flag', source: 'game'}));
  return [...variables, ...added];
};

/** The project's character type: by `type` key, then by name (also the Russian "Персонаж"). */
export const findCharacterType = (types: EntityType[]) => types.find((t) => t.type === CHARACTER_TYPE.type) || types.find((t) => ['character', 'персонаж'].includes(t.name.trim().toLowerCase()));

const ensureCharacterSchema = async (projectId: string) => {
  let type = findCharacterType(await api.getEntityTypes(projectId));
  if (!type) type = await api.createEntityType(projectId, CHARACTER_TYPE);
  const params: EntityParameter[] = await api.getEntityParameters(projectId);
  let gameId = params.find((p) => p.name === GAME_ID_PARAMETER);
  if (!gameId) gameId = await api.createEntityParameter(projectId, {name: GAME_ID_PARAMETER, valueType: 'SHORT_TEXT'});
  if (!(type.parameters || []).some((link) => link.parameterId === gameId!.id)) {
    await api.addParameterToType(projectId, type.id, {parameterId: gameId.id});
  }
  return {type, gameId};
};

export interface SyncResult {
  variablesAdded: number;
  entitiesAdded: number;
}

/** Applies the manifest to the open project (variables of the current timeline + character entities). */
export const applyManifest = async (projectId: string, manifest: GameManifest): Promise<SyncResult> => {
  useGameManifestStore.getState().setManifest(manifest);

  const before = useVariablesStore.getState().variables;
  const synced = withManifestFlags(syncVariablesFromManifest(before, manifest), manifest.flags);
  useVariablesStore.getState().setVariables(synced);
  await useGraphStore.getState().saveToDb();

  let entitiesAdded = 0;
  if (manifest.characters.length > 0) {
    const {type, gameId} = await ensureCharacterSchema(projectId);
    const {entities} = await api.getEntities(projectId, {entityTypeId: type.id, limit: 1000} as any);
    for (const character of charactersToCreate(manifest.characters, entities, gameId.id)) {
      await api.createEntity(projectId, {name: character.name, entityTypeId: type.id, values: {[gameId.id]: character.id}});
      entitiesAdded++;
    }
    // refresh the editor's entity lists directly (the store's loaders skip once loaded)
    const [entityTypes, fresh] = await Promise.all([api.getEntityTypes(projectId), api.getEntities(projectId)]);
    useGraphStore.setState({entityTypes, entities: fresh.entities, entitiesLoaded: true});
  }
  return {variablesAdded: synced.length - before.length, entitiesAdded};
};

const mtimeKey = (projectId: string) => `goflow:manifest-mtime:${projectId}`;

/** Reads the manifest of the configured Godot project (null when there is none) and its mtime. */
export const readGameManifest = async (): Promise<{manifest: GameManifest; mtime: number} | null> => {
  const {manifestPath} = await getSettings();
  const manifest = await loadManifest(manifestPath);
  if (!manifest) return null;
  const fs = await import('@tauri-apps/plugin-fs');
  return {manifest, mtime: (await fs.stat(manifestPath)).mtime?.getTime() ?? 0};
};

/** Manual "Sync with game". */
export const syncWithGame = async (projectId: string): Promise<SyncResult | null> => {
  const read = await readGameManifest();
  if (!read) return null;
  const result = await applyManifest(projectId, read.manifest);
  localStorage.setItem(mtimeKey(projectId), String(read.mtime));
  return result;
};

/** On project open: always loads the manifest (dropdowns, read-only keys); syncs only when the file changed since the last sync. */
export const loadOrSyncOnOpen = async (projectId: string): Promise<SyncResult | null> => {
  const read = await readGameManifest();
  useGameManifestStore.getState().setManifest(read?.manifest ?? null);
  if (!read || localStorage.getItem(mtimeKey(projectId)) === String(read.mtime)) return null;
  const result = await applyManifest(projectId, read.manifest);
  localStorage.setItem(mtimeKey(projectId), String(read.mtime));
  return result;
};
