'use client';

import {useEffect} from 'react';

import {useCurrentProject} from '@hooks/useCurrentProject';
import {useIsTauri} from '@hooks/useIsTauri';
import {ProjectDataService} from '@services/projectDataService';

import {useGraphStore} from '@store/useGraphStore';

import {getNotificationManager} from '@components/Notifications';

/**
 * Desktop editor: on project open loads the game manifest (stage dropdowns, read-only game keys)
 * and runs "Sync with game" when the manifest file changed since the last sync of this project.
 */
const GameSyncInitializer = () => {
  const isDesktop = useIsTauri();
  const {projectId} = useCurrentProject();
  const loaded = useGraphStore((st) => st.hasLoadedFromStorage);

  useEffect(() => {
    if (!isDesktop || !projectId || !loaded) return;
    // wait until this project's graph (and its variables) finished loading, or the sync would be overwritten
    const projectReady = () =>
      new Promise<void>((resolve, reject) => {
        const started = Date.now();
        const poll = () => {
          if (ProjectDataService.getStatus().currentProjectId === projectId && useGraphStore.getState().hasLoadedFromStorage) resolve();
          else if (Date.now() - started > 15000) reject(new Error('project did not load'));
          else setTimeout(poll, 250);
        };
        poll();
      });
    projectReady()
      .then(() => import('@services/godot/gameSync'))
      .then((m) => m.loadOrSyncOnOpen(projectId))
      .then((result) => {
        if (result) getNotificationManager().showSuccess(`Game manifest changed — synced: ${result.variablesAdded} new variables, ${result.entitiesAdded} new characters`, true, 4000);
      })
      .catch((e) => console.error('[game sync]', e));
  }, [isDesktop, projectId, loaded]);

  return null;
};

export default GameSyncInitializer;
