/**
 * RPC handlers of the Debugger's grid beyond the list itself: header columns (FG-12), code snippets of a row (Q7), replaying
 * a request many times (FG-2), the running programs to pick from (FG-16) and select-by-condition (FG-3).
 */
import {
  ApsError,
  CODE_LANGUAGES,
  cleanReplayOptions,
  compileWhere,
  generateCode,
  isReplayLocalHost,
  listRunningPrograms,
  parseWhere,
  replayMany,
  requestOfExchange,
  type DebuggerExchange,
  type HttpRequestSpec,
} from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';
import type { DebuggerState, HeaderColumn } from './debugger-state.js';

/** The most header columns at once (each lean row carries their values). */
export const MAX_HEADER_COLUMNS = 8;

/** The answer of a header column: the last value if repeated, a secret masked. */
export function headerValues(be: Backend, cols: readonly HeaderColumn[], req: Record<string, string>, res?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of cols) {
    const v = (c.side === 'request' ? req : res)?.[c.name.toLowerCase()];
    if (v !== undefined) out[`${c.side}:${c.name.toLowerCase()}`] = be.logger.redactor.isSensitiveKey(c.name) ? '***' : v.slice(0, 200);
  }
  return out;
}

/** The Caching and Content-Encoding columns, read from the response headers (empty when there is nothing to say). */
export function cachingOf(res?: Record<string, string>): { caching?: string; contentEncoding?: string } {
  if (!res) return {};
  const cc = res['cache-control'];
  const caching = cc ?? (res['etag'] || res['last-modified'] ? 'validator only' : res['expires'] ? `expires ${res['expires']}` : undefined);
  return { ...(caching ? { caching: caching.slice(0, 80) } : {}), ...(res['content-encoding'] ? { contentEncoding: res['content-encoding'] } : {}) };
}

/** A test for a condition text (the shared grammar), over exchanges. */
export function whereTestOf(where: string): (e: DebuggerExchange) => boolean {
  const p = parseWhere(where);
  if (!p.ok) throw new ApsError('ValidationError', p.error);
  return compileWhere(p.clauses);
}

const cleanColumns = (raw: unknown): HeaderColumn[] => {
  if (!Array.isArray(raw)) return [];
  const out: HeaderColumn[] = [];
  for (const c of raw as Array<Partial<HeaderColumn>>) {
    const name = String(c?.name ?? '').trim();
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,80}$/.test(name)) continue;
    const side = c?.side === 'request' ? 'request' : 'response';
    if (!out.some((x) => x.name.toLowerCase() === name.toLowerCase() && x.side === side)) out.push({ name, side });
  }
  return out.slice(0, MAX_HEADER_COLUMNS);
};

export function debuggerGridHandlers(
  be: Backend,
  ctx: { state: DebuggerState; shown(): DebuggerState; redacted(e: DebuggerExchange): DebuggerExchange; replaced(): void },
): Handlers {
  const find = (id: string) => {
    const e = ctx.shown().exchanges.find((x) => x.id === id);
    if (!e) throw new ApsError('ValidationError', 'That exchange is no longer in the session');
    return e;
  };
  return {
    /** The header columns the lean rows carry (the window sends its chosen ones when it opens and when they change). */
    'debug.columns': ({ columns }: { columns?: HeaderColumn[] } = {}) => {
      if (columns !== undefined) {
        const next = cleanColumns(columns);
        if (JSON.stringify(next) !== JSON.stringify(ctx.state.columns ?? [])) {
          ctx.state.columns = next;
          ctx.state.columnsGen = (ctx.state.columnsGen ?? 0) + 1;
          ctx.replaced();
          // the window reloads the list: the rows now carry these headers
          be.host.emit('debug.exchange', { phase: 'columns' });
        }
      }
      return { columns: ctx.state.columns ?? [], max: MAX_HEADER_COLUMNS };
    },
    /** One exchange as code (cURL, PowerShell, fetch, HTTPie …), secrets masked. */
    'debug.snippet': ({ id, language }: { id: string; language: string }) => {
      if (!CODE_LANGUAGES.some((l) => l.id === language)) throw new ApsError('ValidationError', `Unknown language "${language}": ${CODE_LANGUAGES.map((l) => l.id).join(', ')}`);
      const e = ctx.redacted(find(id));
      const headers = Object.entries(e.requestHeaders).filter(([k]) => !/^(host|content-length|connection|proxy-.*)$/i.test(k)) as Array<[string, string]>;
      return { language, text: generateCode({ method: e.method, url: e.url, headers, body: e.requestBody }, language) };
    },
    /** Ids of the exchanges a condition selects (for an agent; the window evaluates the same grammar on its own rows). */
    'debug.select': ({ where }: { where: string }) => {
      const test = whereTestOf(where);
      const ids = ctx.shown().exchanges.filter(test).map((e) => e.id);
      return { count: ids.length, ids: ids.slice(0, 5000) };
    },
    /** The running programs with connections, to pick one as "Capture only". */
    'debug.programs': async () => ({ programs: (await listRunningPrograms()).slice(0, 200) }),
    /**
     * Send exchanges again, N sends in all, some at once (FG-2). Every send goes the app's own way (so it is in History).
     * `ids` more than one: the sends cycle through them in order. A host that is not on this computer needs `confirmRemote`
     * when more than one send is asked for.
     */
    'debug.replay': async ({ ids, times, concurrency, delayMs, stopOnFailure, confirmRemote, environment }: { ids: string[]; times?: number; concurrency?: number; delayMs?: number; stopOnFailure?: boolean; confirmRemote?: boolean; environment?: string }) => {
      const picked = ids.map(find).filter((e) => e.kind !== 'tunnel');
      if (!picked.length) throw new ApsError('ValidationError', 'Select requests to send again (an HTTPS tunnel is not a request: turn on HTTPS decryption)');
      const opts = cleanReplayOptions({ count: times ?? picked.length, concurrency, delayMs, stopOnFailure });
      const remote = [...new Set(picked.filter((e) => !isReplayLocalHost(e.host)).map((e) => e.host))];
      if (opts.count > 1 && remote.length && !confirmRemote)
        throw new ApsError('ValidationError', `This sends ${opts.count} requests to ${remote.join(', ')}, which is not on this computer. Confirm to go on (confirmRemote).`);
      const summary = await replayMany(opts, async (i) => {
        const e = picked[i % picked.length]!;
        const started = Date.now();
        const r = (await be.httpSend({ request: requestOfExchange(e) as HttpRequestSpec, environment, id: `dbg-replay-${e.id}-${i}`, name: `Replay ${i + 1}/${opts.count} ${e.method} ${e.url}` })) as { response?: { status: number; durationMs?: number }; error?: { message: string }; historyId?: string };
        return { status: r.response?.status, error: r.error?.message, ms: r.response?.durationMs ?? Date.now() - started, historyId: r.historyId };
      });
      return { options: opts, targets: picked.map((e) => ({ id: e.id, method: e.method, url: ctx.redacted(e).url })), remote, ...summary };
    },
  };
}
