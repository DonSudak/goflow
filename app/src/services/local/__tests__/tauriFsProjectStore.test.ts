import {createProjectDocument} from '../localApi';
import {ExternalChangeError, FsLike, TauriFsProjectStore, slugify, stableStringify} from '../tauriFsProjectStore';

jest.mock('../tauriProjectStoreFactory', () => ({createTauriProjectStore: jest.fn()}));

/** In-memory fs with a manual clock for mtimes. */
class MemFs implements FsLike {
  files = new Map<string, {data: string | Uint8Array; mtime: number}>();
  dirs = new Set<string>();
  clock = 1000;
  touch(path: string, data: string | Uint8Array) {
    this.files.set(path, {data, mtime: ++this.clock});
  }
  async exists(p: string) {
    return this.files.has(p) || this.dirs.has(p);
  }
  async readTextFile(p: string) {
    return this.files.get(p)!.data as string;
  }
  async writeTextFile(p: string, d: string) {
    this.touch(p, d);
  }
  async readFile(p: string) {
    return this.files.get(p)!.data as Uint8Array;
  }
  async writeFile(p: string, d: Uint8Array) {
    this.touch(p, d);
  }
  async readDir(p: string) {
    const names = new Map<string, boolean>();
    for (const path of [...this.files.keys(), ...this.dirs]) {
      if (!path.startsWith(`${p}/`)) continue;
      const [name, ...rest] = path.slice(p.length + 1).split('/');
      names.set(name, (names.get(name) ?? false) || rest.length > 0 || this.dirs.has(`${p}/${name}`));
    }
    return [...names].map(([name, isDirectory]) => ({name, isDirectory}));
  }
  async mkdir(p: string) {
    const parts = p.split('/');
    for (let i = 2; i <= parts.length; i++) this.dirs.add(parts.slice(0, i).join('/'));
  }
  async remove(p: string) {
    for (const k of [...this.files.keys()]) if (k === p || k.startsWith(`${p}/`)) this.files.delete(k);
    for (const k of [...this.dirs]) if (k === p || k.startsWith(`${p}/`)) this.dirs.delete(k);
  }
  async stat(p: string) {
    return {mtime: new Date(this.files.get(p)!.mtime)};
  }
}

const ROOT = '/godot/narrative';
const setup = () => {
  const fs = new MemFs();
  const changes: string[] = [];
  const store = new TauriFsProjectStore(
    fs,
    async () => ROOT,
    (id) => changes.push(id)
  );
  return {fs, store, changes};
};

describe('TauriFsProjectStore', () => {
  it('test_save_writes_sorted_pretty_json_into_slug_folder', async () => {
    const {fs, store} = setup();
    const doc = createProjectDocument('Bar Night!', 'p1');
    await store.save(doc);

    const text = fs.files.get(`${ROOT}/bar-night/project.json`)!.data as string;
    expect(text).toBe(stableStringify(doc));
    expect(text.startsWith('{\n  "createdAt"')).toBe(true); // keys sorted, 2-space indent
    expect(text.endsWith('}\n')).toBe(true);
    expect((await store.get('p1'))!.name).toBe('Bar Night!');
  });

  it('test_rename_keeps_folder_and_slugs_are_deduplicated', async () => {
    const {fs, store} = setup();
    await store.save(createProjectDocument('Intro', 'a'));
    await store.save(createProjectDocument('Intro', 'b'));
    const a = (await store.get('a'))!;
    await store.save({...a, name: 'Renamed'});

    expect(await store.getSlug('a')).toBe('intro');
    expect(await store.getSlug('b')).toBe('intro-2');
    expect(fs.files.has(`${ROOT}/renamed/project.json`)).toBe(false);
  });

  it('test_list_finds_projects_written_by_another_process', async () => {
    const {fs, store} = setup();
    fs.touch(`${ROOT}/from-git/project.json`, stableStringify(createProjectDocument('From git', 'g1')));
    const fresh = new TauriFsProjectStore(fs, async () => ROOT);
    expect((await fresh.list()).map((d) => d.id)).toEqual(['g1']);
    expect(await store.get('g1')).not.toBeNull();
  });

  it('test_save_refuses_to_clobber_newer_file_on_disk', async () => {
    const {fs, store, changes} = setup();
    const doc = createProjectDocument('P', 'p1');
    await store.save(doc);
    fs.touch(`${ROOT}/p/project.json`, stableStringify({...doc, name: 'changed by git'}));

    await expect(store.save({...doc, name: 'stale editor state'})).rejects.toBeInstanceOf(ExternalChangeError);
    expect(changes).toEqual(['p1']);
    expect(JSON.parse(fs.files.get(`${ROOT}/p/project.json`)!.data as string).name).toBe('changed by git');
  });

  it('test_check_external_changes_reports_modified_and_deleted_files', async () => {
    const {fs, store, changes} = setup();
    await store.save(createProjectDocument('One', 'p1'));
    await store.save(createProjectDocument('Two', 'p2'));
    expect(await store.checkExternalChanges()).toEqual([]);

    fs.touch(`${ROOT}/two/project.json`, stableStringify(createProjectDocument('Two', 'p2')));
    expect(await store.checkExternalChanges()).toEqual(['p2']);
    expect(changes).toEqual(['p2']);
  });

  it('test_images_roundtrip_with_extension_and_delete', async () => {
    const {fs, store} = setup();
    await store.save(createProjectDocument('P', 'p1'));
    const png = new Blob([new Uint8Array([137, 80, 78, 71])], {type: 'image/png'});
    // jsdom Blob lacks arrayBuffer()
    (png as any).arrayBuffer = async () => new Uint8Array([137, 80, 78, 71]).buffer;
    await store.putImage('p1', 'e1__entity-avatar', png);

    expect(fs.files.has(`${ROOT}/p/images/e1__entity-avatar.png`)).toBe(true);
    expect(await store.listImages('p1')).toEqual(['e1__entity-avatar']);
    expect((await store.getImage('p1', 'e1__entity-avatar'))!.type).toBe('image/png');

    await store.delete('p1');
    expect([...fs.files.keys()]).toEqual([]);
  });

  it('test_slugify_handles_cyrillic_and_symbols', () => {
    expect(slugify('Бар: ночь №1')).toBe('бар-ночь-1');
    expect(slugify('!!!')).toBe('project');
  });
});
