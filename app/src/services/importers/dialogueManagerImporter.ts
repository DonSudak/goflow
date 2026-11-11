/**
 * `.dialogue` (Dialogue Manager 4.2) -> local edition project document (pure TS; used by scripts/import-dialogue.ts).
 *
 * Mapping is the inverse of DialogueManagerCodeGenerator, so exporter-style files round-trip byte-identically:
 * - `~ cue` -> narrative node titled with the cue; `~ start` that only jumps elsewhere marks the start node
 * - leading `do stage.*()` lines -> node.stage (in exporter order); trailing `do effect/set_flag`, `set vars[...]`
 *   -> operations; a final `do scene("x")` -> stage.scene; all other lines stay node text verbatim
 * - one shared `Name: ` on every dialogue line of a node (a manifest character) -> stage.speaker, prefixes stripped
 * - `- text [if cond /]` -> choice nodes (+ leading ops of the body), `=> cue` -> links, `if/elif/else` -> conditional links;
 *   bodies and fall-through continuations become synthesized nodes `<cue>_<n>`
 * - conditions/ops the exporter cannot reproduce stay verbatim (in node text or in the choice text) with a warning
 */
import {ConditionGroup, ConditionType, Link, NodeStage, StageTransition} from '@types-folder/nodes';
import {OperationTarget, Variable, VariableOperation, VariableType} from '@types-folder/variables';

import {generateInternalName} from '../../utils/transliteration';
import {GAME_MODULES} from '../exporters/implementations/DialogueManagerCodeGenerator';
import {GameManifest, syncVariablesFromManifest} from '../gameManifest';
import type {LocalProjectDocument} from '../local/projectStore';

export interface ImportOptions {
  /** Project name (default: from the exporter header comment, else the slug) */
  name?: string;
  /** Folder slug; seeds all generated ids so re-imports are stable */
  slug: string;
  manifest?: GameManifest;
  /** Keep id/createdAt of an existing project document (re-import) */
  existing?: {id: string; createdAt: string; timelineId?: string};
  /** ISO timestamp for createdAt/updatedAt (default: epoch, deterministic) */
  now?: string;
}

export interface ImportResult {
  doc: LocalProjectDocument;
  warnings: string[];
}

interface SrcLine {
  no: number;
  indent: number;
  text: string;
  children: SrcLine[];
}

interface RawLine {
  no: number;
  text: string;
}

interface Builder {
  id: string;
  cue?: string; // real cue (not synthesized)
  title: string;
  stage: NodeStage;
  stageRank: number;
  raw: RawLine[];
  ops: VariableOperation[];
}

type Literal = {value: string | number | boolean; type: VariableType};
type Read = {variableId: string};

const TAB = '\t';
const STAGE_ORDER = ['clear', 'bg', 'hide', 'move', 'show', 'cg', 'clear_cg'];
const TRANSITIONS = ['cut', 'fade', 'dissolve'];
const OPERATORS: Array<[string, NonNullable<import('@types-folder/nodes').Condition['operator']>]> = [
  ['==', 'eq'],
  ['!=', 'neq'],
  ['>=', 'gte'],
  ['<=', 'lte'],
  ['>', 'gt'],
  ['<', 'lt']
];
const HEADER = /^# (.*) — exported from Go Flow \(Dialogue Manager\)$/;
const HAS_SPEAKER = /^([^:\s[][^:]{0,40}): /;
const NON_DIALOGUE = /^(\s|do!? |set |if |elif |else\b|while |match |when |=>|#|~ |- |%)/;
const STR = '"(?:[^"\\\\]|\\\\.)*"';
const LIT = `(?:${STR}|-?\\d+(?:\\.\\d+)?|true|false)`;

/** FNV-1a, hex. */
const hash = (s: string, len = 8) => {
  let out = '';
  for (let salt = 0; out.length < len; salt++) {
    let h = 0x811c9dc5 ^ salt;
    for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0)!, 0x01000193) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, len);
};

