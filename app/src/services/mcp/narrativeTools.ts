/**
 * Graph editing on a local-edition project document (`<slug>/project.json`), used by the MCP server
 * (scripts/mcp-server.ts). Pure: callers load/save the JSON; every function mutates `doc` in place.
 * Inputs use variable names (`relationships.affection.mira`, `flags.met_mira`, `my_local`), not ids.
 */
import type {NodeStage} from '@types-folder/nodes';
import type {OperationType, Variable, VariableType} from '@types-folder/variables';

import {prepareDataForHTML} from '../../utils/flattenLayers';
import {DialogueManagerCodeGenerator} from '../exporters/implementations/DialogueManagerCodeGenerator';
import {StoryProcessor} from '../exporters/implementations/StoryProcessor';
import {GameManifest, syncVariablesFromManifest} from '../gameManifest';
import type {LocalProjectDocument} from '../local/projectStore';

export interface OperationInput {
  variable: string;
  op: OperationType;
  /** Literal right side (not used by `invert`) */
  value?: string | number | boolean;
  /** Use another variable as the right side instead of `value` */
  value_variable?: string;
}

/** One condition; a link's conditions are AND-ed (OR with `any`). Exactly one of variable / probability / seen / not_seen. */
export interface ConditionInput {
  variable?: string;
  op?: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';
  value?: string | number | boolean;
  compare_variable?: string;
  probability?: number;
  seen?: string;
  not_seen?: string;
}

export interface NodeInput {
  type: 'narrative' | 'choice';
  text: string;
  /** Narrative only: becomes the cue name (`~ <slug(title)>`) */
  title?: string;
  stage?: NodeStage;
  operations?: OperationInput[];
  /** Link from this existing node to the new one */
  after?: string;
  /** Conditions of the link from `after` */
  conditions?: ConditionInput[];
  /** OR the link conditions instead of AND */
  conditions_any?: boolean;
}

const hex = (bytes: number) => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');

export const newProjectDocument = (name: string, now = new Date().toISOString()): LocalProjectDocument => {
  const timelineId = hex(12);
  return {
    format: 1,
    id: hex(12),
    name,
    createdAt: now,
    updatedAt: now,
    graph: {
      timelines: {
        [timelineId]: {
          layers: {root: {type: 'layer', id: 'root', nodeIds: [], nodes: {}, edges: {}}},
          metadata: {root: {panelState: {}, viewport: {}}},
          variables: [],
          lastLayerNumber: 0
        }
      },
      timelinesMetadata: [{id: timelineId, name: 'Main Timeline', description: 'Default timeline', order: 1, isActive: true, createdAt: now, updatedAt: now}]
    },
    projectInfo: null,
    entityTypes: [],
    entityParameters: [],
    entities: [],
    localization: {config: null, entries: []}
  };
};

/** First timeline by order (projects made by the importer/CLI have exactly one). */
export const mainTimeline = (doc: LocalProjectDocument) => {
  const meta = [...doc.graph.timelinesMetadata].sort((a, b) => a.order - b.order)[0];
  const id = meta?.id ?? Object.keys(doc.graph.timelines)[0];
  const t = doc.graph.timelines[id];
  if (!t) throw new Error('Project has no timeline');
  t.variables ??= [];
  return t;
};

type Timeline = ReturnType<typeof mainTimeline>;

const findNode = (t: Timeline, id: string) => {
  for (const layer of Object.values<any>(t.layers)) if (layer?.nodes?.[id]) return {layer, node: layer.nodes[id]};
  throw new Error(`Unknown node "${id}" (see read_project)`);
};

const resolveVariable = (t: Timeline, ref: string, manifest?: GameManifest): Variable => {
  const find = () => t.variables.find((v: Variable) => v.id === ref || v.internalName === ref || v.name === ref);
  if (!find() && manifest) {
    const gk = manifest.game_keys.find((k) => k.key === ref);
    if (gk) t.variables = syncVariablesFromManifest(t.variables, {...manifest, game_keys: [gk]});
  }
  const v = find();
  if (!v) throw new Error(`Unknown variable "${ref}": create it with set_variable, or use a game key from get_manifest`);
  return v;
};

const toOperations = (t: Timeline, nodeId: string, ops: OperationInput[], manifest?: GameManifest) =>
  ops.map((o, order) => {
    const variableId = resolveVariable(t, o.variable, manifest).id;
    let target: any;
    if (o.op !== 'invert') {
      if (o.value_variable) {
        const id = resolveVariable(t, o.value_variable, manifest).id;
        target = {type: 'variable', value: id, variableId: id};
      } else {
        if (o.value === undefined) throw new Error(`Operation ${o.op} on "${o.variable}" needs value or value_variable`);
        target = {type: 'custom', value: o.value};
      }
    }
    return {id: `op${hex(4)}`, nodeId, variableId, operationType: o.op, ...(target ? {target} : {}), enabled: true, order};
  });

