/** A clinic API with two users, a local server that is vulnerable or secure, and the collection that calls it (security tests). */
import { createServer, type Server } from 'node:http';
import type { Collection, WorkspaceStore } from '../../packages/core/src/index.js';

export const TOKEN_A = 'tokA-owner-credential-1';
export const TOKEN_B = 'tokB-other-credential-2';

/** `vulnerable`: every request is answered, whoever sends it; `secure`: authentication and ownership are enforced. */
export async function clinicServer(mode: 'vulnerable' | 'secure'): Promise<{ server: Server; base: string; hits: string[]; close(): Promise<void> }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const auth = String(req.headers.authorization ?? '');
    const token = auth.replace(/^Bearer\s+/i, '');
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      hits.push(`${req.method} ${req.url} ${token ? `as ${token === TOKEN_A ? 'A' : token === TOKEN_B ? 'B' : 'invalid'}` : 'anonymous'}`);
      const send = (status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      };
      const owner = { id: 7, name: 'Rex', email: 'owner@example.com', role: 'user' };
      const url = req.url ?? '';
      if (mode === 'vulnerable') {
        if (req.method === 'POST' && url.startsWith('/patients')) {
          // accepts and returns whatever it is sent (mass assignment)
          let body: Record<string, unknown> = {};
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          } catch {
            /* not JSON */
          }
          return send(201, { id: 9, ...body });
        }
        return send(200, url.startsWith('/admin') ? { users: 3 } : owner);
      }
      if (token !== TOKEN_A && token !== TOKEN_B) return send(401, { error: 'unauthorized' });
      if (url.startsWith('/admin')) return token === TOKEN_A ? send(200, { users: 3 }) : send(403, { error: 'forbidden' });
      if (req.method === 'POST' && url.startsWith('/patients')) {
        let name = 'new';
        try {
          name = (JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { name?: string }).name ?? name;
        } catch {
          /* not JSON */
        }
        return send(201, { id: 9, name, role: 'user' });
      }
      if (url.startsWith('/patients/7')) return token === TOKEN_A ? send(200, owner) : send(404, { error: 'not found' });
      send(200, [owner]);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { server, base, hits, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** The clinic collection (requests written for the owner, whose token is the collection's auth) and an environment with both tokens. */
export function addClinic(store: WorkspaceStore, base: string): Collection {
  const c: Collection = {
    schemaVersion: '1.0',
    id: 'clinic',
    name: 'Clinic',
    version: 1,
    variables: [{ key: 'patientId', value: '7', enabled: true }],
    auth: { type: 'bearer', token: '{{tokenA}}' },
    updatedAt: '2026-10-19T00:00:00Z',
    items: [
      { kind: 'http', id: 'r-list', name: 'List patients', request: { method: 'GET', url: '{{baseUrl}}/patients' } },
      {
        kind: 'http',
        id: 'r-get',
        name: 'Get patient',
        request: { method: 'GET', url: '{{baseUrl}}/patients/{{patientId}}' },
        examples: [{ id: 'e1', name: '200', status: 200, headers: [], body: JSON.stringify({ id: 7, name: 'Rex', email: 'owner@example.com', role: 'user' }) }],
      },
      { kind: 'http', id: 'r-create', name: 'Create patient', request: { method: 'POST', url: '{{baseUrl}}/patients', headers: [{ key: 'Content-Type', value: 'application/json' }], body: { type: 'json', content: '{"name":"Fido"}' } } },
      { kind: 'http', id: 'r-admin', name: 'Admin statistics', request: { method: 'GET', url: '{{baseUrl}}/admin/stats' } },
      { kind: 'http', id: 'r-delete', name: 'Delete patient', request: { method: 'DELETE', url: '{{baseUrl}}/patients/{{patientId}}' } },
    ],
  } as unknown as Collection;
  store.saveCollection(c);
  store.saveEnvironment({
    id: 'staging',
    name: 'staging',
    variables: [
      { key: 'baseUrl', value: base, enabled: true },
      { key: 'tokenA', value: TOKEN_A, enabled: true },
      { key: 'tokenB', value: TOKEN_B, enabled: true },
    ],
  } as never);
  store.saveEnvironment({ id: 'prod', name: 'prod', isProduction: true, variables: [{ key: 'baseUrl', value: base, enabled: true }] } as never);
  return c;
}
