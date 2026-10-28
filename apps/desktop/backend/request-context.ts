/**
 * The context of one RPC call (cloud stage 1): who calls, what they may do, a signal that stops the work, an id the window
 * can cancel by (`rpc.cancel`) and an optional deadline. It travels in AsyncLocalStorage, like the own-writes batch and the
 * production consent, so the 44 handler modules keep their `(be)` signature and read it with `currentCall()` where they need it.
 *
 * Three levels, from the longest lived: `AppServices` (one per process: app-services.ts), the `Session` (one per user and
 * workspace: the `Backend` object) and the `RequestContext` (one per call: this file).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { ApsError, shortId } from '@testpion/core';
import { ALWAYS_METHODS, RPC_GROUPS, SERVER_DEFAULT_GROUPS, methodGroup } from './capabilities.js';

export interface CallUser {
  id: string;
  /** What the user may do (`*` for everything: the desktop owner). A server host passes the capabilities of the signed-in user. */
  permissions: ReadonlySet<string> | '*';
}

/** The person at the keyboard: the desktop app and the CLI have one user who may do everything. */
export const LOCAL_USER: CallUser = Object.freeze({ id: 'local', permissions: '*' as const });

export interface RequestContext {
  /** Unique per call; the window passes its own to be able to cancel (`rpc.cancel { id }`). */
  readonly id: string;
  readonly method: string;
  readonly user: CallUser;
  /** Aborts when the caller cancels, its connection closes, or the deadline passes. Long work passes it down (`signal`). */
  readonly signal: AbortSignal;
  /** When the call is stopped on its own (epoch ms), if the host set a limit. */
  readonly deadline?: number;
  readonly startedAt: number;
  can(capability: string): boolean;
}

/** What a host knows about a call before the backend runs it. */
export interface CallMeta {
  requestId?: string;
  user?: CallUser;
  /** The host's own signal (an HTTP request that closed): the call is cancelled with it. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

const als = new AsyncLocalStorage<RequestContext>();

/** The call the running code belongs to; undefined outside an RPC (a timer, a run that outlived its call, the CLI). */
export function currentCall(): RequestContext | undefined {
  return als.getStore();
}

export function cancelled(why = 'The call was cancelled'): ApsError {
  return new ApsError('CancelledError', why);
}

/** Throws `CancelledError` when the signal has aborted. */
export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelled();
}

/**
 * A controller for work a handler starts (a send, a run, an AI request), stopped when the call is cancelled. The handler
 * keeps registering it under its own id too (`http.cancel`, `run.cancel`): both ways stop the same work.
 */
export function linkedController(): AbortController {
  const ctrl = new AbortController();
  const signal = als.getStore()?.signal;
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return ctrl;
}

/** Settles with `p`, or rejects with `CancelledError` as soon as the signal aborts (the work behind `p` stops through its own linked controllers). */
export function raceAbort<T>(signal: AbortSignal, p: Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => (signal.removeEventListener('abort', onAbort), resolve(v)),
      (e) => (signal.removeEventListener('abort', onAbort), reject(e)),
    );
  });
}

/** The calls in flight of one session, by id: `rpc.cancel` finds them here. */
export class Calls {
  private readonly open = new Map<string, AbortController>();

  /** Run `fn` as one call; the context is dropped when it settles (work it started keeps its linked controllers). */
  async run<T>(method: string, meta: CallMeta | undefined, fn: (ctx: RequestContext) => Promise<T>): Promise<T> {
    const ctrl = new AbortController();
    let id = typeof meta?.requestId === 'string' && meta.requestId && meta.requestId.length <= 80 ? meta.requestId : shortId('rpc-');
    if (this.open.has(id)) id = shortId('rpc-'); // a repeated id never lets one call cancel another
    const user = meta?.user ?? LOCAL_USER;
    const startedAt = Date.now();
    const ctx: RequestContext = {
      id,
      method,
      user,
      signal: ctrl.signal,
      deadline: meta?.timeoutMs ? startedAt + meta.timeoutMs : undefined,
      startedAt,
      can: (c) => user.permissions === '*' || user.permissions.has(c),
    };
    const onHostAbort = () => ctrl.abort();
    if (meta?.signal) {
      if (meta.signal.aborted) ctrl.abort();
      else meta.signal.addEventListener('abort', onHostAbort, { once: true });
    }
    const timer = meta?.timeoutMs ? setTimeout(() => ctrl.abort(), meta.timeoutMs) : undefined;
    timer?.unref?.();
    this.open.set(id, ctrl);
    try {
      return await als.run(ctx, () => fn(ctx));
    } finally {
      if (timer) clearTimeout(timer);
      meta?.signal?.removeEventListener('abort', onHostAbort);
      this.open.delete(id);
    }
  }

  /** Stop a call in flight; false when there is none by that id (it finished, or never existed). */
  cancel(id: string): boolean {
    const c = this.open.get(id);
    if (!c) return false;
    c.abort();
    return true;
  }

  get size(): number {
    return this.open.size;
  }

  /** A session that closes stops what is still running for it. */
  cancelAll(): void {
    for (const c of this.open.values()) c.abort();
  }
}

/**
 * Throws `Forbidden` (plain words) when the caller may not use the method's group. On a server host a call without a user of its own
 * (still the desktop's `LOCAL_USER`) holds `SERVER_DEFAULT_GROUPS`, never everything.
 */
export function requireCapability(ctx: Pick<RequestContext, 'user' | 'can'>, method: string, serverMode?: boolean): void {
  const group = methodGroup(method);
  if (ALWAYS_METHODS.has(method)) return;
  const allowed = serverMode && ctx.user === LOCAL_USER ? SERVER_DEFAULT_GROUPS.has(group) : ctx.can(group);
  if (!allowed)
    throw new ApsError('Forbidden', `You are not allowed to use "${group}" here (${method}): ${RPC_GROUPS[group] ?? 'this part of TestPion'}.`, {
      suggestions: ['Ask the person who runs this server to allow the "' + group + '" group for your account.'],
      details: { group, method, user: ctx.user.id },
    });
}
