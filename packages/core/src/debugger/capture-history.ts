import { shortId } from '../util/ids.js';
import type { CaptureSessionInfo, HistoryEntry } from '../model/types.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import type { Redactor } from '../util/redact.js';
import type { DebuggerExchange } from './proxy.js';

/** Where the Debugger keeps saved capture sessions (HAR files), inside the workspace. */
export const CAPTURE_SESSIONS_DIR = 'debugger';

/** A saved session's file name for `name` (what the Debugger's Save session writes): the name, made safe, `.har`. */
export function captureSessionFileName(name: string): string {
  return `${name
    .replace(/\.har$/i, '')
    .replace(/[^\w.\- ]+/g, '_')
    .trim()}.har`;
}

/** How an exchange came in: through the forward proxy, or the reverse proxy (it stands in front of one server). */
export const exchangeSource = (e: Pick<DebuggerExchange, 'source'>): 'proxy' | 'reverse' => (e.source === 'reverse' ? 'reverse' : 'proxy');

const RESULT_WORDS: Record<CaptureSessionInfo['result'], string> = { collection: 'Saved to collection', flow: 'Flow created', session: 'Session saved' };

/**
 * A capture session in History (kind `capture`): the exchanges it covered (how many, the hosts, from when to when, the
 * proxy or the reverse proxy) and what they became, with a ref that opens it. One entry per Save to collection, Create
 * flow or Save session: History then answers "what did I capture, and where did it go?". Hosts and names pass the
 * redactor (a token in a host name or a session name stays out).
 */
export function captureHistoryEntry(
  exchanges: Array<Pick<DebuggerExchange, 'startedAt' | 'host' | 'source'>>,
  what: { result: CaptureSessionInfo['result']; ref: CaptureSessionInfo['ref']; target: string; items?: number },
  redactor?: Redactor,
): HistoryEntry {
  const byHost = new Map<string, number>();
  for (const e of exchanges) if (e.host) byHost.set(e.host, (byHost.get(e.host) ?? 0) + 1);
  const hosts = [...byHost.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([h]) => (redactor ? redactor.redactString(h) : h))
    .slice(0, 20);
  const times = exchanges
    .map((e) => e.startedAt)
    .filter(Boolean)
    .sort();
  const from = times[0];
  const to = times[times.length - 1];
  const sources = [...new Set(exchanges.map(exchangeSource))].sort();
  const target = redactor ? redactor.redactString(what.target) : what.target;
  const capture: CaptureSessionInfo = {
    result: what.result,
    ref: what.ref,
    exchanges: exchanges.length,
    sources,
    hosts,
    ...(from ? { from, to } : {}),
    ...(what.items !== undefined ? { items: what.items } : {}),
  };
  const span = from && to ? Date.parse(to) - Date.parse(from) : undefined;
  return {
    id: shortId('cap-'),
    timestamp: new Date().toISOString(),
    kind: 'capture',
    name: `${RESULT_WORDS[what.result]}: ${target} (${exchanges.length} ${exchanges.length === 1 ? 'exchange' : 'exchanges'})`,
    url: hosts.join(', ') || undefined,
    status: 'saved',
    ...(span !== undefined && Number.isFinite(span) ? { durationMs: span } : {}),
    capture,
  };
}

/** Add a capture session to the workspace's History; returns the entry (its id is the History ref). */
export function recordCaptureSession(store: WorkspaceStore, ...args: Parameters<typeof captureHistoryEntry>): HistoryEntry {
  const e = captureHistoryEntry(...args);
  store.meta.addHistory(e);
  return e;
}
