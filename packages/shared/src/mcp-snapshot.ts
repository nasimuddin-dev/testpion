/**
 * What an MCP server offered when someone approved it, and what changed since (planning/ai-research-2026-11-11.md N-2).
 * An agent reads a tool's description as instructions: a description or a schema that changes after it was reviewed is how a
 * server goes wrong unnoticed (by a release, or on purpose). The snapshot is a small JSON file in the workspace, so the change
 * is also a git diff. Pure: the CLI (`testpion mcp --check`), the MCP tool `mcp_server_tools` and the app say the same.
 */
import type { LintPrompt, LintResource, LintTool } from './mcp-tool-lint.js';

export interface McpSnapshot {
  version: 1;
  server?: { name?: string; version?: string };
  protocolVersion?: string;
  /** When it was approved (ISO). */
  approvedAt: string;
  instructions?: string;
  tools: LintTool[];
  prompts: LintPrompt[];
  resources: Array<{ uri: string; name?: string; description?: string }>;
}

export type DriftLevel = 'breaking' | 'review' | 'info';

export interface DriftChange {
  level: DriftLevel;
  /** A stable name: tool-removed, tool-added, description, schema-breaking, schema, annotations, instructions, prompt-*, resource-*. */
  code: string;
  /** The tool, prompt or resource it is about. */
  item?: string;
  /** One sentence for people. */
  text: string;
  before?: unknown;
  after?: unknown;
}

export interface McpDrift {
  changed: boolean;
  breaking: number;
  review: number;
  info: number;
  changes: DriftChange[];
  /** "3 changes since it was approved on 2026-11-11: 1 breaking, 2 to review." */
  text: string;
}

/** Object keys in order, so the same schema always reads the same (a file diff shows only real changes). */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
    );
  return v;
}
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a ?? null)) === JSON.stringify(canonical(b ?? null));
const byName = <T extends { name?: string }>(xs: T[]) => [...xs].sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')));

interface Discovered {
  serverInfo?: { name?: string; version?: string };
  protocolVersion?: string;
  instructions?: string;
  tools: LintTool[];
  prompts?: LintPrompt[];
  resources?: LintResource[];
}

/** The snapshot of what a server lists now. */
export function mcpSnapshotOf(d: Discovered, approvedAt: string): McpSnapshot {
  return {
    version: 1,
    ...(d.serverInfo ? { server: { name: d.serverInfo.name, version: d.serverInfo.version } } : {}),
    ...(d.protocolVersion ? { protocolVersion: d.protocolVersion } : {}),
    approvedAt,
    ...(d.instructions?.trim() ? { instructions: d.instructions } : {}),
    tools: byName(d.tools).map((t) => canonical({ name: t.name, ...(t.title ? { title: t.title } : {}), description: t.description ?? '', inputSchema: t.inputSchema ?? {}, ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}), ...(t.annotations && Object.keys(t.annotations).length ? { annotations: t.annotations } : {}) }) as LintTool),
    prompts: byName(d.prompts ?? []).map((p) => canonical({ name: p.name, description: p.description ?? '', ...(p.arguments?.length ? { arguments: p.arguments } : {}) }) as LintPrompt),
    resources: (d.resources ?? []).map((r) => ({ uri: r.uri ?? r.name, name: r.name, description: r.description ?? '' })).sort((a, b) => a.uri.localeCompare(b.uri)),
  };
}

const props = (s: Record<string, unknown> | undefined) => ((s?.properties ?? {}) as Record<string, Record<string, unknown>>);
const required = (s: Record<string, unknown> | undefined) => (Array.isArray(s?.required) ? (s!.required as unknown[]).filter((x): x is string => typeof x === 'string') : []);

/** Why a caller written for the approved input schema would now fail (empty: the change only adds or loosens). */
function schemaBreaks(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined): string[] {
  const out: string[] = [];
  const b = props(before);
  const a = props(after);
  const newlyRequired = required(after).filter((r) => !required(before).includes(r));
  if (newlyRequired.length) out.push(`${newlyRequired.join(', ')} ${newlyRequired.length === 1 ? 'is' : 'are'} now required`);
  const gone = Object.keys(b).filter((k) => !(k in a));
  if (gone.length && after?.additionalProperties === false) out.push(`${gone.join(', ')} ${gone.length === 1 ? 'is' : 'are'} no longer accepted`);
  else if (gone.length) out.push(`${gone.join(', ')} ${gone.length === 1 ? 'was' : 'were'} removed`);
  for (const k of Object.keys(b)) {
    if (!(k in a)) continue;
    if (!same(b[k]!.type, a[k]!.type)) out.push(`${k} changed type (${JSON.stringify(b[k]!.type)} to ${JSON.stringify(a[k]!.type)})`);
    else if (Array.isArray(b[k]!.enum) && Array.isArray(a[k]!.enum)) {
      const dropped = (b[k]!.enum as unknown[]).filter((v) => !(a[k]!.enum as unknown[]).some((w) => same(v, w)));
      if (dropped.length) out.push(`${k} no longer accepts ${dropped.map((v) => JSON.stringify(v)).join(', ')}`);
    }
  }
  return out;
}

