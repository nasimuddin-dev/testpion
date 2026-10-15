import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { consoleRefs } from '../../apps/desktop/backend/console-log.js';
import { WorkspaceStore } from '../../packages/core/src/index.js';
import { tempDir, waitFor } from '../helpers.js';

// WF-16: the Console, Traces and History name what they belong to, as refs: a send from a saved request links its
// History entry and trace; a run's request links the run (and result), the trace and the saved request.
const tmp = tempDir('tp-links-');
let server: Server;
let base = '';
let be: Backend;

beforeAll(async () => {
  server = createServer((_req, res) => res.end('{"ok":true}'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const root = join(tmp.dir, 'ws');
  const s = WorkspaceStore.create(root, 'Links');
  s.saveCollection({
    schemaVersion: '1.0',
    id: 'c1',
    name: 'Links',
    version: 0,
    updatedAt: '',
    variables: [],
    items: [{ kind: 'http', id: 'r1', name: 'Ping', request: { method: 'GET', url: `${base}/ping`, headers: [] } }],
  } as never);
  s.close();
  be = new Backend({ appDir: join(tmp.dir, 'app'), emit: () => undefined, noMonitors: true });
  be.openStore(root);
});
afterAll(async () => {
  await be.dispose();
  server.close();
  tmp.cleanup();
});

describe('Console ↔ History ↔ Traces', () => {
  it('a send from a saved request: the console entry links the request, its History entry and its trace', async () => {
    const r = (await be.invoke('http.send', { request: { method: 'GET', url: `${base}/ping`, headers: [] }, collectionId: 'c1', requestId: 'r1', name: 'Ping' })) as {
      historyId: string;
      traceId: string;
    };
    const e = be.consoleBuffer.at(-1)!;
    expect(e.refs).toEqual([
      { kind: 'request', collectionId: 'c1', requestId: 'r1' },
      { kind: 'history', historyId: r.historyId },
      { kind: 'trace', traceId: r.traceId },
    ]);
    // the trace names the same request and History entry
    const t = (await be.invoke('traces.get', { id: r.traceId })) as { refs?: unknown[] };
    expect(t.refs).toEqual([
      { kind: 'request', collectionId: 'c1', requestId: 'r1' },
      { kind: 'history', historyId: r.historyId },
    ]);
    expect(be.ws.meta.historyOfTrace(r.traceId)?.id).toBe(r.historyId);
  });

  it('a request that failed links its History entry and trace too', async () => {
    await be.invoke('http.send', { request: { method: 'GET', url: 'http://127.0.0.1:9/down', headers: [] }, name: 'Down' });
    const e = be.consoleBuffer.at(-1)!;
    expect(e.refs?.map((r) => r.kind)).toEqual(['history', 'trace']);
  });

  it("a collection run's requests link their run and result, and the saved request", async () => {
    const { runId } = (await be.invoke('col.run', { collectionId: 'c1' })) as { runId: string };
    await waitFor(() => be.consoleBuffer.some((x) => x.source === 'run' && x.refs?.some((r) => r.kind === 'run' && r.runId === runId)), 10_000, 'the run');
    const e = be.consoleBuffer.find((x) => x.source === 'run' && x.refs?.some((r) => r.kind === 'run' && r.runId === runId))!;
    expect(e.refs).toContainEqual({ kind: 'request', collectionId: 'c1', requestId: 'r1' });
    expect(e.refs).toContainEqual(expect.objectContaining({ kind: 'run', runId, resultId: expect.stringMatching(/^r1@1/) }));
  });

  it('refs leave out what is not there', () => {
    expect(consoleRefs({})).toBeUndefined();
    expect(consoleRefs({ collectionId: 'c' })).toBeUndefined();
    expect(consoleRefs({ traceId: 't' })).toEqual([{ kind: 'trace', traceId: 't' }]);
  });
});
