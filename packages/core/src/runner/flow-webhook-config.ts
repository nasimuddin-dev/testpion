/**
 * A flow behind a webhook: a test file's top-level `webhook:` block ({ path, secret }) says that `testpion serve flows`
 * (or the app's "Serve webhooks") runs the flow when something POSTs to that path, with the JSON body as its inputs.
 * This module reads, checks and finds the blocks; the server is flow-webhooks.ts. It has no runner imports, so the
 * loader and the lint can use it.
 */
import { readFileSync, statSync } from 'node:fs';
import { extname, relative, sep } from 'node:path';
import { ApsError } from '../errors.js';
import { slugify } from '../util/ids.js';
import { parseYaml } from '../util/lazy-yaml.js';
import { parseExpose, type FlowInput } from './exposed-flows.js';
import { walkTestFiles } from './suite-file.js';

/** The `webhook:` block of a test file. */
interface FlowWebhook {
  /** Where the flow listens, e.g. /hooks/new-order (default /hooks/<file slug>). */
  path?: string;
  /** Callers must send it (X-TestPion-Secret, or Authorization: Bearer); "{{VAR}}" reads it from the environment or the secrets. */
  secret?: string;
}

/** A flow of the workspace with a webhook. */
export interface WebhookFlow {
  /** The file inside tests/, with forward slashes. */
  file: string;
  /** The path it listens on (the default when the block names none). */
  path: string;
  /** The secret as written (a "{{VAR}}" template or a value); absent when anyone may call it. */
  secret?: string;
  /** The inputs its expose: block declares (the body is checked against them); absent when it declares none. */
  inputs?: FlowInput[];
  /** Why it is not served (a bad block, a path another flow already uses). */
  problem?: string;
}

const PATH_RE = /^\/[A-Za-z0-9._~\-/]{0,199}$/;

/** The path a file's webhook gets when its block names none: /hooks/<file inside tests/ without extension, slugified>. */
export function defaultWebhookPath(file: string): string {
  return `/hooks/${slugify(
    file
      .replace(/\\/g, '/')
      .replace(/^tests\//, '')
      .replace(/\.(ya?ml|json)$/i, ''),
  )}`;
}

/** A webhook path as it is compared: a leading /, no trailing / (except the root), no ./.. segments or //. Throws when it is not one. */
function normalizeWebhookPath(path: string, where = ''): string {
  const p = path.trim();
  if (!PATH_RE.test(p) || p.split('/').some((s) => s === '.' || s === '..') || p.includes('//'))
    throw new ApsError('ConfigurationError', `webhook.path "${path}" must start with / and use only letters, digits and - _ . ~ / (e.g. /hooks/new-order)${where}`);
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/** Validate a `webhook:` block; undefined when there is none. `true` (or {}) takes the default path; a text is the path. */
export function parseWebhook(raw: unknown, file?: string): FlowWebhook | undefined {
  if (raw === undefined || raw === null || raw === false) return undefined;
  const where = file ? ` in ${file}` : '';
  if (raw === true) return {};
  if (typeof raw === 'string') return { path: normalizeWebhookPath(raw, where) };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ApsError('ConfigurationError', `webhook: must be a map { path, secret } (or true for the default path)${where}`);
  const w = raw as Record<string, unknown>;
  const unknown = Object.keys(w).filter((k) => k !== 'path' && k !== 'secret');
  if (unknown.length) throw new ApsError('ConfigurationError', `webhook: takes path and secret, not ${unknown.join(', ')}${where}`);
  if (w.path !== undefined && w.path !== null && typeof w.path !== 'string') throw new ApsError('ConfigurationError', `webhook.path must be a text like /hooks/new-order${where}`);
  if (w.secret !== undefined && w.secret !== null && (typeof w.secret !== 'string' || !w.secret.trim()))
    throw new ApsError('ConfigurationError', `webhook.secret must be a text, best a {{VARIABLE}} kept as a secret${where}`);
  return {
    ...(typeof w.path === 'string' && w.path.trim() ? { path: normalizeWebhookPath(w.path, where) } : {}),
    ...(typeof w.secret === 'string' ? { secret: w.secret.trim() } : {}),
  };
}

/** The path a webhook listens on: its own, or the file's default. */
export function webhookPathOf(file: string, w: FlowWebhook): string {
  return w.path ?? defaultWebhookPath(file);
}

/** The file inside tests/ for a path the lint gets (absolute, tests/…, or already relative). */
export function testsRelative(file: string): string {
  const p = file.replace(/\\/g, '/');
  const i = p.lastIndexOf('/tests/');
  return i >= 0 ? p.slice(i + '/tests/'.length) : p.replace(/^tests\//, '');
}

const MENTIONS = /^\s*"?webhook"?\s*:/m;

/** What a file says, by its size and time: a rescan only parses the files that changed. */
type Cached = { key: string; flow: WebhookFlow | null };
const cache = new Map<string, Cached>();

/** The webhook of one file's text (null when it has none); a bad block comes back with `problem`. */
export function webhookOfText(text: string, file: string): WebhookFlow | null {
  if (!MENTIONS.test(text)) return null;
  let data: unknown;
  try {
    data = extname(file).toLowerCase() === '.json' ? JSON.parse(text) : parseYaml(text);
  } catch (e) {
    return { file, path: defaultWebhookPath(file), problem: `The file does not parse: ${(e as Error).message.split('\n')[0]}` };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !('webhook' in data)) return null;
  const d = data as Record<string, unknown>;
  try {
    const w = parseWebhook(d.webhook, file);
    if (!w) return null;
    let inputs: FlowInput[] | undefined;
    try {
      inputs = parseExpose(d.expose, file)?.inputs;
    } catch {
      inputs = undefined;
    }
    return { file, path: webhookPathOf(file, w), ...(w.secret ? { secret: w.secret } : {}), ...(inputs?.length ? { inputs } : {}) };
  } catch (e) {
    return { file, path: defaultWebhookPath(file), problem: (e as Error).message };
  }
}

/**
 * Every test file under `testsDir` with a `webhook:` block, in path order. A path a file before it already uses comes
 * back with `problem` (the first one wins). Only files that changed since the last call are read again.
 */
export function webhookFlows(testsDir: string): WebhookFlow[] {
  const out: WebhookFlow[] = [];
  const seen = new Map<string, string>();
  for (const abs of walkTestFiles(testsDir, { suites: false })) {
    let key: string;
    try {
      const st = statSync(abs);
      key = `${st.size}:${st.mtimeMs}`;
    } catch {
      continue;
    }
    let hit = cache.get(abs);
    if (!hit || hit.key !== key) {
      let text: string;
      try {
        text = readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      hit = { key, flow: webhookOfText(text, relative(testsDir, abs).split(sep).join('/')) };
      if (cache.size > 5000) cache.clear();
      cache.set(abs, hit);
    }
    if (!hit.flow) continue;
    const f = { ...hit.flow };
    if (!f.problem) {
      const other = seen.get(f.path);
      if (other) f.problem = `The webhook path ${f.path} is already used by tests/${other}`;
      else seen.set(f.path, f.file);
    }
    out.push(f);
  }
  return out;
}
