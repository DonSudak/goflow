import {LocalProjectDocument, ProjectStore} from './projectStore';

/** Subset of @tauri-apps/plugin-fs used by the store (injected so it can be mocked in tests). */
export interface FsLike {
  exists(path: string): Promise<boolean>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, data: string): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  readDir(path: string): Promise<Array<{name: string; isDirectory: boolean}>>;
  mkdir(path: string, options?: {recursive?: boolean}): Promise<void>;
  remove(path: string, options?: {recursive?: boolean}): Promise<void>;
  stat(path: string): Promise<{mtime: Date | null}>;
}

/** Thrown when a project file changed on disk since this app last read or wrote it (git pull, branch switch, other editor). */
export class ExternalChangeError extends Error {
  constructor(readonly projectId: string) {
    super(`Project ${projectId} changed on disk`);
  }
}

const PROJECT_FILE = 'project.json';

/** Recursively sorts object keys (arrays keep their order) so the JSON diffs well in git. */
export const sortKeysDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((k) => [k, sortKeysDeep((value as Record<string, unknown>)[k])])
    );
  }
  return value;
};

export const stableStringify = (doc: unknown): string => JSON.stringify(sortKeysDeep(doc), null, 2) + '\n';

/** Folder name from a project name: lowercase letters/digits (any script), other runs become dashes. */
export const slugify = (name: string): string =>
  name
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'project';

const MIME_EXT: Record<string, string> = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg'};
const EXT_MIME = Object.fromEntries(Object.entries(MIME_EXT).map(([m, e]) => [e, m]));

/**
 * ProjectStore over a directory of git-friendly project folders:
 *   <projectsDir>/<slug>/project.json        (2-space indent, sorted keys)
 *   <projectsDir>/<slug>/images/<key>.<ext>
 * The folder slug is chosen once from the project name; renames keep the folder (id lives in the JSON).
 * Writes refuse to clobber a file that changed on disk since we last saw it (ExternalChangeError).
 */
export class TauriFsProjectStore implements ProjectStore {
  private slugs = new Map<string, string>(); // project id -> folder
  private mtimes = new Map<string, number>(); // project id -> mtime we last read/wrote
  private scanned = false;

  constructor(
    private fs: FsLike,
    private projectsDir: () => Promise<string>,
    private onExternalChange: (projectId: string) => void = () => {}
  ) {}

  private async dir(...parts: string[]) {
    return [await this.projectsDir(), ...parts].join('/');
  }

  private async mtimeOf(path: string): Promise<number> {
    return (await this.fs.stat(path)).mtime?.getTime() ?? 0;
  }

  /** Reads a project file and checks it against the mtime we know. */
  private async readDoc(slug: string): Promise<LocalProjectDocument | null> {
    const file = await this.dir(slug, PROJECT_FILE);
    if (!(await this.fs.exists(file))) return null;
    const doc = JSON.parse(await this.fs.readTextFile(file)) as LocalProjectDocument;
    const mtime = await this.mtimeOf(file);
    const known = this.mtimes.get(doc.id);
    this.slugs.set(doc.id, slug);
    if (known !== undefined && mtime > known) {
      this.onExternalChange(doc.id);
      throw new ExternalChangeError(doc.id);
    }
    this.mtimes.set(doc.id, mtime);
    return doc;
  }

  private async scan() {
    const root = await this.projectsDir();
    if (!(await this.fs.exists(root))) await this.fs.mkdir(root, {recursive: true});
    const slugs: string[] = [];
    for (const entry of await this.fs.readDir(root)) {
      if (entry.isDirectory && (await this.fs.exists(`${root}/${entry.name}/${PROJECT_FILE}`))) slugs.push(entry.name);
    }
    this.scanned = true;
    return slugs;
  }

  private async slugFor(id: string): Promise<string | undefined> {
    if (!this.slugs.has(id) && !this.scanned) await this.list();
    return this.slugs.get(id);
  }