const parseLiteral = (src: string): Literal | null => {
  const t = src.trim();
  if (t === 'true' || t === 'false') return {value: t === 'true', type: 'boolean'};
  if (/^-?\d+$/.test(t)) return {value: Number(t), type: 'integer'};
  if (/^-?\d+\.\d+$/.test(t)) return {value: Number(t), type: 'float'};
  if (new RegExp(`^${STR}$`).test(t)) return {value: JSON.parse(t), type: 'string'};
  return null;
};

/** Splits on a separator at paren depth 0 outside strings. */
const splitTop = (expr: string, sep: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let inStr = false;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0 && expr.startsWith(sep, i)) {
      parts.push(expr.slice(start, i).trim());
      start = i + sep.length;
      i += sep.length - 1;
    }
  }
  parts.push(expr.slice(start).trim());
  return parts;
};

const stripParens = (expr: string): string | null => {
  const t = expr.trim();
  if (!t.startsWith('(') || !t.endsWith(')')) return null;
  return splitTop(t.slice(1, -1), ')').length === 1 ? t.slice(1, -1).trim() : null;
};

/** Parses tab-indented source into a line tree (blank lines dropped). */
const parseTree = (source: string): SrcLine[] => {
  const roots: SrcLine[] = [];
  const stack: SrcLine[] = [];
  source.split(/\r?\n/).forEach((rawLine, i) => {
    if (!rawLine.trim()) return;
    const indent = /^\t*/.exec(rawLine)![0].length;
    const line: SrcLine = {no: i + 1, indent, text: rawLine.slice(indent).trimEnd(), children: []};
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    (stack.length ? stack[stack.length - 1].children : roots).push(line);
    stack.push(line);
  });
  return roots;
};

/** Source lines (with children) as raw text, re-indented relative to `base`. */
const flatten = (line: SrcLine, base: number, out: RawLine[] = []): RawLine[] => {
  out.push({no: line.no, text: TAB.repeat(line.indent - base) + line.text});
  line.children.forEach((c) => flatten(c, base, out));
  return out;
};

