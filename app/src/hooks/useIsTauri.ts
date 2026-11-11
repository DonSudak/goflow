import {useEffect, useState} from 'react';

import {isTauri} from '@services/godot/settings';

/** True when running inside the Tauri desktop shell (false during static prerender, so hydration matches). */
export const useIsTauri = (): boolean => {
  const [tauri, setTauri] = useState(false);
  useEffect(() => setTauri(isTauri()), []);
  return tauri;
};
