import {useSearchParams} from 'next/navigation';

/**
 * Route params live in the query string (`/project/editor?project=..&timeline=..&layer=..`)
 * so that `next build` can emit a static export (no dynamic segments).
 */
export const useRouteParams = (): {project?: string; timeline?: string; layer?: string; type?: string; entity?: string; token?: string} => {
  const params = useSearchParams();
  return Object.fromEntries(params?.entries() ?? []);
};

export const useCurrentRoute = () => {
  const params = useRouteParams();

  return {
    projectId: params.project as string,
    timelineId: params.timeline as string,
    layerId: params.layer || 'root'
  };
};
