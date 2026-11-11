/**
 * LocalApi — in-browser replacement of the Go Flow backend for the `local` edition.
 *
 * ApiService.fetchWithAuth() routes every request here when isLocal(), so all api.* methods and the
 * raw fetchWithAuth callers (localization, export) keep working unchanged. Handlers mirror the
 * backend REST routes and response envelopes over a ProjectStore (one JSON document per project).
 * Routes of removed features (AI, billing, teams, comments, notebook, analytics...) answer 501.
 */
import {createEmptyProjectState} from '../../utils/projectStateHelpers';
import {LocalProjectDocument, LocalTimelineMeta, ProjectStore, getProjectStore} from './projectStore';

export const LOCAL_USER = {id: 'local-user', email: 'local@localhost', name: 'Local User'};

type Handler = (m: RegExpMatchArray, body: any, query: URLSearchParams) => Promise<Response> | Response;

const now = () => new Date().toISOString();

export const newId = (): string => {
  // 24 hex chars, same shape as backend Mongo ObjectIds
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
const noContent = () => new Response(null, {status: 204});
const notFound = (what: string) => json({error: `${what} not found`}, 404);
const notAvailable = (path: string) => json({error: `Not available in local edition: ${path}`}, 501);

const countWords = (text: string) => (text && text.trim() ? text.trim().split(/\s+/).length : 0);
const TRANSLATED = ['TRANSLATED', 'REVIEWED', 'APPROVED', 'PROTECTED'];
const APPROVED = ['APPROVED', 'PROTECTED'];

export const emptyTimeline = () => {
  const {layers, layerMetadata} = createEmptyProjectState();
  return {layers, metadata: layerMetadata, variables: [], lastLayerNumber: 0};
};

export const createProjectDocument = (name: string, id = newId()): LocalProjectDocument => {
  const timelineId = newId();
  const t = now();
  return {
    format: 1,
    id,
    name,
    createdAt: t,
    updatedAt: t,
    graph: {
      timelines: {[timelineId]: emptyTimeline()},
      timelinesMetadata: [{id: timelineId, name: 'Main Timeline', description: 'Default timeline', order: 1, isActive: true, createdAt: t, updatedAt: t}]
    },
    projectInfo: {id: newId(), projectId: id, status: 'concept', genres: [], formats: [], createdAt: t, updatedAt: t},
    entityTypes: [],
    entityParameters: [],
    entities: [],
    localization: {config: null, entries: []}
  };
};

export class LocalApi {
  private routes: Array<[string, RegExp, Handler]> = [];
  private imageUrls = new Map<string, string>(); // `${projectId}/${key}` -> object URL
  private version = 0;

  constructor(
    private apiUrl: string,
    private store: () => ProjectStore = getProjectStore
  ) {
    this.registerRoutes();
  }

  /** fetch()-compatible entry point used by ApiService.fetchWithAuth in the local edition */
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const rel = url.startsWith(this.apiUrl) ? url.slice(this.apiUrl.length) : url;
    const [rawPath, rawQuery = ''] = rel.split('?');
    const path = rawPath.replace(/\/+$/, '') || '/';
    const method = (init.method || 'GET').toUpperCase();
    let body: any;
    try {
      body = typeof init.body === 'string' && init.body ? JSON.parse(init.body) : undefined;
    } catch {
      body = undefined;
    }
    for (const [m, re, handler] of this.routes) {
      const match = m === method ? path.match(re) : null;
      if (match) {
        try {
          return await handler(match, body, new URLSearchParams(rawQuery));
        } catch (error) {
          console.error('[LocalApi]', method, path, error);
          return json({error: error instanceof Error ? error.message : String(error)}, 500);
        }
      }
    }
    console.warn('[LocalApi] not available locally:', method, path);
    return notAvailable(`${method} ${path}`);
  }

  // ---------- documents ----------

  private async doc(projectId: string): Promise<LocalProjectDocument> {
    const d = await this.store().get(projectId);
    if (!d) throw new Error(`Project ${projectId} not found`);
    return d;
  }

  private async save(d: LocalProjectDocument) {
    d.updatedAt = now();
    await this.store().save(d);
  }

  private async update<T>(projectId: string, fn: (d: LocalProjectDocument) => T): Promise<T> {
    const d = await this.doc(projectId);
    const result = fn(d);
    await this.save(d);
    return result;
  }

  private async docByTimeline(timelineId: string): Promise<LocalProjectDocument> {
    const docs = await this.store().list();
    const d = docs.find((x) => x.graph.timelinesMetadata.some((t) => t.id === timelineId));
    if (!d) throw new Error(`Timeline ${timelineId} not found`);
    return d;
  }

  /**
   * Graph write-through: dbService.saveProject() calls this with the full graph snapshot the editor
   * just cached in IndexedDB, so the project document always holds the latest graph.
   */
  async saveGraph(snapshot: {projectId: string; timelines: any; timelinesMetadata?: any[]; projectName?: string}) {
    const d = await this.store().get(snapshot.projectId);
    if (!d) return;
    d.graph.timelines = snapshot.timelines || d.graph.timelines;
    if (Array.isArray(snapshot.timelinesMetadata) && snapshot.timelinesMetadata.length > 0) {
      const old = new Map(d.graph.timelinesMetadata.map((t) => [t.id, t]));
      d.graph.timelinesMetadata = snapshot.timelinesMetadata.map((t: any, i: number) => ({
        ...old.get(t.id),
        id: t.id,
        name: t.name ?? old.get(t.id)?.name ?? 'Timeline',
        order: t.order ?? old.get(t.id)?.order ?? i + 1,
        isActive: t.isActive ?? old.get(t.id)?.isActive ?? false,
        createdAt: old.get(t.id)?.createdAt ?? now(),
        updatedAt: now()
      }));
    }
    await this.save(d);
  }

  private projectDto(d: LocalProjectDocument) {
    return {
      id: d.id,
      name: d.name,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      creatorId: LOCAL_USER.id,
      version: 1,
      members: [{id: `${d.id}-owner`, projectId: d.id, userId: LOCAL_USER.id, role: 'OWNER', createdAt: d.createdAt, user: LOCAL_USER}],
      projectInfo: d.projectInfo
    };
  }

  private snapshot(d: LocalProjectDocument) {
    return {
      timelines: d.graph.timelines,
      timelinesMetadata: d.graph.timelinesMetadata,
      projectName: d.name,
      projectId: d.id,
      _lastModified: Date.parse(d.updatedAt)
    };
  }

  private timelineDto(projectId: string, t: LocalTimelineMeta) {
    return {projectId, description: undefined, ...t};
  }

  // ---------- entities ----------

  private hydrateType(d: LocalProjectDocument, t: any) {
    return {
      ...t,
      parameters: (t.parameters || [])
        .map((link: any) => ({...link, entityTypeId: t.id, parameter: d.entityParameters.find((p) => p.id === link.parameterId)}))
        .sort((a: any, b: any) => a.order - b.order),
      _count: {entities: d.entities.filter((e) => e.entityTypeId === t.id).length}
    };
  }

  private hydrateEntity(d: LocalProjectDocument, e: any) {
    const type = d.entityTypes.find((t) => t.id === e.entityTypeId);
    return {
      ...e,
      entityType: type ? {...type, parameters: undefined} : undefined,
      values: (e.values || []).map((v: any) => ({...v, entityId: e.id, parameter: d.entityParameters.find((p) => p.id === v.parameterId)}))
    };
  }

  private setValues(e: any, values: Record<string, any> | Array<{parameterId: string; value: any}>) {
    const pairs = Array.isArray(values) ? values.map((v) => [v.parameterId, v.value] as const) : Object.entries(values);
    e.values = e.values || [];
    for (const [parameterId, value] of pairs) {
      const existing = e.values.find((v: any) => v.parameterId === parameterId);
      if (value === null || value === undefined) {
        e.values = e.values.filter((v: any) => v.parameterId !== parameterId);
      } else if (existing) {
        existing.value = value;
        existing.updatedAt = now();
      } else {
        e.values.push({id: newId(), parameterId, value, createdAt: now(), updatedAt: now()});
      }
    }
  }

  // ---------- images ----------

  private imageKey(entityId: string, parameterId: string) {
    return `${entityId}__${parameterId}`;
  }

  /** Sync URL for <img src>; filled by warmImages() / upload. */
  imageUrl(projectId: string, entityId: string, parameterId: string): string {
    return this.imageUrls.get(`${projectId}/${this.imageKey(entityId, parameterId)}`) || '';
  }

  private async cacheImage(projectId: string, key: string, blob: Blob) {
    const k = `${projectId}/${key}`;
    const old = this.imageUrls.get(k);
    if (old) URL.revokeObjectURL(old);
    this.imageUrls.set(k, URL.createObjectURL(blob));
  }

  private async warmImages(projectId: string) {
    const store = this.store();
    for (const key of await store.listImages(projectId)) {
      if (this.imageUrls.has(`${projectId}/${key}`)) continue;
      const blob = await store.getImage(projectId, key);
      if (blob) await this.cacheImage(projectId, key, blob);
    }
  }

  // ---------- localization ----------

  private scanTexts(timeline: any) {
    const texts: any[] = [];
    for (const [layerId, layer] of Object.entries<any>(timeline?.layers || {})) {
      for (const [nodeId, node] of Object.entries<any>(layer?.nodes || {})) {
        const push = (nodeType: string, fieldPath: string, text: string) => {
          if (text && text.trim()) texts.push({nodeId, nodeType, nodeTitle: node.data?.title, layerId, fieldPath, originalText: text, wordCount: countWords(text), characterCount: text.length});
        };
        if (node?.type === 'narrative' && node.data) {
          push('narrative', 'data.title', node.data.title);
          push('narrative', 'data.text', node.data.text);
        }
        if (node?.type === 'choice' && node.data) push('choice', 'data.text', node.data.text);
      }
    }
    return texts;
  }

  private syncLocalization(d: LocalProjectDocument, timelineId?: string) {
    const cfg = d.localization.config;
    if (!cfg) throw new Error('Project localization not found');
    const ids = timelineId ? [timelineId] : Object.keys(d.graph.timelines);
    return ids.map((tid) => {
      const texts = this.scanTexts(d.graph.timelines[tid]);
      let created = 0;
      let updated = 0;
      let outdated = 0;
      for (const lang of cfg.targetLanguages) {
        for (const text of texts) {
          const existing = d.localization.entries.find(
            (e) => e.timelineId === tid && e.layerId === text.layerId && e.nodeId === text.nodeId && e.fieldPath === text.fieldPath && e.targetLanguage === lang
          );
          if (!existing) {
            d.localization.entries.push({
              id: newId(),
              projectId: d.id,
              timelineId: tid,
              ...text,
              baseLanguage: cfg.baseLanguage,
              targetLanguage: lang,
              status: 'PENDING',
              createdAt: now(),
              updatedAt: now()
            });
            created++;
          } else if (existing.originalText !== text.originalText) {
            Object.assign(existing, text, {status: existing.translatedText ? 'OUTDATED' : 'PENDING', updatedAt: now()});
            outdated++;
          } else {
            updated++;
          }
        }
      }
      return {timelineId: tid, scanResult: {totalTexts: texts.length}, localizationsCreated: created, localizationsUpdated: updated, localizationsMarkedOutdated: outdated};
    });
  }

  private langStats(entries: any[]) {
    const total = entries.length;
    const translated = entries.filter((e) => TRANSLATED.includes(e.status)).length;
    const reviewed = entries.filter((e) => ['REVIEWED', ...APPROVED].includes(e.status)).length;
    const approved = entries.filter((e) => APPROVED.includes(e.status)).length;
    return {total, translated, reviewed, approved, progress: total ? Math.round((translated / total) * 100) : 0};
  }

  private async findEntry(id: string): Promise<[LocalProjectDocument, any]> {
    for (const d of await this.store().list()) {
      const e = d.localization.entries.find((x) => x.id === id);
      if (e) return [d, e];
    }
    throw new Error(`Localization with id ${id} not found`);
  }

  private async updateEntries(ids: string[], fn: (e: any) => void) {
    const touched = new Map<string, LocalProjectDocument>();
    for (const id of ids) {
      const cached = [...touched.values()].find((d) => d.localization.entries.some((x) => x.id === id));
      const [d, e] = cached ? [cached, cached.localization.entries.find((x) => x.id === id)] : await this.findEntry(id).catch(() => [null, null]);
      if (!d || !e) continue;
      fn(e);
      e.updatedAt = now();
      touched.set(d.id, d);
    }
    for (const d of touched.values()) await this.save(d);
    return {updated: ids.length};
  }

  private entryDto(e: any) {
    const {status, method, ...rest} = e;
    return {...rest, status, method, translationStatus: status, translationMethod: method};
  }

  // ---------- routes ----------

  private on(method: string, pattern: string, handler: Handler) {
    // pattern like /projects/:id/data -> ^/projects/([^/]+)/data$
    const re = new RegExp('^' + pattern.replace(/:[a-zA-Z]+/g, '([^/]+)') + '$');
    this.routes.push([method, re, handler]);
  }

  private registerRoutes() {
    const store = () => this.store();

    // --- auth (single local user) ---
    this.on('GET', '/auth/me', () => json({user: LOCAL_USER}));

    // --- projects ---
    this.on('GET', '/projects', async () => {
      const docs = (await store().list()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return json({projects: docs.map((d) => this.projectDto(d))});
    });
    this.on('POST', '/projects', async (_m, body) => {
      const d = createProjectDocument(body?.name || 'Untitled');
      if (body?.data?.timelines) d.graph.timelines = body.data.timelines;
      await store().save(d);
      return json({message: 'Project was created', project: this.projectDto(d)}, 201);
    });
    this.on('PUT', '/projects/:id', async (m, body) => json({project: this.projectDto(await this.update(m[1], (d) => ((d.name = body?.name ?? d.name), d)))}));
    this.on('DELETE', '/projects/:id', async (m) => {
      await store().delete(m[1]);
      return json({message: 'deleted'});
    });
    this.on('POST', '/projects/:id/duplicate', async (m) => {
      const src = await this.doc(m[1]);
      const copy: LocalProjectDocument = {...structuredClone(src), id: newId(), name: `${src.name} (copy)`, createdAt: now(), updatedAt: now()};
      if (copy.projectInfo) copy.projectInfo.projectId = copy.id;
      await store().save(copy);
      for (const key of await store().listImages(src.id)) {
        const blob = await store().getImage(src.id, key);
        if (blob) await store().putImage(copy.id, key, blob);
      }
      return json({project: this.projectDto(copy)}, 201);
    });
    this.on('GET', '/projects/:id/data', async (m) => json({data: this.snapshot(await this.doc(m[1]))}));
    this.on('POST', '/projects/:id/data', async (m, body) => {
      await this.saveGraph({...body, projectId: m[1]});
      return json({project: this.projectDto(await this.doc(m[1]))});
    });
    this.on('GET', '/projects/:id/snapshot', async (m) => json({success: true, version: this.version, timestamp: Date.now(), snapshot: this.snapshot(await this.doc(m[1]))}));
    // Graph is persisted as a full snapshot via saveGraph(); operations are acknowledged and dropped.
    this.on('POST', '/projects/:id/ops', (_m, body) => json({success: true, syncVersion: ++this.version, appliedOperations: (body?.operations || []).map((o: any) => o.id), serverOperations: []}));
    this.on('GET', '/projects/:id/operations', () => json({success: true, processedOperations: [], operations: [], serverOperations: [], currentVersion: this.version, syncVersion: this.version}));
    this.on('POST', '/projects/:id/import', async (m, body) => {
      const importData = body?.data;
      const timelines = importData?.data?.timelines;
      if (!timelines) return json({error: 'Invalid import data'}, 400);
      const key = Object.keys(timelines)[0];
      const timelineData = timelines[key];
      const name = timelineData?.name || importData?.metadata?.timelineNames?.[key] || importData?.title || 'Imported Timeline';
      const d = await this.update(m[1], (d) => {
        let target = body.timelineId && d.graph.timelinesMetadata.find((t) => t.id === body.timelineId);
        if (!target) {
          target = {id: body.timelineId || newId(), name, order: d.graph.timelinesMetadata.length + 1, isActive: false, createdAt: now(), updatedAt: now()};
          d.graph.timelinesMetadata.push(target);
        }
        target.name = name;
        target.updatedAt = now();
        d.graph.timelines[target.id] = {
          layers: timelineData.layers || {},
          metadata: timelineData.metadata || {},
          variables: timelineData.variables || [],
          lastLayerNumber: timelineData.lastLayerNumber || 0
        };
        return d;
      });
      return json({project: this.projectDto(d)});
    });

    // --- project info (bible) ---
    this.on('GET', '/projects/:id/info', async (m) => {
      const d = await this.doc(m[1]);
      return d.projectInfo ? json({success: true, data: d.projectInfo}) : notFound('Project info');
    });
    const saveInfo: Handler = async (m, body) =>
      json({success: true, data: await this.update(m[1], (d) => (d.projectInfo = {...(d.projectInfo || {id: newId(), projectId: d.id, createdAt: now()}), ...body, updatedAt: now()}))});
    this.on('POST', '/projects/:id/info', saveInfo);
    this.on('PUT', '/projects/:id/info', saveInfo);
    this.on('GET', '/projects/:id/bible-quality', () => notFound('Bible quality'));

    // --- timelines ---
    this.on('GET', '/api/projects/:id/timelines', async (m) => {
      const d = await this.doc(m[1]);
      return json([...d.graph.timelinesMetadata].sort((a, b) => a.order - b.order).map((t) => this.timelineDto(d.id, t)));
    });
    this.on('POST', '/api/projects/:id/timelines', async (m, body) => {
      const t = await this.update(m[1], (d) => {
        const meta: LocalTimelineMeta = {
          id: newId(),
          name: body?.name || 'Untitled Timeline',
          description: body?.description,
          order: body?.order ?? Math.max(0, ...d.graph.timelinesMetadata.map((x) => x.order)) + 1,
          isActive: false,
          createdAt: now(),
          updatedAt: now()
        };
        d.graph.timelinesMetadata.push(meta);
        d.graph.timelines[meta.id] = emptyTimeline();
        return meta;
      });
      return json(this.timelineDto(m[1], t), 201);
    });
    this.on('GET', '/api/timelines/:id', async (m) => {
      const d = await this.docByTimeline(m[1]);
      return json(this.timelineDto(d.id, d.graph.timelinesMetadata.find((t) => t.id === m[1])!));
    });
    this.on('PUT', '/api/timelines/:id', async (m, body) => {
      const d = await this.docByTimeline(m[1]);
      const t = d.graph.timelinesMetadata.find((x) => x.id === m[1])!;
      Object.assign(t, {...body, updatedAt: now()});
      await this.save(d);
      return json(this.timelineDto(d.id, t));
    });
    this.on('DELETE', '/api/timelines/:id', async (m) => {
      const d = await this.docByTimeline(m[1]);
      d.graph.timelinesMetadata = d.graph.timelinesMetadata.filter((t) => t.id !== m[1]);
      delete d.graph.timelines[m[1]];
      d.localization.entries = d.localization.entries.filter((e) => e.timelineId !== m[1]);
      await this.save(d);
      return noContent();
    });
    this.on('POST', '/api/timelines/:id/duplicate', async (m, body) => {
      const d = await this.docByTimeline(m[1]);
      const src = d.graph.timelinesMetadata.find((t) => t.id === m[1])!;
      const meta: LocalTimelineMeta = {...src, id: newId(), name: body?.name || `${src.name} Copy`, isActive: false, order: d.graph.timelinesMetadata.length + 1, createdAt: now(), updatedAt: now()};
      d.graph.timelinesMetadata.push(meta);
      d.graph.timelines[meta.id] = structuredClone(d.graph.timelines[m[1]] || emptyTimeline());
      await this.save(d);
      return json(this.timelineDto(d.id, meta), 201);
    });
    this.on('POST', '/api/timelines/:id/activate', async (m) => {
      const d = await this.docByTimeline(m[1]);
      d.graph.timelinesMetadata.forEach((t) => (t.isActive = t.id === m[1]));
      await this.save(d);
      return noContent();
    });

    // --- entity parameters (registered before /entities/:id) ---
    this.on('GET', '/projects/:id/entities/parameters', async (m, _b, q) => {
      const d = await this.doc(m[1]);
      const vt = q.get('valueType');
      return json({success: true, data: d.entityParameters.filter((p) => !vt || p.valueType === vt).sort((a, b) => a.order - b.order)});
    });
    this.on('GET', '/projects/:id/entities/parameters/:pid', async (m) => {
      const p = (await this.doc(m[1])).entityParameters.find((x) => x.id === m[2]);
      return p ? json({success: true, data: p}) : notFound('Parameter');
    });
    this.on('POST', '/projects/:id/entities/parameters', async (m, body) =>
      json(
        {
          success: true,
          data: await this.update(m[1], (d) => {
            const p = {
              id: newId(),
              projectId: d.id,
              name: body.name,
              valueType: body.valueType,
              options: body.options || [],
              order: body.order ?? d.entityParameters.length,
              createdAt: now(),
              updatedAt: now()
            };
            d.entityParameters.push(p);
            return p;
          })
        },
        201
      )
    );
    this.on('PUT', '/projects/:id/entities/parameters/:pid', async (m, body) =>
      json({
        success: true,
        data: await this.update(m[1], (d) => {
          const p = d.entityParameters.find((x) => x.id === m[2]);
          if (!p) throw new Error('Parameter not found');
          return Object.assign(p, body, {id: p.id, updatedAt: now()});
        })
      })
    );
    this.on('DELETE', '/projects/:id/entities/parameters/:pid', async (m) => {
      await this.update(m[1], (d) => {
        d.entityParameters = d.entityParameters.filter((p) => p.id !== m[2]);
        d.entityTypes.forEach((t) => (t.parameters = (t.parameters || []).filter((l: any) => l.parameterId !== m[2])));
        d.entities.forEach((e) => (e.values = (e.values || []).filter((v: any) => v.parameterId !== m[2])));
      });
      return json({success: true});
    });

    // --- entity types ---
    this.on('GET', '/projects/:id/entity-types', async (m) => {
      const d = await this.doc(m[1]);
      return json({success: true, data: [...d.entityTypes].sort((a, b) => a.order - b.order).map((t) => this.hydrateType(d, t))});
    });
    this.on('GET', '/projects/:id/entity-types/:tid', async (m) => {
      const d = await this.doc(m[1]);
      const t = d.entityTypes.find((x) => x.id === m[2]);
      return t ? json({success: true, data: this.hydrateType(d, t)}) : notFound('Entity type');
    });
    this.on('POST', '/projects/:id/entity-types', async (m, body) => {
      const d = await this.doc(m[1]);
      const t = {
        id: newId(),
        projectId: d.id,
        name: body.name,
        type: body.type,
        description: body.description,
        isDefault: false,
        order: body.order ?? d.entityTypes.length,
        parameters: [],
        createdAt: now(),
        updatedAt: now()
      };
      d.entityTypes.push(t);
      await this.save(d);
      return json({success: true, data: this.hydrateType(d, t)}, 201);
    });
    this.on('PUT', '/projects/:id/entity-types/:tid', async (m, body) => {
      const d = await this.doc(m[1]);
      const t = d.entityTypes.find((x) => x.id === m[2]);
      if (!t) return notFound('Entity type');
      Object.assign(t, {name: body.name ?? t.name, type: body.type ?? t.type, description: body.description ?? t.description, order: body.order ?? t.order, updatedAt: now()});
      await this.save(d);
      return json({success: true, data: this.hydrateType(d, t)});
    });
    this.on('DELETE', '/projects/:id/entity-types/:tid', async (m) => {
      const d = await this.doc(m[1]);
      const count = d.entities.filter((e) => e.entityTypeId === m[2]).length;
      if (count > 0) return json({error: `Cannot delete type: ${count} entities use it`}, 400);
      d.entityTypes = d.entityTypes.filter((t) => t.id !== m[2]);
      await this.save(d);
      return json({success: true});
    });
    this.on('POST', '/projects/:id/entity-types/:tid/parameters', async (m, body) => {
      const d = await this.doc(m[1]);
      const t = d.entityTypes.find((x) => x.id === m[2]);
      if (!t) return notFound('Entity type');
      if ((t.parameters || []).some((l: any) => l.parameterId === body.parameterId)) return json({error: 'Parameter already added'}, 400);
      const link = {id: newId(), parameterId: body.parameterId, required: !!body.required, order: body.order || 0, createdAt: now(), updatedAt: now()};
      t.parameters = [...(t.parameters || []), link];
      await this.save(d);
      return json({success: true, data: {...link, entityTypeId: t.id, parameter: d.entityParameters.find((p) => p.id === link.parameterId)}}, 201);
    });
    this.on('DELETE', '/projects/:id/entity-types/:tid/parameters/:pid', async (m) => {
      await this.update(m[1], (d) => {
        const t = d.entityTypes.find((x) => x.id === m[2]);
        if (t) t.parameters = (t.parameters || []).filter((l: any) => l.parameterId !== m[3]);
      });
      return json({success: true});
    });

    // --- entities ---
    this.on('GET', '/projects/:id/entities', async (m, _b, q) => {
      const d = await this.doc(m[1]);
      await this.warmImages(d.id);
      const typeId = q.get('entityTypeId');
      const search = q.get('search')?.toLowerCase();
      const page = parseInt(q.get('page') || '1', 10);
      const limit = parseInt(q.get('limit') || '20', 10);
      const all = d.entities
        .filter((e) => !typeId || e.entityTypeId === typeId)
        .filter((e) => !search || e.name?.toLowerCase().includes(search) || e.description?.toLowerCase().includes(search))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return json({
        success: true,
        data: all.slice((page - 1) * limit, page * limit).map((e) => this.hydrateEntity(d, e)),
        pagination: {page, limit, total: all.length, pages: Math.ceil(all.length / limit)}
      });
    });
    this.on('GET', '/projects/:id/entities/:eid', async (m) => {
      const d = await this.doc(m[1]);
      await this.warmImages(d.id);
      const e = d.entities.find((x) => x.id === m[2]);
      return e ? json({success: true, data: this.hydrateEntity(d, e)}) : notFound('Entity');
    });
    this.on('POST', '/projects/:id/entities', async (m, body) => {
      const d = await this.doc(m[1]);
      if (!d.entityTypes.some((t) => t.id === body.entityTypeId)) return json({error: 'Entity type not found'}, 400);
      const e: any = {id: newId(), projectId: d.id, name: body.name, entityTypeId: body.entityTypeId, description: body.description, image: body.image, values: [], createdAt: now(), updatedAt: now()};
      if (body.values) this.setValues(e, body.values);
      d.entities.push(e);
      await this.save(d);
      return json({success: true, data: this.hydrateEntity(d, e)}, 201);
    });
    this.on('PUT', '/projects/:id/entities/:eid', async (m, body) => {
      const d = await this.doc(m[1]);
      const e = d.entities.find((x) => x.id === m[2]);
      if (!e) return notFound('Entity');
      for (const k of ['name', 'description', 'entityTypeId', 'image'] as const) if (body[k] !== undefined) e[k] = body[k];
      if (body.values) this.setValues(e, body.values);
      e.updatedAt = now();
      await this.save(d);
      return json({success: true, data: this.hydrateEntity(d, e)});
    });
    this.on('PUT', '/projects/:id/entities/:eid/values', async (m, body) => {
      const d = await this.doc(m[1]);
      const e = d.entities.find((x) => x.id === m[2]);
      if (!e) return notFound('Entity');
      this.setValues(e, body.values || []);
      await this.save(d);
      return json({success: true, data: this.hydrateEntity(d, e)});
    });
    this.on('DELETE', '/projects/:id/entities/:eid', async (m) => {
      await this.update(m[1], (d) => (d.entities = d.entities.filter((e) => e.id !== m[2])));
      for (const key of await store().listImages(m[1])) if (key.startsWith(`${m[2]}__`)) await store().deleteImage(m[1], key);
      return json({success: true});
    });

    // --- templates: none bundled locally ---
    this.on('GET', '/project-templates', () => json({success: true, data: []}));

    // --- images (stored as blobs in the ProjectStore, served as object URLs) ---
    this.on('POST', '/images/upload', async (_m, body) => {
      const blob = await (await fetch(body.imageData)).blob();
      const key = this.imageKey(body.entityId, body.parameterId);
      await store().putImage(body.projectId, key, blob);
      await this.cacheImage(body.projectId, key, blob);
      const part = {gcsPath: key, metadata: {width: 0, height: 0, size: blob.size, mimeType: blob.type, filename: body.filename}, compressionRatio: 1};
      return json({success: true, data: {type: 'image', storage: 'local', original: part, optimized: part, thumbnail: part, uploadedAt: now(), processedAt: now()}});
    });
    this.on('POST', '/images/access-tokens', async (_m, body) => {
      await this.warmImages(body.projectId);
      const expiresAt = new Date(Date.now() + 864e5).toISOString();
      return json({
        success: true,
        data: (body.imageIds || []).map((r: any) => ({...r, signedUrl: this.imageUrl(body.projectId, r.entityId, r.parameterId), expiresAt}))
      });
    });
    this.on('POST', '/images/batch-access', async (_m, body) => {
      await this.warmImages(body.projectId);
      const expiresAt = new Date(Date.now() + 864e5).toISOString();
      const data: any[] = [];
      for (const key of await store().listImages(body.projectId)) {
        const [entityId, parameterId] = key.split('__');
        if (!(body.entityIds || []).includes(entityId)) continue;
        for (const version of body.types || ['thumbnail']) data.push({entityId, parameterId, version, signedUrl: this.imageUrl(body.projectId, entityId, parameterId), expiresAt});
      }
      return json({success: true, data});
    });
    this.on('DELETE', '/images/:team/:pid/:eid/:param', async (m) => {
      const key = this.imageKey(m[3], m[4]);
      await store().deleteImage(m[2], key);
      this.imageUrls.delete(`${m[2]}/${key}`);
      return json({success: true});
    });

    // --- localization (manual only; AI translation routes are not registered) ---
    const L = '/localization/projects/:id';
    this.on('GET', L, async (m) => {
      const cfg = (await this.doc(m[1])).localization.config;
      return cfg ? json({success: true, data: cfg}) : notFound('Project localization');
    });
    this.on('POST', L, async (m, body) =>
      json({
        success: true,
        data: await this.update(m[1], (d) => {
          d.localization.config = {
            id: newId(),
            projectId: d.id,
            autoTranslate: false,
            preserveMarkup: true,
            requireReview: false,
            minContextWords: 50,
            maxBatchSize: 20,
            createdAt: now(),
            ...d.localization.config,
            ...body,
            updatedAt: now()
          };
          return d.localization.config;
        })
      })
    );
    this.on('DELETE', L, async (m) => {
      await this.update(m[1], (d) => (d.localization = {config: null, entries: []}));
      return json({success: true});
    });
    this.on('POST', `${L}/languages`, async (m, body) =>
      json({
        success: true,
        data: await this.update(m[1], (d) => {
          const cfg = d.localization.config;
          if (!cfg) throw new Error('Project localization not found');
          if (!cfg.targetLanguages.includes(body.language)) cfg.targetLanguages = [...cfg.targetLanguages, body.language];
          return cfg;
        })
      })
    );
    this.on('DELETE', `${L}/languages/:lang`, async (m) =>
      json({
        success: true,
        data: await this.update(m[1], (d) => {
          const cfg = d.localization.config;
          if (!cfg) throw new Error('Project localization not found');
          cfg.targetLanguages = cfg.targetLanguages.filter((l: string) => l !== m[2]);
          d.localization.entries = d.localization.entries.filter((e) => e.targetLanguage !== m[2]);
          return cfg;
        })
      })
    );
    this.on('GET', `${L}/timelines/summary`, async (m) => {
      const d = await this.doc(m[1]);
      const cfg = d.localization.config;
      if (!cfg) return json({success: true, data: []});
      return json({
        success: true,
        data: d.graph.timelinesMetadata.map((t) => {
          const languageStats = cfg.targetLanguages.map((language: string) => ({
            language,
            ...this.langStats(d.localization.entries.filter((e) => e.timelineId === t.id && e.targetLanguage === language))
          }));
          const avg = languageStats.reduce((s: number, l: any) => s + l.progress, 0) / Math.max(languageStats.length, 1);
          return {id: t.id, name: t.name, description: t.description, languageStats, overallStatus: avg === 0 ? 'not_started' : avg < 100 ? 'in_progress' : 'completed', lastUpdated: t.updatedAt};
        })
      });
    });
    this.on('GET', `${L}/stats`, async (m) => {
      const d = await this.doc(m[1]);
      const entries = d.localization.entries;
      const statusBreakdown: Record<string, number> = {};
      const methodBreakdown: Record<string, number> = {};
      entries.forEach((e) => {
        statusBreakdown[e.status] = (statusBreakdown[e.status] || 0) + 1;
        if (e.method) methodBreakdown[e.method] = (methodBreakdown[e.method] || 0) + 1;
      });
      const languageBreakdown: Record<string, any> = {};
      for (const lang of d.localization.config?.targetLanguages || []) {
        const {total, translated, approved, progress} = this.langStats(entries.filter((e) => e.targetLanguage === lang));
        languageBreakdown[lang] = {total, translated, approved, progress};
      }
      return json({
        success: true,
        data: {
          totalTexts: entries.length,
          totalWords: entries.reduce((s, e) => s + (e.wordCount || 0), 0),
          totalCharacters: entries.reduce((s, e) => s + (e.characterCount || 0), 0),
          languageBreakdown,
          statusBreakdown,
          methodBreakdown
        }
      });
    });
    this.on('GET', `${L}/timelines/:tid/texts`, async (m, _b, q) => {
      const d = await this.doc(m[1]);
      const lang = q.get('language');
      const rows = d.localization.entries
        .filter((e) => e.timelineId === m[2] && (!lang || e.targetLanguage === lang))
        .sort((a, b) => `${a.layerId}/${a.nodeId}/${a.fieldPath}`.localeCompare(`${b.layerId}/${b.nodeId}/${b.fieldPath}`));
      return json({success: true, data: rows.map((e) => this.entryDto(e))});
    });
    this.on('POST', `${L}/sync`, async (m, _b, q) => json({success: true, data: await this.update(m[1], (d) => this.syncLocalization(d, q.get('timelineId') || undefined))}));
    this.on('POST', `${L}/scan`, async (m, body) => {
      const d = await this.doc(m[1]);
      const ids = body?.timelineId ? [body.timelineId] : Object.keys(d.graph.timelines);
      const extractedTexts = ids.flatMap((tid) => this.scanTexts(d.graph.timelines[tid]));
      return json({success: true, data: {extractedTexts, newTexts: extractedTexts.length, updatedTexts: 0, removedTexts: 0, totalTexts: extractedTexts.length}});
    });
    this.on('POST', `${L}/translations/batch`, async (_m, body) => {
      for (const u of body?.updates || []) {
        await this.updateEntries([u.localizationId], (e) => Object.assign(e, {translatedText: u.translatedText, method: u.method, status: u.reviewedBy ? 'REVIEWED' : 'TRANSLATED'}));
      }
      return json({success: true, data: {updated: (body?.updates || []).length, errors: []}});
    });
    const T = '/localization/translations/:lid';
    this.on('PUT', T, async (m, body) => {
      await this.updateEntries([m[1]], (e) => Object.assign(e, {translatedText: body.translatedText, method: body.method, quality: body.quality, status: body.reviewedBy ? 'REVIEWED' : 'TRANSLATED'}));
      return json({success: true, data: this.entryDto((await this.findEntry(m[1]))[1])});
    });
    const clear = (e: any) => Object.assign(e, {translatedText: null, method: null, quality: null, status: 'PENDING'});
    const approve = (e: any) => (e.status = 'APPROVED');
    const protect = (e: any) => (e.status = 'PROTECTED');
    const unprotect = (e: any) => e.status === 'PROTECTED' && (e.status = 'APPROVED');
    this.on('DELETE', T, async (m) => json({success: true, data: await this.updateEntries([m[1]], clear)}));
    this.on('POST', `${T}/approve`, async (m) => json({success: true, data: await this.updateEntries([m[1]], approve)}));
    this.on('POST', `${T}/protect`, async (m) => json({success: true, data: await this.updateEntries([m[1]], protect)}));
    this.on('DELETE', `${T}/protect`, async (m) => json({success: true, data: await this.updateEntries([m[1]], unprotect)}));
    this.on('POST', '/localization/bulk/approve', async (_m, b) => json({success: true, data: await this.updateEntries(b?.localizationIds || [], approve)}));
    this.on('POST', '/localization/bulk/protect', async (_m, b) => json({success: true, data: await this.updateEntries(b?.localizationIds || [], protect)}));
    this.on('DELETE', '/localization/bulk/protect', async (_m, b) => json({success: true, data: await this.updateEntries(b?.localizationIds || [], unprotect)}));
    this.on('DELETE', '/localization/bulk/delete', async (_m, b) => json({success: true, data: await this.updateEntries(b?.localizationIds || [], clear)}));
  }
}