  /** Folder name of a project (used for `<slug>.dialogue`). */
  async getSlug(id: string): Promise<string | undefined> {
    return this.slugFor(id);
  }

  /** Re-checks mtimes of every known project (call on window focus). */
  async checkExternalChanges(): Promise<string[]> {
    const changed: string[] = [];
    for (const [id, slug] of this.slugs) {
      const file = await this.dir(slug, PROJECT_FILE);
      const exists = await this.fs.exists(file);
      if (!exists || (await this.mtimeOf(file)) > (this.mtimes.get(id) ?? Infinity)) changed.push(id);
    }
    if (changed.length) this.onExternalChange(changed[0]);
    return changed;
  }

  async list() {
    const docs: LocalProjectDocument[] = [];
    for (const slug of await this.scan()) {
      const doc = await this.readDoc(slug);
      if (doc) docs.push(doc);
    }
    return docs;
  }

  async get(id: string) {
    const slug = await this.slugFor(id);
    return slug ? this.readDoc(slug) : null;
  }

  async save(doc: LocalProjectDocument) {
    let slug = await this.slugFor(doc.id);
    if (!slug) {
      const taken = new Set([...this.slugs.values(), ...(await this.scan())]);
      const base = slugify(doc.name);
      slug = base;
      for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
      await this.fs.mkdir(await this.dir(slug), {recursive: true});
      this.slugs.set(doc.id, slug);
    }
    const file = await this.dir(slug, PROJECT_FILE);
    const known = this.mtimes.get(doc.id);
    if (known !== undefined && (await this.fs.exists(file)) && (await this.mtimeOf(file)) > known) {
      this.onExternalChange(doc.id);
      throw new ExternalChangeError(doc.id);
    }
    await this.fs.writeTextFile(file, stableStringify(doc));
    this.mtimes.set(doc.id, await this.mtimeOf(file));
    globalThis.dispatchEvent?.(new CustomEvent('goflow:project-saved', {detail: {id: doc.id, slug}}));
  }

  async delete(id: string) {
    const slug = await this.slugFor(id);
    if (!slug) return;
    await this.fs.remove(await this.dir(slug), {recursive: true});
    this.slugs.delete(id);
    this.mtimes.delete(id);
  }

  private async imagesDir(projectId: string) {
    const slug = await this.slugFor(projectId);
    if (!slug) throw new Error(`Project ${projectId} not found`);
    return this.dir(slug, 'images');
  }

  private async findImage(projectId: string, key: string): Promise<string | null> {
    const dir = await this.imagesDir(projectId);
    if (!(await this.fs.exists(dir))) return null;
    const entry = (await this.fs.readDir(dir)).find((e) => e.name.replace(/\.[^.]+$/, '') === key);
    return entry ? `${dir}/${entry.name}` : null;
  }

  async putImage(projectId: string, key: string, data: Blob) {
    const dir = await this.imagesDir(projectId);
    await this.fs.mkdir(dir, {recursive: true});
    const old = await this.findImage(projectId, key);
    if (old) await this.fs.remove(old);
    await this.fs.writeFile(`${dir}/${key}.${MIME_EXT[data.type] || 'bin'}`, new Uint8Array(await data.arrayBuffer()));
  }

  async getImage(projectId: string, key: string) {
    const path = await this.findImage(projectId, key);
    if (!path) return null;
    const ext = path.split('.').pop() as string;
    return new Blob([(await this.fs.readFile(path)) as BlobPart], {type: EXT_MIME[ext] || 'application/octet-stream'});
  }

  async deleteImage(projectId: string, key: string) {
    const path = await this.findImage(projectId, key);
    if (path) await this.fs.remove(path);
  }

  async listImages(projectId: string) {
    const dir = await this.imagesDir(projectId);
    if (!(await this.fs.exists(dir))) return [];
    return (await this.fs.readDir(dir)).filter((e) => !e.isDirectory).map((e) => e.name.replace(/\.[^.]+$/, ''));
  }
}
