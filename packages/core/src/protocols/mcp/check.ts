/**
 * One check of an MCP server under test (planning/ai-research-2026-11-11.md N-2): does it follow the protocol where a
 * client can see it (conformance), is it easy for an agent to use (the lint of shared/mcp-tool-lint.ts), and did what it
 * offers change since someone approved it (shared/mcp-snapshot.ts). The approved snapshot is a file of the workspace,
 * `mcp-snapshots/<server>.json`, so a change is also a git diff and a teammate's approval travels with the repository.
 *
 * Conformance here is what can be observed from the client side without side effects: the handshake, the lists, a ping, a
 * call of a tool that does not exist. `probeArguments` also calls the tools that say they only read (readOnlyHint) with
 * no arguments when they require some, to see that the server refuses: opt-in, because it calls real tools.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { diffMcpSnapshot, lintMcpTools, mcpSnapshotOf, type McpDrift, type McpSnapshot, type ToolLint } from '@testpion/shared';
import { atomicWrite } from '../../storage/fsutil.js';
import type { McpDiscovery, McpSession } from './client.js';

/** The MCP revisions this client can speak (the SDK's list), newest first. */
export const MCP_KNOWN_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'] as const;

export interface ConformanceFinding {
  level: 'error' | 'warn' | 'tip';
  code: string;
  text: string;
  tool?: string;
}

export interface McpConformance {
  checks: number;
  errors: number;
  warnings: number;
  findings: ConformanceFinding[];
  text: string;
}

export interface McpServerCheck {
  serverInfo?: McpDiscovery['serverInfo'];
  protocolVersion?: string;
  conformance: McpConformance;
  lint: ToolLint;
  /** Absent when the server was never approved. */
  drift?: McpDrift;
  approved?: { at: string; file: string };
  /** What the server lists now (what `approve` writes). */
  snapshot: McpSnapshot;
  /** false: an error of the protocol or the lint, or a change that breaks callers or needs a review. */
  ok: boolean;
  text: string;
}

type Session = Pick<McpSession, 'callTool' | 'ping'>;

const NO_SUCH_TOOL = 'testpion_no_such_tool_check';

