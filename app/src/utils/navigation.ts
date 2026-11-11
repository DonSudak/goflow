/**
 * Route builders/parsers. All project routes are static paths with query params
 * (`/project/...?project=&timeline=&layer=&type=&entity=`) so the app can be statically exported.
 */
const withQuery = (path: string, query: Record<string, string | undefined>): string => {
  const q = Object.keys(query)
    .filter((k) => query[k])
    .map((k) => `${k}=${encodeURIComponent(query[k] as string)}`)
    .join('&');
  return q ? `${path}?${q}` : path;
};

/**
 * Построение пути к редактору
 * timelineId — без него страница редактора перенаправит на активный таймлайн
 */
export const buildEditorPath = (projectId: string | undefined, timelineId?: string, layerId?: string): string =>
  withQuery('/project/editor', {project: projectId, timeline: timelineId, layer: layerId && layerId !== 'root' ? layerId : undefined});

/**
 * Построение пути к воспроизведению
 */
export const buildPlayPath = (projectId: string, timelineId: string, nodeId?: string): string => withQuery('/project/play', {project: projectId, timeline: timelineId, nodeId});

/**
 * Парсинг URL редактора (pathname + search, например window.location.pathname + window.location.search)
 */
const PARAM_RE = {
  project: /(?:^|[?&])project=([^&#]*)/,
  timeline: /(?:^|[?&])timeline=([^&#]*)/,
  layer: /(?:^|[?&])layer=([^&#]*)/
};
const queryParam = (url: string, key: keyof typeof PARAM_RE): string | null => {
  const m = url.match(PARAM_RE[key]);
  return m && m[1] ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : null;
};

export const parseEditorPath = (url: string) => {
  if (!url.startsWith('/project/editor')) return null;
  const projectId = queryParam(url, 'project');
  const timelineId = queryParam(url, 'timeline');
  if (!projectId || !timelineId) return null;

  return {
    projectId,
    timelineId,
    layerId: queryParam(url, 'layer') || 'root'
  };
};

/**
 * Построение пути к проекту (библия)
 */
export const buildProjectPath = (projectId: string): string => withQuery('/project', {project: projectId});

/**
 * Построение пути к сущностям проекта
 */
export const buildEntitiesPath = (projectId: string): string => withQuery('/project/entities', {project: projectId});

/**
 * Построение пути к типу сущностей
 */
export const buildEntityTypePath = (projectId: string, typeId: string): string => withQuery('/project/entities', {project: projectId, type: typeId});

/**
 * Построение пути к конкретной сущности
 */
export const buildEntityPath = (projectId: string, typeId: string, entityId: string): string => withQuery('/project/entities', {project: projectId, type: typeId, entity: entityId});

/**
 * Построение пути к локализации проекта
 */
export const buildLocalizationPath = (projectId: string): string => withQuery('/project/localization', {project: projectId});

/**
 * Парсинг пути проекта (pathname + search)
 */
export const parseProjectPath = (url: string) => {
  const [path, search = ''] = url.split('#')[0].split('?');
  const q = new URLSearchParams(search);
  const projectId = q.get('project');
  if (!projectId || !path.startsWith('/project')) return null;
  const section = path.startsWith('/project/entities') ? ('entities' as const) : path.startsWith('/project/localization') ? ('localization' as const) : ('about' as const);

  return {
    projectId,
    section,
    typeId: q.get('type') || undefined,
    entityId: q.get('entity') || undefined
  };
};
