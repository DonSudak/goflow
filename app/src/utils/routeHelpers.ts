/**
 * Определяет, находится ли пользователь в воркспейсе проекта
 * @param pathname - текущий путь (от usePathname)
 * @returns true если пользователь находится в любом разделе проекта (/project, /project/editor, ...)
 */
export const isInProjectWorkspace = (pathname: string): boolean => pathname === '/project' || pathname.startsWith('/project/');

/**
 * Извлекает ID проекта из URL (pathname + search)
 * @returns project id или null
 */
export const extractProjectId = (url: string): string | null => {
  const [path, search = ''] = url.split('?');
  if (!isInProjectWorkspace(path)) {
    return null;
  }
  return new URLSearchParams(search).get('project');
};
