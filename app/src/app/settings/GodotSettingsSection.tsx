'use client';

import React, {useEffect, useState} from 'react';

import {GodotPathKind, GodotSettings, getSettings, pickGodotPath, resetGodotPath, setAutoExport} from '@services/godot/settings';

import s from './page.module.css';

const FIELDS: Array<{key: GodotPathKind; label: string; hint: string}> = [
  {key: 'godotProject', label: 'Godot project', hint: 'Folder with project.godot'},
  {key: 'projectsDir', label: 'Narrative projects folder', hint: 'Default: <Godot project>/narrative'},
  {key: 'dialogueDir', label: 'Dialogue output folder', hint: 'Default: <Godot project>/content/dialogue'},
  {key: 'godotExe', label: 'Godot executable', hint: 'Used by "Play in Godot" (file name must contain "godot")'}
];

/** Desktop-only settings. Paths are picked in native dialogs opened by the Rust side. */
const GodotSettingsSection: React.FC = () => {
  const [settings, setSettings] = useState<GodotSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSettings()
      .then(setSettings)
      .catch((e) => setError(String(e)));
  }, []);

  const run = async (action: () => Promise<GodotSettings | null>, key?: GodotPathKind) => {
    setError(null);
    try {
      const before = settings;
      const next = await action();
      if (!next) return;
      setSettings(next);
      // the project store reads the projects folder once per session
      if (key && key !== 'godotExe' && key !== 'dialogueDir' && next.projectsDir !== before?.projectsDir) window.location.reload();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className={s.settingsSection}>
      <div className={s.sectionHeader}>
        <h2 className={s.sectionTitle}>Godot</h2>
        <p className={s.sectionDescription}>Projects are stored as git-friendly JSON in the narrative folder; dialogue is exported to the Godot project.</p>
      </div>

      <div className={s.settingsCard}>
        {FIELDS.map((field) => (
          <div className={s.fieldGroup} key={field.key}>
            <label className={s.fieldLabel}>{field.label}</label>
            <div style={{display: 'flex', gap: 8, alignItems: 'center'}}>
              <code style={{flex: 1, overflowWrap: 'anywhere'}}>{settings?.[field.key] || '—'}</code>
              <button type='button' className={s.saveButton} onClick={() => run(() => pickGodotPath(field.key), field.key)}>
                Choose…
              </button>
              <button type='button' className={s.saveButton} onClick={() => run(() => resetGodotPath(field.key), field.key)}>
                Reset
              </button>
            </div>
            <p className={s.fieldDescription}>{field.hint}</p>
          </div>
        ))}

        <div className={s.fieldGroup}>
          <label className={s.fieldLabel}>
            <input type='checkbox' checked={!!settings?.autoExport} onChange={(e) => run(() => setAutoExport(e.target.checked))} /> Auto-export .dialogue on save
          </label>
          <p className={s.fieldDescription}>Game manifest: {settings?.manifestPath || '—'}. CLI args --project-dir / --godot-project override the folders.</p>
        </div>
        {error && <p style={{color: 'var(--red-11)'}}>{error}</p>}
      </div>
    </div>
  );
};

export default GodotSettingsSection;
