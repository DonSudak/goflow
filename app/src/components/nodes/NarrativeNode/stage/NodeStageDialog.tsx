'use client';

import React, {useState} from 'react';

import {Badge, Button, Dialog, Flex, Text} from '@radix-ui/themes';
import {NodeStage, StageTransition} from '@types-folder/nodes';

import {useGameManifestStore} from '@store/useGameManifestStore';

import {normalizeStage} from './stageUtils';

import s from './NodeStage.module.scss';

const TRANSITIONS: Array<StageTransition | ''> = ['', 'cut', 'fade', 'dissolve'];

/** Dropdown of manifest ids; a free text input only when there is no manifest. */
const Pick: React.FC<{label: string; value?: string; options?: Array<{id: string; label?: string}>; onChange: (v: string) => void; free: boolean}> = ({label, value, options, onChange, free}) => (
  <label className={s.field}>
    <span className={s.label}>{label}</span>
    {free ? (
      <input className={s.control} value={value || ''} onChange={(e) => onChange(e.target.value)} />
    ) : (
      <select className={s.control} value={value || ''} onChange={(e) => onChange(e.target.value)}>
        <option value=''>—</option>
        {value && !options?.some((o) => o.id === value) && <option value={value}>{value} (unknown)</option>}
        {(options || []).map((o) => (
          <option key={o.id} value={o.id}>
            {o.label || o.id}
          </option>
        ))}
      </select>
    )}
  </label>
);

const Transition: React.FC<{value?: StageTransition; onChange: (v?: StageTransition) => void}> = ({value, onChange}) => (
  <label className={s.field}>
    <span className={s.label}>transition</span>
    <select className={s.control} value={value || ''} onChange={(e) => onChange((e.target.value || undefined) as StageTransition | undefined)}>
      {TRANSITIONS.map((t) => (
        <option key={t} value={t}>
          {t || 'default'}
        </option>
      ))}
    </select>
  </label>
);

type Rows<K extends 'show' | 'hide' | 'move'> = NonNullable<NodeStage[K]>;

