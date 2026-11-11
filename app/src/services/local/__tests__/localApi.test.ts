import {LocalApi} from '../localApi';
import {LocalProjectDocument, ProjectStore} from '../projectStore';

const API = 'http://localhost:3001';

// jsdom test environment lacks these browser globals
class FakeResponse {
  status: number;
  ok: boolean;
  constructor(
    private body: string | null,
    init: {status?: number} = {}
  ) {
    this.status = init.status ?? 200;
    this.ok = this.status >= 200 && this.status < 300;
  }
  async json() {
    return JSON.parse(this.body as string);
  }
}
(globalThis as any).Response ??= FakeResponse;
(globalThis as any).structuredClone ??= (v: unknown) => JSON.parse(JSON.stringify(v));

class MemoryStore implements ProjectStore {
  docs = new Map<string, LocalProjectDocument>();
  images = new Map<string, Blob>();
  async list() {
    return [...this.docs.values()].map((d) => structuredClone(d));
  }
  async get(id: string) {
    const d = this.docs.get(id);
    return d ? structuredClone(d) : null;
  }
  async save(doc: LocalProjectDocument) {
    this.docs.set(doc.id, structuredClone(doc));
  }
  async delete(id: string) {
    this.docs.delete(id);
  }
  async putImage(p: string, k: string, b: Blob) {
    this.images.set(`${p}/${k}`, b);
  }
  async getImage(p: string, k: string) {
    return this.images.get(`${p}/${k}`) ?? null;
  }
  async deleteImage(p: string, k: string) {
    this.images.delete(`${p}/${k}`);
  }
  async listImages(p: string) {
    return [...this.images.keys()].filter((k) => k.startsWith(`${p}/`)).map((k) => k.slice(p.length + 1));
  }
}

const setup = () => {
  const store = new MemoryStore();
  const local = new LocalApi(API, () => store);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await local.fetch(`${API}${path}`, {method, body: body === undefined ? undefined : JSON.stringify(body)});
    return {status: res.status, json: res.status === 204 ? null : await res.json()};
  };
  return {store, local, call};
};

describe('LocalApi', () => {
  it('test_project_lifecycle_creates_lists_renames_duplicates_and_deletes', async () => {
    const {call} = setup();
    const created = await call('POST', '/projects', {name: 'Bar Night'});
    expect(created.status).toBe(201);
    const id = created.json.project.id;

    const timelines = await call('GET', `/api/projects/${id}/timelines`);
    expect(timelines.json).toHaveLength(1);
    expect(timelines.json[0]).toMatchObject({name: 'Main Timeline', isActive: true, projectId: id});

    await call('PUT', `/projects/${id}`, {name: 'Bar Night 2'});
    const dup = await call('POST', `/projects/${id}/duplicate`);
    expect(dup.json.project.name).toBe('Bar Night 2 (copy)');
    expect((await call('GET', '/projects')).json.projects).toHaveLength(2);

    await call('DELETE', `/projects/${id}`);
    expect((await call('GET', '/projects')).json.projects.map((p: any) => p.id)).toEqual([dup.json.project.id]);
  });

  it('test_graph_write_through_is_returned_by_snapshot', async () => {
    const {call, local} = setup();
    const id = (await call('POST', '/projects', {name: 'P'})).json.project.id;
    const tid = (await call('GET', `/api/projects/${id}/timelines`)).json[0].id;
    const layers = {root: {id: 'root', nodes: {n1: {id: 'n1', type: 'narrative', data: {title: 'T', text: 'Hello'}}}, edges: {}, nodeIds: ['n1']}};

    await local.saveGraph({projectId: id, timelines: {[tid]: {layers, metadata: {}, variables: [], lastLayerNumber: 0}}, timelinesMetadata: [{id: tid, name: 'Renamed'}]});

    const snap = await call('GET', `/projects/${id}/snapshot`);
    expect(snap.json.snapshot.timelines[tid].layers.root.nodes.n1.data.text).toBe('Hello');
    expect(snap.json.snapshot.timelinesMetadata[0].name).toBe('Renamed');
  });

  it('test_entities_types_parameters_and_values_roundtrip', async () => {
    const {call} = setup();
    const id = (await call('POST', '/projects', {name: 'P'})).json.project.id;
    const type = (await call('POST', `/projects/${id}/entity-types`, {name: 'Character', type: 'character'})).json.data;
    const param = (await call('POST', `/projects/${id}/entities/parameters`, {name: 'Age', valueType: 'NUMBER'})).json.data;
    await call('POST', `/projects/${id}/entity-types/${type.id}/parameters`, {parameterId: param.id, required: true});

    const entity = (await call('POST', `/projects/${id}/entities`, {name: 'Mira', entityTypeId: type.id, values: {[param.id]: 27}})).json.data;
    expect(entity.values[0]).toMatchObject({parameterId: param.id, value: 27, parameter: {name: 'Age'}});

    const types = (await call('GET', `/projects/${id}/entity-types`)).json.data;
    expect(types[0].parameters[0].parameter.name).toBe('Age');
    expect(types[0]._count.entities).toBe(1);
    expect((await call('DELETE', `/projects/${id}/entity-types/${type.id}`)).status).toBe(400);

    await call('DELETE', `/projects/${id}/entities/parameters/${param.id}`);
    const list = (await call('GET', `/projects/${id}/entities`)).json;
    expect(list.data[0].values).toEqual([]);
    expect(list.pagination.total).toBe(1);
  });

  it('test_manual_localization_sync_translate_and_outdate', async () => {
    const {call, local} = setup();
    const id = (await call('POST', '/projects', {name: 'P'})).json.project.id;
    const tid = (await call('GET', `/api/projects/${id}/timelines`)).json[0].id;
    const graph = (text: string) => ({
      projectId: id,
      timelines: {[tid]: {layers: {root: {nodes: {n1: {type: 'narrative', data: {title: '', text}}, c1: {type: 'choice', data: {text: 'Order a beer'}}}}}, metadata: {}, variables: []}}
    });
    await local.saveGraph(graph('Rough night?'));

    await call('POST', `/localization/projects/${id}`, {baseLanguage: 'en', targetLanguages: ['ru']});
    await call('POST', `/localization/projects/${id}/sync`);
    const texts = (await call('GET', `/localization/projects/${id}/timelines/${tid}/texts?language=ru`)).json.data;
    expect(texts.map((t: any) => t.originalText).sort()).toEqual(['Order a beer', 'Rough night?']);

    const row = texts.find((t: any) => t.nodeId === 'n1');
    await call('PUT', `/localization/translations/${row.id}`, {translatedText: 'Тяжёлая ночь?', method: 'MANUAL'});
    const summary = (await call('GET', `/localization/projects/${id}/timelines/summary`)).json.data;
    expect(summary[0].languageStats[0]).toMatchObject({language: 'ru', total: 2, translated: 1, progress: 50});

    await local.saveGraph(graph('Long night?'));
    await call('POST', `/localization/projects/${id}/sync?timelineId=${tid}`);
    const after = (await call('GET', `/localization/projects/${id}/timelines/${tid}/texts?language=ru`)).json.data.find((t: any) => t.nodeId === 'n1');
    expect(after).toMatchObject({status: 'OUTDATED', originalText: 'Long night?', translatedText: 'Тяжёлая ночь?'});
  });

  it('test_removed_features_answer_501', async () => {
    const {call} = setup();
    expect((await call('GET', '/teams')).status).toBe(501);
    expect((await call('POST', '/ai/fill-node')).status).toBe(501);
  });
});
