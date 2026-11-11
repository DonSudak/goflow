import {getCurrentTimelineId} from '../../utils/getCurrentTimelineId';
import {buildEditorPath, buildPlayPath} from '../../utils/navigation';

describe('Navigation Logic Integration', () => {
  describe('Path building consistency', () => {
    it('should use consistent path format across components', () => {
      const projectId = 'test-project';
      const timelineId = 'test-timeline';
      const layerId = 'test-layer';

      const expectedPath = buildEditorPath(projectId, timelineId, layerId);

      expect(expectedPath).toBe('/project/editor?project=test-project&timeline=test-timeline&layer=test-layer');
    });

    it('should handle root layer consistently', () => {
      const projectId = 'test-project';
      const timelineId = 'test-timeline';

      const rootPath = buildEditorPath(projectId, timelineId);
      const explicitRootPath = buildEditorPath(projectId, timelineId, 'root');

      expect(rootPath).toBe(explicitRootPath);
      expect(rootPath).toBe('/project/editor?project=test-project&timeline=test-timeline');
    });

    it('should handle timeline ID parameter correctly', () => {
      const projectId = 'test-project';
      const timelineId = 'test-timeline';

      const path = buildEditorPath(projectId, timelineId);

      expect(path).toBe('/project/editor?project=test-project&timeline=test-timeline');
    });

    it('should build play paths correctly', () => {
      const projectId = 'test-project';
      const timelineId = 'test-timeline';
      const nodeId = 'test-node';

      const playPath = buildPlayPath(projectId, timelineId);
      const playPathWithNode = buildPlayPath(projectId, timelineId, nodeId);

      expect(playPath).toBe('/project/play?project=test-project&timeline=test-timeline');
      expect(playPathWithNode).toBe('/project/play?project=test-project&timeline=test-timeline&nodeId=test-node');
    });
  });

  describe('Timeline ID extraction', () => {
    beforeEach(() => {
      // Сбрасываем window.location перед каждым тестом
      delete (window as any).location;
    });

    it('should extract timeline ID from current URL', () => {
      Object.defineProperty(window, 'location', {
        value: {
          pathname: '/project/editor?project=project123&timeline=timeline-1&layer=layer-456'
        },
        writable: true
      });

      const timelineId = getCurrentTimelineId();
      expect(timelineId).toBe('timeline-1');
    });

    it('should return null for invalid paths', () => {
      Object.defineProperty(window, 'location', {
        value: {
          pathname: '/invalid/path'
        },
        writable: true
      });

      const timelineId = getCurrentTimelineId();
      expect(timelineId).toBe(null);
    });
  });

  describe('Navigation scenarios', () => {
    it('should handle navigation from root to child layer', () => {
      const projectId = 'project123';
      const timelineId = 'timeline-1';
      const childLayerId = 'layer-456';

      const rootPath = buildEditorPath(projectId, timelineId);
      const childPath = buildEditorPath(projectId, timelineId, childLayerId);

      expect(rootPath).toBe('/project/editor?project=project123&timeline=timeline-1');
      expect(childPath).toBe('/project/editor?project=project123&timeline=timeline-1&layer=layer-456');
    });

    it('should handle navigation between different timelines', () => {
      const projectId = 'project123';
      const timeline1 = 'timeline-1';
      const timeline2 = 'timeline-2';
      const layerId = 'layer-456';

      const path1 = buildEditorPath(projectId, timeline1, layerId);
      const path2 = buildEditorPath(projectId, timeline2, layerId);

      expect(path1).toBe('/project/editor?project=project123&timeline=timeline-1&layer=layer-456');
      expect(path2).toBe('/project/editor?project=project123&timeline=timeline-2&layer=layer-456');
    });

    it('should handle navigation from editor to play mode', () => {
      const projectId = 'project123';
      const timelineId = 'timeline-1';

      const editorPath = buildEditorPath(projectId, timelineId);
      const playPath = buildPlayPath(projectId, timelineId);

      expect(editorPath).toBe('/project/editor?project=project123&timeline=timeline-1');
      expect(playPath).toBe('/project/play?project=project123&timeline=timeline-1');
    });

    it('should handle complex navigation scenarios', () => {
      const projectId = 'project123';
      const timelineId = 'timeline-1';

      // Навигация по иерархии слоев
      const rootPath = buildEditorPath(projectId, timelineId);
      const layer1Path = buildEditorPath(projectId, timelineId, 'layer-1');
      const layer2Path = buildEditorPath(projectId, timelineId, 'layer-2');

      // Переход в режим воспроизведения
      const playPath = buildPlayPath(projectId, timelineId);
      const playWithNodePath = buildPlayPath(projectId, timelineId, 'start-node');

      expect(rootPath).toBe('/project/editor?project=project123&timeline=timeline-1');
      expect(layer1Path).toBe('/project/editor?project=project123&timeline=timeline-1&layer=layer-1');
      expect(layer2Path).toBe('/project/editor?project=project123&timeline=timeline-1&layer=layer-2');
      expect(playPath).toBe('/project/play?project=project123&timeline=timeline-1');
      expect(playWithNodePath).toBe('/project/play?project=project123&timeline=timeline-1&nodeId=start-node');
    });
  });
});