/** What a client can see of the protocol. */
export async function mcpConformance(session: Session, d: McpDiscovery, o: { probeArguments?: boolean; signal?: AbortSignal } = {}): Promise<McpConformance> {
  const findings: ConformanceFinding[] = [];
  let checks = 0;
  const check = (ok: boolean, level: ConformanceFinding['level'], code: string, text: string, tool?: string) => {
    checks++;
    if (!ok) findings.push({ level, code, text, ...(tool ? { tool } : {}) });
  };

  check(!!d.serverInfo?.name?.trim() && !!d.serverInfo?.version?.trim(), 'error', 'server-info', 'The server does not give its name and version in the handshake (serverInfo): both are required.');
  if (d.protocolVersion) {
    check(/^\d{4}-\d{2}-\d{2}$/.test(d.protocolVersion), 'error', 'protocol-version', `The protocol version "${d.protocolVersion}" is not a date (YYYY-MM-DD).`);
    check(d.protocolVersion >= '2025-03-26', 'tip', 'protocol-old', `The server speaks MCP ${d.protocolVersion}, an old revision: tool annotations, structured results and elicitation came later.`);
  }
  const caps = d.capabilities ?? {};
  check(!(d.tools.length && !caps.tools), 'error', 'capability-tools', 'The server lists tools but does not declare the tools capability.');
  check(!(caps.tools && !d.tools.length), 'tip', 'no-tools', 'The server declares the tools capability and lists none.');

  const names = new Map<string, number>();
  for (const t of d.tools) names.set(t.name, (names.get(t.name) ?? 0) + 1);
  const twice = [...names].filter(([, n]) => n > 1).map(([n]) => n);
  check(!twice.length, 'error', 'duplicate-tools', `Tool names must be unique; listed more than once: ${twice.join(', ')}.`);
  for (const t of d.tools) {
    const s = (t.inputSchema ?? {}) as Record<string, unknown>;
    check(s.properties === undefined || (typeof s.properties === 'object' && s.properties !== null && !Array.isArray(s.properties)), 'error', 'schema-properties', `The input schema of ${t.name} has properties that are not an object.`, t.name);
    check(s.required === undefined || (Array.isArray(s.required) && s.required.every((r) => typeof r === 'string')), 'error', 'schema-required', `The input schema of ${t.name} has a required that is not a list of names.`, t.name);
    const out = t.outputSchema as Record<string, unknown> | undefined;
    check(!out || out.type === 'object', 'error', 'output-schema-type', `The output schema of ${t.name} is not an object schema (type: object).`, t.name);
  }

  try {
    await session.ping();
    check(true, 'error', 'ping', '');
  } catch (e) {
    check(false, 'error', 'ping', `The server does not answer a ping (${(e as Error).message.slice(0, 120)}): every server must.`);
  }

  if (caps.tools) {
    // a tool that does not exist: an error (a protocol error, or a result with isError), never a success
    try {
      const r = await session.callTool(NO_SUCH_TOOL, {}, { signal: o.signal, timeoutMs: 15_000 });
      check(r.isError, 'error', 'unknown-tool', 'A call of a tool that does not exist came back as a success: the server must answer with an error, or an agent takes a typo for a result.');
    } catch {
      check(true, 'error', 'unknown-tool', '');
    }
    if (o.probeArguments) {
      for (const t of d.tools) {
        const req = Array.isArray(t.inputSchema?.required) ? (t.inputSchema!.required as unknown[]) : [];
        if (!req.length || t.annotations?.readOnlyHint !== true) continue;
        try {
          const r = await session.callTool(t.name, {}, { signal: o.signal, timeoutMs: 15_000 });
          check(r.isError, 'warn', 'missing-arguments', `${t.name} requires ${req.join(', ')} but a call without them came back as a success: it should refuse and say which parameter is missing.`, t.name);
        } catch {
          check(true, 'warn', 'missing-arguments', '', t.name);
        }
      }
    }
  }

  const rank = { error: 0, warn: 1, tip: 2 } as const;
  findings.sort((a, b) => rank[a.level] - rank[b.level]);
  const errors = findings.filter((f) => f.level === 'error').length;
  const warnings = findings.filter((f) => f.level === 'warn').length;
  const text = errors || warnings ? `Protocol: ${checks} checks, ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}.` : `Protocol: ${checks} checks passed.`;
  return { checks, errors, warnings, findings, text };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'server';

/** The file of a server's approved snapshot, relative to the workspace. */
export const mcpSnapshotFile = (server: { id: string; name: string }): string => `mcp-snapshots/${slug(server.name || server.id)}.json`;

export function readMcpSnapshot(root: string, server: { id: string; name: string }): McpSnapshot | undefined {
  const file = join(root, mcpSnapshotFile(server));
  if (!existsSync(file)) return undefined;
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as McpSnapshot;
    return v && v.version === 1 && Array.isArray(v.tools) ? { ...v, prompts: v.prompts ?? [], resources: v.resources ?? [] } : undefined;
  } catch {
    return undefined;
  }
}

/** Approves what the server lists now: writes the snapshot file and gives its path (relative to the workspace). */
export function approveMcpSnapshot(root: string, server: { id: string; name: string }, snapshot: McpSnapshot): string {
  const rel = mcpSnapshotFile(server);
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  atomicWrite(file, JSON.stringify(snapshot, null, 2) + '\n');
  return rel;
}

/** The whole check of a connected server. `root` (a workspace) and `server` give the approved snapshot to compare with. */
export async function checkMcpServer(session: Session & Pick<McpSession, 'discover'>, o: { root?: string; server?: { id: string; name: string }; probeArguments?: boolean; signal?: AbortSignal; now?: () => Date } = {}): Promise<McpServerCheck> {
  const d = await session.discover();
  const conformance = await mcpConformance(session, d, o);
  const lint = lintMcpTools(d.tools, { instructions: d.instructions, prompts: d.prompts, resources: d.resources });
  const snapshot = mcpSnapshotOf(d, (o.now?.() ?? new Date()).toISOString());
  const approved = o.root && o.server ? readMcpSnapshot(o.root, o.server) : undefined;
  const drift = approved ? diffMcpSnapshot(approved, snapshot) : undefined;
  const ok = !conformance.errors && !lint.errors && !drift?.changed;
  const text = [conformance.text, `For agents: ${lint.text}`, drift ? `Changes: ${drift.text}` : o.server ? 'Changes: never approved, so nothing to compare with (approve it once you have read the tools).' : ''].filter(Boolean).join(' ');
  return { serverInfo: d.serverInfo, ...(d.protocolVersion ? { protocolVersion: d.protocolVersion } : {}), conformance, lint, ...(drift ? { drift } : {}), ...(approved && o.server ? { approved: { at: approved.approvedAt, file: mcpSnapshotFile(o.server) } } : {}), snapshot, ok, text };
}
