import { describe, it, expect } from 'vitest';
import { bodyViewsOf, imageFacts, parseForm, parseXml, svgFacts, xmlOutline, keepsBytes } from '../../packages/shared/src/body-views';
import { decodeMessagePack, decodeProtobufRaw, decodeSignalR, decodeSocketIo, protobufText, protobufToJson, DecodeError, base64Of } from '../../packages/shared/src/binary-decode';
import { formatGraphql, graphqlOf } from '../../packages/shared/src/graphql-view';
import { cachingOf } from '../../packages/shared/src/caching';
import { tlsFindings, nameMatches } from '../../packages/shared/src/connection-info';
import { exchangeView } from '../../packages/shared/src/exchange-view';

const bytes = (...n: number[]) => Uint8Array.from(n);

describe('body view routing', () => {
  it('picks views by content type and by the first bytes', () => {
    expect(bodyViewsOf({ contentType: 'image/png' })).toEqual(['image']);
    expect(bodyViewsOf({ contentType: 'application/octet-stream', bytes: bytes(0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0) })).toEqual(['image']);
    expect(bodyViewsOf({ contentType: 'text/html; charset=utf-8', text: '<html></html>' })).toEqual(['html']);
    expect(bodyViewsOf({ contentType: 'application/soap+xml' })).toEqual(['xml']);
    expect(bodyViewsOf({ contentType: 'application/x-www-form-urlencoded' })).toEqual(['form']);
    expect(bodyViewsOf({ contentType: 'multipart/form-data; boundary=x' })).toEqual(['form']);
    expect(bodyViewsOf({ contentType: 'application/x-msgpack' })).toEqual(['msgpack']);
    expect(bodyViewsOf({ contentType: 'application/x-protobuf' })).toEqual(['protobuf']);
    expect(bodyViewsOf({ contentType: 'text/css' })).toEqual(['syntax']);
    expect(bodyViewsOf({ contentType: 'application/json', graphql: true })).toEqual(['graphql']);
    expect(bodyViewsOf({ contentType: 'application/json', text: '{"a":1}' })).toEqual([]);
    expect(bodyViewsOf({ contentType: 'text/plain', text: '<?xml version="1.0"?><a/>' })).toEqual(['xml']);
  });
  it('keeps bytes only for images (not svg) and binary protocols', () => {
    expect(keepsBytes('image/png')).toBe(true);
    expect(keepsBytes('image/svg+xml')).toBe(false);
    expect(keepsBytes('application/x-msgpack')).toBe(true);
    expect(keepsBytes('application/json')).toBe(false);
  });
});

describe('image facts', () => {
  it('reads PNG, GIF, JPEG and WebP dimensions from the header', () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    new DataView(png.buffer).setUint32(16, 640);
    new DataView(png.buffer).setUint32(20, 480);
    expect(imageFacts(png, 5000)).toMatchObject({ format: 'png', width: 640, height: 480, bytes: 5000 });
    expect(imageFacts(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0, 0x20, 0, 0))).toMatchObject({ format: 'gif', width: 16, height: 32 });
    // SOI, APP0 (length 4), SOF0 with 3 x 5
    expect(imageFacts(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 5, 0, 3, 0, 0, 0))).toMatchObject({ format: 'jpeg', width: 3, height: 5 });
    const webp = new Uint8Array(30);
    webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c]);
    webp[21] = 0x1f; // width-1 = 31, height-1 = 0 -> 32 x 1
    expect(imageFacts(webp)).toMatchObject({ format: 'webp', width: 32, height: 1 });
    expect(imageFacts(bytes(1, 2, 3))).toBeUndefined();
  });
  it('reads an SVG size and warns about scripts', () => {
    expect(svgFacts('<svg xmlns="x" viewBox="0 0 24 12"></svg>')).toMatchObject({ format: 'svg', width: 24, height: 12 });
    expect(svgFacts('<svg width="10" height="20"><script>x()</script></svg>').note).toMatch(/nothing runs/);
  });
});

describe('XML tree', () => {
  it('parses elements, attributes, text, CDATA and skips a DOCTYPE without expanding entities', () => {
    const r = parseXml('<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x "boom">]><a id="1"><b>&lt;hi&gt; &x; &#65;</b><c/><![CDATA[raw <>]]></a>');
    expect(r.error).toBeUndefined();
    expect(r.root?.name).toBe('a');
    expect(r.root?.attrs).toEqual([['id', '1']]);
    expect(r.root?.children?.[0]?.children?.[0]?.text).toBe('<hi> &x; A');
    expect(xmlOutline(r.root!)).toContain('<b> <hi> &x; A');
  });
  it('reports where a document breaks and stops at the limits', () => {
    expect(parseXml('<a><b></a>').error).toMatch(/closes <b>/);
    expect(parseXml('<a>').error).toMatch(/never closed/);
    expect(parseXml('<a>' + '<b/>'.repeat(6000) + '</a>')).toMatchObject({ truncated: true });
    expect(parseXml('<a>'.repeat(100)).truncated).toBe(true);
    expect(parseXml('text').error).toBeDefined();
  });
});

