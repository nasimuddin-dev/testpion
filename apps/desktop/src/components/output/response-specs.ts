import {
  extensionForMime,
  fileNameFromContentDisposition,
  harFromExchange,
  jsonLines,
  jsonPretty,
  jsonMin,
  junitXml,
  markdownTable,
  netscapeCookies,
  objectsToCsv,
  objectsToTsv,
  outputFileName,
  toCsv,
  urlNamePart,
} from '@testpion/shared';
import type { CheckResult, HttpResponseData, Trace } from '../../types';
import type { OutputFormatSpec, OutputSpec } from './output-core';

/**
 * What can be downloaded from a response, tab by tab (the REST / SOAP response pane, and GraphQL's body): the specs
 * the response pane's down arrow shows. Big bodies are saved from the spooled payload by the backend.
 */

export interface ResponseContext {
  method?: string;
  checks?: CheckResult[];
  curl?: string;
  stream?: string;
  scriptLogs?: string[];
  jwts?: unknown[];
  table?: { rows: unknown[] };
  /** The body as the Pretty view shows it (JSON indented, XML / HTML laid out). */
  prettyText?: string;
  trace?: Trace;
  environment?: string;
}

/** `GET-patients-2026-10-17-1405-200`, or `GET-patients-headers-2026-…-200` for a part. */
export function responseBaseName(r: { url: string; status?: number | string }, method?: string, part?: string): string {
  const name = [urlNamePart(r.url) ?? 'response', part].filter(Boolean).join('-');
  return outputFileName({ method, name, status: r.status, ext: '' });
}

const header = (r: HttpResponseData, name: string) => r.headers.find(([k]) => k.toLowerCase() === name)?.[1];

/** The body's formats: raw bytes (the server's file name when it gives one), pretty JSON, the table, HTML, XML, HAR. */
export function bodyFormats(r: HttpResponseData, ctx: ResponseContext): OutputFormatSpec[] {
  const base = responseBaseName(r, ctx.method);
  const ext = extensionForMime(r.contentType);
  const disposition = fileNameFromContentDisposition(header(r, 'content-disposition'));
  const rawName = disposition ? (/\.\w{1,16}$/.test(disposition) ? disposition : `${disposition}.${ext}`) : `${base}.${ext}`;
  const spooled = r.payloadPath ? { kind: 'response' as const, payloadPath: r.payloadPath } : undefined;
  const isJson = r.json !== undefined || (/json/i.test(r.contentType) && !!spooled);
  const isXml = /xml/i.test(r.contentType);
  const isHtml = /html/i.test(r.contentType);
  const out: OutputFormatSpec[] = [];
  if (isJson)
    out.push(
      {
        key: 'json',
        format: 'json',
        label: 'JSON (pretty)',
        default: true,
        ...(spooled && (r.truncated || r.json === undefined) ? { source: { ...spooled, part: 'pretty' as const } } : { build: () => jsonPretty(r.json) }),
      },
      { key: 'json-min', format: 'json-min', ...(spooled && (r.truncated || r.json === undefined) ? { source: { ...spooled, part: 'pretty' as const } } : { build: () => jsonMin(r.json) }) },
    );
  out.push({
    key: 'raw',
    format: 'raw',
    label: `Raw body (.${/\.(\w{1,16})$/.exec(rawName)?.[1] ?? ext}, as received)`,
    fileName: rawName,
    ...(spooled ? { source: { ...spooled, part: 'body' as const } } : { build: () => r.bodyPreview }),
  });
  if (ctx.table)
    out.push(
      { key: 'csv', format: 'csv', label: 'Table as CSV', build: () => objectsToCsv(ctx.table!.rows) },
      { key: 'tsv', format: 'tsv', label: 'Table as TSV', build: () => objectsToTsv(ctx.table!.rows) },
    );
  if (isHtml) out.push({ key: 'html', format: 'html', label: 'HTML page', ...(spooled ? { source: { ...spooled, part: 'body' as const } } : { build: () => r.bodyPreview }) });
  if (isXml) out.push({ key: 'xml', format: 'xml', label: 'XML (pretty)', build: () => ctx.prettyText ?? r.bodyPreview });
  if (!isJson && !isXml && !isHtml && !/^<binary /.test(r.bodyPreview)) out.push({ key: 'text', format: 'text', build: () => ctx.prettyText ?? r.bodyPreview });
  out.push({ key: 'har', format: 'har', label: 'HAR (request + response)', build: () => jsonPretty(harOf(r, ctx)) });
  return out;
}

function harOf(r: HttpResponseData, ctx: ResponseContext) {
  return harFromExchange({
    method: ctx.method,
    url: r.url,
    status: r.status,
    statusText: r.statusText,
    httpVersion: r.httpVersion,
    headers: r.headers,
    cookies: r.cookies,
    contentType: r.contentType,
    body: r.truncated ? undefined : r.bodyPreview,
    size: r.size,
    durationMs: r.durationMs,
    timeline: r.timeline,
  });
}