/** Stage directions editor for a narrative node (all lists come from the game manifest). */
const NodeStageDialog: React.FC<{open: boolean; stage?: NodeStage; onClose: () => void; onSave: (stage: NodeStage | undefined) => void}> = ({open, stage, onClose, onSave}) => {
  const manifest = useGameManifestStore((st) => st.manifest);
  const free = !manifest;
  const [draft, setDraft] = useState<NodeStage>(stage || {});
  const set = (patch: Partial<NodeStage>) => setDraft((d) => ({...d, ...patch}));
  const setRow = <K extends 'show' | 'hide' | 'move'>(key: K, i: number, patch: Partial<Rows<K>[number]>) =>
    set({[key]: ((draft[key] || []) as any[]).map((r, j) => (j === i ? {...r, ...patch} : r))} as Partial<NodeStage>);
  const addRow = (key: 'show' | 'hide' | 'move', row: object) => set({[key]: [...((draft[key] || []) as object[]), row]} as Partial<NodeStage>);
  const removeRow = (key: 'show' | 'hide' | 'move', i: number) => set({[key]: ((draft[key] || []) as object[]).filter((_, j) => j !== i)} as Partial<NodeStage>);

  const characters = manifest?.characters.map((c) => ({id: c.id, label: `${c.name} (${c.id})`}));
  const slots = manifest?.slots.map((id) => ({id}));
  const charOf = (id?: string) => manifest?.characters.find((c) => c.id === id);
  const cgMode = draft.cg === null ? 'clear' : draft.cg ? 'set' : '';

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Content maxWidth='720px' onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <Dialog.Title>Stage</Dialog.Title>
        <Dialog.Description size='1' color='gray'>
          {manifest ? 'Ids come from the game manifest.' : 'No game manifest: type ids by hand (Settings → Godot, then Sync with game).'}
        </Dialog.Description>

        <div className={s.section}>
          <Flex gap='3' wrap='wrap' align='end'>
            <Pick label='speaker' value={draft.speaker} options={characters} free={free} onChange={(v) => set({speaker: v})} />
            <label className={s.field}>
              <span className={s.label}>clear stage first</span>
              <input type='checkbox' checked={!!draft.clear} onChange={(e) => set({clear: e.target.checked})} />
            </label>
          </Flex>
        </div>

        <div className={s.section}>
          <Text weight='bold' size='2'>
            Background
          </Text>
          <Flex gap='3' wrap='wrap' align='end'>
            <Pick
              label='background'
              value={draft.background?.id}
              options={manifest?.backgrounds.map((id) => ({id}))}
              free={free}
              onChange={(v) => set({background: v ? {...draft.background, id: v} : undefined})}
            />
            <Transition value={draft.background?.transition} onChange={(t) => draft.background && set({background: {...draft.background, transition: t}})} />
          </Flex>
        </div>

        <div className={s.section}>
          <Text weight='bold' size='2'>
            Show
          </Text>
          {(draft.show || []).map((r, i) => (
            <Flex key={i} gap='3' wrap='wrap' align='end' className={s.row}>
              <Pick label='slot' value={r.slot} options={slots} free={free} onChange={(v) => setRow('show', i, {slot: v})} />
              <Pick label='character' value={r.character} options={characters} free={free} onChange={(v) => setRow('show', i, {character: v, expression: undefined, outfit: undefined})} />
              <Pick label='expression' value={r.expression} options={charOf(r.character)?.expressions.map((id) => ({id}))} free={free} onChange={(v) => setRow('show', i, {expression: v})} />
              <Pick label='outfit' value={r.outfit} options={charOf(r.character)?.outfits.map((id) => ({id}))} free={free} onChange={(v) => setRow('show', i, {outfit: v})} />
              <Transition value={r.transition} onChange={(t) => setRow('show', i, {transition: t})} />
              <Button size='1' variant='soft' color='red' onClick={() => removeRow('show', i)}>
                Remove
              </Button>
            </Flex>
          ))}
          <Button size='1' variant='soft' onClick={() => addRow('show', {slot: manifest?.slots[0] || '', character: ''})}>
            + Show character
          </Button>
        </div>

        <div className={s.section}>
          <Text weight='bold' size='2'>
            Hide / Move
          </Text>
          {(draft.hide || []).map((r, i) => (
            <Flex key={`h${i}`} gap='3' wrap='wrap' align='end' className={s.row}>
              <Pick label='hide slot' value={r.slot} options={slots} free={free} onChange={(v) => setRow('hide', i, {slot: v})} />
              <Transition value={r.transition} onChange={(t) => setRow('hide', i, {transition: t})} />
              <Button size='1' variant='soft' color='red' onClick={() => removeRow('hide', i)}>
                Remove
              </Button>
            </Flex>
          ))}
          {(draft.move || []).map((r, i) => (
            <Flex key={`m${i}`} gap='3' wrap='wrap' align='end' className={s.row}>
              <Pick label='move from' value={r.from} options={slots} free={free} onChange={(v) => setRow('move', i, {from: v})} />
              <Pick label='to' value={r.to} options={slots} free={free} onChange={(v) => setRow('move', i, {to: v})} />
              <Transition value={r.transition} onChange={(t) => setRow('move', i, {transition: t})} />
              <Button size='1' variant='soft' color='red' onClick={() => removeRow('move', i)}>
                Remove
              </Button>
            </Flex>
          ))}
          <Flex gap='2'>
            <Button size='1' variant='soft' onClick={() => addRow('hide', {slot: ''})}>
              + Hide
            </Button>
            <Button size='1' variant='soft' onClick={() => addRow('move', {from: '', to: ''})}>
              + Move
            </Button>
          </Flex>
        </div>

        <div className={s.section}>
          <Flex gap='3' wrap='wrap' align='end'>
            <label className={s.field}>
              <span className={s.label}>CG</span>
              <select className={s.control} value={cgMode} onChange={(e) => set({cg: e.target.value === 'clear' ? null : e.target.value === 'set' ? {id: ''} : undefined})}>
                <option value=''>unchanged</option>
                <option value='set'>set</option>
                <option value='clear'>clear</option>
              </select>
            </label>
            {cgMode === 'set' && (
              <>
                <Pick label='cg' value={draft.cg?.id} options={manifest?.cgs.map((id) => ({id}))} free={free} onChange={(v) => set({cg: {...draft.cg, id: v}})} />
                <Transition value={draft.cg?.transition} onChange={(t) => draft.cg && set({cg: {...draft.cg, transition: t}})} />
              </>
            )}
            <Pick
              label='scene (after the line)'
              value={draft.scene}
              options={manifest?.scenes.map((sc) => ({id: sc.id, label: `${sc.name || sc.id}${sc.adult ? ' — 18+' : ''}`}))}
              free={free}
              onChange={(v) => set({scene: v})}
            />
            {manifest?.scenes.find((sc) => sc.id === draft.scene)?.adult && <Badge color='red'>18+</Badge>}
          </Flex>
        </div>

        <Flex gap='3' justify='end' mt='4'>
          <Button variant='soft' color='gray' onClick={onClose}>
            Cancel
          </Button>
          <Button variant='soft' color='red' onClick={() => onSave(undefined)}>
            Remove stage
          </Button>
          <Button onClick={() => onSave(normalizeStage(draft))}>Save stage</Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
};

export default NodeStageDialog;