const toConditions = (t: Timeline, conds: ConditionInput[] | undefined, manifest?: GameManifest, any = false) => {
  if (!conds?.length) return [];
  const conditions = conds.map((c) => {
    const id = `c${hex(4)}`;
    if (c.probability !== undefined) {
      if (!(c.probability >= 0 && c.probability <= 1)) throw new Error('probability must be within 0..1');
      return {id, type: 'probability', probability: c.probability};
    }
    const nodeRef = c.seen ?? c.not_seen;
    if (nodeRef) return {id, type: c.seen ? 'node_happened' : 'node_not_happened', nodeId: nodeRef, nodeType: findNode(t, nodeRef).node.type};
    if (!c.variable) throw new Error('A condition needs variable, probability, seen or not_seen');
    const varId = resolveVariable(t, c.variable, manifest).id;
    return c.compare_variable
      ? {id, type: 'variable_comparison', varId, operator: c.op ?? 'eq', valType: 'variable', comparisonVarId: resolveVariable(t, c.compare_variable, manifest).id}
      : {id, type: 'variable_comparison', varId, operator: c.op ?? 'eq', valType: 'custom', value: c.value ?? true};
  });
  return [{id: `g${hex(4)}`, operator: any ? 'OR' : 'AND', conditions}];
};

export const link = (doc: LocalProjectDocument, from: string, to: string, conditions?: ConditionInput[], manifest?: GameManifest, any = false): string => {
  const t = mainTimeline(doc);
  const a = findNode(t, from);
  const b = findNode(t, to);
  if (a.layer !== b.layer) throw new Error('Both nodes must be in the same layer');
  const id = `e${hex(4)}`;
  a.layer.edges ??= {};
  a.layer.edges[id] = {id, type: 'link', startNodeId: from, endNodeId: to, conditions: toConditions(t, conditions, manifest, any)};
  return id;
};

/** Removes the edge `edgeId`, or every edge from → to. Returns the number removed. */
export const unlink = (doc: LocalProjectDocument, ref: {edge?: string; from?: string; to?: string}): number => {
  let n = 0;
  for (const layer of Object.values<any>(mainTimeline(doc).layers))
    for (const e of Object.values<any>(layer?.edges ?? {}))
      if (ref.edge ? e.id === ref.edge : e.startNodeId === ref.from && e.endNodeId === ref.to) {
        delete layer.edges[e.id];
        n++;
      }
  if (!n) throw new Error('No such edge');
  return n;
};

export const addNode = (doc: LocalProjectDocument, input: NodeInput, manifest?: GameManifest): string => {
  const t = mainTimeline(doc);
  const parent = input.after ? findNode(t, input.after) : null;
  const layer = parent?.layer ?? t.layers.root;
  const id = `${input.type === 'choice' ? 'c' : 'n'}${hex(4)}`;
  const all = Object.values<any>(layer.nodes);
  let coordinates = {x: 0, y: all.length ? Math.max(...all.map((n) => n.coordinates?.y ?? 0)) + 240 : 0};
  if (parent) {
    const x = (parent.node.coordinates?.x ?? 0) + 320;
    const column = all.filter((n) => n.coordinates?.x === x).map((n) => n.coordinates.y);
    coordinates = {x, y: column.length ? Math.max(...column) + 240 : (parent.node.coordinates?.y ?? 0)};
  }
  const data = input.type === 'choice' ? {text: input.text} : {title: input.title ?? '', text: input.text, ...(input.stage ? {stage: input.stage} : {})};
  layer.nodes[id] = {id, type: input.type, coordinates, data, operations: []};
  layer.nodeIds.push(id);
  if (input.operations) layer.nodes[id].operations = toOperations(t, id, input.operations, manifest);
  if (input.after) link(doc, input.after, id, input.conditions, manifest, input.conditions_any);
  return id;
};

export const updateNode = (doc: LocalProjectDocument, id: string, patch: {text?: string; title?: string; stage?: NodeStage | null; operations?: OperationInput[]}, manifest?: GameManifest) => {
  const t = mainTimeline(doc);
  const {node} = findNode(t, id);
  if (patch.text !== undefined) node.data.text = patch.text;
  if (node.type === 'narrative') {
    if (patch.title !== undefined) node.data.title = patch.title;
    if (patch.stage === null) delete node.data.stage;
    else if (patch.stage) node.data.stage = patch.stage;
  } else if (patch.title !== undefined || patch.stage) throw new Error(`${node.type} nodes have no title/stage`);
  if (patch.operations) node.operations = toOperations(t, id, patch.operations, manifest);
};

