/**
 * A flow exposed as an MCP tool: a test file or suite whose top-level `expose:` block names the tool an agent calls
 * (`tool`), what it does (`description`) and the variables the flow reads as its arguments (`inputs`). The MCP server
 * registers one tool per exposed flow (mcp-server/tools/flow-tools.ts); `testpion flows` and the app list them.
 */
import { extname } from 'node:path';
import type { Node, Pair } from 'yaml';
import { isMap, isPair, isScalar, isSeq, parseDocument, parseYaml } from '../util/lazy-yaml.js';
import { ApsError } from '../errors.js';
import { isSuiteFile } from './suite-file.js';
import { TestFileScanner } from './test-file-scan.js';

/** One argument of the tool: a variable the flow reads as {{name}}. */
export interface FlowInput {
  name: string;
  description?: string;
  /** Used when the agent leaves the argument out. */
  default?: string;
  /** The agent must give it (inputs without a default are required unless `required: false`). */
  required?: boolean;
}

/** The `expose:` block of a test file or suite. */
export interface FlowExposure {
  /** snake_case; the tool's name as the agent sees it. */
  tool: string;
  description?: string;
  inputs?: FlowInput[];
}

/** An exposed flow found under tests/. */
export interface ExposedFlow extends FlowExposure {
  /** Path inside tests/, with forward slashes. */
  file: string;
  kind: 'file' | 'suite';
  inputs: FlowInput[];
  /** Why the block is not usable (an invalid name, a malformed input); the tool is not registered then. */
  problem?: string;
}

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** Validate an `expose:` block; undefined when there is none. Throws ConfigurationError with what is wrong. */
export function parseExpose(raw: unknown, file?: string): FlowExposure | undefined {
  if (raw === undefined || raw === null) return undefined;
  const where = file ? ` in ${file}` : '';
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ApsError('ConfigurationError', `expose: must be a map { tool, description, inputs }${where}`);
  const e = raw as Record<string, unknown>;
  if (typeof e.tool !== 'string' || !e.tool.trim()) throw new ApsError('ConfigurationError', `expose.tool is the tool's name (snake_case, e.g. checkout_flow)${where}`);
  const tool = e.tool.trim();
  if (!TOOL_NAME.test(tool)) throw new ApsError('ConfigurationError', `expose.tool "${tool}" must be snake_case: lowercase letters, digits and _ (e.g. checkout_flow)${where}`);
  if (e.description !== undefined && typeof e.description !== 'string') throw new ApsError('ConfigurationError', `expose.description must be a text${where}`);
  let inputs: FlowInput[] | undefined;
  if (e.inputs !== undefined) {
    if (!Array.isArray(e.inputs)) throw new ApsError('ConfigurationError', `expose.inputs must be a list of { name, description, default, required }${where}`);
    inputs = e.inputs.map((x, i) => {
      const it = (typeof x === 'string' ? { name: x } : x) as Record<string, unknown>;
      if (!it || typeof it !== 'object' || typeof it.name !== 'string' || !VAR_NAME.test(it.name))
        throw new ApsError('ConfigurationError', `expose.inputs[${i}] needs a variable name (the {{name}} the flow reads)${where}`);
      if (it.description !== undefined && typeof it.description !== 'string') throw new ApsError('ConfigurationError', `expose.inputs[${i}].description must be a text${where}`);
      return {
        name: it.name,
        ...(it.description ? { description: it.description } : {}),
        ...(it.default !== undefined && it.default !== null ? { default: String(it.default) } : {}),
        ...(it.required !== undefined ? { required: !!it.required } : {}),
      };
    });
    const seen = new Set<string>();
    for (const i of inputs) {
      if (seen.has(i.name)) throw new ApsError('ConfigurationError', `expose.inputs names "${i.name}" twice${where}`);
      seen.add(i.name);
    }
  }
  return { tool, ...(e.description ? { description: e.description } : {}), ...(inputs ? { inputs } : {}) };
}

/** Whether an input must be given: `required` when set, else only when it has no default. */
export function inputRequired(i: FlowInput): boolean {
  return i.required ?? i.default === undefined;
}

