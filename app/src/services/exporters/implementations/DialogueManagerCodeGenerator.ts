/**
 * Exporter to Godot Dialogue Manager 4.2 `.dialogue` scripts for Useless Tycoon.
 *
 * Mapping (see README_EXPORT.md):
 * - start node -> `~ start` + jump; every narrative node -> own cue (slug of title or `n_<id8>`)
 * - narrative text is emitted verbatim; choices -> `- text [if cond /]` responses
 * - variables `<module>.<key>` (game keys) -> `do effect({...})` / `get("...", initial)`,
 *   `flags.<x>` -> `do set_flag(...)` / `flag(...)`, anything else -> `vars["..."]` (StoryBridge.vars)
 */
import {ChoiceNode, Condition, ConditionGroup, ConditionType, Link, NarrativeNode, Node} from '@types-folder/nodes';
import {OperationTarget, Variable, VariableOperation} from '@types-folder/variables';

import {generateInternalName} from '../../../utils/transliteration';
import {ExportConfig, ExportFormat, ExportableStory, ICodeGenerator, IFormatValidator} from '../interfaces/exportInterfaces';

/** Game state modules readable via `get()` and writable via `effect()`. */
export const GAME_MODULES = ['relationships', 'household', 'uselessness', 'success_threat', 'inventory', 'hero'];

type VarKind = {kind: 'game'; key: string} | {kind: 'flag'; key: string} | {kind: 'local'; key: string};

