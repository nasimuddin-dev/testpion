import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { ApsError } from '../../packages/core/src/index.js';

/**
 * Robustness audit (2026-10-09): every backend RPC handler called with bad input. Records per call whether it
 * throws an ApsError (good), throws any other Error (a raw TypeError etc. reaches the user as "ProtocolError"),
 * returns, hangs > 2 s, or causes an unhandled rejection / uncaught exception; and whether anything is written
 * outside the sandbox's data folders (path traversal). The results go to AUDIT_OUT (JSON). Opt-in (AUDIT_RPC=1):
 * it takes minutes, and it only records, so the suite stays green.
 */
const OUT = process.env.AUDIT_OUT ?? join(tmpdir(), 'audit-rpc-fuzz.json');
const SKIP = new Set([
  'debug.systemProxy', // changes the OS proxy
  'debug.openBrowser', // launches a browser
  'debug.openTerminal', // launches a terminal
  'debug.certificate', // may install a CA in the OS trust store
  'debug.start',
  'git.push',
  'git.sync',
]);

function handlerKeys(): Map<string, string[]> {
  const m = new Map<string, string[]>();
  const dir = join(__dirname, '../../apps/desktop/backend/handlers');
  const files = [...readdirSync(dir).map((f) => join(dir, f)), join(__dirname, '../../apps/desktop/backend/backend.ts')];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const x of src.matchAll(/'([a-zA-Z]+\.[a-zA-Z0-9.]+)':\s*(?:async\s*)?\(\{([^}]*)\}/g)) {
      const keys = x[2]!
        .split(',')
        .map((k) => k.trim().split(/[:=\s]/)[0]!.replace(/^\.\.\./, ''))
        .filter((k) => /^[a-zA-Z_]\w*$/.test(k));
      m.set(x[1]!, keys);
    }
  }
  return m;
}

const GENERIC = ['id', 'name', 'path', 'file', 'dir', 'collectionId', 'requestId', 'environment', 'workspace', 'url', 'folderId', 'from', 'to', 'key', 'value', 'branch', 'ref', 'content', 'text', 'data', 'ids', 'items', 'request', 'spec', 'monitor', 'query', 'target', 'source'];
const HUGE = 'x'.repeat(10 * 1024 * 1024);

type Outcome = { method: string; variant: string; outcome: 'aps' | 'other' | 'returns' | 'hang' | 'skip'; kind?: string; message?: string; ms: number };

function walk(dir: string, acc: Map<string, number> = new Map()): Map<string, number> {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    try {
      if (e.isDirectory()) walk(p, acc);
      else acc.set(p, statSync(p).mtimeMs);
    } catch {
      /* raced */
    }
  }
  return acc;
}

