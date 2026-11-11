'use client';

import {useEffect, useState} from 'react';

import {useRouter} from 'next/navigation';

import {useRouteParams} from '@hooks/useCurrentRoute';
import {useTeamSwitch} from '@hooks/useTeamSwitch';
import {api} from '@services/api';
import {buildEditorPath} from 'src/utils/navigation';

import TimelineCanvas from './TimelineCanvas';

/** /project/editor?project=..[&timeline=..[&layer=..]] — without a timeline redirects to the active one */
const EditorPage = () => {
  const params = useRouteParams();
  return params.timeline ? <TimelineCanvas /> : <EditorRedirect projectId={params.project as string} />;
};

const EditorRedirect = ({projectId}: {projectId: string}) => {
  const router = useRouter();
  const [loading, setLoading] = useState(true);

  // Обрабатываем переключение команд с автоматическим редиректом
  useTeamSwitch({
    redirectFromProject: true
  });

  useEffect(() => {
    const redirectToFirstTimeline = async () => {
      try {
        // Получаем список таймлайнов для проекта
        const timelines = await api.getProjectTimelines({projectId});

        if (timelines && timelines.length > 0) {
          // Находим активный таймлайн или берем первый
          const activeTimeline = timelines.find((t: any) => t.isActive) || timelines[0];
          router.replace(buildEditorPath(projectId, activeTimeline.id));
        } else {
          console.error('No timelines found for project:', projectId);
          // Fallback - возвращаемся к списку проектов
          router.replace('/');
        }
      } catch (error) {
        console.error('Failed to load timelines for project:', projectId, error);
        // Fallback - возвращаемся к списку проектов
        router.replace('/');
      } finally {
        setLoading(false);
      }
    };

    redirectToFirstTimeline();
  }, [router, projectId]);

  if (loading) {
    return <div>Loading...</div>;
  }

  return null;
};

export default EditorPage;
