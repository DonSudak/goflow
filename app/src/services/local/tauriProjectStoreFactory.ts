import {getNotificationManager} from '@components/Notifications';

import {getSettings} from '../godot/settings';
import {FsLike, TauriFsProjectStore} from './tauriFsProjectStore';

/** @tauri-apps/plugin-fs loaded lazily (the module touches Tauri internals at import time). */
const tauriFs = new Proxy({} as FsLike, {
  get:
    (_, name: string) =>
    async (...args: unknown[]) =>
      ((await import('@tauri-apps/plugin-fs')) as any)[name](...args)
});

let reloading = false;
/** Disk wins: tell the user and reload so the editor shows the file's current content. */
const reloadFromDisk = () => {
  if (reloading) return;
  reloading = true;
  getNotificationManager().showError('Project changed on disk (git pull / other editor). Reloading…', true, 3000);
  setTimeout(() => window.location.reload(), 1500);
};

export const createTauriProjectStore = (): TauriFsProjectStore => {
  const store = new TauriFsProjectStore(tauriFs, async () => (await getSettings()).projectsDir, reloadFromDisk);
  // git pull / branch switch while the app is in the background
  window.addEventListener('focus', () => store.checkExternalChanges().catch(console.error));
  // auto-export `.dialogue` (dynamic import: godotExport depends on the editor stores)
  window.addEventListener('goflow:project-saved', (e) => {
    void import('../godot/godotExport').then((m) => m.onProjectSaved((e as CustomEvent).detail.id));
  });
  return store;
};
