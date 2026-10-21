import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Redactor, WorkspaceStore, historyToHar, type SavedHttpRequest } from '../../packages/core/src/index.js';
import { importAny } from '../helpers-import.js';

describe('history as HAR', () => {
  it('exports HTTP and GraphQL entries with bodies, masking secrets, and imports back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-har-'));
    const store = WorkspaceStore.create(join(dir, 'ws'), 'W');
    try {
      mkdirSync(store.path('payloads'), { recursive: true });
      const payload = store.path('payloads', 'p1.bin');
      writeFileSync(payload, '{"id":7,"token":"sk-live-abc123"}');
      store.meta.addHistory({
        id: 'h1',
        timestamp: '2026-09-30T01:00:00.000Z',
        kind: 'http',
        name: 'Create pet',
        method: 'POST',
        url: 'https://api.test/pets?api_key=k-123&page=1',
        status: 201,
        durationMs: 42,
        size: 34,
        request: { method: 'POST', url: '{{baseUrl}}/pets', headers: [{ key: 'Authorization', value: 'Bearer secret-token', enabled: true }, { key: 'Content-Type', value: 'application/json', enabled: true }], body: { type: 'json', content: '{"name":"Rex"}' } },
        responseMeta: { headers: [['content-type', 'application/json'], ['set-cookie', 'sid=abc']], timing: { dnsMs: 3, tcpMs: 10, tlsMs: 20, ttfbMs: 7, downloadMs: 2, totalMs: 42, reusedConnection: false } },
        payloadPath: payload,
      });
      store.meta.addHistory({ id: 'h2', timestamp: '2026-09-30T01:01:00.000Z', kind: 'graphql', name: 'Who', method: 'POST', url: 'https://api.test/graphql', status: 200, durationMs: 5, request: { endpoint: '{{gql}}', query: '{ me { id } }', variables: '{"a":1}' } });
      store.meta.addHistory({ id: 'h3', timestamp: '2026-09-30T01:02:00.000Z', kind: 'mcp', name: 'tool', status: 'ok' });

      const redactor = new Redactor();
      redactor.addSecret('sk-live-abc123');
      const har = historyToHar(store, store.meta.listHistory({ limit: 10 }).items, redactor) as { log: { version: string; entries: any[] } };
      expect(har.log.version).toBe('1.2');
      expect(har.log.entries).toHaveLength(2);
      const e = har.log.entries.find((x) => x.comment === 'Create pet');
      expect(e.request.url).toBe('https://api.test/pets?api_key=REDACTED&page=1');
      expect(e.request.headers).toContainEqual({ name: 'Authorization', value: '[REDACTED]' });
      expect(e.request.postData).toEqual({ mimeType: 'application/json', text: '{"name":"Rex"}' });
      expect(e.response.status).toBe(201);
      // the phases kept with the response; HAR's connect includes the TLS time
      expect(e.timings).toEqual({ blocked: -1, dns: 3, connect: 30, ssl: 20, send: 0, wait: 7, receive: 2 });
      expect(e.response.headers).toContainEqual({ name: 'set-cookie', value: '[REDACTED]' });
      expect(e.response.content.text).toBe('{"id":7,"token":"[REDACTED]"}');
      const g = har.log.entries.find((x) => x.comment === 'Who');
      expect(JSON.parse(g.request.postData.text)).toEqual({ query: '{ me { id } }', variables: { a: 1 } });
      expect(g.timings).toEqual({ send: 0, wait: 5, receive: 0 });

      // the HAR importer reads it back as requests
      const back = importAny(JSON.stringify(har));
      expect(back.format).toBe('har');
      const reqs = back.collection!.items as SavedHttpRequest[];
      expect(reqs.map((r) => r.request.method)).toEqual(expect.arrayContaining(['POST']));
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
