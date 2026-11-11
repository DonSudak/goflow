import {Variable} from '@types-folder/variables';

import {mapManifestType, parseGameManifest, syncVariablesFromManifest} from '..';

describe('parseGameManifest', () => {
  test('tolerates missing and extra fields', () => {
    const m = parseGameManifest({extra: 1, characters: [{id: 'mira'}, {name: 'no id'}], flags: ['a', 3], scenes: ['s1', {id: 's2', adult: true}]});
    expect(m.version).toBe(1);
    expect(m.game_keys).toEqual([]);
    expect(m.characters).toEqual([{id: 'mira', name: 'mira', expressions: [], outfits: []}]);
    expect(m.flags).toEqual(['a']);
    expect(m.scenes).toEqual([{id: 's1'}, {id: 's2', name: undefined, adult: true}]);
    expect(parseGameManifest(null).backgrounds).toEqual([]);
  });

  test('game keys default module from key prefix and writable to true', () => {
    const m = parseGameManifest({game_keys: [{key: 'hero.mood', type: 'float', initial: 0.5}, {type: 'int'}]});
    expect(m.game_keys).toEqual([{key: 'hero.mood', type: 'float', initial: 0.5, module: 'hero', writable: true}]);
  });

  test('type mapping', () => {
    expect(mapManifestType('int', 0)).toBe('integer');
    expect(mapManifestType('bool', false)).toBe('boolean');
    expect(mapManifestType('float', 0)).toBe('float');
    expect(mapManifestType('StringName', '')).toBe('string');
    expect(mapManifestType('Variant', 1)).toBe('float');
  });
});

describe('syncVariablesFromManifest', () => {
  const manifest = parseGameManifest({
    game_keys: [
      {key: 'household.money', type: 'int', initial: 100, module: 'household', writable: true},
      {key: 'hero.mood', type: 'float', initial: 0.5, module: 'hero', writable: true}
    ]
  });

  test('adds missing keys, updates existing, keeps user vars', () => {
    const vars: Variable[] = [
      {id: 'u', name: 'tips', type: 'integer', value: 0},
      {id: 'm', name: 'Деньги', internalName: 'household.money', type: 'string', value: 'x', description: 'my note'}
    ];
    const result = syncVariablesFromManifest(vars, manifest);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(vars[0]);
    expect(result[1]).toEqual({id: 'm', name: 'Деньги', internalName: 'household.money', type: 'integer', value: 100, description: 'my note', source: 'game'});
    expect(result[2]).toEqual({id: 'game_hero.mood', name: 'hero.mood', internalName: 'hero.mood', type: 'float', value: 0.5, description: '[game] hero', source: 'game'});
    expect(vars[1].type).toBe('string'); // input not mutated
  });

  test('is idempotent', () => {
    const once = syncVariablesFromManifest([], manifest);
    expect(syncVariablesFromManifest(once, manifest)).toEqual(once);
  });
});