const TAB = '\t';
const COMPARISON: Record<string, string> = {eq: '==', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<='};
const LOCAL_OPS: Record<string, string> = {addition: '+', join: '+', subtract: '-', multiply: '*', divide: '/'};

export class DialogueManagerCodeGenerator implements ICodeGenerator, IFormatValidator {
  private story: ExportableStory = {} as ExportableStory;
  private nodes = new Map<string, Node>();
  private outgoing = new Map<string, Link[]>();
  private names = new Map<string, string>();
  private seenTargets = new Set<string>();
  private warnings: string[] = [];

  generateCode(story: ExportableStory, config: ExportConfig): string {
    this.prepare(story);
    const lines: string[] = [];
    if (config.includeComments) lines.push(`# ${story.title} — exported from Go Flow (Dialogue Manager)`, '');

    const start = this.nodes.get(story.startNodeId);
    lines.push('~ start');
    if (start?.type === 'narrative') {
      lines.push(`=> ${this.names.get(start.id)}`);
    } else {
      this.warnings.push(`Start node "${story.startNodeId}" is not a narrative node; start jumps to END`);
      lines.push('=> END');
    }

    const narratives = story.nodes.filter((n): n is NarrativeNode => n.type === 'narrative');
    // Start node first, the rest in graph order.
    narratives.sort((a, b) => Number(b.id === story.startNodeId) - Number(a.id === story.startNodeId));
    for (const node of narratives) {
      const cue = this.names.get(node.id)!;
      lines.push('', `~ ${cue}`);
      if (this.seenTargets.has(node.id)) lines.push(`set vars["seen.${cue}"] = true`);
      for (const textLine of (node.data.text || '').split('\n')) {
        if (textLine.trim()) lines.push(textLine.trimEnd());
      }
      this.emitOperations(node, '', lines);
      this.emitTransitions(this.outgoing.get(node.id) || [], '', lines);
    }
    return lines.join('\n') + '\n';
  }

  generateReadme(story: ExportableStory): string {
    return [
      `# ${story.title} — Dialogue Manager export`,
      '',
      'Drop the `.dialogue` file into `content/dialogue/` of the Useless Tycoon project.',
      'Entry cue: `start`. Requires StoryBridge (`get`, `flag`, `set_flag`, `effect`, `vars`) as an extra game state.'
    ].join('\n');
  }

  getFileExtension(): string {
    return '.dialogue';
  }

  getSupportedFormat(): ExportFormat {
    return ExportFormat.DIALOGUE_MANAGER;
  }

  validateForFormat(): string[] {
    return [];
  }

  getFormatWarnings(story: ExportableStory): string[] {
    this.generateCode(story, {format: ExportFormat.DIALOGUE_MANAGER, includeComments: false, minifyOutput: false, generateReadme: false});
    return [...this.warnings];
  }

  /** Warnings collected during the last generateCode() call. */
  getWarnings(): string[] {
    return [...this.warnings];
  }

  // --- graph ---

  private prepare(story: ExportableStory): void {
    this.story = story;
    this.warnings = [];
    this.nodes = new Map(story.nodes.map((n) => [n.id, n]));
    this.outgoing = new Map();
    for (const edge of story.edges) {
      if (!this.outgoing.has(edge.startNodeId)) this.outgoing.set(edge.startNodeId, []);
      this.outgoing.get(edge.startNodeId)!.push(edge);
    }

    this.seenTargets = new Set();
    for (const edge of story.edges) {
      for (const group of edge.conditions || []) {
        for (const c of group.conditions) {
          if ((c.type === ConditionType.NODE_HAPPENED || c.type === ConditionType.NODE_NOT_HAPPENED) && c.nodeId) this.seenTargets.add(c.nodeId);
        }
      }
    }

    // `start` is our entry cue; END/end are Dialogue Manager keywords.
    const used = new Set(['start', 'end', 'END']);
    this.names = new Map();
    for (const node of story.nodes) {
      if (node.type !== 'narrative' && node.type !== 'choice') continue;
      const title = node.type === 'narrative' ? node.data.title : '';
      const slug = title ? generateInternalName(title.trim()) : '';
      const base = /[a-z0-9]/.test(slug) ? slug : `${node.type === 'narrative' ? 'n' : 'c'}_${node.id.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 8)}`;
      let name = base;
      for (let i = 2; used.has(name); i++) name = `${base}_${i}`;
      used.add(name);
      this.names.set(node.id, name);
    }
  }

  private emitTransitions(edges: Link[], indent: string, lines: string[]): void {
    const choiceEdges = edges.filter((e) => this.nodes.get(e.endNodeId)?.type === 'choice');
    if (choiceEdges.length === 0) {
      this.emitLinks(edges, indent, lines);
      return;
    }
    if (choiceEdges.length !== edges.length) {
      this.warnings.push(`Node "${edges[0].startNodeId}" mixes choices and direct links; direct links are ignored`);
    }
    for (const edge of choiceEdges) {
      const choice = this.nodes.get(edge.endNodeId) as ChoiceNode;
      const text = (choice.data.text || '').replace(/\s*\n\s*/g, ' ').trim();
      const cond = this.conditionCode(edge.conditions);
      lines.push(`${indent}- ${text}${cond ? ` [if ${cond} /]` : ''}`);
      const body = indent + TAB;
      if (this.seenTargets.has(choice.id)) lines.push(`${body}set vars["seen.${this.names.get(choice.id)}"] = true`);
      this.emitOperations(choice, body, lines);
      this.emitLinks(this.outgoing.get(choice.id) || [], body, lines);
    }
  }

  /** Direct links: unconditional -> jump, conditional -> if/elif/else. */
  private emitLinks(edges: Link[], indent: string, lines: string[]): void {
    const valid = edges.filter((e) => {
      if (this.nodes.get(e.endNodeId)?.type === 'narrative') return true;
      this.warnings.push(`Link "${e.id}" to non-narrative node "${e.endNodeId}" is not supported; ignored`);
      return false;
    });
    const conditional: Array<[string, Link]> = [];
    const plain: Link[] = [];
    for (const e of valid) {
      const cond = this.conditionCode(e.conditions);
      if (cond) conditional.push([cond, e]);
      else plain.push(e);
    }
    if (plain.length > 1) this.warnings.push(`Node "${plain[0].startNodeId}" has several unconditional links; only the first is used`);
    const fallback = plain[0] ? `=> ${this.names.get(plain[0].endNodeId)}` : '=> END';

    if (conditional.length === 0) {
      lines.push(`${indent}${fallback}`);
      return;
    }
    conditional.forEach(([cond, e], i) => {
      lines.push(`${indent}${i === 0 ? 'if' : 'elif'} ${cond}`, `${indent}${TAB}=> ${this.names.get(e.endNodeId)}`);
    });
    lines.push(`${indent}else`, `${indent}${TAB}${fallback}`);
  }

  // --- variables ---

  private classify(variable: Variable): VarKind {
    for (const name of [variable.internalName, variable.name]) {
      if (!name) continue;
      const flag = /^flags\.(.+)$/.exec(name);
      if (flag) return {kind: 'flag', key: flag[1]};
      const module = name.split('.')[0];
      if (name.includes('.') && GAME_MODULES.includes(module)) return {kind: 'game', key: name};
    }
    return {kind: 'local', key: variable.internalName || variable.name};
  }

  private read(variable: Variable): string {
    const v = this.classify(variable);
    // Unpublished game keys read as null, so always pass the initial value as default.
    if (v.kind === 'game') return `get(${JSON.stringify(v.key)}, ${this.literal(variable.value, variable.type)})`;
    if (v.kind === 'flag') return `flag(${JSON.stringify(v.key)})`;
    return `vars.get(${JSON.stringify(v.key)}, ${this.literal(variable.value, variable.type)})`;
  }

  private literal(value: unknown, type: string): string {
    if (type === 'boolean') return value === true || value === 'true' ? 'true' : 'false';
    if (type === 'string') return JSON.stringify(String(value ?? ''));
    const num = Number(value);
    if (value === '' || value === null || value === undefined || Number.isNaN(num)) return type === 'float' || type === 'percent' ? '0.0' : '0';
    return type === 'float' || type === 'percent' ? this.float(num) : String(num);
  }

  private float(n: number): string {
    return Number.isInteger(n) ? n.toFixed(1) : String(n);
  }

  private targetExpr(target: OperationTarget | undefined, type: string): string | null {
    if (!target) return null;
    if (target.type === 'variable') {
      const v = this.story.variables.find((x) => x.id === target.variableId);
      return v ? this.read(v) : null;
    }
    return this.literal(target.value, type);
  }

  private emitOperations(node: NarrativeNode | ChoiceNode, indent: string, lines: string[]): void {
    const ops = (node.operations || []).filter((op) => op.enabled).sort((a, b) => a.order - b.order);
    for (const op of ops) {
      const code = this.operationCode(op);
      if (code) lines.push(`${indent}${code}`);
    }
  }

  private operationCode(op: VariableOperation): string | null {
    const variable = this.story.variables.find((v) => v.id === op.variableId);
    if (!variable) {
      this.warnings.push(`Operation "${op.id}" references unknown variable "${op.variableId}"`);
      return null;
    }
    const v = this.classify(variable);

    if (v.kind === 'game') {
      const amount = op.target?.type === 'custom' ? Number(op.target.value) : NaN;
      if ((op.operationType === 'addition' || op.operationType === 'subtract') && !Number.isNaN(amount)) {
        const signed = op.operationType === 'subtract' ? -amount : amount;
        return `do effect({${JSON.stringify(v.key)}: ${this.float(signed)}})`;
      }
      this.warnings.push(`Unsupported operation "${op.operationType}" on game key "${v.key}" (only addition/subtract of a number); skipped`);
      return null;
    }

    if (v.kind === 'flag') {
      const key = JSON.stringify(v.key);
      if (op.operationType === 'invert') return `do set_flag(${key}, not flag(${key}))`;
      const value = op.operationType === 'override' ? this.targetExpr(op.target, 'boolean') : null;
      if (value) return `do set_flag(${key}, ${value})`;
      this.warnings.push(`Unsupported operation "${op.operationType}" on flag "${v.key}"; skipped`);
      return null;
    }

    const ref = `vars[${JSON.stringify(v.key)}]`;
    if (op.operationType === 'invert') return `set ${ref} = not ${this.read(variable)}`;
    const value = this.targetExpr(op.target, variable.type);
    if (value === null) {
      this.warnings.push(`Operation "${op.id}" on "${v.key}" has no target; skipped`);
      return null;
    }
    if (op.operationType === 'override') return `set ${ref} = ${value}`;
    return `set ${ref} = ${this.read(variable)} ${LOCAL_OPS[op.operationType]} ${value}`;
  }

  // --- conditions ---

  private conditionCode(groups?: ConditionGroup[]): string {
    const codes = (groups || []).map((g) => this.groupCode(g)).filter(Boolean);
    return codes.join(' and ');
  }

  private groupCode(group: ConditionGroup): string {
    const codes = group.conditions.map((c) => this.singleCondition(c)).filter(Boolean);
    if (codes.length <= 1) return codes[0] || '';
    return `(${codes.join(` ${group.operator === 'OR' ? 'or' : 'and'} `)})`;
  }

  private singleCondition(c: Condition): string {
    switch (c.type) {
      case ConditionType.PROBABILITY:
        // Dialogue Manager cannot call randf(); StoryBridge.chance(p) rolls 0..1.
        return `chance(${c.probability ?? 0})`;
      case ConditionType.NODE_HAPPENED:
      case ConditionType.NODE_NOT_HAPPENED: {
        const name = c.nodeId && this.names.get(c.nodeId);
        if (!name) return '';
        const seen = `vars.get("seen.${name}", false)`;
        return c.type === ConditionType.NODE_HAPPENED ? seen : `not ${seen}`;
      }
      case ConditionType.VARIABLE_COMPARISON: {
        const left = this.story.variables.find((v) => v.id === c.varId);
        const op = COMPARISON[c.operator || ''];
        if (!left || !op) return '';
        let right = '';
        if (c.valType === 'variable') {
          const rv = this.story.variables.find((v) => v.id === c.comparisonVarId);
          right = rv ? this.read(rv) : '';
        } else if (c.value !== undefined) {
          right = this.literal(c.value, left.type);
        }
        return right ? `${this.read(left)} ${op} ${right}` : '';
      }
      default:
        return '';
    }
  }
}
