import { parseYaml, stringifyYaml } from '../util/lazy-yaml.js';
import { slugify } from '../util/ids.js';
import type { SemanticChange } from './semantic.js';

/**
 * Test and flow files (tests/*.yaml) compared by meaning: steps added, removed, renamed or changed (which parts:
 * request line, headers, body, extract, checks, if, forEach …), connections (dependsOn) added or removed, and a
 * change to `layout:` alone reported as "rearranged", not as a change to what runs.
 */

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** A test or flow file under tests/ (not a suite). */
export const isFlowFile = (path: string) => /^tests\/.+\.(ya?ml|json)$/i.test(path) && !/\.suite\.(ya?ml|json)$/i.test(path);

interface Flow {
  data: Rec;
  steps: Array<{ id: string; raw: Rec }>;
  title: string;
}

/** The parts of a step, by what a reader calls them; keys not listed are "settings". */
const PARTS: Array<[string, string[]]> = [
  ['name', ['name', 'description']],
  ['type', ['type']],
  ['request line', ['method', 'url', 'endpoint', 'target', 'address', 'server', 'tool', 'resource', 'mode', 'path', 'operationName']],
  ['params', ['params']],
  ['headers', ['headers', 'metadata']],
  ['cookies', ['cookies']],
  ['auth', ['auth']],
  [
    'body',
    [
      'body',
      'json',
      'variables',
      'graphqlVariables',
      'message',
      'messages',
      'arguments',
      'args',
      'send',
      'publish',
      'subscribe',
      'prompt',
      'system',
      'input',
      'question',
      'contexts',
      'ms',
      'duration',
    ],
  ],
  ['extract', ['extract']],
  ['checks', ['assertions', 'checks', 'evaluators']],
  ['depends on', ['dependsOn']],
  ['if', ['if', 'when', 'condition']],
  ['forEach', ['repeat', 'forEach', 'for_each']],
  ['scripts', ['preRequestScript', 'testScript', 'script', 'code', 'pre_request_script', 'test_script']],
  ['sub-flow', ['file', 'flow', 'inputs']],
];

/** A step's keys grouped into parts (the `request:` map's keys count as the step's own). */
function stepParts(raw: Rec): Record<string, Rec> {
  const flat: Rec = { ...raw, ...(isRec(raw.request) ? raw.request : {}) };
  delete flat.request;
  delete flat.id;
  const out: Record<string, Rec> = {};
  const isGraphql = flat.type === 'graphql' || (!flat.type && !flat.url && flat.query !== undefined);
  for (const [k, v] of Object.entries(flat)) {
    let part = PARTS.find(([, keys]) => keys.includes(k))?.[0];
    if (k === 'query') part = isGraphql ? 'body' : 'params';
    (out[part ?? 'settings'] ??= {})[k] = v;
  }
  return out;
}

const depsOf = (raw: Rec): string[] => (raw.dependsOn === undefined || raw.dependsOn === null ? [] : Array.isArray(raw.dependsOn) ? raw.dependsOn.map(String) : [String(raw.dependsOn)]);

