import {useSearchParams} from 'next/navigation';

import {renderHook} from '@testing-library/react';

import {useCurrentRoute} from '../useCurrentRoute';

// Мокаем useParams из Next.js
jest.mock('next/navigation', () => ({
  useSearchParams: jest.fn()
}));

const mockUseSearchParams = useSearchParams as jest.MockedFunction<typeof useSearchParams>;
const mockUseParams = {mockReturnValue: (params: Record<string, string> | null) => mockUseSearchParams.mockReturnValue((params ? new URLSearchParams(params) : null) as any)};

describe('useCurrentRoute', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return all parameters when they are provided', () => {
    mockUseParams.mockReturnValue({
      project: 'project123',
      timeline: 'timeline-1',
      layer: 'layer-456'
    });

    const {result} = renderHook(() => useCurrentRoute());

    expect(result.current).toEqual({
      projectId: 'project123',
      timelineId: 'timeline-1',
      layerId: 'layer-456'
    });
  });

  it('should return undefined timelineId when timeline_id is not provided', () => {
    mockUseParams.mockReturnValue({
      project: 'project123',
      layer: 'layer-456'
    });

    const {result} = renderHook(() => useCurrentRoute());

    expect(result.current).toEqual({
      projectId: 'project123',
      timelineId: undefined,
      layerId: 'layer-456'
    });
  });

  it('should use "root" when layer_id is not provided', () => {
    mockUseParams.mockReturnValue({
      project: 'project123',
      timeline: 'timeline-1'
    });

    const {result} = renderHook(() => useCurrentRoute());

    expect(result.current).toEqual({
      projectId: 'project123',
      timelineId: 'timeline-1',
      layerId: 'root'
    });
  });

  it('should use defaults when only project_id is provided', () => {
    mockUseParams.mockReturnValue({
      project: 'project123'
    });

    const {result} = renderHook(() => useCurrentRoute());

    expect(result.current).toEqual({
      projectId: 'project123',
      timelineId: undefined,
      layerId: 'root'
    });
  });

  it('should handle empty params object', () => {
    mockUseParams.mockReturnValue({});

    const {result} = renderHook(() => useCurrentRoute());

    expect(result.current).toEqual({
      projectId: undefined,
      timelineId: undefined,
      layerId: 'root'
    });
  });

  it('should handle null/undefined params', () => {
    mockUseParams.mockReturnValue(null as any);

    const {result} = renderHook(() => useCurrentRoute());

    expect(result.current).toEqual({
      projectId: undefined,
      timelineId: undefined,
      layerId: 'root'
    });
  });

  it('should take the last value of repeated query params (edge case)', () => {
    mockUseSearchParams.mockReturnValue(
      new URLSearchParams([
        ['project', 'project123'],
        ['project', 'extra'],
        ['timeline', 'timeline-1']
      ]) as any
    );

    const {result} = renderHook(() => useCurrentRoute());

    expect(result.current).toEqual({projectId: 'extra', timelineId: 'timeline-1', layerId: 'root'});
  });

  it('should update when params change', () => {
    mockUseParams.mockReturnValue({
      project: 'project123',
      timeline: 'timeline-1',
      layer: 'layer-456'
    });

    const {result, rerender} = renderHook(() => useCurrentRoute());

    expect(result.current.layerId).toBe('layer-456');

    // Изменяем параметры
    mockUseParams.mockReturnValue({
      project: 'project123',
      timeline: 'timeline-1',
      layer: 'layer-789'
    });

    rerender();

    expect(result.current.layerId).toBe('layer-789');
  });
});