describe('form and multipart', () => {
  it('lists urlencoded fields decoded', () => {
    const r = parseForm('application/x-www-form-urlencoded', 'a=1+2&b=%C3%A9&c');
    expect(r?.parts.map((p) => [p.name, p.value])).toEqual([['a', '1 2'], ['b', 'é'], ['c', '']]);
  });
  it('lists multipart parts with file names and keeps a file text-free', () => {
    const body = ['--X', 'Content-Disposition: form-data; name="f"', '', 'v', '--X', 'Content-Disposition: form-data; name="up"; filename="a.bin"', 'Content-Type: application/octet-stream', '', 'BINARY', '--X--', ''].join('\r\n');
    const r = parseForm('multipart/form-data; boundary=X', body);
    expect(r?.parts).toEqual([
      { name: 'f', filename: undefined, contentType: undefined, size: 1, value: 'v' },
      { name: 'up', filename: 'a.bin', contentType: 'application/octet-stream', size: 6, value: undefined },
    ]);
    expect(parseForm('text/plain', 'x')).toBeUndefined();
  });
});

describe('MessagePack', () => {
  it('decodes maps, arrays, strings, numbers, bin, timestamps and ext', () => {
    // {"a":1,"b":[true,null,-2,"x"],"c":1.5}
    const mp = bytes(0x83, 0xa1, 0x61, 0x01, 0xa1, 0x62, 0x94, 0xc3, 0xc0, 0xfe, 0xa1, 0x78, 0xa1, 0x63, 0xcb, 0x3f, 0xf8, 0, 0, 0, 0, 0, 0);
    expect(decodeMessagePack(mp).value).toEqual({ a: 1, b: [true, null, -2, 'x'], c: 1.5 });
    expect(decodeMessagePack(bytes(0xc4, 2, 0xab, 0xcd)).value).toEqual({ $bytes: 2, hex: 'abcd' });
    expect(decodeMessagePack(bytes(0xd6, 0xff, 0, 0, 0, 1)).value).toBe('1970-01-01T00:00:01.000Z');
    expect(decodeMessagePack(bytes(0xd4, 7, 9)).value).toEqual({ $ext: 7, hex: '09' });
    expect(decodeMessagePack(bytes(0x01, 0x02)).trailing).toBe(1);
  });
  it('refuses lies about lengths, deep nesting and truncated data without allocating', () => {
    expect(() => decodeMessagePack(bytes(0xdd, 0xff, 0xff, 0xff, 0xff))).toThrow(DecodeError);
    expect(() => decodeMessagePack(bytes(...Array(100).fill(0x91), 0))).toThrow(/deeper/);
    expect(() => decodeMessagePack(bytes(0xa5, 0x61))).toThrow(/ends/);
    expect(() => decodeMessagePack(bytes(0xc1))).toThrow(/Not MessagePack/);
    expect(() => decodeMessagePack(new Uint8Array(2 * 1024 * 1024))).toThrow(/not decoded/);
  });
  it('keeps a __proto__ key as data', () => {
    const v = decodeMessagePack(bytes(0x81, 0xa9, ...Array.from('__proto__', (c) => c.charCodeAt(0)), 0x01)).value as Record<string, unknown>;
    expect(Object.keys(v)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('Protobuf without a schema', () => {
  it('reads varints, strings, nested messages and fixed-width values', () => {
    // 1: 150, 2: "testing", 3 { 1: 1 }, 4: fixed32 1.0
    const pb = bytes(0x08, 0x96, 0x01, 0x12, 0x07, ...Array.from('testing', (c) => c.charCodeAt(0)), 0x1a, 0x02, 0x08, 0x01, 0x25, 0, 0, 0x80, 0x3f);
    const f = decodeProtobufRaw(pb);
    expect(f.map((x) => [x.field, x.wire, x.kind])).toEqual([[1, 'varint', undefined], [2, 'bytes', 'string'], [3, 'bytes', 'message'], [4, 'fixed32', undefined]]);
    expect(f[0]!.value).toBe(150);
    expect(f[3]!.asFloat).toBe(1);
    expect(protobufToJson(f)).toMatchObject({ '1': 150, '2': 'testing', '3': { '1': 1 } });
    expect(protobufText(f)).toContain('2: "testing"');
    expect(protobufText(f)).toContain('3 {\n  1: 1\n}');
  });
  it('groups repeated fields and refuses what is not protobuf', () => {
    expect(protobufToJson(decodeProtobufRaw(bytes(0x08, 1, 0x08, 2, 0x08, 3)))).toEqual({ '1': [1, 2, 3] });
    expect(() => decodeProtobufRaw(bytes(0x0b))).toThrow(DecodeError); // wire type 3 (group)
    expect(() => decodeProtobufRaw(bytes(0x12, 0x09, 1))).toThrow(/longer/);
    expect(() => decodeProtobufRaw(bytes(0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 1))).toThrow(DecodeError);
  });
});

describe('SignalR and Socket.IO', () => {
  it('reads SignalR JSON messages split by the record separator', () => {
    const m = decodeSignalR('{"protocol":"json","version":1}\u001e{"type":1,"target":"Send","arguments":["hi"]}\u001e{"type":6}\u001e')!;
    expect(m.map((x) => [x.kind, x.name])).toEqual([['handshake', 'json'], ['invocation', 'Send'], ['ping', undefined]]);
    expect(m[1]!.data).toEqual(['hi']);
    expect(decodeSignalR('{"a":1}')).toBeUndefined();
  });
  it('reads Socket.IO events, acks, namespaces and polling payloads', () => {
    const m = decodeSocketIo('0{"sid":"abc"}\u001e40/chat,\u001e42/chat,7["msg",{"x":1}]\u001e3')!;
    expect(m.map((x) => x.kind)).toEqual(['engine.io open', 'connect', 'event', 'engine.io pong']);
    expect(m[2]).toMatchObject({ name: 'msg', data: [{ x: 1 }] });
    expect(decodeSocketIo('42["a",1]')![0]).toMatchObject({ kind: 'event', name: 'a', data: [1] });
    expect(decodeSocketIo('13:42["a","bcd"]')![0]!.name).toBe('a');
    expect(decodeSocketIo('hello')).toBeUndefined();
  });
});

describe('GraphQL view', () => {
  const body = JSON.stringify({ operationName: 'GetUser', query: 'query GetUser($id: ID!) { user(id: $id) { id name ...F } } fragment F on User { email }', variables: { id: '7' } });
  it('finds the operation, variables and errors', () => {
    const g = graphqlOf({ method: 'POST', url: 'https://x/graphql', requestContentType: 'application/json', requestBody: body, responseBody: JSON.stringify({ data: { user: null }, errors: [{ message: 'Not found', path: ['user'], locations: [{ line: 1, column: 9 }], extensions: { code: 'NOT_FOUND' } }] }) })!;
    expect(g.label).toBe('query GetUser');
    expect(g.operations[0]).toMatchObject({ type: 'query', name: 'GetUser', rootField: 'user', variables: { id: '7' } });
    expect(g.errors).toEqual([{ message: 'Not found', path: 'user', line: 1, column: 9, code: 'NOT_FOUND' }]);
    expect(g.partial).toBe(true);
  });
  it('lays the query out and handles anonymous, batched and GET calls', () => {
    expect(formatGraphql('query A($x: Int = 1) { a(x: $x) { b c @include(if: true) ... on T { d } } }')).toBe(
      ['query A($x: Int = 1) {', '  a(x: $x) {', '    b', '    c @include(if: true)', '    ... on T {', '      d', '    }', '  }', '}'].join('\n'),
    );
    expect(graphqlOf({ method: 'POST', requestContentType: 'application/json', requestBody: '{"query":"{ me { id } }"}' })!.label).toBe('query me');
    expect(graphqlOf({ method: 'POST', requestContentType: 'application/json', requestBody: '[{"query":"mutation M { x }"},{"query":"{ y }"}]' })!.label).toBe('mutation M (+1 batched)');
    expect(graphqlOf({ method: 'GET', url: 'https://x/api?query=%7B%20a%20%7D&variables=%7B%7D' })).toBeUndefined();
    expect(graphqlOf({ method: 'GET', url: 'https://x/graphql?query=%7B%20a%20%7D' })!.operations[0]!.rootField).toBe('a');
    expect(graphqlOf({ method: 'POST', requestContentType: 'application/json', requestBody: '{"a":1}' })).toBeUndefined();
  });
});

describe('caching verdicts', () => {
  const v = (status: number, h: Record<string, string>, method = 'GET') => cachingOf({ status, method, responseHeaders: h });
  it.each([
    [200, { 'cache-control': 'no-store' }, 'not-cacheable'],
    [200, { 'cache-control': 'max-age=3600' }, 'fresh-cacheable'],
    [200, { 'cache-control': 'no-cache', etag: '"a"' }, 'revalidate'],
    [200, { 'cache-control': 'no-cache' }, 'revalidate'],
    [200, { 'cache-control': 'max-age=0', etag: '"a"' }, 'revalidate'],
    [200, {}, 'not-cacheable'],
    [200, { etag: '"a"' }, 'revalidate'],
    [500, {}, 'not-cacheable'],
    [301, { 'cache-control': 'max-age=60' }, 'fresh-cacheable'],
    [304, {}, 'unknown'],
  ])('status %i %j -> %s', (status, h, verdict) => {
    expect(v(status, h).verdict).toBe(verdict);
  });
  it('POST is never cached; Expires and Last-Modified give a lifetime; Age counts down', () => {
    expect(v(200, { 'cache-control': 'max-age=60' }, 'POST').verdict).toBe('not-cacheable');
    expect(v(200, { expires: 'Wed, 01 Jan 2031 01:00:00 GMT', date: 'Wed, 01 Jan 2031 00:00:00 GMT' }).freshSeconds).toBe(3600);
    const h = v(200, { 'last-modified': 'Wed, 01 Jan 2031 00:00:00 GMT', date: 'Thu, 02 Jan 2031 00:00:00 GMT' });
    expect(h).toMatchObject({ heuristic: true, freshSeconds: 8640 });
    expect(v(200, { 'cache-control': 'public, max-age=100', age: '40' }).summary).toMatch(/1 min left/);
    expect(v(200, { 'cache-control': 'max-age=10', vary: '*' }).notes[0]).toMatch(/Vary: \*/);
  });
});

describe('TLS findings', () => {
  const leaf = { subject: 'CN=api.example.com', issuer: 'CN=Some CA', validFrom: '2020-01-01T00:00:00Z', validTo: '2031-01-01T00:00:00Z', san: ['*.example.com'] };
  const now = Date.parse('2030-12-25T00:00:00Z');
  it('flags expiry, soon-to-expire, name mismatch, untrusted chains and old protocols', () => {
    expect(tlsFindings({ version: 'TLSv1.3', chain: [leaf, leaf] }, 'api.example.com', now).map((f) => f.level)).toEqual(['warn']);
    expect(tlsFindings({ chain: [{ ...leaf, validTo: '2030-01-01T00:00:00Z' }] }, 'api.example.com', now)[0]).toMatchObject({ level: 'bad', text: expect.stringMatching(/expired/) });
    expect(tlsFindings({ chain: [leaf] }, 'other.test', now).some((f) => /not other\.test/.test(f.text))).toBe(true);
    expect(tlsFindings({ authorized: false, authError: 'self signed certificate', version: 'TLSv1', chain: [{ ...leaf, issuer: leaf.subject }] }, 'api.example.com', now).map((f) => f.text).join(' ')).toMatch(/not trusted.*old protocol.*self-signed/);
  });
  it('matches wildcard names one label deep', () => {
    expect(nameMatches('*.example.com', 'a.example.com')).toBe(true);
    expect(nameMatches('*.example.com', 'a.b.example.com')).toBe(false);
    expect(nameMatches('example.com', 'EXAMPLE.com')).toBe(true);
  });
});

describe('exchangeView (CLI and MCP share it)', () => {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47]);
  new DataView(png.buffer).setUint32(16, 2);
  new DataView(png.buffer).setUint32(20, 3);
  const e = { url: 'https://x/a.png', host: 'x', status: 200, contentType: 'image/png', responseBodyBase64: base64Of(png), responseBodyBytes: 900 };
  it('reads an image from kept bytes and lists the views', () => {
    expect(exchangeView(e, 'image')).toMatchObject({ ok: true, data: { format: 'png', width: 2, height: 3, bytes: 900 } });
    expect(exchangeView(e, 'list').data).toMatchObject({ views: ['image'] });
  });
  it('decodes a body as msgpack, hex or base64 text, and says plainly when it cannot', () => {
    expect(exchangeView({ url: 'u', responseBody: '81a16101' }, 'msgpack')).toMatchObject({ ok: true, data: { value: { a: 1 } } });
    expect(exchangeView({ url: 'u', responseBody: 'gaFhAQ==' }, 'msgpack')).toMatchObject({ ok: true });
    expect(exchangeView({ url: 'u', responseBody: '0801' }, 'protobuf')).toMatchObject({ ok: true, text: '1: 1' });
    expect(exchangeView({ url: 'u', responseBody: 'zzz' }, 'xml')).toMatchObject({ ok: false });
    expect(exchangeView({ url: 'u' }, 'xml')).toMatchObject({ ok: false, error: expect.stringMatching(/not kept/) });
    expect(exchangeView({ url: 'u', responseBody: 'c1' }, 'msgpack')).toMatchObject({ ok: false, error: expect.stringMatching(/Not MessagePack/) });
    expect(exchangeView({ url: 'u', status: 200 }, 'tls')).toMatchObject({ ok: false });
  });
});
