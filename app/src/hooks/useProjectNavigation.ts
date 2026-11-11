import {useCallback} from 'react';

import {usePathname, useRouter} from 'next/navigation';

import {buildEntitiesPath, buildEntityPath, buildEntityTypePath, buildProjectPath} from '../utils/navigation';
import {useRouteParams} from './useCurrentRoute';

export interface ProjectRouteParams {
  projectId: string;
  typeId?: string;
  entityId?: string;
}

export interface ProjectNavigation {
  params: ProjectRouteParams;
  isEntitiesSection: boolean;
  isEntityModalOpen: boolean;
  navigateToProject: (projectId: string) => void;
  navigateToEntities: (projectId: string) => void;
  navigateToEntityType: (projectId: string, typeId: string) => void;
  navigateToEntity: (projectId: string, typeId: string, entityId: string) => void;
  closeEntityModal: () => void;
  getCurrentSection: () => 'about' | 'entities';
}

export const useProjectNavigation = (): ProjectNavigation => {
  const params = useRouteParams();
  const router = useRouter();
  const pathname = usePathname();

  const projectId = params.project as string;
  const typeId = params.type;
  const entityId = params.entity;

  const routeParams: ProjectRouteParams = {
    projectId,
    typeId,
    entityId
  };

  const isEntitiesSection = pathname.includes('/entities');
  const isEntityModalOpen = !!entityId;

  const navigateToProject = useCallback(
    (projectId: string) => {
      router.push(buildProjectPath(projectId));
    },
    [router]
  );

  const navigateToEntities = useCallback(
    (projectId: string) => {
      router.push(buildEntitiesPath(projectId));
    },
    [router]
  );

  const navigateToEntityType = useCallback(
    (projectId: string, typeId: string) => {
      router.push(buildEntityTypePath(projectId, typeId));
    },
    [router]
  );

  const navigateToEntity = useCallback(
    (projectId: string, typeId: string, entityId: string) => {
      router.push(buildEntityPath(projectId, typeId, entityId));
    },
    [router]
  );

  const closeEntityModal = useCallback(() => {
    if (typeId) {
      router.push(buildEntityTypePath(projectId, typeId));
    } else {
      router.push(buildEntitiesPath(projectId));
    }
  }, [router, projectId, typeId]);

  const getCurrentSection = useCallback((): 'about' | 'entities' => {
    return isEntitiesSection ? 'entities' : 'about';
  }, [isEntitiesSection]);

  return {
    params: routeParams,
    isEntitiesSection,
    isEntityModalOpen,
    navigateToProject,
    navigateToEntities,
    navigateToEntityType,
    navigateToEntity,
    closeEntityModal,
    getCurrentSection
  };
};