/** Every tab's spec (a tab without one has no download: Events and History have their own bars). */
export function responseSpecs(r: HttpResponseData, ctx: ResponseContext): Record<string, OutputSpec | undefined> {
  const name = (part?: string) => responseBaseName(r, ctx.method, part);
  const env = ctx.environment;
  const host = urlNamePart(r.url.replace(/^\w+:\/\/([^/]+).*$/, 'x://$1')) ?? '';
  const checks = ctx.checks ?? [];
  return {
    body: { id: 'response.body', what: 'response body', name: name(), formats: bodyFormats(r, ctx), environment: env, empty: r.bodyPreview || r.payloadPath ? undefined : 'The body is empty' },
    headers: {
      id: 'response.headers',
      what: 'response headers',
      name: name('headers'),
      environment: env,
      formats: [
        { format: 'json', build: () => jsonPretty(r.headers.map(([name, value]) => ({ name, value }))) },
        { format: 'csv', build: () => toCsv([['name', 'value'], ...r.headers]) },
        { format: 'text', label: 'Text (Name: value)', build: () => r.headers.map(([k, v]) => `${k}: ${v}`).join('\n') + '\n' },
      ],
    },
    cookies: {
      id: 'response.cookies',
      what: 'response cookies',
      name: name('cookies'),
      environment: env,
      empty: r.cookies.length ? undefined : 'No cookies',
      formats: [
        { format: 'json', build: () => jsonPretty(r.cookies) },
        {
          format: 'csv',
          build: () =>
            toCsv([
              ['name', 'value', 'attributes'],
              ...r.cookies.map((c) => [
                c.name,
                c.value,
                Object.entries(c.attributes)
                  .map(([k, v]) => (v === 'true' ? k : `${k}=${v}`))
                  .join('; '),
              ]),
            ]),
        },
        { format: 'cookies-txt', build: () => netscapeCookies(r.cookies, host) },
      ],
    },
    jwt: { id: 'response.jwt', what: 'decoded JWTs', name: name('jwt'), environment: env, formats: [{ format: 'json', build: () => jsonPretty(ctx.jwts ?? []) }] },
    timeline: {
      id: 'response.timeline',
      what: 'response timeline',
      name: name('timeline'),
      formats: [
        { format: 'json', build: () => jsonPretty({ url: r.url, phases: r.timeline, connection: r.connection }) },
        { format: 'har', label: 'HAR (with timings)', build: () => jsonPretty(harOf(r, ctx)) },
        {
          format: 'md',
          build: () =>
            markdownTable(
              ['phase', 'start (ms)', 'duration (ms)'],
              r.timeline.map((p) => [p.name, p.startMs, p.durationMs]),
            ),
        },
      ],
    },
    tests: {
      id: 'response.tests',
      what: 'response checks',
      name: name('checks'),
      empty: checks.length || ctx.scriptLogs?.length ? undefined : 'No checks ran',
      formats: [
        { format: 'json', build: () => jsonPretty({ checks, scriptLogs: ctx.scriptLogs ?? [] }) },
        {
          format: 'junit',
          build: () =>
            junitXml(
              name(),
              checks.map((c) => ({ name: c.name, passed: c.passed, message: c.message })),
            ),
        },
        {
          format: 'md',
          build: () =>
            markdownTable(
              ['check', 'result', 'message'],
              checks.map((c) => [c.name, c.passed ? 'passed' : 'failed', c.message]),
            ),
        },
      ],
    },
    stream:
      ctx.stream !== undefined ? { id: 'response.stream', what: 'response stream', name: name('stream'), environment: env, formats: [{ format: 'text', build: () => ctx.stream ?? '' }] } : undefined,
    trace: {
      id: 'response.trace',
      what: 'request trace',
      name: name('trace'),
      environment: env,
      empty: ctx.trace ? undefined : 'The trace is loading',
      formats: [{ format: 'json', build: () => jsonPretty(ctx.trace) }],
    },
    code: ctx.curl
      ? {
          id: 'response.curl',
          what: 'cURL command',
          name: name('curl'),
          environment: env,
          formats: [
            { format: 'curl', label: 'Shell script (.sh)', build: () => `#!/bin/sh\n${ctx.curl}\n` },
            { format: 'text', build: () => ctx.curl ?? '' },
          ],
        }
      : undefined,
  };
}

/** Server-sent events as JSON Lines, CSV or text/event-stream (all of them, not just the filtered ones). */
export function sseFormats(events: Array<{ event: string; data: string; id?: string; retry?: number; atMs: number }>): OutputFormatSpec[] {
  return [
    { format: 'jsonl', build: () => jsonLines(events) },
    { format: 'csv', build: () => toCsv([['atMs', 'event', 'id', 'data'], ...events.map((e) => [e.atMs, e.event, e.id ?? '', e.data])]) },
    {
      format: 'text',
      label: 'Text (text/event-stream)',
      build: () =>
        events
          .map((e) => [e.id !== undefined ? `id: ${e.id}` : '', e.event && e.event !== 'message' ? `event: ${e.event}` : '', ...e.data.split('\n').map((d) => `data: ${d}`)].filter(Boolean).join('\n'))
          .join('\n\n') + '\n',
    },
  ];
}
