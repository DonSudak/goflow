import Dexie, {type Table} from 'dexie';

/**
 * Self-contained project document (one JSON file per project on disk).
 * Format is documented in app/docs/LOCAL_EDITION.md — bump `format` on breaking changes.
 */
export interface LocalProjectDocument {
  format: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Graph: same shape as backend project.data snapshot */
  graph: {
    timelines: Record<string, {layers: any; metadata: any; variables: any[]; lastLayerNumber?: number}>;
    timelinesMetadata: LocalTimelineMeta[];
  };
  projectInfo: Record<string, any> | null;
  entityTypes: any[]; // EntityType without nested parameter objects (parameters: [{id, parameterId, required, order}])
  entityParameters: any[];
  entities: any[]; // Entity with values: [{id, parameterId, value}]
  localization: {
    config: Record<string, any> | null;
    /** NodeLocalization rows (one per node field per target language) */
    entries: any[];
  };
}

export interface LocalTimelineMeta {
  id: string;
  name: string;
  description?: string;
  order: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Storage seam of the local edition. IndexedDB now; G2b adds a Tauri fs implementation
 * (<projects dir>/<slug>/project.json + images/<key>).
 */
export interface ProjectStore {
  list(): Promise<LocalProjectDocument[]>;
  get(id: string): Promise<LocalProjectDocument | null>;
  save(doc: LocalProjectDocument): Promise<void>;
  delete(id: string): Promise<void>;
  putImage(projectId: string, key: string, data: Blob): Promise<void>;
  getImage(projectId: string, key: string): Promise<Blob | null>;
  deleteImage(projectId: string, key: string): Promise<void>;
  listImages(projectId: string): Promise<string[]>;
}

interface ImageRow {
  id: string; // `${projectId}/${key}`
  projectId: string;
  key: string;
  data: Blob;
}

class LocalProjectsDb extends Dexie {
  documents!: Table<LocalProjectDocument, string>;
  images!: Table<ImageRow, string>;

  constructor() {
    super('GoFlowLocalProjects');
    this.version(1).stores({documents: 'id', images: 'id, projectId'});
  }
}

export class IndexedDbProjectStore implements ProjectStore {
  private db = new LocalProjectsDb();

  list() {
    return this.db.documents.toArray();
  }
  async get(id: string) {
    return (await this.db.documents.get(id)) ?? null;
  }
  async save(doc: LocalProjectDocument) {
    await this.db.documents.put(doc);
  }
  async delete(id: string) {
    await this.db.transaction('rw', this.db.documents, this.db.images, async () => {
      await this.db.documents.delete(id);
      await this.db.images.where('projectId').equals(id).delete();
    });
  }
  async putImage(projectId: string, key: string, data: Blob) {
    await this.db.images.put({id: `${projectId}/${key}`, projectId, key, data});
  }
  async getImage(projectId: string, key: string) {
    return (await this.db.images.get(`${projectId}/${key}`))?.data ?? null;
  }
  async deleteImage(projectId: string, key: string) {
    await this.db.images.delete(`${projectId}/${key}`);
  }
  async listImages(projectId: string) {
    return (await this.db.images.where('projectId').equals(projectId).toArray()).map((r) => r.key);
  }
}

let store: ProjectStore | null = null;

/** Single switch point for the storage backend (G2b: return TauriFsProjectStore when running in Tauri). */
export const getProjectStore = (): ProjectStore => (store ??= new IndexedDbProjectStore());

/** Test hook */
export const setProjectStore = (s: ProjectStore | null) => {
  store = s;
};
