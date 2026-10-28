import { beforeEach, describe, expect, it, vi } from 'vitest';

// A command that outlives its timeout takes its children with it: on Windows the whole tree (taskkill /T), elsewhere the process group.
const calls: { kill: number[][]; tree: Array<number | null | undefined> } = { kill: [], tree: [] };
let childPid = 4242;
vi.mock('../../packages/core/src/net/process.js', async (orig) => {
  const real = await orig<typeof import('../../packages/core/src/net/process.js')>();
  return {
    ...real,
    killProcessTree: (pid: number | null | undefined) => void calls.tree.push(pid),
    // a command that never answers
    execFileChecked: (_w: string, _f: string, _a: string[], _o: object, cb: (e: Error | null, out: string, err: string) => void) => ({
      pid: childPid,
      kill: () => (calls.kill.push([childPid]), cb(new Error('killed'), '', '')),
    }),
  };
});

import { killProcessTree as realKill } from '../../packages/core/src/net/process.js';
const { killProcessTree } = await vi.importActual<typeof import('../../packages/core/src/net/process.js')>('../../packages/core/src/net/process.js');
import { fetchSecretRef } from '../../packages/core/src/vars/external-secrets.js';

beforeEach(() => {
  calls.kill.length = 0;
  calls.tree.length = 0;
});

describe('killProcessTree', () => {
  it('Windows: taskkill /PID <pid> /T /F', () => {
    const seen: string[][] = [];
    killProcessTree(777, { platform: 'win32', taskkill: (a) => void seen.push(a) });
    expect(seen).toEqual([['/PID', '777', '/T', '/F']]);
  });

  it('POSIX: the process group first, the process alone when it leads none', () => {
    const sent: Array<[number, string]> = [];
    killProcessTree(777, { platform: 'linux', kill: (p, s) => void sent.push([p, s]) });
    expect(sent).toEqual([[-777, 'SIGKILL']]);
    sent.length = 0;
    killProcessTree(777, {
      platform: 'linux',
      kill: (p, s) => {
        sent.push([p, s]);
        if (p < 0) throw Object.assign(new Error('no such group'), { code: 'ESRCH' });
      },
    });
    expect(sent).toEqual([
      [-777, 'SIGKILL'],
      [777, 'SIGKILL'],
    ]);
  });

  it('no pid, or one that is gone, is not an error', () => {
    expect(() => killProcessTree(undefined, { platform: 'win32', taskkill: () => assertNever() })).not.toThrow();
    expect(() =>
      killProcessTree(5, {
        platform: 'linux',
        kill: () => {
          throw new Error('gone');
        },
      }),
    ).not.toThrow();
    expect(realKill).toBeTypeOf('function');
  });
});

function assertNever(): never {
  throw new Error('should not run');
}

describe('a secret manager command that never answers', () => {
  it('is ended with its whole tree at the timeout (not only the shell)', async () => {
    childPid = 4242;
    await expect(fetchSecretRef('azure-kv://vault/secret', { timeoutMs: 40 })).rejects.toThrow(/did not answer within/);
    expect(calls.tree).toEqual([4242]);
    expect(calls.kill).toEqual([[4242]]);
  });
});

import { TracingTransport } from '../../packages/core/src/protocols/mcp/client.js';

describe('an MCP server started through npx', () => {
  const fakeStdio = (leaves: boolean) => {
    const inner: Record<string, unknown> = { pid: 5150, start: async () => undefined, send: async () => undefined };
    inner.close = () => new Promise<void>((resolve) => (leaves ? resolve() : setTimeout(resolve, 2000)));
    return inner as never;
  };

  it('is ended with everything it started when it has not left 1.5 s after its input closed', async () => {
    vi.useFakeTimers();
    try {
      const t = new TracingTransport(fakeStdio(false), () => undefined);
      const closing = t.close();
      await vi.advanceTimersByTimeAsync(1400);
      expect(calls.tree).toEqual([]);
      await vi.advanceTimersByTimeAsync(200);
      expect(calls.tree).toEqual([5150]);
      await vi.advanceTimersByTimeAsync(1000);
      await closing;
    } finally {
      vi.useRealTimers();
    }
  });

  it('a server that leaves by itself is not killed', async () => {
    const t = new TracingTransport(fakeStdio(true), () => undefined);
    await t.close();
    expect(calls.tree).toEqual([]);
  });

  it('one that never answered the handshake is ended at once, tree and all', async () => {
    const t = new TracingTransport(fakeStdio(true), () => undefined);
    await t.abandon();
    expect(calls.tree).toEqual([5150]);
  });
});