export const deleteNode = (doc: LocalProjectDocument, id: string) => {
  const {layer} = findNode(mainTimeline(doc), id);
  delete layer.nodes[id];
  layer.nodeIds = layer.nodeIds.filter((n: string) => n !== id);
  for (const e of Object.values<any>(layer.edges ?? {})) if (e.startNodeId === id || e.endNodeId === id) delete layer.edges[e.id];
};

/** Creates or updates a story variable (not a game key: those come from the manifest). */
export const setVariable = (doc: LocalProjectDocument, v: {name: string; type: VariableType; value: string | number | boolean; description?: string}) => {
  const t = mainTimeline(doc);
  const existing = t.variables.find((x: Variable) => x.name === v.name || x.internalName === v.name);
  if (existing?.source === 'game') throw new Error(`"${v.name}" is a game key; it is synced from the manifest`);
  if (existing) Object.assign(existing, v);
  else t.variables.push({id: hex(12), internalName: v.name, ...v});
};

export const syncGameVariables = (doc: LocalProjectDocument, manifest: GameManifest) => {
  const t = mainTimeline(doc);
  t.variables = syncVariablesFromManifest(t.variables, manifest);
  return t.variables.length;
};

const fmtValue = (v: unknown) => (typeof v === 'string' ? JSON.stringify(v) : String(v));

/** Human/LLM readable dump of the main timeline: variables, then nodes with cue, stage, ops and outgoing links. */
export const outline = (doc: LocalProjectDocument): string => {
  const t = mainTimeline(doc);
  const varName = new Map<string, string>(t.variables.map((v: Variable) => [v.id, v.internalName || v.name]));
  const vn = (id: string) => varName.get(id) ?? id;
  const {nodes, edges} = prepareDataForHTML(t.layers);
  const story = new StoryProcessor().flattenLayers({title: doc.name, data: {nodes, edges, variables: t.variables}} as any);
  const cues = new DialogueManagerCodeGenerator().cueNames(story);
  const cond = (c: any) =>
    c.type === 'probability'
      ? `chance ${c.probability}`
      : c.type === 'node_happened'
        ? `seen ${c.nodeId}`
        : c.type === 'node_not_happened'
          ? `not seen ${c.nodeId}`
          : `${vn(c.varId)} ${c.operator} ${c.valType === 'variable' ? vn(c.comparisonVarId) : fmtValue(c.value)}`;
  const out = [`# ${doc.name}`, '', '## Variables'];
  for (const v of t.variables as Variable[]) out.push(`- ${v.internalName || v.name}: ${v.type} = ${fmtValue(v.value)}${v.source === 'game' ? ' (game)' : ''}`);
  out.push('', '## Nodes');
  for (const layer of Object.values<any>(t.layers)) {
    if (!layer?.nodes) continue;
    if (layer.id !== 'root') out.push('', `### layer ${layer.id} ${layer.name ?? ''}`.trimEnd());
    for (const id of layer.nodeIds as string[]) {
      const n = layer.nodes[id];
      if (!n) continue;
      const cue = n.type === 'narrative' ? cues.get(id) : undefined;
      out.push('', `[${id}] ${n.type}${n.data?.title ? ` "${n.data.title}"` : ''}${cue ? ` → ~ ${cue}` : ''}`);
      if (n.data?.text)
        out.push(
          ...String(n.data.text)
            .split('\n')
            .map((l) => `  | ${l}`)
        );
      if (n.data?.stage) out.push(`  stage: ${JSON.stringify(n.data.stage)}`);
      for (const o of n.operations ?? [])
        if (o.enabled !== false) out.push(`  op: ${vn(o.variableId)} ${o.operationType}${o.target ? ` ${o.target.type === 'variable' ? vn(o.target.variableId) : fmtValue(o.target.value)}` : ''}`);
      for (const e of Object.values<any>(layer.edges ?? {}))
        if (e.startNodeId === id) {
          const conds = (e.conditions ?? []).map((g: any) => g.conditions.map(cond).join(` ${g.operator} `)).filter(Boolean);
          out.push(`  -> ${e.endNodeId}${conds.length ? ` if ${conds.join(' AND ')}` : ''}  (edge ${e.id})`);
        }
    }
  }
  return out.join('\n');
};
