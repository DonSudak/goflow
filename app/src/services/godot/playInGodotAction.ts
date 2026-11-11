import {getNotificationManager} from '@components/Notifications';

import {ProjectDataService} from '../projectDataService';

/** UI action: export the current timeline and start Godot at the node's cue (or `start`), with toasts. */
export const playInGodotAction = async (nodeId?: string) => {
  const projectId = ProjectDataService.getStatus().currentProjectId;
  if (!projectId) return;
  try {
    const {playInGodot} = await import('./godotExport');
    const {cue} = await playInGodot(projectId, nodeId);
    getNotificationManager().showSuccess(`Godot started at cue "${cue}"`, true, 3000);
  } catch (error) {
    getNotificationManager().showError(error instanceof Error ? error.message : String(error));
  }
};

/** UI action: "Sync with game" (manifest -> game variables + character entities). */
export const syncWithGameAction = async () => {
  const projectId = ProjectDataService.getStatus().currentProjectId;
  if (!projectId) return;
  try {
    const {syncWithGame} = await import('./gameSync');
    const result = await syncWithGame(projectId);
    if (!result) getNotificationManager().showError('No game manifest found (Settings → Godot → Godot project)');
    else getNotificationManager().showSuccess(`Synced with game: ${result.variablesAdded} new variables, ${result.entitiesAdded} new characters`, true, 4000);
  } catch (error) {
    getNotificationManager().showError(error instanceof Error ? error.message : String(error));
  }
};
