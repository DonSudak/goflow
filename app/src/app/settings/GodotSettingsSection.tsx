'use client';

import React, {useEffect, useState} from 'react';

import {GodotSettings, getSettings, loadStoredSettings, saveSettings} from '@services/godot/settings';

import s from './page.module.css';

type Field = {key: 'godotProject' | 'projectsDir' | 'dialogueDir' | 'godotExe'; label: string; hint: string; directory: boolean};

const FIELDS: Field[] = [
  {key: 'godotProject', label: 'Godot project', hint: 'Folder with project.godot', directory: true},
  {key: 'projectsDir', label: 'Narrative projects folder', hint: 'Default: <Godot project>/narrative', directory: true},
  {key: 'dialogueDir', label: 'Dialogue output folder', hint: 'Default: <Godot project>/content/dialogue', directory: true},
  {key: 'godotExe', label: 'Godot executable', hint: 'Used by "Play in Godot"', directory: false}
];

/** Desktop-only settings: where the Godot project, narrative projects and dialogue exports live. */
const GodotSettingsSection: React.FC = () => {
  const [stored, setStored] = useState<Partial<GodotSettings>>({});
  const [effective, setEffective] = useState<GodotSettings | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    loadStoredSettings().then(setStored);
    getSettings().then(setEffective);
  }, []);

  const browse = async (field: Field) => {
    const {open} = await import('@tauri-apps/plugin-dialog');
    const picked = await open({directory: field.directory, multiple: false, defaultPath: stored[field.key] || effective?.[field.key] || undefined});
    if (typeof picked === 'string') setStored((prev) => ({...prev, [field.key]: picked}));
  };

  const save = async () => {
    const projectsDirChanged = (stored.projectsDir || '') !== (effective?.projectsDir || '');
    await saveSettings(stored);
    setEffective(await getSettings());
    setSaved(true);
    // the projects folder is read once per session by the project store
    if (projectsDirChanged || stored.godotProject !== effective?.godotProject) window.location.reload();
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
            <label className={s.fieldLabel} htmlFor={`godot-${field.key}`}>
              {field.label}
            </label>
            <div style={{display: 'flex', gap: 8}}>
              <input
                id={`godot-${field.key}`}
                type='text'
                className={s.fieldInput}
                style={{flex: 1}}
                value={stored[field.key] || ''}
                placeholder={effective?.[field.key] || ''}
                onChange={(e) => setStored((prev) => ({...prev, [field.key]: e.target.value}))}
              />
              <button type='button' className={s.saveButton} onClick={() => browse(field)}>
                Browse…
              </button>
            </div>
            <p className={s.fieldDescription}>
              {field.hint}
              {effective?.[field.key] ? ` · in use: ${effective[field.key]}` : ''}
            </p>
          </div>
        ))}

        <div className={s.fieldGroup}>
          <label className={s.fieldLabel}>
            <input type='checkbox' checked={!!stored.autoExport} onChange={(e) => setStored((prev) => ({...prev, autoExport: e.target.checked}))} /> Auto-export .dialogue on save
          </label>
          <p className={s.fieldDescription}>
            Writes &lt;dialogue folder&gt;/&lt;project folder&gt;.dialogue shortly after each edit. CLI args --project-dir / --godot-project override these settings.
          </p>
        </div>

        <div className={s.cardActions}>
          <button type='button' className={s.saveButton} onClick={save}>
            {saved ? 'Saved' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default GodotSettingsSection;
