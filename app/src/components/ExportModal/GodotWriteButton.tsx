'use client';

import React, {useState} from 'react';

import {useCurrentProject} from '@hooks/useCurrentProject';
import {useIsTauri} from '@hooks/useIsTauri';
import {Button} from '@radix-ui/themes';

import {getNotificationManager} from '@components/Notifications';

/** Desktop only: writes `<dialogue dir>/<project folder>.dialogue` straight into the Godot project. */
const GodotWriteButton: React.FC<{onDone?: () => void}> = ({onDone}) => {
  const isDesktop = useIsTauri();
  const {projectId} = useCurrentProject();
  const [busy, setBusy] = useState(false);
  if (!isDesktop || !projectId) return null;

  const write = async () => {
    setBusy(true);
    try {
      const {writeDialogueToGodot} = await import('@services/godot/godotExport');
      const {paths, warnings} = await writeDialogueToGodot(projectId);
      (await import('@services/godot/notify')).notifyExportWarnings(warnings);
      getNotificationManager().showSuccess(`Written to Godot: ${paths.map((p) => p.split('/').pop()).join(', ')}`, true, 4000);
      onDone?.();
    } catch (error) {
      getNotificationManager().showError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button variant='soft' size='3' onClick={write} disabled={busy}>
      Write to Godot project
    </Button>
  );
};

export default GodotWriteButton;
