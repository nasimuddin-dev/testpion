/**
 * AI-10b · Fix what an import left: the scripts of an imported collection that carry `// TODO(import)` lines (a call the
 * converter found no equivalent for: `pm.datasets`, `bru.getAuthMode`, `insomnia.parentFolders` …). TestPion finds them
 * itself (the same marker the converter writes); the model only rewrites each script with TestPion's `tp.*` API, in a
 * reviewable proposal (one item per script, a diff, the person accepts or not). Nothing it writes is trusted: every
 * script is checked statically (no pm.* / bru.* / members that do not exist), run once in the sandbox against the request's
 * saved example response (else a stand-in), and refused when it throws. Never run against the real API.
 *
 * Works from the CLI (`testpion ai run import-leftovers --item collection:<id>`), MCP (`ai_run_task`) and the Import dialog's
 * "Fix with AI" after an import, with the mock provider or a real one; without a provider the markers stay and the report
 * lists them.
 */
import { ApsError } from '../errors.js';
import type { ItemRef } from '@testpion/shared';
import type { Collection, CollectionNode, SavedExample } from '../model/types.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import type { AiTaskInput, DraftItem, PreparedItem } from './tasks/registry.js';
import { stringList } from '../util/collections.js';
import { dryRunScript, type SampleRequest } from './write-script.js';
import type { VerificationBadge } from './proposal.js';
import { registerVerifier, type StoredResponse } from './verify.js';

const LEFTOVER_MARK = /TODO\(import\)/;
const MAX_SCRIPTS = 12;
const MAX_SCRIPT = 3000;

export const LEFTOVERS_PLAN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['scripts'],
  properties: {
    summary: { type: 'string', description: 'One or two sentences: what was rewritten' },
    scripts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'script'],
        properties: {
          id: { type: 'string', description: 'The id of a leftover from the context (never invent one)' },
          script: { type: 'string', description: 'The whole script, tp.* only, plain JavaScript, no network, no imports; no TODO(import) left' },
          explanation: { type: 'string', description: 'What the marked lines do now, in one sentence' },
        },
      },
    },
    assumptions: { type: 'array', items: { type: 'string' } },
  },
};

type Phase = 'pre' | 'test';

/** What `prepare` keeps (on this computer) to build the items and verify them. */
interface LeftoversLocal {
  collectionId: string;
  items: Record<string, { requestId: string; name: string; phase: Phase; current: string; request: SampleRequest; example?: StoredResponse }>;
}

const sample = (n: Extract<CollectionNode, { kind: 'http' | 'graphql' }>): SampleRequest =>
  n.kind === 'http'
    ? { method: n.request.method, url: n.request.url, headers: (n.request.headers ?? []).filter((h) => h.enabled !== false).map((h) => ({ key: h.key, value: h.value })), ...(n.request.body && 'content' in n.request.body ? { body: n.request.body.content } : {}) }
    : { method: 'POST', url: n.request.endpoint, headers: (n.request.headers ?? []).map((h) => ({ key: h.key, value: h.value })) };

const exampleOf = (e: SavedExample | undefined): StoredResponse | undefined => (e ? { status: e.status, headers: e.headers.map((h): [string, string] => [h.key, h.value]), body: e.body } : undefined);

/** Every script of the collection (or a folder of it) with a `TODO(import)` marker, with the request it belongs to. */
export function findLeftovers(c: Collection, folderId?: string): Array<{ node: Extract<CollectionNode, { kind: 'http' | 'graphql' }>; path: string[]; phase: Phase; script: string }> {
  const out: Array<{ node: Extract<CollectionNode, { kind: 'http' | 'graphql' }>; path: string[]; phase: Phase; script: string }> = [];
  const walk = (nodes: CollectionNode[], path: string[], on: boolean) => {
    for (const n of nodes) {
      if (n.kind === 'folder') walk(n.items, [...path, n.name], on || n.id === folderId);
      else if (on) {
        if (n.preRequestScript && LEFTOVER_MARK.test(n.preRequestScript)) out.push({ node: n, path, phase: 'pre', script: n.preRequestScript });
        if (n.testScript && LEFTOVER_MARK.test(n.testScript)) out.push({ node: n, path, phase: 'test', script: n.testScript });
      }
    }
  };
  walk(c.items, [], !folderId);
  return out;
}

