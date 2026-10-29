/**
 * AI-4 · the stability filter (planning/ai-features.md): a generated test is offered with a badge that says it ran twice,
 * on this computer, against a mock built from the API definition itself, and gave the same result both times. The mock
 * (`startSpecMock`) answers like the document says: a request that breaks the schema or leaves out a required parameter
 * gets the documented 4xx, no credentials on a secured operation get 401, an id that does not exist gets 404, anything
 * else the documented success status with an example body. It sends nothing anywhere else.
 *
 * A test that gives different results on the two runs (a value that changes on every run) is called unstable; one that
 * fails both times on the mock needs a rule the document does not state, so it is a warning, never a failure: the mock
 * is the document, not the real API.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ExecServices } from '../runner/execute.js';
import { bodySchemaOf } from '../openapi/spec-gaps.js';
import { findOperation, schemaProblems, type OpenApiDoc } from '../openapi/contract.js';
import { sampleFromSchema } from '../import/openapi-import.js';
import { deref } from '../util/json-ref.js';
import type { VerificationBadge } from './proposal.js';

type Json = Record<string, any>;

export interface SpecMock {
  url: string;
  close(): Promise<void>;
}

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const REFUSAL_ORDER = ['422', '400'];
const MISSING_ID = /^(does-not-exist|999999999|00000000-0000-4000-8000-000000000000)$/;

/** The response of the document for a request: [status, body]. */
function answer(doc: OpenApiDoc, method: string, url: string, headers: Record<string, string | string[] | undefined>, rawBody: string): [number, unknown] {
  const hit = findOperation(doc, method, url);
  if (!hit) return [404, { error: 'This operation is not in the document' }];
  const op = hit.operation as Json;
  const item = (doc.paths?.[hit.path] ?? {}) as Json;
  const codes = Object.keys(op.responses ?? {});
  const refusal = () => Number(REFUSAL_ORDER.find((c) => codes.includes(c)) ?? codes.find((c) => /^4\d\d$/.test(c) && !['401', '403', '404'].includes(c)) ?? 400);
  const query = new URL(url, 'http://mock.invalid').searchParams;

  const security = (op.security ?? doc.security) as unknown;
  if (Array.isArray(security) && security.length > 0 && !security.some((s) => s && Object.keys(s).length === 0)) {
    const hasCredentials = Object.keys(headers).some((h) => /^(authorization|x-api-key|api-key|apikey|x-auth-token)$/i.test(h) && String(headers[h] ?? '').trim()) || query.has('api_key') || query.has('apikey');
    if (!hasCredentials) return [401, { error: 'Credentials are required' }];
  }
  if (Object.values(hit.params).some((v) => MISSING_ID.test(v))) return [404, { error: 'Not found' }];

  for (const p of [...asList(item.parameters), ...asList(op.parameters)].map((x) => deref(doc as Json, x) as Json)) {
    if (!p?.required || p.in === 'path') continue;
    if (p.in === 'query' && !query.has(p.name)) return [refusal(), { error: `Missing query parameter ${p.name}` }];
    if (p.in === 'header' && !headers[String(p.name).toLowerCase()]) return [refusal(), { error: `Missing header ${p.name}` }];
  }
  const body = bodySchemaOf(doc as Json, op, item);
  if (body) {
    if (!rawBody.trim()) {
      if (body.required) return [refusal(), { error: 'A body is required' }];
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return [refusal(), { error: 'The body is not JSON' }];
      }
      const problems = schemaProblems(doc, body.schema, parsed);
      if (problems.length) return [refusal(), { error: problems.join('; ') }];
    }
  }
  const ok = codes.find((c) => /^2\d\d$/.test(c)) ?? '200';
  const response = deref(doc as Json, op.responses?.[ok]) as Json | undefined;
  const media = Object.entries((response?.content ?? {}) as Json).find(([k]) => /json/.test(k))?.[1] as Json | undefined;
  if (!media) return [Number(ok), ''];
  const example = media.example ?? (media.examples && Object.values(media.examples as Json)[0]?.value) ?? sampleFromSchema(media.schema, doc);
  return [Number(ok), example ?? {}];
}

/** A server on 127.0.0.1 that answers as the document says. */
export async function startSpecMock(doc: OpenApiDoc): Promise<SpecMock> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let status = 500;
      let body: unknown = { error: 'The mock failed' };
      try {
        [status, body] = answer(doc, req.method ?? 'GET', req.url ?? '/', req.headers, Buffer.concat(chunks).toString('utf8'));
      } catch {
        /* a document the mock cannot read answers 500: the tests report it */
      }
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json', 'content-length': Buffer.byteLength(text) });
      res.end(req.method === 'HEAD' ? undefined : text);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * The tests of a generated file run twice against the mock of the document: `pass` when every test passes both times,
 * `warn` when some fail (they need a rule the document does not state, or a real API) or differ between the runs.
 */
export async function verifySpecStable(yaml: string, doc: OpenApiDoc, services: ExecServices, signal?: AbortSignal): Promise<VerificationBadge> {
  const [{ runTests }, { loadTestsFromFile }] = await Promise.all([import('../runner/runner.js'), import('../runner/loader.js')]);
  const tests = [];
  for await (const t of loadTestsFromFile('ai/spec-stable.yaml', yaml)) tests.push(t);
  if (!tests.length) return { verifier: 'spec-stable', status: 'skip', label: 'no tests to run on a mock' };
  const mock = await startSpecMock(doc);
  try {
    const runs: Array<Map<string, string>> = [];
    for (let i = 0; i < 2; i++) {
      const vars = services.vars.clone();
      vars.set('baseUrl', mock.url, 'runtime');
      const seen = new Map<string, string>();
      await runTests({
        name: 'Spec tests on a mock',
        tests,
        services: { ...services, vars, production: undefined },
        signal,
        traceMode: 'none',
        concurrency: 1,
        timeoutMs: 10_000,
        onEvent: (e) => {
          if (e.type === 'test-end') seen.set(e.result.name, e.result.status);
        },
      });
      runs.push(seen);
    }
    const names = [...runs[0]!.keys()];
    const unstable = names.filter((n) => runs[0]!.get(n) !== runs[1]!.get(n));
    const failing = names.filter((n) => runs[0]!.get(n) === runs[1]!.get(n) && runs[0]!.get(n) !== 'passed');
    const total = names.length;
    const passing = total - unstable.length - failing.length;
    if (!unstable.length && !failing.length) return { verifier: 'spec-stable', status: 'pass', label: `${total}/${total} pass twice on a mock of the document` };
    const detail = [
      ...unstable.slice(0, 5).map((n) => `${n}: a different result on the second run (unstable)`),
      ...failing.slice(0, 5).map((n) => `${n}: does not pass on a mock of the document, so it needs a rule the document does not state, or the real API`),
    ].join('\n');
    return { verifier: 'spec-stable', status: 'warn', label: `${passing}/${total} pass twice on a mock of the document${unstable.length ? ` · ${unstable.length} unstable` : ''}${failing.length ? ` · ${failing.length} fail` : ''}`, detail };
  } finally {
    await mock.close();
  }
}