export const importDialogue = (source: string, opts: ImportOptions): ImportResult => {
  const warnings: string[] = [];
  const warn = (no: number | number[] | null, message: string) => {
    const at = no === null ? '' : Array.isArray(no) ? `lines ${no.join(', ')}: ` : `line ${no}: `;
    warnings.push(`${at}${message}`);
  };
  const manifest = opts.manifest;
  const seed = opts.slug;

  // ---------- variables ----------
  const variables: Variable[] = [];
  const varById = new Map<string, Variable>();
  const addVar = (v: Variable) => {
    variables.push(v);
    varById.set(v.id, v);
    return v;
  };
  const gameVar = (key: string, lit?: Literal | null): Variable | null => {
    let gk = manifest?.game_keys.find((k) => k.key === key);
    if (manifest && !gk) gk = manifest.game_keys.find((k) => k.read_key === key);
    if (manifest && !gk) return null;
    if (!manifest && !GAME_MODULES.includes(key.split('.')[0])) return null;
    const name = gk?.key ?? key;
    const existing = variables.find((v) => v.source === 'game' && v.name === name);
    if (existing) return existing;
    if (gk) {
      const [synced] = syncVariablesFromManifest([], {...manifest!, game_keys: [gk]});
      return addVar(synced);
    }
    const type = lit?.type === 'integer' ? 'float' : (lit?.type ?? 'float');
    return addVar({
      id: `game_${name}`,
      name,
      internalName: name,
      type,
      value: lit?.type === 'string' ? '' : lit?.type === 'boolean' ? false : 0,
      description: `[game] ${name.split('.')[0]}`,
      source: 'game'
    });
  };
  const flagVar = (key: string): Variable => {
    const name = `flags.${key}`;
    return variables.find((v) => v.name === name) ?? addVar({id: `flag_${key}`, name, type: 'boolean', value: false});
  };
  const localVar = (key: string, init: Literal | null, no: number): Variable => {
    const existing = variables.find((v) => v.source !== 'game' && v.name === key && !key.startsWith('flags.'));
    if (existing) {
      if (init && (init.value !== existing.value || (init.type !== existing.type && !(existing.type === 'float' && init.type === 'integer')))) {
        warn(no, `vars["${key}"] default ${JSON.stringify(init.value)} differs from the first one (${JSON.stringify(existing.value)}); export uses the first`);
      }
      return existing;
    }
    const type = init?.type ?? 'integer';
    return addVar({id: `var_${key}`, name: key, type, value: init?.value ?? (type === 'boolean' ? false : type === 'string' ? '' : 0)});
  };

  // ---------- cues ----------
  const roots = parseTree(source);
  let name = opts.name;
  const cueLines: Array<{cue: string; no: number; body: SrcLine[]}> = [];
  for (const line of roots) {
    if (line.text.startsWith('~ ')) cueLines.push({cue: line.text.slice(2).trim(), no: line.no, body: []});
    else if (cueLines.length) cueLines[cueLines.length - 1].body.push(line);
    else if (HEADER.test(line.text) && !name) name = HEADER.exec(line.text)![1];
    else if (!line.text.startsWith('#')) warn(line.no, `"${line.text}" before the first cue is dropped`);
  }
  name = name || opts.slug;

  const builders: Builder[] = [];
  const order: string[] = []; // node ids in output order (narratives and choices)
  const choices: Array<{id: string; text: string; ops: VariableOperation[]}> = [];
  const edges: Link[] = [];
  const cueIds = new Map<string, string>();
  const takenTitles = new Set(cueLines.map((c) => c.cue));
  const newBuilder = (title: string, cue?: string): Builder => {
    const b: Builder = {id: `n${hash(`${seed}:${title}`, 7)}`, cue, title, stage: {}, stageRank: -1, raw: [], ops: []};
    builders.push(b);
    order.push(b.id);
    return b;
  };
  const synthCount = new Map<string, number>();
  const synth = (parent: Builder): Builder => {
    const root = parent.title.replace(/_\d+$/, '') || 'node';
    let n = synthCount.get(root) ?? 0;
    let title;
    do title = `${root}_${++n}`;
    while (takenTitles.has(title));
    synthCount.set(root, n);
    takenTitles.add(title);
    return newBuilder(title);
  };

  let startId: string | null = null;
  for (const c of cueLines) {
    if (c.cue === 'start' && c.body.length === 1 && /^=> \S+$/.test(c.body[0].text) && c.body[0].children.length === 0) continue; // redirect
    if (cueIds.has(c.cue)) {
      warn(c.no, `duplicate cue "${c.cue}"`);
      continue;
    }
    const slug = generateInternalName(c.cue);
    if (slug !== c.cue || ['end', 'END'].includes(c.cue) || (c.cue === 'start' && cueLines[0] !== c)) {
      warn(c.no, `cue "${c.cue}" will be exported as "${slug}"; jumps from other files to it break`);
    }
    cueIds.set(c.cue, newBuilder(c.cue, c.cue).id);
  }
  const startCue = cueLines.find((c) => c.cue === 'start');
  if (startCue && !cueIds.has('start')) {
    const target = startCue.body[0].text.slice(3).trim();
    startId = cueIds.get(target) ?? null;
  }
  startId = startId ?? builders[0]?.id ?? null;
  // the exporter's start node is the first node without incoming links: keep the intended one first
  if (startId) {
    order.splice(order.indexOf(startId), 1);
    order.unshift(startId);
  }

  let edgeNo = 0;
  const link = (from: string, to: string, conditions: ConditionGroup[] = []) => {
    edges.push({id: `e${String(++edgeNo).padStart(4, '0')}`, type: 'link', startNodeId: from, endNodeId: to, conditions});
  };

  // ---------- conditions ----------
  const parsedSeen = new Set<string>(); // cues referenced by parsed node-happened conditions
  const parseRead = (src: string, lit?: Literal | null): Read | null => {
    let m = new RegExp(`^(?:state|get)\\((${STR})(?:,\\s*(${LIT}))?\\)$`).exec(src.trim());
    if (m) {
      const v = gameVar(JSON.parse(m[1]), m[2] ? parseLiteral(m[2]) : lit);
      return v ? {variableId: v.id} : null;
    }
    m = new RegExp(`^flag\\((${STR})\\)$`).exec(src.trim());
    if (m) return {variableId: flagVar(JSON.parse(m[1])).id};
    m = new RegExp(`^vars\\.get\\((${STR}),\\s*(${LIT})\\)$`).exec(src.trim());
    if (m) return {variableId: localVar(JSON.parse(m[1]), parseLiteral(m[2]), 0).id};
    return null;
  };
  const seenAtom = (src: string): string | null => {
    const m = new RegExp(`^vars\\.get\\("seen\\.([^"]+)",\\s*false\\)$`).exec(src.trim());
    return m && cueIds.has(m[1]) ? m[1] : null;
  };
  let condNo = 0;
  const parseAtom = (src: string): import('@types-folder/nodes').Condition | null => {
    const id = `c${++condNo}`;
    const t = src.trim();
    let m = /^chance\((-?\d+(?:\.\d+)?)\)$/.exec(t);
    if (m) return {id, type: ConditionType.PROBABILITY, probability: Number(m[1])};
    const negated = /^not /.test(t);
    const body = negated ? t.slice(4).trim() : t;
    const seen = seenAtom(body);
    if (seen) {
      parsedSeen.add(seen);
      return {id, type: negated ? ConditionType.NODE_NOT_HAPPENED : ConditionType.NODE_HAPPENED, nodeId: cueIds.get(seen)!, nodeType: 'narrative'};
    }
    for (const [sym, operator] of OPERATORS) {
      const parts = splitTop(t, ` ${sym} `);
      if (parts.length !== 2) continue;
      const rightLit = parseLiteral(parts[1]);
      const left = parseRead(parts[0], rightLit);
      if (!left) return null;
      if (rightLit) return {id, type: ConditionType.VARIABLE_COMPARISON, varId: left.variableId, operator, value: rightLit.value, valType: 'custom'};
      const right = parseRead(parts[1]);
      return right ? {id, type: ConditionType.VARIABLE_COMPARISON, varId: left.variableId, operator, comparisonVarId: right.variableId, valType: 'variable'} : null;
    }
    const read = parseRead(body);
    return read ? {id, type: ConditionType.VARIABLE_COMPARISON, varId: read.variableId, operator: 'eq', value: !negated, valType: 'custom'} : null;
  };
  /** `a and (b or c)` -> groups; null when not expressible as AND-of-groups. */
  const parseCondition = (expr: string): ConditionGroup[] | null => {
    const group = (operator: 'AND' | 'OR', atoms: string[]): ConditionGroup | null => {
      const conditions = atoms.map(parseAtom);
      return conditions.every(Boolean) ? {id: `g${++condNo}`, operator, conditions: conditions as any} : null;
    };
    const ors = splitTop(expr, ' or ');
    if (ors.length > 1) {
      const g = ors.every((p) => !stripParens(p) && splitTop(p, ' and ').length === 1) ? group('OR', ors) : null;
      return g ? [g] : null;
    }
    const groups: ConditionGroup[] = [];
    for (const part of splitTop(expr, ' and ')) {
      const inner = stripParens(part);
      let g: ConditionGroup | null;
      if (inner !== null) {
        const innerOr = splitTop(inner, ' or ');
        const innerAnd = splitTop(inner, ' and ');
        if (innerOr.length > 1 && innerAnd.length > 1) return null;
        g = innerOr.length > 1 ? group('OR', innerOr) : group('AND', innerAnd);
      } else g = group('AND', [part]);
      if (!g) return null;
      groups.push(g);
    }
    return groups;
  };

  // ---------- operations ----------
  let opNo = 0;
  const op = (nodeId: string, variable: Variable, operationType: VariableOperation['operationType'], target?: OperationTarget): VariableOperation => ({
    id: `op${String(++opNo).padStart(4, '0')}`,
    nodeId,
    variableId: variable.id,
    operationType,
    ...(target ? {target} : {}),
    enabled: true,
    order: 0
  });
  const target = (src: string, type?: VariableType): OperationTarget | null => {
    const lit = parseLiteral(src);
    if (lit) return {type: 'custom', value: lit.value};
    const read = parseRead(src, type ? {value: 0, type} : null);
    return read ? {type: 'variable', value: '', variableId: read.variableId} : null;
  };
  /** One op line -> operations (several for a multi-key effect), or null when the exporter could not reproduce it. */
  const parseOp = (text: string, nodeId: string, no: number): VariableOperation[] | null => {
    let m = /^do effect\(\{(.*)\}\)$/.exec(text);
    if (m) {
      const out: VariableOperation[] = [];
      for (const pair of splitTop(m[1], ',')) {
        const kv = new RegExp(`^(${STR}):\\s*(-?\\d+(?:\\.\\d+)?)$`).exec(pair.trim());
        if (!kv) return null;
        const key = JSON.parse(kv[1]);
        const gk = manifest?.game_keys.find((k) => k.key === key);
        if (manifest && (!gk || !gk.writable)) return null;
        const v = gameVar(key);
        if (!v || v.name !== key) return null;
        const amount = Number(kv[2]);
        out.push(op(nodeId, v, amount < 0 ? 'subtract' : 'addition', {type: 'custom', value: Math.abs(amount)}));
      }
      return out;
    }
    m = new RegExp(`^do set_flag\\((${STR}),\\s*(.+)\\)$`).exec(text);
    if (m) {
      const key = JSON.parse(m[1]);
      if (m[2].trim() === `not flag(${m[1]})`) return [op(nodeId, flagVar(key), 'invert')];
      const t = target(m[2], 'boolean');
      return t ? [op(nodeId, flagVar(key), 'override', t)] : null;
    }
    m = new RegExp(`^set vars\\[(${STR})\\] = (.+)$`).exec(text);
    if (m) {
      const key = JSON.parse(m[1]);
      const rhs = m[2].trim();
      const self = new RegExp(`^(not )?vars\\.get\\(${m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')},\\s*(${LIT})\\)(?: ([-+*/]) (.+))?$`).exec(rhs);
      if (self) {
        const v = localVar(key, parseLiteral(self[2]), no);
        if (self[1] && !self[3]) return [op(nodeId, v, 'invert')];
        if (self[1] || !self[3]) return null;
        const t = target(self[4], v.type);
        if (!t) return null;
        const kind = {'+': v.type === 'string' ? 'join' : 'addition', '-': 'subtract', '*': 'multiply', '/': 'divide'}[self[3]] as VariableOperation['operationType'];
        return [op(nodeId, v, kind, t)];
      }
      const lit = parseLiteral(rhs);
      const v = localVar(key, lit ? {value: lit.type === 'string' ? '' : lit.type === 'boolean' ? false : 0, type: lit.type} : null, no);
      if (lit && v.type !== lit.type && !(v.type === 'float' && lit.type === 'integer')) return null;
      const t = target(rhs, v.type);
      return t ? [op(nodeId, v, 'override', t)] : null;
    }
    return null;
  };
  const isOpLine = (text: string) => /^(do effect\(|do set_flag\(|set vars\[)/.test(text);

  // ---------- stage ----------
  const parseArgs = (src: string): string[] | null => {
    if (!src.trim()) return [];
    const parts = splitTop(src, ',');
    return parts.every((p) => new RegExp(`^${STR}$`).test(p)) ? parts.map((p) => JSON.parse(p)) : null;
  };
  const tr = (t?: string) => (t ? {transition: t as StageTransition} : {});
  /** Applies a leading `do stage.x(...)` line to the builder; false when it must stay verbatim. */
  const applyStage = (b: Builder, text: string): boolean => {
    const m = /^do stage\.(\w+)\((.*)\)$/.exec(text);
    const args = m && parseArgs(m[2]);
    if (!m || !args) return false;
    const rank = STAGE_ORDER.indexOf(m[1]);
    const repeatable = ['hide', 'move', 'show'].includes(m[1]);
    if (rank < 0 || rank < b.stageRank || (rank === b.stageRank && !repeatable)) return false;
    // trailing empty args are dropped by the exporter; a transition must be a known one
    if (args.length && args[args.length - 1] === '') return false;
    const s = b.stage;
    switch (m[1]) {
      case 'clear':
        if (args.length) return false;
        s.clear = true;
        break;
      case 'bg':
        if (args.length < 1 || args.length > 2 || (args[1] && !TRANSITIONS.includes(args[1]))) return false;
        s.background = {id: args[0], ...tr(args[1])};
        break;
      case 'hide':
        if (args.length < 1 || args.length > 2 || (args[1] && !TRANSITIONS.includes(args[1]))) return false;
        (s.hide ??= []).push({slot: args[0], ...tr(args[1])});
        break;
      case 'move':
        if (args.length < 2 || args.length > 3 || (args[2] && !TRANSITIONS.includes(args[2]))) return false;
        (s.move ??= []).push({from: args[0], to: args[1], ...tr(args[2])});
        break;
      case 'show': {
        if (args.length < 2 || args.length > 5 || (args[4] && !TRANSITIONS.includes(args[4]))) return false;
        const [slot, character, expression, outfit, transition] = args;
        (s.show ??= []).push({slot, character, ...(expression ? {expression} : {}), ...(outfit ? {outfit} : {}), ...tr(transition)});
        break;
      }
      case 'cg':
        if (args.length < 1 || args.length > 2 || (args[1] && !TRANSITIONS.includes(args[1]))) return false;
        s.cg = {id: args[0], ...tr(args[1])};
        break;
      case 'clear_cg':
        if (args.length || s.cg) return false;
        s.cg = null;
        break;
    }
    b.stageRank = m[1] === 'clear_cg' ? STAGE_ORDER.indexOf('cg') + 1 : rank;
    return true;
  };

  // ---------- control flow ----------
  type Cont = () => string | null;
  const memo = (f: Cont): Cont => {
    let done = false;
    let value: string | null = null;
    return () => {
      if (!done) {
        value = f();
        done = true;
      }
      return value;
    };
  };
  const jumpTarget = (line: SrcLine): string | null | undefined => {
    const m = /^=> (\S+)$/.exec(line.text);
    if (!m || line.children.length) return undefined;
    if (m[1] === 'END') return null;
    return cueIds.get(m[1]);
  };
  /** Target of a line sequence used as a continuation: a lone jump resolves directly, otherwise a new node. */
  const seqTarget = (lines: SrcLine[], parent: Builder, cont: Cont): string | null => {
    if (lines.length === 0) return cont();
    if (lines.length === 1) {
      const t = jumpTarget(lines[0]);
      if (t !== undefined) return t;
    }
    const b = synth(parent);
    compile(lines, b, cont);
    return b.id;
  };
  const branchTarget = (lines: SrcLine[], parent: Builder, cont: Cont): string => {
    const t = lines.length === 1 ? jumpTarget(lines[0]) : undefined;
    if (typeof t === 'string') return t;
    const b = synth(parent);
    if (t !== null) compile(lines, b, cont); // `=> END` -> empty node without links
    return b.id;
  };

  const compile = (lines: SrcLine[], b: Builder, cont: Cont): void => {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const text = line.text;
      const rest = () => lines.slice(i + 1);
      const unreachable = (from: number) => {
        const dead = lines.slice(from).flatMap((l) => flatten(l, l.indent).map((r) => r.no));
        if (dead.length) warn(dead, 'unreachable after a jump; dropped');
      };

      // stage directions lead the node (only the node's own `seen` marker may precede them)
      const leading = b.raw.every((r) => b.cue && r.text === `set vars["seen.${b.cue}"] = true`);
      if (leading && text.startsWith('do stage.') && line.children.length === 0 && applyStage(b, text)) continue;

      if (/^=> /.test(text) && line.children.length === 0) {
        const m = /^=> (\S+)$/.exec(text);
        if (m && (m[1] === 'END' || cueIds.has(m[1]))) {
          if (m[1] !== 'END') link(b.id, cueIds.get(m[1])!);
          unreachable(i + 1);
          return;
        }
        if (m && m[1] === 'END!') {
          warn(line.no, '`=> END!` becomes `=> END`');
          unreachable(i + 1);
          return;
        }
        warn(line.no, `jump "${text}" kept verbatim (unknown cue or jump-and-return)`);
        b.raw.push(...flatten(line, line.indent));
        continue;
      }

      if (text.startsWith('- ')) {
        let j = i;
        while (j + 1 < lines.length && lines[j + 1].text.startsWith('- ')) j++;
        const after = memo(() => seqTarget(lines.slice(j + 1), b, cont));
        for (const r of lines.slice(i, j + 1)) {
          let rText = r.text.slice(2);
          let inlineJump: string | null | undefined;
          const jm = /\s*=> (\S+)\s*$/.exec(rText);
          if (jm && (jm[1] === 'END' || cueIds.has(jm[1]))) {
            inlineJump = jm[1] === 'END' ? null : cueIds.get(jm[1])!;
            rText = rText.slice(0, jm.index);
          }
          let conditions: ConditionGroup[] = [];
          const cm = /\s*\[if (.+?) \/\]/.exec(rText);
          if (cm) {
            const parsed = parseCondition(cm[1]);
            if (parsed) {
              conditions = parsed;
              rText = rText.slice(0, cm.index) + rText.slice(cm.index + cm[0].length);
            } else warn(r.no, `choice condition "${cm[1]}" kept verbatim in the choice text`);
          }
          const choiceId = `c${hash(`${seed}:${b.title}:${r.no}`, 7)}`;
          const choice = {id: choiceId, text: rText.trim(), ops: [] as VariableOperation[]};
          choices.push(choice);
          order.push(choiceId);
          link(b.id, choiceId, conditions);
          let k = 0;
          for (; k < r.children.length && r.children[k].children.length === 0 && isOpLine(r.children[k].text); k++) {
            const ops = parseOp(r.children[k].text, choiceId, r.children[k].no);
            if (!ops) break;
            choice.ops.push(...ops);
          }
          const body = r.children.slice(k);
          if (inlineJump !== undefined) {
            if (body.length) warn(r.no, 'choice has both an inline jump and a body; the body is dropped');
            if (inlineJump) link(choiceId, inlineJump);
            continue;
          }
          const t = body.length ? seqTarget(body, b, after) : after();
          if (t) link(choiceId, t);
        }
        return;
      }

      if (/^if /.test(text)) {
        let j = i;
        while (j + 1 < lines.length && /^(elif |else if |else$)/.test(lines[j + 1].text)) j++;
        const chain = lines.slice(i, j + 1);
        const conds = chain.map((l) => (l.text === 'else' ? [] : parseCondition(l.text.replace(/^(if|elif|else if) /, '').replace(/:$/, ''))));
        if (conds.every(Boolean) && chain.every((l) => l.children.length)) {
          const after = memo(() => seqTarget(lines.slice(j + 1), b, cont));
          chain.forEach((l, n) => {
            if (l.text === 'else') {
              const t = seqTarget(l.children, b, after);
              if (t) link(b.id, t);
            } else link(b.id, branchTarget(l.children, b, after), conds[n]!);
          });
          if (chain[chain.length - 1].text !== 'else') {
            const t = after();
            if (t) link(b.id, t);
          }
          return;
        }
        warn(chain[0].no, 'if-block with conditions the exporter cannot express kept verbatim');
        chain.forEach((l) => b.raw.push(...flatten(l, l.indent)));
        i = j;
        continue;
      }

      b.raw.push(...flatten(line, line.indent));
    }
    const t = cont();
    if (t) link(b.id, t);
  };

  for (const c of cueLines) {
    const id = cueIds.get(c.cue);
    if (!id) continue;
    compile(c.body, builders.find((b) => b.id === id)!, () => null);
  }

  // ---------- finalize nodes (needs all parsed conditions for `seen` lines) ----------
  const byName = new Map((manifest?.characters ?? []).map((ch) => [ch.name, ch.id]));
  const nodes: Record<string, any> = {};
  for (const b of builders) {
    const raw = [...b.raw];
    if (b.cue && raw[0]?.text === `set vars["seen.${b.cue}"] = true` && parsedSeen.has(b.cue)) raw.shift();
    const sm = raw.length ? new RegExp(`^do scene\\((${STR})\\)$`).exec(raw[raw.length - 1].text) : null;
    if (sm) {
      b.stage.scene = JSON.parse(sm[1]);
      raw.pop();
    }
    // trailing operation lines (the exporter writes ops after the text)
    const trailing: VariableOperation[][] = [];
    let k = raw.length;
    while (k > 0 && isOpLine(raw[k - 1].text)) {
      const ops = parseOp(raw[k - 1].text, b.id, raw[k - 1].no);
      if (!ops) break;
      trailing.unshift(ops);
      k--;
    }
    b.ops.push(...trailing.flat());
    let text = raw.slice(0, k).map((r) => r.text);
    // speaker: every dialogue line starts with the same manifest character name
    const dialogue = text.filter((t) => !NON_DIALOGUE.test(t));
    const names = new Set(dialogue.map((t) => HAS_SPEAKER.exec(t)?.[1]));
    const speaker = names.size === 1 && [...names][0] ? byName.get([...names][0]!) : undefined;
    if (
      speaker &&
      dialogue.every((t) => {
        const rest = t.replace(HAS_SPEAKER, '');
        return !HAS_SPEAKER.test(rest) && !NON_DIALOGUE.test(rest);
      })
    ) {
      b.stage.speaker = speaker;
      text = text.map((t) => (NON_DIALOGUE.test(t) ? t : t.replace(HAS_SPEAKER, '')));
    }
    b.ops.forEach((o, n) => (o.order = n));
    const stage = Object.fromEntries(['speaker', 'clear', 'background', 'hide', 'move', 'show', 'cg', 'scene'].filter((key) => key in b.stage).map((key) => [key, (b.stage as any)[key]]));
    nodes[b.id] = {
      id: b.id,
      type: 'narrative',
      coordinates: {x: 0, y: 0},
      data: {title: b.title, text: text.join('\n'), ...(Object.keys(stage).length ? {stage} : {})},
      operations: b.ops
    };
  }
  for (const c of choices) {
    c.ops.forEach((o, n) => (o.order = n));
    nodes[c.id] = {id: c.id, type: 'choice', coordinates: {x: 0, y: 0}, data: {text: c.text}, operations: c.ops};
  }

  // ---------- layout: columns by BFS depth from the start node ----------
  const depth = new Map<string, number>();
  const queue = startId ? [startId] : [];
  if (startId) depth.set(startId, 0);
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of edges.filter((x) => x.startNodeId === id)) {
      if (depth.has(e.endNodeId)) continue;
      depth.set(e.endNodeId, depth.get(id)! + 1);
      queue.push(e.endNodeId);
    }
  }
  const maxDepth = Math.max(0, ...depth.values());
  const rows = new Map<number, number>();
  for (const id of order) {
    const d = depth.get(id) ?? maxDepth + 1;
    const row = rows.get(d) ?? 0;
    rows.set(d, row + 1);
    nodes[id].coordinates = {x: d * 320, y: row * 240};
  }

  // ---------- document ----------
  const now = opts.now ?? new Date(0).toISOString();
  const projectId = opts.existing?.id ?? hash(`${seed}:project`, 24);
  const timelineId = opts.existing?.timelineId ?? hash(`${seed}:timeline`, 24);
  const doc: LocalProjectDocument = {
    format: 1,
    id: projectId,
    name,
    createdAt: opts.existing?.createdAt ?? now,
    updatedAt: now,
    graph: {
      timelines: {
        [timelineId]: {
          layers: {root: {type: 'layer', id: 'root', nodeIds: order, nodes, edges: Object.fromEntries(edges.map((e) => [e.id, e]))}},
          metadata: {root: {panelState: {}, viewport: {}}},
          variables,
          lastLayerNumber: 0
        }
      },
      timelinesMetadata: [{id: timelineId, name: 'Main Timeline', description: 'Default timeline', order: 1, isActive: true, createdAt: opts.existing?.createdAt ?? now, updatedAt: now}]
    },
    projectInfo: null,
    entityTypes: [],
    entityParameters: [],
    entities: [],
    localization: {config: null, entries: []}
  };
  if (startId && edges.some((e) => e.endNodeId === startId)) warn(null, 'the start cue is a jump target; the export may pick another start node');
  return {doc, warnings};
};