/** What changed between the approved snapshot and what the server lists now. */
export function diffMcpSnapshot(approved: McpSnapshot, now: McpSnapshot): McpDrift {
  const changes: DriftChange[] = [];
  const add = (level: DriftLevel, code: string, text: string, item?: string, before?: unknown, after?: unknown) => changes.push({ level, code, text, ...(item ? { item } : {}), ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) });

  const old = new Map(approved.tools.map((t) => [t.name, t]));
  const cur = new Map(now.tools.map((t) => [t.name, t]));
  for (const [name, t] of old) {
    const n = cur.get(name);
    if (!n) {
      add('breaking', 'tool-removed', `The tool ${name} is gone: an agent or a test that calls it now fails.`, name);
      continue;
    }
    if ((t.description ?? '') !== (n.description ?? '')) add('review', 'description', `The description of ${name} changed. An agent reads it as instructions: read the new text before you approve it.`, name, t.description ?? '', n.description ?? '');
    if (!same(t.inputSchema, n.inputSchema)) {
      const breaks = schemaBreaks(t.inputSchema, n.inputSchema);
      if (breaks.length) add('breaking', 'schema-breaking', `The parameters of ${name} changed in a way that breaks callers: ${breaks.join('; ')}.`, name, t.inputSchema, n.inputSchema);
      else add('review', 'schema', `The parameters of ${name} changed (nothing that breaks a caller of the approved version).`, name, t.inputSchema, n.inputSchema);
    }
    if (!same(t.outputSchema, n.outputSchema)) add('review', 'output-schema', `The output schema of ${name} changed.`, name, t.outputSchema, n.outputSchema);
    if (!same(t.annotations, n.annotations)) {
      const wasSafe = t.annotations?.readOnlyHint === true || t.annotations?.destructiveHint === false;
      const isSafe = n.annotations?.readOnlyHint === true || n.annotations?.destructiveHint === false;
      add(wasSafe && !isSafe ? 'review' : 'info', 'annotations', wasSafe && !isSafe ? `${name} no longer says it only reads: a client that ran it without asking should ask now.` : `The annotations of ${name} changed.`, name, t.annotations, n.annotations);
    }
  }
  for (const name of cur.keys()) if (!old.has(name)) add('review', 'tool-added', `A new tool, ${name}: an agent connected to this server can call it. Read its description before you approve it.`, name);

  if ((approved.instructions ?? '') !== (now.instructions ?? '')) add('review', 'instructions', 'The server instructions changed. They go into the context of every agent that connects.', undefined, approved.instructions ?? '', now.instructions ?? '');

  const oldP = new Map(approved.prompts.map((p) => [p.name, p]));
  const curP = new Map(now.prompts.map((p) => [p.name, p]));
  for (const [name, p] of oldP) {
    const n = curP.get(name);
    if (!n) add('breaking', 'prompt-removed', `The prompt ${name} is gone.`, name);
    else if (!same(p, n)) add('review', 'prompt-changed', `The prompt ${name} changed (its description or its arguments).`, name, p, n);
  }
  for (const name of curP.keys()) if (!oldP.has(name)) add('info', 'prompt-added', `A new prompt, ${name}.`, name);

  const oldR = new Set(approved.resources.map((r) => r.uri));
  const curR = new Set(now.resources.map((r) => r.uri));
  const goneR = [...oldR].filter((u) => !curR.has(u));
  const newR = [...curR].filter((u) => !oldR.has(u));
  if (goneR.length) add('info', 'resources-removed', `${goneR.length} resource${goneR.length === 1 ? ' is' : 's are'} gone: ${goneR.slice(0, 5).join(', ')}${goneR.length > 5 ? ' …' : ''}.`);
  if (newR.length) add('info', 'resources-added', `${newR.length} new resource${newR.length === 1 ? '' : 's'}: ${newR.slice(0, 5).join(', ')}${newR.length > 5 ? ' …' : ''}.`);

  if (approved.protocolVersion && now.protocolVersion && approved.protocolVersion !== now.protocolVersion) add('info', 'protocol', `The server now speaks MCP ${now.protocolVersion} (it was ${approved.protocolVersion}).`);
  if (approved.server?.version && now.server?.version && approved.server.version !== now.server.version) add('info', 'server-version', `The server is now version ${now.server.version} (it was ${approved.server.version}).`);

  const rank = { breaking: 0, review: 1, info: 2 } as const;
  changes.sort((a, b) => rank[a.level] - rank[b.level]);
  const count = (l: DriftLevel) => changes.filter((c) => c.level === l).length;
  const breaking = count('breaking');
  const review = count('review');
  const info = count('info');
  const day = approved.approvedAt.slice(0, 10);
  const parts = [breaking ? `${breaking} breaking` : '', review ? `${review} to review` : '', info ? `${info} for information` : ''].filter(Boolean).join(', ');
  const text = changes.length ? `${changes.length} change${changes.length === 1 ? '' : 's'} since it was approved on ${day}: ${parts}.` : `Nothing changed since it was approved on ${day}.`;
  return { changed: breaking + review > 0, breaking, review, info, changes, text };
}
