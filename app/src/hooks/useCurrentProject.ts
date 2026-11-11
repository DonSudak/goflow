'use client';

import {useRouteParams} from './useCurrentRoute';

export function useCurrentProject() {
  const projectId = useRouteParams().project;

  return {
    projectId,
    isProjectLoaded: !!projectId
  };
}
