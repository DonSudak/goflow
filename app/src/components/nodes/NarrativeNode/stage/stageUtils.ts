import {GameManifest} from '@services/gameManifest';
import {NodeStage} from '@types-folder/nodes';

/** Drops empty fields/rows; returns undefined for an empty stage (so the node data stays clean). */
export const normalizeStage = (stage: NodeStage | undefined): NodeStage | undefined => {
  if (!stage) return undefined;
  const out: NodeStage = {};
  if (stage.speaker?.trim()) out.speaker = stage.speaker.trim();
  if (stage.background?.id?.trim()) out.background = {...stage.background, id: stage.background.id.trim()};
  const show = (stage.show || []).filter((r) => r.slot && r.character);
  if (show.length) out.show = show.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== '' && v !== undefined)) as typeof r);
  const hide = (stage.hide || []).filter((r) => r.slot);
  if (hide.length) out.hide = hide;
  const move = (stage.move || []).filter((r) => r.from && r.to);
  if (move.length) out.move = move;
  if (stage.cg === null) out.cg = null;
  else if (stage.cg?.id?.trim()) out.cg = stage.cg;
  if (stage.clear) out.clear = true;
  if (stage.scene?.trim()) out.scene = stage.scene.trim();
  return Object.keys(out).length ? out : undefined;
};

export interface StageChip {
  key: string;
  label: string;
  adult?: boolean;
}

/** Compact chips for the node card. */
export const stageSummary = (stage: NodeStage | undefined, manifest: GameManifest | null): StageChip[] => {
  if (!stage) return [];
  const characterName = (id: string) => manifest?.characters.find((c) => c.id === id)?.name || id;
  const chips: StageChip[] = [];
  if (stage.clear) chips.push({key: 'clear', label: 'clear'});
  if (stage.speaker) chips.push({key: 'speaker', label: `speaker: ${characterName(stage.speaker)}`});
  if (stage.background) chips.push({key: 'bg', label: `bg: ${stage.background.id}`});
  for (const [i, r] of (stage.show || []).entries()) chips.push({key: `show${i}`, label: `+${r.character}${r.expression ? ` ${r.expression}` : ''} @${r.slot}`});
  for (const [i, r] of (stage.hide || []).entries()) chips.push({key: `hide${i}`, label: `−${r.slot}`});
  for (const [i, r] of (stage.move || []).entries()) chips.push({key: `move${i}`, label: `${r.from}→${r.to}`});
  if (stage.cg === null) chips.push({key: 'cg', label: 'cg: clear'});
  else if (stage.cg) chips.push({key: 'cg', label: `cg: ${stage.cg.id}`});
  if (stage.scene) chips.push({key: 'scene', label: `scene: ${stage.scene}`, adult: !!manifest?.scenes.find((s) => s.id === stage.scene)?.adult});
  return chips;
};
