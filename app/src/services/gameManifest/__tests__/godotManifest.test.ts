import fixture from './godot_manifest.fixture.json';
import {parseGameManifest} from '../index';

// Real manifest written by tools/goflow/export_manifest.gd (keyed objects, vn section).
describe('parseGameManifest on the Godot-generated manifest', () => {
  const m = parseGameManifest(fixture);

  it('reads keyed game keys, drops non-scalars, keeps read_key', () => {
    const aff = m.game_keys.find((k) => k.key === 'relationships.affection.mira');
    expect(aff).toMatchObject({writable: true, read_key: 'relationships.mira.affection'});
    expect(m.game_keys.find((k) => k.key === 'household.money')).toMatchObject({initial: 60, writable: true});
    expect(m.game_keys.some((k) => k.key === 'world.present')).toBe(false);
  });

  it('reads characters with speaker names and vn assets', () => {
    expect(m.characters.find((c) => c.id === 'mira')).toMatchObject({name: 'Мира', expressions: ['neutral', 'smile']});
    expect(m.backgrounds).toContain('bar');
    expect(m.slots).toEqual(['center', 'left', 'right']);
    expect(m.scenes.map((s) => s.id)).toContain('mira_night');
    expect(m.paths.find((p) => p.id === 'university')?.name).toBe('[PH] ВУЗ');
    expect(m.dialogues.find((d) => d.path.endsWith('bar.dialogue'))?.cues).toEqual(['bar_meet']);
  });
});
