import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { recordingTools } from '../../packages/core/src/mcp-server/recording-tools.js';
import { copyExample } from '../helpers.js';
import {
  flowFromExchanges,
  flowFromHar,
  loadTestsFromFile,
  McpManager,
  noiseReason,
  ProviderRegistry,
  recordedFlowPath,
  Redactor,
  runTests,
  VariableScope,
  WorkspaceManager,
  type ExecServices,
  type FlowSourceExchange,
  type TestResult,
} from '../../packages/core/src/index.js';

// Record a flow: exchanges the HTTP Debugger captured become a flow file whose steps pass values along (a token into
// a later Authorization header, an id into a URL and a body, a pagination cursor into a query), with noise left out
// and secrets never written. The flow it makes runs against the API again, with fresh tokens and ids.
const PASSWORD = 'pw-correct-horse';
const API_KEY = 'key-live-123456';
let server: Server;
let base = '';
const dir = mkdtempSync(join(tmpdir(), 'tp-flow-record-'));

beforeAll(async () => {
  const tokens = new Set<string>();
  const pets = new Map<string, { id: string; name: string; chip: number; ownerId: string }>();
  const cursors = new Set<string>();
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (status: number, data: unknown, headers: Record<string, string | string[]> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(data));
      };
      const u = new URL(req.url ?? '/', 'http://x');
      if (req.headers['x-api-key'] !== API_KEY) return send(401, { error: 'api key' });
      if (u.pathname === '/auth/login' && req.method === 'POST') {
        const b = JSON.parse(body || '{}');
        if (b.password !== PASSWORD) return send(401, { error: 'bad password' });
        const t = `tok-${randomUUID().replace(/-/g, '')}`;
        tokens.add(t);
        return send(
          200,
          { access_token: t, token_type: 'Bearer', expires_in: 3600, user: { id: `usr_${randomUUID().slice(0, 6)}`, name: b.username } },
          { 'set-cookie': `sid=${randomUUID()}; Path=/; HttpOnly` },
        );
      }
      const token = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
      if (!token || !tokens.has(token)) return send(403, { error: 'token' });
      if (u.pathname === '/me') return send(200, { ok: true });
      if (u.pathname === '/pets' && req.method === 'POST') {
        const b = JSON.parse(body);
        const pet = { id: randomUUID(), name: b.name, chip: 100000000 + Math.floor(Math.random() * 800000000), ownerId: b.ownerId };
        pets.set(pet.id, pet);
        return send(201, pet, { location: `/pets/${pet.id}` });
      }
      if (u.pathname === '/pets' && req.method === 'GET') {
        const c = u.searchParams.get('cursor');
        if (c && !cursors.has(c)) return send(400, { error: 'cursor' });
        const next = Buffer.from(`cursor:${randomUUID().slice(0, 8)}`).toString('base64');
        cursors.add(next);
        return send(200, { items: [...pets.values()].slice(0, 2), next_cursor: next });
      }
      const m = /^\/pets\/([^/]+)$/.exec(u.pathname);
      const pet = m && pets.get(m[1]!);
      if (!pet) return send(404, { error: 'no pet' });
      if (req.method === 'GET') return send(200, pet);
      if (req.method === 'PUT') {
        const b = JSON.parse(body);
        if (b.chip !== pet.chip) return send(409, { error: 'chip' });
        return send(200, { ...pet, name: b.name });
      }
      send(405, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

let clock = Date.parse('2026-10-09T10:00:00Z');
/** Send a request and keep it as the Debugger would: an exchange with both sides. */
async function exchange(method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<FlowSourceExchange> {
  const requestBody = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  const reqHeaders: Record<string, string> = {
    'x-api-key': API_KEY,
    'user-agent': 'Mozilla/5.0',
    'accept-language': 'en',
    ...(requestBody && typeof body !== 'string' ? { 'content-type': 'application/json' } : {}),
    ...headers,
  };
  const r = await fetch(`${base}${path}`, { method, headers: reqHeaders, body: requestBody });
  const text = await r.text();
  return {
    id: `x${clock}`,
    startedAt: new Date((clock += 1000)).toISOString(),
    method,
    url: `${base}${path}`,
    requestHeaders: Object.fromEntries(Object.entries(reqHeaders).map(([k, v]) => [k.toLowerCase(), v])),
    requestBody,
    status: r.status,
    responseHeaders: Object.fromEntries([...r.headers.entries()]),
    responseBody: text,
    contentType: r.headers.get('content-type') ?? undefined,
  };
}
const noise = (method: string, url: string, contentType: string, extra: Partial<FlowSourceExchange> = {}): FlowSourceExchange => ({
  id: `n${clock}`,
  startedAt: new Date((clock += 10)).toISOString(),
  method,
  url,
  requestHeaders: {},
  status: 200,
  contentType,
  ...extra,
});

function services(env: Record<string, string>): ExecServices {
  const vars = new VariableScope();
  vars.setScope('environment', env);
  const redactor = new Redactor();
  return { vars, providers: new ProviderRegistry([], vars, redactor), mcp: new McpManager(() => undefined), mcpServers: [], redactor, pricing: [], defaultTimeoutMs: 10_000 };
}

async function runFlowText(text: string, env: Record<string, string>) {
  const p = join(dir, `flow-${Math.random().toString(36).slice(2)}.yaml`);
  writeFileSync(p, text);
  const results = new Map<string, TestResult>();
  await runTests({ name: 'recorded', tests: loadTestsFromFile(p), services: services(env), concurrency: 1, onEvent: (e) => void (e.type === 'test-end' && results.set(e.result.id, e.result)) });
  return Object.fromEntries(
    [...results].map(([k, r]) => [k.split('#').pop()!, `${r.status}${r.status === 'passed' ? '' : `: ${r.checks.find((c) => !c.passed)?.message ?? r.error?.message ?? ''}`}`]),
  );
}

describe('flowFromExchanges', () => {
  it('turns a login → token → create → id → pagination session into a flow that runs again', async () => {
    const login = await exchange('POST', '/auth/login', {}, { username: 'ada', password: PASSWORD });
    const auth = JSON.parse(login.responseBody!);
    const bearer = { authorization: `Bearer ${auth.access_token}`, cookie: `sid=${/sid=([^;]+)/.exec(login.responseHeaders!['set-cookie']!)![1]}; _ga=GA1.2.33` };
    const assets = [
      noise('GET', `${base}/static/app.js`, 'application/javascript'),
      noise('GET', 'https://www.google-analytics.com/g/collect?v=2', 'text/plain'),
      noise('OPTIONS', `${base}/pets`, ''),
    ];
    const me = await exchange('GET', '/me', bearer);
    const created = await exchange('POST', '/pets', bearer, { name: 'Rex', ownerId: auth.user.id });
    const pet = JSON.parse(created.responseBody!);
    const read = await exchange('GET', `/pets/${pet.id}`, bearer);
    const update = await exchange('PUT', `/pets/${pet.id}`, bearer, { id: pet.id, name: 'Rex II', chip: pet.chip });
    const page1 = await exchange('GET', '/pets?limit=2', bearer);
    const cursor = JSON.parse(page1.responseBody!).next_cursor as string;
    const page2 = await exchange('GET', `/pets?limit=2&cursor=${encodeURIComponent(cursor)}`, bearer);
    for (const e of [login, me, created, read, update, page1, page2]) expect(e.status, e.url).toBeLessThan(300);

    // given out of order: steps follow the time the requests were made
    const r = flowFromExchanges([page2, ...assets, login, me, created, read, update, page1], { name: 'Pets', recordedAt: '2026-10-09T10:00:00Z' });
    expect(r.steps.map((s) => `${s.method} ${s.id}`)).toEqual(['POST post-login', 'GET get-me', 'POST post-pets', 'GET get-pets', 'PUT put-pets', 'GET get-pets-2', 'GET get-pets-3']);
    // noise is left out, with why
    expect(r.dropped.map((d) => d.reason).sort()).toEqual(['a CORS preflight', 'a static asset', 'analytics / telemetry']);

    const doc = parse(r.text) as { name: string; defaults: { variables: Record<string, string> }; tests: Array<Record<string, any>> };
    const step = (id: string) => doc.tests.find((t) => t.id === id)!;
    expect(doc.name).toBe('Pets');
    expect(doc.defaults.variables).toEqual({ baseUrl: base });
    // the token: extracted from the login, used in every later Authorization header
    expect(step('post-login').extract).toMatchObject({ accessToken: '$.access_token', userId: '$.user.id' });
    expect(step('get-me').headers.Authorization).toBe('Bearer {{accessToken}}');
    expect(step('get-me').dependsOn).toEqual(['post-login']);
    // the session cookie goes through the cookie jar (and the analytics cookie is dropped)
    expect(step('get-me').headers.Cookie).toBeUndefined();
    expect(r.links).toContainEqual(expect.objectContaining({ source: 'cookie jar', from: 'post-login', to: 'get-me' }));
    // the id: in the URL path, in the body; a number keeps its type in a JSON body
    expect(step('post-pets').extract).toMatchObject({ petId: '$.id', chip: '$.chip' });
    expect(step('post-pets').body).toEqual({ name: 'Rex', ownerId: '{{userId}}' });
    expect(step('get-pets').url).toBe('{{baseUrl}}/pets/{{petId}}');
    expect(step('get-pets').dependsOn).toEqual(['post-login', 'post-pets']);
    expect(step('put-pets').body.type).toBe('json');
    expect(JSON.parse(step('put-pets').body.content.replace('{{chip}}', '1'))).toEqual({ id: '{{petId}}', name: 'Rex II', chip: 1 });
    expect(step('put-pets').body.content).toMatch(/"chip": \{\{chip\}\}/);
    // the pagination cursor: from the first page into the next one's query
    expect(step('get-pets-2').extract).toMatchObject({ nextCursor: '$.next_cursor' });
    expect(step('get-pets-3').url).toBe('{{baseUrl}}/pets?limit=2&cursor={{nextCursor}}');
    // checks: the recorded status
    expect(step('post-pets').assertions).toEqual([{ type: 'status', expected: 201 }]);
    // the links the dialog shows
    expect(r.links).toContainEqual({ variable: 'accessToken', from: 'post-login', fromIndex: 1, to: 'get-me', toIndex: 2, source: '$.access_token', target: 'Authorization header' });
    expect(r.links).toContainEqual(expect.objectContaining({ variable: 'petId', from: 'post-pets', to: 'get-pets', target: 'URL path' }));
    expect(r.links).toContainEqual(expect.objectContaining({ variable: 'nextCursor', to: 'get-pets-3', target: 'query cursor' }));

    // secrets: never in the file, listed to set
    for (const s of [PASSWORD, API_KEY, auth.access_token, pet.id, cursor]) expect(r.text).not.toContain(s);
    expect(step('post-login').body.password).toBe('{{password}}');
    expect(step('post-login').headers['X-Api-Key']).toBe('{{apiKey}}');
    expect(r.secrets.sort()).toEqual(['apiKey', 'password']);
    expect(r.text).toMatch(/Set \{\{password\}\}, \{\{apiKey\}\}|Set \{\{apiKey\}\}, \{\{password\}\}/);
    // browser noise headers are not part of a step
    expect(JSON.stringify(doc.tests)).not.toMatch(/Mozilla|accept-language|_ga/i);

    // it runs again: a new token, a new pet, a new cursor, each passed along
    const status = await runFlowText(r.text, { password: PASSWORD, apiKey: API_KEY });
    expect(status).toEqual({ 'post-login': 'passed', 'get-me': 'passed', 'post-pets': 'passed', 'get-pets': 'passed', 'put-pets': 'passed', 'get-pets-2': 'passed', 'get-pets-3': 'passed' });
  });

  it('uses the environment: an origin and a secret it already has are used by name, nothing written for them', async () => {
    const login = await exchange('POST', '/auth/login', {}, { username: 'ada', password: PASSWORD });
    const me = await exchange('GET', '/me', { authorization: `Bearer ${JSON.parse(login.responseBody!).access_token}` });
    const r = flowFromExchanges([login, me], {
      environment: {
        name: 'Local',
        variables: [
          { key: 'petApi', value: `${base}/` },
          { key: 'adaPassword', value: PASSWORD, secret: true },
        ],
      },
    });
    const doc = parse(r.text) as { defaults?: unknown; tests: Array<Record<string, any>> };
    expect(doc.defaults).toBeUndefined();
    expect(doc.tests[0]!.url).toBe('{{petApi}}/auth/login');
    expect(doc.tests[0]!.body.password).toBe('{{adaPassword}}');
    expect(r.variables).toContainEqual(expect.objectContaining({ name: 'petApi', kind: 'origin', fromEnvironment: true }));
    expect(r.secrets).toEqual(['apiKey']);
    expect(await runFlowText(r.text, { petApi: base, adaPassword: PASSWORD, apiKey: API_KEY })).toEqual({ 'post-login': 'passed', 'get-me': 'passed' });
  });

  it('steps that share no value wait for the step before them; a second origin gets a variable of its own', () => {
    const at = (s: number) => new Date(Date.parse('2026-10-09T10:00:00Z') + s * 1000).toISOString();
    const e = (id: string, url: string, s: number, extra: Partial<FlowSourceExchange> = {}): FlowSourceExchange => ({
      id,
      method: 'GET',
      url,
      startedAt: at(s),
      requestHeaders: {},
      status: 200,
      contentType: 'application/json',
      responseBody: '{"ok":true}',
      ...extra,
    });
    const r = flowFromExchanges([e('a', 'https://api.example.com/health', 1), e('b', 'https://auth.example.com/.well-known/jwks.json', 2), e('c', 'https://api.example.com/version', 3)]);
    expect(r.steps.map((s) => s.dependsOn)).toEqual([[], ['get-health'], ['get-jwks-json']]);
    expect(r.steps.map((s) => s.url)).toEqual(['{{baseUrl}}/health', '{{authUrl}}/.well-known/jwks.json', '{{baseUrl}}/version']);
    expect(parse(r.text).defaults.variables).toEqual({ baseUrl: 'https://api.example.com', authUrl: 'https://auth.example.com' });
    // left out by the dialog
    expect(flowFromExchanges([e('a', 'https://api.example.com/health', 1), e('c', 'https://api.example.com/version', 3)], { drop: ['a'] }).steps.map((s) => s.exchangeId)).toEqual(['c']);
  });

  it('values the redactor knows and credential headers become variables; short and common values do not flow', () => {
    const red = new Redactor();
    red.addSecret('tenant-secret-999');
    const at = (s: number) => new Date(Date.parse('2026-10-09T10:00:00Z') + s * 1000).toISOString();
    const r = flowFromExchanges(
      [
        {
          id: '1',
          method: 'POST',
          url: 'https://x.test/orders',
          startedAt: at(1),
          requestHeaders: { 'content-type': 'application/json' },
          requestBody: '{"qty":1}',
          status: 201,
          responseBody: '{"id":7,"status":"ok","total":1,"currency":"application/json"}',
          contentType: 'application/json',
        },
        {
          id: '2',
          method: 'GET',
          url: 'https://x.test/orders/7?api_key=abcd1234zz',
          startedAt: at(2),
          requestHeaders: { 'x-tenant': 'tenant-secret-999', authorization: 'Basic dXNlcjpwYXNz', 'x-session-token': 'sess-998877', cookie: 'theme=dark' },
          status: 200,
          responseBody: '{}',
          contentType: 'application/json',
        },
      ],
      { redactor: red },
    );
    const t = parse(r.text).tests[1];
    expect(t.url).toBe('{{baseUrl}}/orders/7?api_key={{apiKey}}');
    expect(t.headers).toEqual({ 'X-Tenant': '{{tenant}}', Authorization: 'Basic {{basicCredentials}}', 'X-Session-Token': '{{sessionToken}}', Cookie: '{{cookie}}' });
    expect(t.dependsOn).toEqual(['post-orders']);
    expect(r.secrets.sort()).toEqual(['apiKey', 'basicCredentials', 'cookie', 'sessionToken', 'tenant']);
    for (const s of ['tenant-secret-999', 'dXNlcjpwYXNz', 'sess-998877', 'abcd1234zz', 'theme=dark']) expect(r.text).not.toContain(s);
    expect(r.links).toEqual([]);
  });

  it('a response header flows through a script line; the Location of a created item becomes its URL', () => {
    const at = (s: number) => new Date(Date.parse('2026-10-09T10:00:00Z') + s * 1000).toISOString();
    const r = flowFromExchanges([
      {
        id: '1',
        method: 'POST',
        url: 'https://x.test/uploads',
        startedAt: at(1),
        requestHeaders: {},
        status: 201,
        responseHeaders: { location: '/uploads/u-77aa', 'x-upload-ticket': 'TICKET-55aa66bb' },
        responseBody: '',
      },
      { id: '2', method: 'GET', url: 'https://x.test/uploads/u-77aa', startedAt: at(2), requestHeaders: { 'x-upload-ticket': 'TICKET-55aa66bb' }, status: 200 },
    ]);
    const [a, b] = parse(r.text).tests;
    expect(a.testScript).toContain("tp.variables.set('location', tp.response.headers.get('location'));");
    expect(a.testScript).toContain("tp.variables.set('uploadTicket', tp.response.headers.get('x-upload-ticket'));");
    expect(b.url).toBe('{{baseUrl}}{{location}}');
    expect(b.headers['X-Upload-Ticket']).toBe('{{uploadTicket}}');
    expect(r.steps[0]!.extract).toEqual({ location: 'header location', uploadTicket: 'header x-upload-ticket' });
  });

  it('noise: static assets, preflights, telemetry, page loads and tunnels; a configurable host list', () => {
    const e = (url: string, extra: Partial<FlowSourceExchange> = {}): FlowSourceExchange => ({
      id: url,
      method: 'GET',
      url,
      startedAt: '2026-10-09T10:00:00Z',
      requestHeaders: {},
      status: 200,
      ...extra,
    });
    expect(noiseReason(e('https://x.test/logo.png'))).toBe('a static asset');
    expect(noiseReason(e('https://x.test/fonts/a', { contentType: 'font/woff2' }))).toBe('a static asset');
    expect(noiseReason(e('https://x.test/', { contentType: 'text/html; charset=utf-8' }))).toBe('a web page');
    expect(noiseReason(e('https://x.test/api', { requestHeaders: { 'sec-fetch-dest': 'image' } }))).toBe('a browser image load');
    expect(noiseReason(e('https://o123.ingest.sentry.io/api/1/envelope/', { method: 'POST' }))).toBe('analytics / telemetry');
    expect(noiseReason(e('https://x.test:443', { kind: 'tunnel', method: 'CONNECT' }))).toBe('an HTTPS tunnel (not decrypted)');
    expect(noiseReason(e('https://metrics.corp.test/v1', { method: 'POST' }), { extraNoiseHosts: ['corp.test'] })).toBe('analytics / telemetry');
    expect(noiseReason(e('https://x.test/api/items', { contentType: 'application/json' }))).toBeUndefined();
    expect(noiseReason(e('https://x.test/logo.png'), { keepNoise: true })).toBeUndefined();
    expect(() => flowFromExchanges([e('https://x.test/logo.png')])).toThrow(/Nothing to record: all 1 exchanges were left out \(a static asset\)/);
  });

  it('a HAR file: the same conversion; form bodies; the default path', () => {
    const har = {
      log: {
        version: '1.2',
        creator: { name: 'x', version: '1' },
        entries: [
          {
            startedDateTime: '2026-10-09T10:00:00Z',
            time: 10,
            request: {
              method: 'POST',
              url: 'https://shop.test/oauth/token',
              httpVersion: 'HTTP/1.1',
              headers: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
              queryString: [],
              cookies: [],
              headersSize: -1,
              bodySize: 40,
              postData: { mimeType: 'application/x-www-form-urlencoded', text: 'grant_type=client_credentials&client_secret=shh-very-secret' },
            },
            response: {
              status: 200,
              statusText: 'OK',
              httpVersion: 'HTTP/1.1',
              headers: [{ name: 'Content-Type', value: 'application/json' }],
              cookies: [],
              content: { size: 60, mimeType: 'application/json', text: '{"access_token":"at-0123456789abcdef","expires_in":3600}' },
              redirectURL: '',
              headersSize: -1,
              bodySize: 60,
            },
            cache: {},
            timings: { send: 1, wait: 5, receive: 4 },
          },
          {
            startedDateTime: '2026-10-09T10:00:01Z',
            time: 10,
            request: {
              method: 'GET',
              url: 'https://shop.test/cart',
              httpVersion: 'HTTP/1.1',
              headers: [{ name: 'Authorization', value: 'Bearer at-0123456789abcdef' }],
              queryString: [],
              cookies: [],
              headersSize: -1,
              bodySize: 0,
            },
            response: {
              status: 200,
              statusText: 'OK',
              httpVersion: 'HTTP/1.1',
              headers: [],
              cookies: [],
              content: { size: 2, mimeType: 'application/json', text: '{}' },
              redirectURL: '',
              headersSize: -1,
              bodySize: 2,
            },
            cache: {},
            timings: { send: 1, wait: 5, receive: 4 },
          },
        ],
      },
    };
    const r = flowFromHar(JSON.stringify(har), { source: 'shop.har' });
    const [a, b] = parse(r.text).tests;
    expect(a.body).toEqual({
      type: 'form-urlencoded',
      fields: [
        { key: 'grant_type', value: 'client_credentials' },
        { key: 'client_secret', value: '{{clientSecret}}' },
      ],
    });
    expect(b.headers.Authorization).toBe('Bearer {{accessToken}}');
    expect(r.text).toMatch(/^# Recorded from shop\.har/);
    expect(r.text).not.toContain('shh-very-secret');
    expect(() => flowFromHar('nope')).toThrow(/Not a HAR file/);
    expect(recordedFlowPath('Checkout: happy path')).toBe('recorded/checkout-happy-path.yaml');
  });
});

describe('flow_from_exchanges (MCP)', () => {
  it('writes tests/recorded/<name>.yaml from the captured exchanges (a free name), or previews it', async () => {
    const store = new WorkspaceManager().open(copyExample('public-workspace', join(dir, 'ws')));
    const login = await exchange('POST', '/auth/login', {}, { username: 'ada', password: PASSWORD });
    const me = await exchange('GET', '/me', { authorization: `Bearer ${JSON.parse(login.responseBody!).access_token}` });
    const session = [login, me] as never[];
    const [tool] = recordingTools({ store, redactor: new Redactor(), session });
    const dry = (await tool!.run({ name: 'Login', dry_run: true })) as { file: string; written: boolean; links: unknown[]; secrets: string[] };
    expect(dry).toMatchObject({ file: 'tests/recorded/login.yaml', written: false, secrets: ['apiKey', 'password'] });
    expect(dry.links).toHaveLength(1);
    const a = (await tool!.run({ name: 'Login' })) as { file: string; written: boolean };
    const b = (await tool!.run({ name: 'Login', ids: [me.id] })) as { file: string; steps: unknown[] };
    expect([a.file, b.file, b.steps.length]).toEqual(['tests/recorded/login.yaml', 'tests/recorded/login-2.yaml', 1]);
    expect(store.readTestFile('recorded/login.yaml')).toContain('Bearer {{accessToken}}');
    await expect(Promise.resolve().then(() => tool!.run({ ids: ['nope'] }))).rejects.toThrow(/No exchanges/);
    store.close();
  });
});