/** The `expose:` block of a test file's text (undefined when there is none; throws when it is invalid). */
export function readExposure(text: string, file?: string): FlowExposure | undefined {
  const data = (file && extname(file).toLowerCase() === '.json' ? JSON.parse(text) : parseYaml(text)) as Record<string, unknown> | null;
  return data && typeof data === 'object' && !Array.isArray(data) ? parseExpose(data.expose, file) : undefined;
}

const MENTIONS = /^\s*"?expose"?\s*:/m;

/** What one file says about being exposed (undefined when it has no `expose:` block). */
function exposedOfText(text: string, file: string, kind: ExposedFlow['kind']): ExposedFlow | undefined {
  // cheap pre-check: only files that mention the key are parsed
  if (!MENTIONS.test(text)) return undefined;
  try {
    const e = readExposure(text, file);
    return e ? { ...e, inputs: e.inputs ?? [], file, kind } : undefined;
  } catch (e) {
    const data = (() => {
      try {
        return parseYaml(text) as Record<string, unknown> | null;
      } catch {
        return null;
      }
    })();
    const tool = data && typeof data.expose === 'object' && data.expose && typeof (data.expose as { tool?: unknown }).tool === 'string' ? String((data.expose as { tool: string }).tool) : '';
    return data && 'expose' in data ? { tool, inputs: [], file, kind, problem: (e as Error).message } : undefined;
  }
}

/** Files are read once and remembered by size and time: the agent tools ask for the list on every request. */
const scanner = new TestFileScanner<ExposedFlow | undefined>((text, file, abs) => exposedOfText(text, file, isSuiteFile(abs) ? 'suite' : 'file'));

/** Every test file and suite under tests/ with an `expose:` block, in path order. Invalid blocks come back with `problem`. Only files that changed since the last call are read again. */
export function exposedFlows(store: { path(...p: string[]): string }): ExposedFlow[] {
  const out: ExposedFlow[] = [];
  for (const { value } of scanner.scan(store.path('tests'))) if (value) out.push({ ...value, inputs: value.inputs.map((i) => ({ ...i })) });
  return out;
}

/**
 * The file's text with its `expose:` block set (or removed when `expose` is undefined), the rest left as it is:
 * comments, key order and line endings stay. The block goes after name and description, before the tests.
 */
export function setExposure(text: string, expose: FlowExposure | undefined): string {
  const crlf = text.includes('\r\n');
  const doc = parseDocument(text.replace(/\r\n/g, '\n'));
  if (doc.errors.length) throw new ApsError('ConfigurationError', `The file does not parse: ${doc.errors[0]!.message.split('\n')[0]}`);
  if (!isMap(doc.contents)) throw new ApsError('ConfigurationError', 'Only a test file or suite written as a map (name, tests …) can be exposed');
  const items = doc.contents.items as Pair[];
  const at = items.findIndex((p) => isScalar(p.key) && p.key.value === 'expose');
  if (at >= 0) {
    items.splice(at, 1);
    // the key that followed the block closes up (no blank line left behind)
    const follower = items[at];
    if (follower && !expose) (follower.key as Node).spaceBefore = false;
  }
  if (expose) {
    const value: Record<string, unknown> = { tool: expose.tool };
    if (expose.description) value.description = expose.description;
    if (expose.inputs?.length)
      value.inputs = expose.inputs.map((i) => ({
        name: i.name,
        ...(i.description ? { description: i.description } : {}),
        ...(i.default !== undefined ? { default: i.default } : {}),
        ...(i.required !== undefined ? { required: i.required } : {}),
      }));
    const node = doc.createNode(value);
    if (isMap(node)) for (const p of node.items) if (isPair(p) && isSeq(p.value)) for (const row of p.value.items) if (isMap(row)) row.flow = true;
    const pair = doc.createPair('expose', node);
    // after name / description, before everything else
    let pos = 0;
    for (let i = 0; i < items.length; i++) {
      const k: unknown = items[i]!.key;
      if (isScalar(k) && ['name', 'description'].includes(String(k.value))) pos = i + 1;
    }
    items.splice(pos, 0, pair);
    (pair.key as Node).spaceBefore = pos > 0;
    const next = items[pos + 1];
    if (next) (next.key as Node).spaceBefore = true;
  }
  const out = doc.toString({ lineWidth: 0 });
  return crlf ? out.replace(/\n/g, '\r\n') : out;
}
