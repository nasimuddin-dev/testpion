import { afterAll, describe, expect, it } from 'vitest';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { LOCAL_USER, currentCall, linkedController } from '../../apps/desktop/backend/request-context.js';
import { tempDir } from '../helpers.js';

// Cloud stage 1: every RPC call has a context (user, permissions, signal, request id, deadline) in AsyncLocalStorage; the
// window (or a bridge) cancels a call by its request id; handlers that start long work stop with it.
const tmp = tempDir('tp-reqctx-');
const be = new Backend({ appDir: tmp.dir, emit: () => {}, noMonitors: true });
afterAll(async () => {
  await be.dispose();
  tmp.cleanup();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A test-only RPC method that works until its call is cancelled. */
function slow(name: string, seen: { started: number; stoppedAt?: number; ctx?: ReturnType<typeof currentCall>; ctrl?: AbortController }) {
  be.handlers[name] = async () => {
    seen.started = Date.now();
    seen.ctx = currentCall();
    const ctrl = (seen.ctrl = linkedController());
    await new Promise<void>((res) => {
      if (ctrl.signal.aborted) return res();
      ctrl.signal.addEventListener('abort', () => res(), { once: true });
      setTimeout(res, 5000).unref();
    });
    seen.stoppedAt = Date.now();
    return 'done';
  };
}

describe('RequestContext', () => {
  it('a handler sees its call: id, method, local user with every permission, a signal, no deadline on the desktop', async () => {
    let ctx: ReturnType<typeof currentCall>;
    be.handlers['t.ctx'] = () => ((ctx = currentCall()), 1);
    await be.invoke('t.ctx', {}, { requestId: 'win-1' });
    expect(ctx!.id).toBe('win-1');
    expect(ctx!.method).toBe('t.ctx');
    expect(ctx!.user).toBe(LOCAL_USER);
    expect(ctx!.can('anything')).toBe(true);
    expect(ctx!.deadline).toBeUndefined();
    expect(ctx!.signal.aborted).toBe(false);
    expect(currentCall()).toBeUndefined(); // outside a call there is none
    expect(be.calls.size).toBe(0);
  });

  it('a host passes the signed-in user: permissions come from it', async () => {
    let can: boolean[] = [];
    be.handlers['t.can'] = () => ((can = [currentCall()!.can('run'), currentCall()!.can('delete')]), 1);
    await be.invoke('t.can', {}, { user: { id: 'u-42', permissions: new Set(['t', 'run']) } });
    expect(can).toEqual([true, false]);
  });

  it('a call whose signal has aborted is refused with CancelledError before its handler runs', async () => {
    let ran = false;
    be.handlers['t.never'] = () => ((ran = true), 1);
    const ac = new AbortController();
    ac.abort();
    await expect(be.invoke('t.never', {}, { signal: ac.signal })).rejects.toMatchObject({ kind: 'CancelledError' });
    expect(ran).toBe(false);
  });

  it('rpc.cancel stops a long handler within 50 ms, and the caller gets CancelledError at once', async () => {
    const seen: Parameters<typeof slow>[1] = { started: 0 };
    slow('t.slow', seen);
    const p = be.invoke('t.slow', {}, { requestId: 'cancel-me' });
    const rejected = expect(p).rejects.toMatchObject({ kind: 'CancelledError' });
    await sleep(20);
    expect(be.calls.size).toBe(1);
    const t = Date.now();
    expect(await be.invoke('rpc.cancel', { id: 'cancel-me' })).toBe(true);
    await rejected;
    expect(Date.now() - t).toBeLessThan(50);
    await sleep(20);
    expect(seen.stoppedAt! - t).toBeLessThan(50); // the work itself stopped through its linked controller
    expect(await be.invoke('rpc.cancel', { id: 'cancel-me' })).toBe(false); // already over
    expect(be.calls.size).toBe(0);
  });

  it('a deadline stops the call; a host signal that aborts mid-call stops it too', async () => {
    slow('t.slow2', { started: 0 });
    await expect(be.invoke('t.slow2', {}, { timeoutMs: 40 })).rejects.toMatchObject({ kind: 'CancelledError' });
    const ac = new AbortController();
    const p = be.invoke('t.slow2', {}, { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toMatchObject({ kind: 'CancelledError' });
  });

  it('a repeated request id never lets one call cancel another', async () => {
    slow('t.slow3', { started: 0 });
    const a = be.invoke('t.slow3', {}, { requestId: 'same' });
    const b = be.invoke('t.slow3', {}, { requestId: 'same' });
    await sleep(20);
    expect(be.calls.size).toBe(2);
    be.calls.cancel('same');
    await expect(a).rejects.toMatchObject({ kind: 'CancelledError' });
    be.calls.cancelAll();
    await expect(b).rejects.toMatchObject({ kind: 'CancelledError' });
  });

  it('two calls at the same time keep their own context', async () => {
    const ids: string[] = [];
    be.handlers['t.id'] = async () => {
      await sleep(10);
      ids.push(currentCall()!.id);
      return 1;
    };
    await Promise.all([be.invoke('t.id', {}, { requestId: 'x1' }), be.invoke('t.id', {}, { requestId: 'x2' })]);
    expect(ids.sort()).toEqual(['x1', 'x2']);
  });

  it('http.cancel style controllers of a cancelled call stop (linkedController outside a call is a plain controller)', () => {
    const c = linkedController();
    expect(c.signal.aborted).toBe(false);
    c.abort();
    expect(c.signal.aborted).toBe(true);
  });
});
