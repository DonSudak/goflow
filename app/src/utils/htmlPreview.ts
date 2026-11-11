import {useGraphStore} from '@store/useGraphStore';

import {loadProject} from '../services/dbService';
import {PlaybackStorageService} from '../services/playbackStorageService';
import {ProjectDataService} from '../services/projectDataService';
import {STORY_KEY, StorageService} from '../services/storageService';
import {prepareDataForHTML} from './flattenLayers';
import {storyStyles} from './storyStyles';
import {generateStoryHTML} from './storyTemplate';

export {prepareDataForHTML};

// Функция для генерации HTML шаблона
export const generateHTMLTemplate = (title: string, storyData: any) => {
  const template = generateStoryHTML(title, storyData, {isExport: true});
  return template.replace('[STYLES_PLACEHOLDER]', storyStyles);
};

export const saveStoryDataToStorage = async (projectId: string, projectName: string, timelineId?: string) => {
  try {
    // Загружаем данные проекта из IndexedDB
    const projectData = await loadProject(projectId);

    if (!projectData) {
      console.error('No project data available for preview');
      return;
    }

    // Используем переданный timelineId или получаем текущий из GraphStore
    const currentTimelineId = timelineId || useGraphStore.getState().currentTimelineId;

    // Если timelineId не найден, берем первый доступный
    const timelineKeys = Object.keys(projectData.timelines || {});
    const finalTimelineId = timelineKeys.includes(currentTimelineId) ? currentTimelineId : timelineKeys[0];

    if (!finalTimelineId) {
      console.error('No timeline data available for preview');
      return;
    }

    const timelineData = projectData.timelines[finalTimelineId];
    const layersToUse = timelineData.layers || {};
    const parsedVariables = timelineData.variables || [];

    // Преобразуем слои в формат nodes/edges
    const {nodes, edges} = prepareDataForHTML(layersToUse);

    // Сохраняем данные для предпросмотра с помощью StorageService (оставляем для превью)
    StorageService.saveStoryPreview({
      title: projectName,
      data: {
        nodes,
        edges,
        variables: parsedVariables
      },
      metadata: {
        timestamp: new Date().toISOString(),
        version: '1.0'
      }
    });
  } catch (error) {
    console.error('Failed to load project data for preview:', error);
  }
};

// Функция для открытия превью HTML в новой вкладке
export const openHTMLPreview = async (projectName: string, teamId: string, startNodeId?: string, projectId?: string, timelineId?: string) => {
  // Получаем projectId из параметра или из ProjectDataService
  const currentProjectId = projectId || ProjectDataService.getStatus().currentProjectId;

  if (!currentProjectId) {
    console.error('No project ID available for preview');
    return;
  }

  // Получаем текущий timelineId
  const currentTimelineId = timelineId || useGraphStore.getState().currentTimelineId;

  if (!currentTimelineId) {
    console.error('No timeline ID available for preview');
    return;
  }

  try {
    // ИСПРАВЛЕНИЕ: Принудительно сохраняем актуальные данные в IndexedDB перед воспроизведением
    // Это обеспечивает, что все последние изменения будут включены в playback
    await useGraphStore.getState().saveToDb();

    // Пытаемся использовать новый сервис IndexedDB
    const playbackId = await PlaybackStorageService.savePlaybackData(currentProjectId, teamId, currentTimelineId, projectName, startNodeId);

    // Создаем URL с playbackId
    const playbackUrl = PlaybackStorageService.buildPlaybackUrl(currentProjectId, currentTimelineId, startNodeId);

    console.log('Opening HTML preview with IndexedDB data:', playbackId);
    window.open(playbackUrl, '_blank');
  } catch (error) {
    console.error('Failed to save playback data to IndexedDB, falling back to localStorage:', error);

    // Fallback на старый метод localStorage
    await saveStoryDataToStorage(currentProjectId, projectName, currentTimelineId);

    // Открываем в новой вкладке с новой структурой роутинга
    let url: string;
    if (currentProjectId) {
      // Используем новую структуру роутинга
      url = startNodeId ? `/${currentProjectId}/play/${currentTimelineId}?startNode=${startNodeId}` : `/${currentProjectId}/play/${currentTimelineId}`;
    } else {
      // Fallback на старую структуру
      url = startNodeId ? `/play?startNode=${startNodeId}` : '/play';
    }

    window.open(url, '_blank');
  }
};