export function prepareLeftoversContext(store: WorkspaceStore, item: ItemRef): PreparedItem {
  if (item.kind !== 'collection' && item.kind !== 'folder') throw new ApsError('ValidationError', 'Fix import leftovers takes a collection or a folder (collection:<id> or folder:<collectionId>:<folderId>)');
  const c = store.getCollection(item.collectionId);
  const found = findLeftovers(c, item.kind === 'folder' ? item.folderId : undefined);
  if (!found.length) throw new ApsError('ValidationError', `Nothing in ${c.name} is marked TODO(import): the import converted every script`, { suggestions: ['Only scripts with a // TODO(import) line (a call with no equivalent) are rewritten by this task.'] });
  const local: LeftoversLocal = { collectionId: c.id, items: {} };
  const leftovers = found.slice(0, MAX_SCRIPTS).map((f, i) => {
    const id = `s${i + 1}`;
    const example = exampleOf(f.node.kind === 'http' ? f.node.examples?.[0] : undefined);
    local.items[id] = { requestId: f.node.id, name: f.node.name, phase: f.phase, current: f.script, request: sample(f.node), ...(example ? { example } : {}) };
    const todos = f.script
      .split('\n')
      .map((l, n) => ({ line: n + 1, text: l.trim() }))
      .filter((l) => LEFTOVER_MARK.test(l.text))
      .map((l) => ({ line: l.line, note: l.text.replace(/^\/\/\s*TODO\(import\):?\s*/, '') }));
    return {
      id,
      request: { name: f.node.name, folder: f.path.join(' / ') || undefined, method: f.node.kind === 'http' ? f.node.request.method : 'POST', url: f.node.kind === 'http' ? f.node.request.url : f.node.request.endpoint },
      phase: f.phase === 'pre' ? 'pre (runs before the request is sent)' : 'test (runs after the response)',
      script: f.script.length > MAX_SCRIPT ? f.script.slice(0, MAX_SCRIPT) + '\n// … (cut)' : f.script,
      todos,
      ...(example ? { savedResponse: { status: example.status, body: (example.body ?? '').slice(0, 1500) } } : {}),
    };
  });
  return { label: c.name, local, collection: c, context: { collection: c.name, leftovers, ...(found.length > MAX_SCRIPTS ? { notShown: found.length - MAX_SCRIPTS } : {}) } };
}

/** Turn the model's answer into one reviewable item per script. */
export function proposeLeftovers(a: { value?: unknown }, input: AiTaskInput): { items: DraftItem[]; notes?: string[]; problems?: string[] } {
  const local = input.local as LeftoversLocal | undefined;
  const list = (a.value as { scripts?: Array<{ id?: unknown; script?: unknown; explanation?: unknown }> } | undefined)?.scripts;
  if (!local || !Array.isArray(list)) return { items: [], problems: ['The answer has no scripts'] };
  const items: DraftItem[] = [];
  const notes: string[] = [];
  for (const s of list) {
    const key = String(s.id ?? '');
    const info = local.items[key];
    if (!info) {
      notes.push(`The model named a script (${key || 'no id'}) that is not in the context: ignored`);
      continue;
    }
    const raw = typeof s.script === 'string' ? s.script : '';
    const fenced = /^\s*```(?:javascript|js)?\s*\n([\s\S]*?)\n```\s*$/.exec(raw);
    const code = (fenced ? fenced[1]! : raw).replace(/\r\n/g, '\n').trim();
    if (!code) {
      notes.push(`"${info.name}": the model returned no script`);
      continue;
    }
    items.push({
      kind: 'script',
      title: `${info.name}: ${info.phase === 'pre' ? 'pre-request' : 'post-response'} script`,
      after: `${code}\n`,
      before: info.current,
      language: 'javascript',
      target: { kind: 'request', collectionId: local.collectionId, requestId: info.requestId },
      data: { phase: info.phase, mode: 'replace', leftover: { request: info.request, ...(info.example ? { example: info.example } : {}), ...(typeof s.explanation === 'string' ? { explanation: s.explanation.slice(0, 400) } : {}) } },
    });
  }
  return { items, ...(notes.length ? { notes } : {}) };
}

export function describeLeftovers(value: unknown): { summary?: string; assumptions?: string[] } {
  const v = (value ?? {}) as { summary?: unknown; assumptions?: unknown };
  return { summary: typeof v.summary === 'string' ? v.summary.slice(0, 1200) : undefined, assumptions: stringList(v.assumptions, 10) };
}

/* ------------------------------------------------------------------ verification */

const STAND_IN: StoredResponse = { status: 200, headers: [['content-type', 'application/json']], body: '{}' };

/**
 * A rewritten script is trusted only after it ran: the static check and the sandbox run of `script-dry-run`, against the
 * request's saved example when there is one. On a stand-in response a failing test proves nothing, so it is only a warning.
 */
async function checkLeftoverScript(code: string, phase: Phase, o: { request?: SampleRequest; example?: StoredResponse }): Promise<VerificationBadge> {
  if (LEFTOVER_MARK.test(code)) return { verifier: 'import-leftovers', status: 'warn', label: 'still has a TODO(import) line', detail: 'The marked call has no TestPion equivalent and the model kept it: rewrite it by hand or leave it.' };
  if (/\b(pm|postman|bru|insomnia|pw|hopp|tc)\s*\.\s*[A-Za-z_$]/.test(code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""'))) return { verifier: 'import-leftovers', status: 'fail', label: "still uses another tool's script API", detail: 'Write tp.* only.' };
  const b = await dryRunScript(code, phase, { request: o.request, response: o.example ?? (phase === 'test' ? STAND_IN : undefined) });
  const label = b.label;
  if (b.status === 'fail' && !o.example && /tests? fail on the response/.test(label)) return { ...b, verifier: 'import-leftovers', status: 'warn', label: `parsed and ran; ${label} (the request has no saved response, so a stand-in was used)` };
  return { ...b, verifier: 'import-leftovers', ...(o.example ? { label: `${label} (on the saved response)` } : {}) };
}

registerVerifier('import-leftovers', (item) => {
  if (item.kind !== 'script') return undefined;
  const d = (item.data as { phase?: Phase; leftover?: { request?: SampleRequest; example?: StoredResponse } } | undefined) ?? {};
  return checkLeftoverScript(item.after, d.phase ?? 'test', { request: d.leftover?.request, example: d.leftover?.example });
});

export const LEFTOVERS_VERIFIERS = ['import-leftovers'];
