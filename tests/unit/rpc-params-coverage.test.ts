import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { RPC_PARAMS, hostPathsOf } from '../../apps/desktop/backend/rpc-params.js';

// Every RPC handler checks its parameters before it runs (rpc-params.ts), so a host that is not the window (the web
// bridge, a cloud server, an agent) gets "<method>: missing <param>" instead of a TypeError from deep inside. A handler
// that takes nothing has an empty entry. A handler without an entry must be on tests/fixtures/rpc-params-without-entry.txt:
// the handlers that predate the rule (their only caller is the app's own window, which sends what the handler reads).
// That list only ever shrinks: a new handler is not on it, so adding one means adding its entry.
const PREDATES_THE_RULE = 'predates the table: only the app window calls it, with the parameters its handler reads';
const LEGACY = readFileSync(join(__dirname, '..', 'fixtures', 'rpc-params-without-entry.txt'), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean);
const NO_ENTRY: Record<string, string> = Object.fromEntries(LEGACY.map((m) => [m, PREDATES_THE_RULE]));

const dir = mkdtempSync(join(tmpdir(), 'tp-rpc-cover-'));
const be = new Backend({ appDir: dir, emit: () => {}, noMonitors: true });
afterAll(() => {
  // best effort: a database file can stay held for a moment on Windows (the temp folder is cleaned up anyway)
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* left for the OS */
  }
});

describe('RPC parameter tables', () => {
  it('every handler registered in the backend has a parameter entry, or is on the list of those that predate the rule', () => {
    const handlers = Object.keys(be.handlers);
    expect(handlers.length).toBeGreaterThan(200);
    expect(handlers.filter((h) => !Object.hasOwn(RPC_PARAMS, h) && !NO_ENTRY[h]).sort()).toEqual([]);
  });

  it('the handlers the security review named have entries (RAG, bundle imports, large files)', () => {
    for (const m of ['rag.estimate', 'rag.metricCheck', 'rag.metric.try', 'rag.matrix', 'rag.sample', 'rag.compare', 'rag.rescore', 'rag.columns', 'rag.importBeir', 'bundle.imports', 'git.large', 'git.largeCheck'])
      expect(RPC_PARAMS[m], m).toBeDefined();
  });

  it('every parameter that names a place on the host computer is typed p (a path) or pn (a name or a path): the host-path gate enumerates them', () => {
    const expected: Array<[string, string, string]> = [
      ['git.clone', 'dest', 'p?'],
      ['git.openFolder', 'path', 'p'],
      ['ws.open', 'ref', 'pn?'],
      ['col.previewDataFile', 'path', 'p'],
      ['terminal.create', 'cwd', 'p?'],
      ['bundle.preview', 'path', 'p?'],
    ];
    for (const [m, k, t] of expected) expect(RPC_PARAMS[m]?.[k], `${m}.${k}`).toBe(t);
    // whatever else is named like a host path (a working folder, a destination, a certificate or key file, proto files) must be one of them
    const hostNamed = /^(dest|cwd|certPath|keyPath|caPath|protoFiles)$/;
    const missing = Object.entries(RPC_PARAMS).flatMap(([m, spec]) => Object.entries(spec).filter(([k, t]) => hostNamed.test(k) && !/^(p|pn)\??$/.test(t) && !(m === 'grpc.grpcurl' && k === 'protoFiles')).map(([k]) => `${m}.${k}`));
    expect(missing).toEqual([]);
  });

  it('hostPathsOf lists the values of p parameters, and the values of pn parameters only when they look like a path', () => {
    expect(hostPathsOf('git.clone', { url: 'u', dest: '/tmp/x' })).toEqual(['/tmp/x']);
    expect(hostPathsOf('git.clone', { url: 'u' })).toEqual([]);
    expect(hostPathsOf('ws.open', { ref: 'My workspace' })).toEqual([]);
    for (const ref of ['/home/a/w', 'C:\\w', '\\\\server\\share', '~/w', 'file:///w']) expect(hostPathsOf('ws.open', { ref }), ref).toEqual([ref]);
  });

  it('no entry is for a handler that does not exist, and the list only shrinks: a handler that got an entry or went away is taken off it', () => {
    const handlers = new Set(Object.keys(be.handlers));
    expect(Object.keys(RPC_PARAMS).filter((m) => !handlers.has(m))).toEqual([]);
    expect(LEGACY.filter((m) => !handlers.has(m) || Object.hasOwn(RPC_PARAMS, m))).toEqual([]);
    expect(new Set(LEGACY).size).toBe(LEGACY.length);
  });
});
