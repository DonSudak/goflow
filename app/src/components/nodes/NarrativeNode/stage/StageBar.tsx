'use client';

import React, {useState} from 'react';

import {NodeStage} from '@types-folder/nodes';
import cls from 'classnames';
import {getCommandManager} from 'src/commands/CommandManager';

import {useGameManifestStore} from '@store/useGameManifestStore';
import {useGraphStore} from '@store/useGraphStore';

import NodeStageDialog from './NodeStageDialog';
import {stageSummary} from './stageUtils';

import s from './NodeStage.module.scss';

/** Stage chips on a narrative node card + "Stage" button (shown when the node is selected or has a stage). */
const StageBar: React.FC<{nodeId: string; stage?: NodeStage; selected: boolean}> = ({nodeId, stage, selected}) => {
  const manifest = useGameManifestStore((st) => st.manifest);
  const [open, setOpen] = useState(false);
  const chips = stageSummary(stage, manifest);
  if (!chips.length && !selected) return null;

  const save = (next: NodeStage | undefined) => {
    const {layers, currentGraphId} = useGraphStore.getState();
    const node = layers[currentGraphId]?.nodes[nodeId];
    if (node?.type === 'narrative') {
      getCommandManager().editNarrativeNode(nodeId, {title: node.data.title, text: node.data.text, attachedEntities: node.data.attachedEntities, stage: next});
    }
    setOpen(false);
  };

  return (
    <div className={cls(s.bar, 'nodrag')} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      {chips.map((c) => (
        <span key={c.key} className={cls(s.chip, {[s.adult]: c.adult})}>
          {c.label}
          {c.adult ? ' 18+' : ''}
        </span>
      ))}
      <button type='button' className={s.edit_button} onClick={() => setOpen(true)} aria-label='Edit stage directions'>
        {chips.length ? 'edit stage' : '+ stage'}
      </button>
      {open && <NodeStageDialog open stage={stage} onClose={() => setOpen(false)} onSave={save} />}
    </div>
  );
};

export default StageBar;