describe.skipIf(!process.env.AUDIT_RPC)('audit: RPC handlers with bad input', () => {
  it('records every handler x bad input', { timeout: 3_600_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'tp-audit-rpc-'));
    const outside = join(root, 'outside');
    mkdirSync(join(outside, 'AUDITX-abs'), { recursive: true });
    writeFileSync(join(outside, 'AUDITX-abs', 'workspace.json'), '{"sentinel":true}');
    writeFileSync(join(outside, 'AUDITX-abs.json'), '{"sentinel":true}');
    const keysOf = handlerKeys();
    const results: Outcome[] = [];
    const unhandled: Array<{ during: string; type: string; message: string; stack?: string }> = [];
    let current = '';
    const saved = { r: process.listeners('unhandledRejection'), u: process.listeners('uncaughtException') };
    process.removeAllListeners('unhandledRejection');
    process.removeAllListeners('uncaughtException');
    const rec = (type: string) => (e: unknown) =>
      unhandled.push({ during: current, type, message: String((e as Error)?.message ?? e).slice(0, 300), stack: (e as Error)?.stack?.split('\n').slice(0, 8).join('\n') });
    const onRej = rec('unhandledRejection');
    const onExc = rec('uncaughtException');
    process.on('unhandledRejection', onRej);
    process.on('uncaughtException', onExc);
    const externals: string[] = [];
    const before = walk(outside);
    const only = process.env.AUDIT_ONLY?.split(',');
    try {
      let n = 0;
      const probe = new Backend({ appDir: join(root, 'probe'), emit: () => {}, noMonitors: true });
      const methods = Object.keys(probe.handlers)
        .sort()
        .filter((m) => !only || only.some((o) => m.startsWith(o)));
      await probe.dispose();
      for (const method of methods) {
        if (SKIP.has(method)) {
          results.push({ method, variant: '*', outcome: 'skip', ms: 0 });
          continue;
        }
        // a fresh home per handler: one that deletes / switches the workspace doesn't spoil the rest
        const home = join(root, `h${n++}`);
        const be = new Backend({
          appDir: home,
          emit: () => {},
          noMonitors: true,
          openExternal: (u) => void externals.push(`${method}: ${u}`),
          openPath: (p) => void externals.push(`${method}: openPath ${p}`),
          openDialog: async () => undefined,
          saveDialog: async () => undefined,
        });
        const wsRoot = (be as unknown as { store?: { root: string } }).store?.root ?? home;
        const rel = relative(wsRoot, join(outside, 'AUDITX-rel'));
        const keys = [...new Set([...(keysOf.get(method) ?? []), ...GENERIC])];
        const fill = (v: unknown) => Object.fromEntries(keys.map((k) => [k, v]));
        const variants: Array<[string, unknown]> = [
          ['undefined', undefined],
          ['null', null],
          ['{}', {}],
          ['number', 42],
          ['string', 'x'],
          ['array', []],
          ['keys=number', fill(12345)],
          ['keys=object', fill({})],
          ['keys=null', fill(null)],
          ['keys=unknown-id', fill('nope-unknown-id')],
          ['keys=../traversal', fill(rel)],
          ['keys=abs-outside', fill(join(outside, 'AUDITX-abs'))],
          ['keys=10MB', fill(HUGE)],
        ];
        const h = be.handlers[method]!;
        for (const [variant, params] of variants) {
          current = `${method} ${variant}`;
          const t0 = Date.now();
          let timer: ReturnType<typeof setTimeout> | undefined;
          const hang = new Promise<'hang'>((r) => (timer = setTimeout(() => r('hang'), 2000)));
          let o: Outcome;
          try {
            // the same `params ?? {}` as Backend.invoke
            const r = await Promise.race([Promise.resolve().then(() => h(params ?? {})), hang]);
            o = { method, variant, outcome: r === 'hang' ? 'hang' : 'returns', ms: Date.now() - t0 };
          } catch (e) {
            if (e instanceof ApsError) o = { method, variant, outcome: 'aps', kind: e.kind, message: e.message.slice(0, 200), ms: Date.now() - t0 };
            else o = { method, variant, outcome: 'other', kind: (e as Error)?.constructor?.name ?? typeof e, message: String((e as Error)?.message ?? e).slice(0, 200), ms: Date.now() - t0 };
          } finally {
            clearTimeout(timer);
          }
          results.push(o);
        }
        current = `${method} (after)`;
        try {
          await Promise.race([Promise.resolve(be.handlers['ws.current']!({})), new Promise((_, j) => setTimeout(() => j(new Error('ws.current hang')), 2000))]);
        } catch (e) {
          results.push({ method, variant: 'after:ws.current', outcome: 'other', message: String((e as Error).message).slice(0, 200), ms: 0 });
        }
        current = `${method} (dispose)`;
        await Promise.race([be.dispose(), new Promise((r) => setTimeout(r, 3000))]).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 1000));
    } finally {
      process.removeListener('unhandledRejection', onRej);
      process.removeListener('uncaughtException', onExc);
      for (const l of saved.r) process.on('unhandledRejection', l as never);
      for (const l of saved.u) process.on('uncaughtException', l as never);
    }
    const after = walk(outside);
    const outsideChanges = [...new Set([...before.keys(), ...after.keys()])]
      .filter((p) => before.get(p) !== after.get(p))
      .map((p) => `${before.has(p) ? (after.has(p) ? 'modified' : 'deleted') : 'created'} ${p}`);
    const strays = [...walk(root).keys()].filter((p) => /AUDITX/.test(p) && !p.startsWith(outside));
    writeFileSync(OUT, JSON.stringify({ root, results, unhandled, outsideChanges, strays, externals }, null, 1));
    const bad = results.filter((r) => r.outcome === 'other' || r.outcome === 'hang');
    console.log(`audit: ${results.length} calls, ${bad.length} non-ApsError/hang, ${unhandled.length} unhandled, ${outsideChanges.length} outside writes -> ${OUT}`);
    expect(results.length).toBeGreaterThan(100);
  });
});