function parseFlow(file: string, text: string | undefined): Flow | undefined {
  if (text === undefined) return undefined;
  let data: unknown;
  try {
    data = /\.json$/i.test(file) ? JSON.parse(text) : parseYaml(text);
  } catch {
    return undefined;
  }
  if (!isRec(data)) return undefined;
  const list = Array.isArray(data.tests) ? data.tests : data.tests === undefined && (data.type || data.url || data.request) ? [data] : undefined;
  if (!list || list.some((t) => !isRec(t))) return undefined;
  const seen = new Set<string>();
  const steps = (list as Rec[]).map((raw, i) => {
    let id = typeof raw.id === 'string' || typeof raw.id === 'number' ? String(raw.id) : raw.name ? slugify(String(raw.name)) : `step-${i + 1}`;
    while (seen.has(id)) id = `${id}#${i + 1}`;
    seen.add(id);
    return { id, raw };
  });
  return { data, steps, title: typeof data.name === 'string' && data.tests ? data.name : file.replace(/^tests\//, '') };
}

const stepTitle = (s: { id: string; raw: Rec }) => (typeof s.raw.name === 'string' ? s.raw.name : s.id);

/** Which parts of a step differ, in words ("request line", "headers", "checks (1 → 2)" …); dependsOn is left to the connections. */
export function stepDetails(a: Rec, b: Rec): string[] {
  const pa = stepParts(a);
  const pb = stepParts(b);
  const out: string[] = [];
  const count = (p: Rec | undefined) => {
    const v = p?.assertions ?? p?.checks;
    return Array.isArray(v) ? v.length : 0;
  };
  for (const part of [...PARTS.map(([p]) => p), 'settings']) {
    if (part === 'depends on' || same(pa[part], pb[part])) continue;
    if (part === 'name') out.push(a.name !== b.name && typeof a.name === 'string' ? `renamed from "${a.name}"` : 'description');
    else if (part === 'checks' && count(pa[part]) !== count(pb[part])) out.push(`checks (${count(pa[part])} → ${count(pb[part])})`);
    else if (part === 'settings') out.push(...[...new Set([...Object.keys(pa.settings ?? {}), ...Object.keys(pb.settings ?? {})])].filter((k) => !same(pa.settings?.[k], pb.settings?.[k])));
    else out.push(part);
  }
  return out;
}

/** The meaning of a change to a test or flow file; undefined when either side is not a flow file (then the caller says "changed"). */
export function flowChanges(file: string, beforeText: string | undefined, afterText: string | undefined): SemanticChange[] | undefined {
  const before = parseFlow(file, beforeText);
  const after = parseFlow(file, afterText);
  if ((beforeText !== undefined && !before) || (afterText !== undefined && !after)) return undefined;
  const base = { file, kind: 'test' as const };
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (!before && after) return [{ ...base, change: 'added', title: `flow ${after.title}`, details: [plural(after.steps.length, 'step')] }];
  if (before && !after) return [{ ...base, change: 'removed', title: `flow ${before.title}`, details: [plural(before.steps.length, 'step')] }];
  if (!before || !after) return [];
  const title = after.title;
  const out: SemanticChange[] = [];

  // the file's own keys
  const top: string[] = [];
  if (before.title !== after.title) top.push(`renamed from ${before.title}`);
  for (const k of ['description', 'defaults', 'expose', 'output']) if (!same(before.data[k], after.data[k])) top.push(k === 'expose' ? 'expose (MCP tool)' : k);
  const known = new Set(['name', 'description', 'defaults', 'expose', 'output', 'tests', 'layout']);
  for (const k of new Set([...Object.keys(before.data), ...Object.keys(after.data)])) if (!known.has(k) && before.data.tests !== undefined && !same(before.data[k], after.data[k])) top.push(k);

  // steps by id; a step that left and one that arrived with the same content is a rename
  const a = new Map(before.steps.map((s) => [s.id, s]));
  const b = new Map(after.steps.map((s) => [s.id, s]));
  const added = after.steps.filter((s) => !a.has(s.id));
  const removed = before.steps.filter((s) => !b.has(s.id));
  const renamedTo = new Map<string, string>();
  const body = (r: Rec) => {
    const { id: _i, name: _n, dependsOn: _d, ...rest } = r;
    return JSON.stringify(rest);
  };
  for (const r of [...removed]) {
    const match = added.find((x) => body(x.raw) === body(r.raw));
    if (!match) continue;
    renamedTo.set(r.id, match.id);
    added.splice(added.indexOf(match), 1);
    removed.splice(removed.indexOf(r), 1);
    out.push({ ...base, change: 'renamed', title: `${title} ▸ ${stepTitle(match)}`, details: [`was ${r.id}`], itemId: match.id, itemKind: 'step' });
  }
  for (const s of after.steps) {
    const was = a.get(s.id);
    if (!was || same(was.raw, s.raw)) continue;
    const details = stepDetails(was.raw, s.raw);
    if (!details.length) continue; // only dependsOn changed: said under connections
    const onlyName = details.length === 1 && details[0]!.startsWith('renamed from');
    out.push({ ...base, change: onlyName ? 'renamed' : 'changed', title: `${title} ▸ ${stepTitle(s)}`, details, itemId: s.id, itemKind: 'step' });
  }
  for (const s of added) out.push({ ...base, change: 'added', title: `${title} ▸ ${stepTitle(s)}`, details: ['step'], itemId: s.id, itemKind: 'step' });
  for (const s of removed) out.push({ ...base, change: 'removed', title: `${title} ▸ ${stepTitle(s)}`, details: ['step'], itemId: s.id, itemKind: 'step' });

  // connections: dependsOn edges, with renamed steps under their new ids; edges of added / removed steps go without saying
  const gone = new Set(removed.map((s) => s.id));
  const fresh = new Set(added.map((s) => s.id));
  const ren = (id: string) => renamedTo.get(id) ?? id;
  const edges = (f: Flow, rename: boolean) => new Set(f.steps.flatMap((s) => depsOf(s.raw).map((d) => `${rename ? ren(d) : d} → ${rename ? ren(s.id) : s.id}`)));
  const ea = edges(before, true);
  const eb = edges(after, false);
  const touches = (e: string, ids: Set<string>) => e.split(' → ').some((x) => ids.has(x));
  const edgeDetails = [
    ...[...eb].filter((e) => !ea.has(e) && !touches(e, fresh)).map((e) => `added ${e}`),
    ...[...ea].filter((e) => !eb.has(e) && !touches(e, new Set([...gone].map(ren)))).map((e) => `removed ${e}`),
  ];
  if (edgeDetails.length) out.push({ ...base, change: 'changed', title: `${title} ▸ connections`, details: edgeDetails });

  // order of the steps both versions have
  const common = after.steps.map((s) => s.id).filter((id) => a.has(id));
  const commonBefore = before.steps.map((s) => s.id).filter((id) => b.has(id));
  if (!same(common, commonBefore)) top.push('steps reordered');
  if (!same(before.data.layout, after.data.layout)) top.push('rearranged');
  if (top.length) out.unshift({ ...base, change: 'changed', title: `flow ${title}`, details: top });
  if (!out.length) out.push({ ...base, change: 'changed', title: `flow ${title}`, details: ['formatting or comments'] });
  return out;
}

const show = (v: unknown) => (v === undefined ? '' : typeof v === 'string' ? v : stringifyYaml(v, { lineWidth: 0 }).trimEnd());

/**
 * The parts of a flow file side by side (GIT-205's Compare): one step (`stepId`) part by part, or the file's own
 * settings and its list of steps. Undefined when the text is not a flow file.
 */
export function flowItemParts(file: string, text: string | undefined, stepId?: string): Record<string, string> | undefined {
  const f = parseFlow(file, text);
  if (!f) return undefined;
  if (stepId) {
    const s = f.steps.find((x) => x.id === stepId);
    if (!s) return undefined;
    const parts = stepParts(s.raw);
    const label: Record<string, string> = {
      name: 'Name',
      type: 'Type',
      'request line': 'Request line',
      params: 'Params',
      headers: 'Headers',
      cookies: 'Cookies',
      auth: 'Auth',
      body: 'Body',
      extract: 'Extract',
      checks: 'Checks',
      'depends on': 'Depends on',
      if: 'If',
      forEach: 'Repeat / forEach',
      scripts: 'Scripts',
      'sub-flow': 'Sub-flow',
      settings: 'Settings',
    };
    const out: Record<string, string> = {};
    for (const [part, keys] of Object.entries(parts)) out[label[part] ?? part] = Object.keys(keys).length === 1 ? show(Object.values(keys)[0]) : show(keys);
    return out;
  }
  return {
    Name: show(f.data.name),
    Description: show(f.data.description),
    Defaults: show(f.data.defaults),
    'Expose (MCP tool)': show(f.data.expose),
    Output: show(f.data.output),
    Steps: f.steps.map((s) => `${s.id}${depsOf(s.raw).length ? ` ← ${depsOf(s.raw).join(', ')}` : ''}`).join('\n'),
    Layout: show(f.data.layout),
  };
}
