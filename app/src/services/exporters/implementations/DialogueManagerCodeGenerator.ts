/**
 * Exporter to Godot Dialogue Manager 4.2 `.dialogue` scripts for Useless Tycoon.
 *
 * Mapping (see README_EXPORT.md):
 * - start node -> `~ start` + jump; every narrative node -> own cue (slug of title or `n_<id8>`)
 * - node stage (clear/bg/hide/move/show/cg) -> `do stage.*(...)` at cue start, `stage.scene` -> `do scene()`
 * - narrative text is emitted verbatim (speaker prefix if `stage.speaker`); choices -> `- text [if cond /]`
 * - variables `<module>.<key>` (game keys) -> `do effect({...})` / `state("...", initial)`,
 *   `flags.<x>` -> `do set_flag(...)` / `flag(...)`, anything else -> `vars["..."]` (StoryBridge.vars)
 */
import {ChoiceNode, Condition, ConditionGroup, ConditionType, Link, NarrativeNode, Node, NodeStage} from '@types-folder/nodes';
import {OperationTarget, Variable, VariableOperation} from '@types-folder/variables';

import {generateInternalName} from '../../../utils/transliteration';
import {GameManifest, ManifestGameKey, mapManifestType} from '../../gameManifest';
import {ExportConfig, ExportFormat, ExportableStory, ICodeGenerator, IFormatValidator} from '../interfaces/exportInterfaces';

/** Game state modules readable via `state()` and writable via `effect()`. */
export const GAME_MODULES = ['relationships', 'household', 'uselessness', 'success_threat', 'inventory', 'hero'];

type VarKind = {kind: 'game'; key: string; manifest?: ManifestGameKey} | {kind: 'flag'; key: string} | {kind: 'local'; key: string};

