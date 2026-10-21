import { describe, expect, it, vi } from 'vitest';
import type { OutputFormatSpec } from '../../apps/desktop/src/components/output/output-core';

// the renderer's modules that need a browser (bridge, toasts, store) are not what is under test
vi.mock('sonner', () => ({ toast: {} }));
vi.mock('../../apps/desktop/src/api', () => ({ call: async () => undefined, bridge: {} }));
vi.mock('../../apps/desktop/src/store', () => ({ useApp: { getState: () => ({}) } }));
const { bodyFormats } = await import('../../apps/desktop/src/components/output/response-specs');
const { defaultFormat } = await import('../../apps/desktop/src/components/output/output-core');
const { prettyBody } = await import('../../apps/desktop/src/lib/pretty');

// The download a plain click makes is the body as the Pretty tab shows it, whatever the content type says (the raw bytes stay a choice below)
const response = (contentType: string, body: string, json?: unknown) =>
  ({ url: 'https://api.test/items', status: 200, statusText: 'OK', contentType, headers: [['content-type', contentType]], cookies: [], bodyPreview: body, json, size: body.length, durationMs: 5, truncated: false }) as never;

const textOf = (f: OutputFormatSpec | undefined): string => String(f?.build?.() ?? '');
const ctxFor = (r: { bodyPreview: string; contentType: string; json?: unknown }) => ({ method: 'GET', prettyText: r.json !== undefined ? JSON.stringify(r.json, null, 2) : prettyBody(r.bodyPreview, r.contentType) });

describe('the default download of a response is what the Pretty tab shows', () => {
  it('JSON with a JSON content type: indented', () => {
    const body = '{"a":1,"b":[1,2],"c":{"d":null}}';
    const r = response('application/json', body, JSON.parse(body));
    const f = defaultFormat({ id: 'response.body', what: 'body', name: 'x', formats: bodyFormats(r, ctxFor(r as never)) });
    expect(f?.key).toBe('json');
    expect(textOf(f).split('\n').length).toBeGreaterThan(5);
  });

  it('JSON served as text/plain (no parsed json) is indented too, not one raw line', () => {
    const body = '{"a":1,"b":[1,2],"c":{"d":null}}';
    const r = response('text/plain', body);
    const formats = bodyFormats(r, ctxFor(r as never));
    const f = defaultFormat({ id: 'response.body', what: 'body', name: 'x', formats });
    expect(f?.key).toBe('json');
    expect(textOf(f).split('\n').length).toBeGreaterThan(5);
    expect(JSON.parse(textOf(f))).toEqual(JSON.parse(body));
    // the bytes as received remain one choice
    expect(textOf(formats.find((x) => x.key === 'raw'))).toBe(body);
  });

  it('XML is laid out, HTML is formatted; the received bytes stay available', () => {
    const xml = '<root><item id="1"><name>A</name></item><item id="2"><name>B</name></item></root>';
    const rx = response('application/xml', xml);
    const fx = bodyFormats(rx, ctxFor(rx as never));
    expect(defaultFormat({ id: 'response.body', what: 'body', name: 'x', formats: fx })?.key).toBe('xml');
    expect(textOf(defaultFormat({ id: 'response.body', what: 'body', name: 'x', formats: fx })).split('\n').length).toBeGreaterThan(3);
    expect(textOf(fx.find((x) => x.key === 'raw'))).toBe(xml);

    const html = '<html><body><div><p>one</p><p>two</p></div></body></html>';
    const rh = response('text/html', html);
    const fh = bodyFormats(rh, ctxFor(rh as never));
    expect(defaultFormat({ id: 'response.body', what: 'body', name: 'x', formats: fh })?.key).toBe('html-pretty');
    expect(textOf(defaultFormat({ id: 'response.body', what: 'body', name: 'x', formats: fh })).split('\n').length).toBeGreaterThan(3);
    expect(fh.some((x) => x.key === 'html')).toBe(true);
  });

  it('a body the Pretty tab leaves as it is keeps its first format', () => {
    const r = response('text/plain', 'just a line');
    const formats = bodyFormats(r, ctxFor(r as never));
    expect(defaultFormat({ id: 'response.body', what: 'body', name: 'x', formats })?.key).toBe('raw');
  });
});
