import {parseGameManifest} from '@services/gameManifest';

import {normalizeStage, stageSummary} from '../../../components/nodes/NarrativeNode/stage/stageUtils';
import {readOnlyKeysOf} from '../../../store/useGameManifestStore';
import {charactersToCreate, findCharacterType} from '../gameSync';
import {exportWarningsMessage} from '../notify';

jest.mock('../godotExport', () => ({loadManifest: jest.fn()}));

/** Shape written by the game (objects keyed by id), trimmed from narrative/game_manifest.json. */
const MANIFEST = parseGameManifest({
  version: 1,
  game_keys: {
    'calendar.day': {initial: 1, module: 'calendar', type: 'int', writable: false},
    'relationships.affection.mira': {initial: 0.0, module: 'relationships', type: 'float', writable: true}
  },
  characters: {
    mira: {display_name: '[PH] Мира', expressions: ['neutral', 'smile'], outfits: [], speaker: 'Мира'},
    sasha: {display_name: '[PH] Саша', expressions: ['neutral'], outfits: [], speaker: 'Саша'}
  },
  scenes: {mira_night: {adult: true, kind: 'CG_UNLOCK'}},
  vn: {backgrounds: ['bar'], cgs: [], stage_slots: ['center', 'left', 'right']}
});

describe('game integration (G2c)', () => {
  it('test_read_only_keys_are_the_non_writable_game_keys', () => {
    expect([...readOnlyKeysOf(MANIFEST)]).toEqual(['calendar.day']);
    expect(readOnlyKeysOf(null).size).toBe(0);
  });

  it('test_characters_to_create_skips_entities_with_matching_game_id', () => {
    const existing = [
      {id: 'e1', name: 'Mira (renamed by user)', values: [{parameterId: 'gid', value: 'mira'}]},
      {id: 'e2', name: 'User NPC', values: []}
    ] as any;
    expect(charactersToCreate(MANIFEST.characters, existing, 'gid').map((c) => c.id)).toEqual(['sasha']);
    expect(charactersToCreate(MANIFEST.characters, [], undefined).map((c) => c.name)).toEqual(['Мира', 'Саша']);
  });

  it('test_find_character_type_by_key_or_localized_name', () => {
    expect(findCharacterType([{id: 'a', name: 'Персонаж', type: 'npc'}] as any)?.id).toBe('a');
    expect(findCharacterType([{id: 'b', name: 'Heroes', type: 'character'}] as any)?.id).toBe('b');
    expect(findCharacterType([{id: 'c', name: 'Locations', type: 'location'}] as any)).toBeUndefined();
  });

  it('test_normalize_stage_drops_empty_rows_and_returns_undefined_when_empty', () => {
    expect(normalizeStage({speaker: ' ', show: [{slot: 'center', character: ''}], hide: [{slot: ''}]})).toBeUndefined();
    expect(
      normalizeStage({speaker: 'mira', background: {id: 'bar', transition: 'fade'}, show: [{slot: 'center', character: 'mira', expression: 'smile', outfit: ''}], cg: null, scene: 'mira_night'})
    ).toEqual({speaker: 'mira', background: {id: 'bar', transition: 'fade'}, show: [{slot: 'center', character: 'mira', expression: 'smile'}], cg: null, scene: 'mira_night'});
  });

  it('test_stage_summary_uses_manifest_names_and_marks_adult_scenes', () => {
    const chips = stageSummary({speaker: 'mira', background: {id: 'bar'}, show: [{slot: 'center', character: 'mira', expression: 'smile'}], scene: 'mira_night'}, MANIFEST);
    expect(chips.map((c) => c.label)).toEqual(['speaker: Мира', 'bg: bar', '+mira smile @center', 'scene: mira_night']);
    expect(chips.find((c) => c.key === 'scene')?.adult).toBe(true);
    expect(stageSummary(undefined, MANIFEST)).toEqual([]);
  });

  it('test_export_warnings_message_counts_and_truncates', () => {
    const warnings = Array.from({length: 8}, (_, i) => `w${i}`);
    const msg = exportWarningsMessage(warnings);
    expect(msg.startsWith('8 export warnings:')).toBe(true);
    expect(msg).toContain('• w5');
    expect(msg).not.toContain('• w6');
    expect(msg).toContain('and 2 more');
    expect(exportWarningsMessage(['x'])).toBe('1 export warning:\n• x');
  });
});