const TAB = '\t';
const COMPARISON: Record<string, string> = {eq: '==', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<='};
const LOCAL_OPS: Record<string, string> = {addition: '+', join: '+', subtract: '-', multiply: '*', divide: '/'};
/** Lines that are Dialogue Manager syntax, not dialogue: never get a speaker prefix or a line ID. */
export const NON_DIALOGUE = /^(\s|do!? |set |if |elif |else\b|while |match |when |=>|#|~ |- |%)/;
/** Explicit `Name: text` line. */
export const HAS_SPEAKER = /^[^:\s[][^:]{0,40}: /;
const STATIC_ID = /\[ID:([^\]]*)\]/;

/** Non-empty lines of a node text that Dialogue Manager shows as dialogue (translatable). */
export const dialogueLines = (text: string): string[] =>
  (text || '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && !NON_DIALOGUE.test(l));

/** A translatable line as emitted: static ID key and the text Dialogue Manager will translate (no `Name: `, no ID). */
export interface LocalizableLine {
  key: string;
  nodeId: string;
  /** index among dialogueLines(node text); 0 for a choice */
  index: number;
  kind: 'line' | 'choice';
  text: string;
}

export class DialogueManagerCodeGenerator implements ICodeGenerator, IFormatValidator {
  private story: ExportableStory = {} as ExportableStory;
  private nodes = new Map<string, Node>();
  private outgoing = new Map<string, Link[]>();
  private names = new Map<string, string>();
  private seenTargets = new Set<string>();
  private warnings: string[] = [];
  private manifest?: GameManifest;
  private entities: Array<{id: string; name: string}> = [];
  private lineIds = false;
  private idPrefixes = new Map<string, string>();
  private localizable: LocalizableLine[] = [];

  generateCode(story: ExportableStory, config: ExportConfig): string {
    this.manifest = config.manifest;
    this.entities = config.entities || [];
    this.lineIds = !!config.lineIds;
    this.localizable = [];
    this.prepare(story);
    const lines: string[] = [];
    if (config.includeComments) lines.push(`# ${story.title} — exported from Go Flow (Dialogue Manager)`, '');

    const start = this.nodes.get(story.startNodeId);
    if (start?.type === 'narrative') {
      // A start node titled "start" is the entry cue itself; otherwise `~ start` redirects to it.
      if (this.names.get(start.id) !== 'start') lines.push('~ start', `=> ${this.names.get(start.id)}`);
    } else {
      lines.push('~ start');
      this.warn(`Start node "${story.startNodeId}" is not a narrative node; start jumps to END`);
      lines.push('=> END');
    }

    const narratives = story.nodes.filter((n): n is NarrativeNode => n.type === 'narrative');
    // Start node first, the rest in graph order.
    narratives.sort((a, b) => Number(b.id === story.startNodeId) - Number(a.id === story.startNodeId));
    narratives.forEach((node) => {
      const cue = this.names.get(node.id)!;
      if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
      lines.push(`~ ${cue}`);
      if (this.seenTargets.has(node.id)) lines.push(`set vars["seen.${cue}"] = true`);
      const stage = node.data.stage;
      if (stage) this.emitStage(stage, node.id, lines);
      const speaker = stage?.speaker ? this.speakerName(stage.speaker, node.id) : '';
      let index = 0;
      for (const textLine of (node.data.text || '').split('\n')) {
        if (!textLine.trim()) continue;
        const line = textLine.trimEnd();
        if (NON_DIALOGUE.test(line)) {
          lines.push(line);
          continue;
        }
        const prefixed = speaker && !HAS_SPEAKER.test(line) ? `${speaker}: ${line}` : line;
        lines.push(this.withLineId(prefixed, node.id, index++, 'line', line.replace(HAS_SPEAKER, '')));
      }
      this.emitOperations(node, '', lines);
      if (stage?.scene) {
        this.check(
          this.manifest?.scenes.map((x) => x.id),
          stage.scene,
          'scene',
          node.id
        );
        lines.push(`do scene(${JSON.stringify(stage.scene)})`);
      }
      this.emitTransitions(this.outgoing.get(node.id) || [], '', lines);
    });
    return lines.join('\n') + '\n';
  }

  /** Translatable lines of the last generateCode() call (with `lineIds`), in file order. */
  getLocalizableLines(): LocalizableLine[] {
    return [...this.localizable];
  }

  /** Appends ` [ID:<node8>_<n>]` (n from 1) when line IDs are on; an existing `[ID:…]` is kept as the key. */
  private withLineId(line: string, nodeId: string, index: number, kind: LocalizableLine['kind'], text: string): string {
    if (!this.lineIds) return line;
    const existing = STATIC_ID.exec(line);
    const key = existing ? existing[1] : `${this.idPrefixes.get(nodeId)}_${index + 1}`;
    this.localizable.push({key, nodeId, index, kind, text: text.replace(STATIC_ID, '').trim()});
    return existing ? line : `${line} [ID:${key}]`;
  }

  generateReadme(story: ExportableStory): string {
    return [
      `# ${story.title} — Dialogue Manager export`,
      '',
      'Drop the `.dialogue` file into `content/dialogue/` of the Useless Tycoon project.',
      'Entry cue: `start`. Requires StoryBridge (`state`, `flag`, `set_flag`, `effect`, `chance`, `scene`, `vars`, `stage`) as an extra game state.'
    ].join('\n');
  }

  /** Node id -> cue name exactly as generateCode() emits it (used by "Play in Godot" to jump to a node). */
  cueNames(story: ExportableStory): Map<string, string> {
    this.prepare(story);
    return new Map(this.names);
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

  private warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  // --- stage ---

  /** Order: clear -> background -> hide -> move -> show -> cg (StageController API on the game side). */
  private emitStage(stage: NodeStage, nodeId: string, lines: string[]): void {
    const m = this.manifest;
    const call = (fn: string, ...args: Array<string | undefined>) => {
      // Trailing unset args fall back to the GDScript defaults; inner ones become "".
      while (args.length && !args[args.length - 1]) args.pop();
      lines.push(`do stage.${fn}(${args.map((a) => JSON.stringify(a ?? '')).join(', ')})`);
    };
    if (stage.clear) call('clear');
    if (stage.background) {
      this.check(m?.backgrounds, stage.background.id, 'background', nodeId);
      call('bg', stage.background.id, stage.background.transition);
    }
    for (const h of stage.hide || []) {
      this.check(m?.slots, h.slot, 'slot', nodeId);
      call('hide', h.slot, h.transition);
    }
    for (const mv of stage.move || []) {
      this.check(m?.slots, mv.from, 'slot', nodeId);
      this.check(m?.slots, mv.to, 'slot', nodeId);
      call('move', mv.from, mv.to, mv.transition);
    }
    for (const sh of stage.show || []) {
      this.check(m?.slots, sh.slot, 'slot', nodeId);
      this.check(
        m?.characters.map((c) => c.id),
        sh.character,
        'character',
        nodeId
      );
      const character = m?.characters.find((c) => c.id === sh.character);
      if (character && sh.expression) this.check(character.expressions, sh.expression, `expression of "${sh.character}"`, nodeId);
      if (character && sh.outfit) this.check(character.outfits, sh.outfit, `outfit of "${sh.character}"`, nodeId);
      call('show', sh.slot, sh.character, sh.expression, sh.outfit, sh.transition);
    }
    if (stage.cg === null) call('clear_cg');
    else if (stage.cg) {
      this.check(m?.cgs, stage.cg.id, 'cg', nodeId);
      call('cg', stage.cg.id, stage.cg.transition);
    }
  }

  private speakerName(id: string, nodeId: string): string {
    this.check(
      this.manifest?.characters.map((c) => c.id),
      id,
      'speaker',
      nodeId
    );
    return this.manifest?.characters.find((c) => c.id === id)?.name || this.entities.find((e) => e.id === id)?.name || id;
  }

  /** Warns about an id missing from a manifest list; no manifest = no validation. */
  private check(known: string[] | undefined, id: string, what: string, nodeId: string): void {
    if (known && !known.includes(id)) this.warn(`Unknown ${what} "${id}" in node "${nodeId}" (not in game manifest)`);
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

    // `start` is our entry cue (the start node may own it); END/end are Dialogue Manager keywords.
    const used = new Set(['start', 'end', 'END']);
    this.names = new Map();
    const slugOf = (node: Node) => (node.type === 'narrative' && node.data.title ? generateInternalName(node.data.title.trim()) : '');
    const start = this.nodes.get(story.startNodeId);
    if (start?.type === 'narrative' && slugOf(start) === 'start') this.names.set(start.id, 'start');
    this.idPrefixes = new Map();
    const usedPrefixes = new Set<string>();
    for (const node of story.nodes) {
      if (node.type !== 'narrative' && node.type !== 'choice') continue;
      const clean = node.id.replace(/[^a-zA-Z0-9]/g, '');
      let prefix = usedPrefixes.has(clean.slice(0, 8)) ? clean : clean.slice(0, 8);
      for (let i = 2; usedPrefixes.has(prefix); i++) prefix = `${clean}${i}`;
      usedPrefixes.add(prefix);
      this.idPrefixes.set(node.id, prefix);
      if (this.names.has(node.id)) continue;
      const slug = slugOf(node);
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
      this.warn(`Node "${edges[0].startNodeId}" mixes choices and direct links; direct links are ignored`);
    }
    for (const edge of choiceEdges) {
      const choice = this.nodes.get(edge.endNodeId) as ChoiceNode;
      const text = (choice.data.text || '').replace(/\s*\n\s*/g, ' ').trim();
      const cond = this.conditionCode(edge.conditions);
      lines.push(this.withLineId(`${indent}- ${text}${cond ? ` [if ${cond} /]` : ''}`, choice.id, 0, 'choice', text));
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
      this.warn(`Link "${e.id}" to non-narrative node "${e.endNodeId}" is not supported; ignored`);
      return false;
    });
    const conditional: Array<[string, Link]> = [];
    const plain: Link[] = [];
    for (const e of valid) {
      const cond = this.conditionCode(e.conditions);
      if (cond) conditional.push([cond, e]);
      else plain.push(e);
    }
    if (plain.length > 1) this.warn(`Node "${plain[0].startNodeId}" has several unconditional links; only the first is used`);
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
    const m = this.manifest;
    for (const name of [variable.internalName, variable.name]) {
      if (!name) continue;
      const flag = /^flags\.(.+)$/.exec(name);
      if (flag) {
        if (m && !m.flags.includes(flag[1])) this.warn(`Unknown flag "${flag[1]}" (not in game manifest)`);
        return {kind: 'flag', key: flag[1]};
      }
      if (m) {
        const gk = m.game_keys.find((k) => k.key === name);
        if (gk) return {kind: 'game', key: name, manifest: gk};
      } else if (name.includes('.') && GAME_MODULES.includes(name.split('.')[0])) {
        return {kind: 'game', key: name};
      }
    }
    const key = variable.internalName || variable.name;
    if (m && GAME_MODULES.includes(key.split('.')[0])) this.warn(`Variable "${key}" looks like a game key but is not in the game manifest; exported as story-local`);
    return {kind: 'local', key};
  }

  private read(variable: Variable): string {
    const v = this.classify(variable);
    // Unpublished game keys read as null, so always pass the initial value as default.
    if (v.kind === 'game') {
      const initial = v.manifest ? this.literal(v.manifest.initial, mapManifestType(v.manifest.type, v.manifest.initial)) : this.literal(variable.value, variable.type);
      return `state(${JSON.stringify(v.manifest?.read_key ?? v.key)}, ${initial})`;
    }
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
      this.warn(`Operation "${op.id}" references unknown variable "${op.variableId}"`);
      return null;
    }
    const v = this.classify(variable);

    if (v.kind === 'game') {
      if (v.manifest && !v.manifest.writable) {
        this.warn(`Game key "${v.key}" is read-only (writable=false in manifest); operation skipped`);
        return null;
      }
      const amount = op.target?.type === 'custom' ? Number(op.target.value) : NaN;
      if ((op.operationType === 'addition' || op.operationType === 'subtract') && !Number.isNaN(amount)) {
        const signed = op.operationType === 'subtract' ? -amount : amount;
        return `do effect({${JSON.stringify(v.key)}: ${this.float(signed)}})`;
      }
      this.warn(`Unsupported operation "${op.operationType}" on game key "${v.key}" (only addition/subtract of a number); skipped`);
      return null;
    }

    if (v.kind === 'flag') {
      const key = JSON.stringify(v.key);
      if (op.operationType === 'invert') return `do set_flag(${key}, not flag(${key}))`;
      const value = op.operationType === 'override' ? this.targetExpr(op.target, 'boolean') : null;
      if (value) return `do set_flag(${key}, ${value})`;
      this.warn(`Unsupported operation "${op.operationType}" on flag "${v.key}"; skipped`);
      return null;
    }

    const ref = `vars[${JSON.stringify(v.key)}]`;
    if (op.operationType === 'invert') return `set ${ref} = not ${this.read(variable)}`;
    const value = this.targetExpr(op.target, variable.type);
    if (value === null) {
      this.warn(`Operation "${op.id}" on "${v.key}" has no target; skipped`);
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
        return `chance(${this.float(c.probability ?? 0)})`;
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
