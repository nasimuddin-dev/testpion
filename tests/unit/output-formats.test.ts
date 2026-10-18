import { describe, expect, it } from 'vitest';
import {
  createJsonMinifier,
  createJsonPrettyPrinter,
  crc32,
  csvField,
  csvRecords,
  extensionForMime,
  fileNameFromContentDisposition,
  guardCsvCell,
  harFromExchange,
  htmlDocument,
  jsonLines,
  jsonPretty,
  junitXml,
  markdownTable,
  netscapeCookies,
  objectsToCsv,
  OUTPUT_FORMATS,
  OUTPUT_SURFACES,
  outputFileName,
  sanitizeFileName,
  toCsv,
  uniqueFileName,
  zipFiles,
} from '../../packages/shared/src/index.js';

// The builders of "Download" (the down arrow on every output): the same bytes wherever the output is saved.

/** A strict RFC 4180 reader (quoted fields, doubled quotes, CRLF), to round-trip what toCsv writes. */
function readCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') ((cell += '"'), i++);
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') (row.push(cell), (cell = ''));
    else if (c === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      ((row = []), (cell = ''), i++);
    } else cell += c;
  }
  if (cell || row.length) (row.push(cell), rows.push(row));
  return rows;
}

describe('CSV', () => {
  it('round-trips quotes, separators, line breaks, unicode and empty cells', () => {
    const rows = [
      ['name', 'value', 'note'],
      ['a,b', 'say "hi"', 'line1\nline2'],
      ['ünïcödé ✓', '', ' padded '],
      ['cr\rlf', 'x', 'y'],
    ];
    const text = toCsv(rows);
    expect(text.endsWith('\r\n')).toBe(true);
    expect(readCsv(text)).toEqual(rows);
  });

  it('null and undefined are empty, objects JSON, dates ISO', () => {
    expect(toCsv([[null, undefined, { a: 1 }, new Date('2026-01-02T03:04:05Z'), true, 4]])).toBe(',,"{""a"":1}",2026-01-02T03:04:05.000Z,true,4\r\n');
  });

  it('the injection guard prefixes formulas with an apostrophe and quotes them', () => {
    for (const bad of ['=1+2', '+A1', '@SUM(A1:A2)', '-cmd|x', '\t=1', '\r=1', '＝1+2', 'a";=1+2', 'x,=HYPERLINK("y")']) expect(guardCsvCell(bad), bad).toBe(`'${bad}`);
    expect(csvField('=1+2')).toBe(`"'=1+2"`);
    // the CSV of the guarded cell reads back with the apostrophe: Excel shows it as text
    expect(readCsv(toCsv([['=1+2', '@x']]))).toEqual([["'=1+2", "'@x"]]);
  });

  it('keeps plain numbers usable (negative, decimal, exponent) and leaves ordinary text alone', () => {
    for (const ok of ['-12.5', '+3', '-1e5', '42', 'hello', 'a-b', "it's - fine", '1, -2']) expect(guardCsvCell(ok), ok).toBe(ok);
  });

  it('the guard can be turned off, TSV uses tabs, the Excel variant starts with a BOM', () => {
    expect(toCsv([['=x']], { guard: false })).toBe('=x\r\n');
    expect(toCsv([['a', 'b c']], { delimiter: '\t' })).toBe('a\tb c\r\n');
    expect(toCsv([['a']], { bom: true }).charCodeAt(0)).toBe(0xfeff);
  });

  it('objects become a table with every key, in the order first seen', () => {
    const text = objectsToCsv([
      { a: 1, b: 2 },
      { b: 3, c: { d: 4 } },
    ]);
    expect(csvRecords(text.trim())).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', ''],
      ['', '3', '{"d":4}'],
    ]);
  });
});

describe('JSON', () => {
  const value = { a: [1, 2, { b: 'x"y\\z', c: [] }], d: {}, e: null, f: 'héllo, {world}: [x]', g: [[]], h: true };
  const text = JSON.stringify(value);

  it('pretty, minified and JSON Lines round-trip', () => {
    expect(JSON.parse(jsonPretty(value))).toEqual(value);
    expect(
      jsonLines([1, { a: 2 }])
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l)),
    ).toEqual([1, { a: 2 }]);
  });

  it('the streaming re-indenter equals JSON.stringify(…, null, 2) whatever the chunk boundaries', () => {
    const want = JSON.stringify(value, null, 2) + '\n';
    for (const size of [1, 2, 3, 7, 1000]) {
      const p = createJsonPrettyPrinter();
      let out = '';
      for (let i = 0; i < text.length; i += size) out += p.push(text.slice(i, i + size));
      out += p.end();
      expect(out, `chunks of ${size}`).toBe(want);
    }
    // already pretty input comes out the same
    const p = createJsonPrettyPrinter();
    expect(p.push(want) + p.end()).toBe(want);
  });

  it('the streaming minifier drops whitespace outside strings only', () => {
    const m = createJsonMinifier();
    const pretty = JSON.stringify(value, null, 2);
    let out = '';
    for (let i = 0; i < pretty.length; i += 5) out += m.push(pretty.slice(i, i + 5));
    expect(out).toBe(text);
  });

  it('re-indents a 5 MB document chunk by chunk with the same result', () => {
    const big = JSON.stringify(Array.from({ length: 40_000 }, (_, i) => ({ id: i, name: `patient ${i}`, tags: ['a', 'b'], nested: { ok: i % 2 === 0 } })));
    const p = createJsonPrettyPrinter();
    let out = '';
    for (let i = 0; i < big.length; i += 256 * 1024) out += p.push(big.slice(i, i + 256 * 1024));
    out += p.end();
    expect(out).toBe(JSON.stringify(JSON.parse(big), null, 2) + '\n');
  });
});

describe('documents', () => {
  it('Markdown tables escape pipes and line breaks', () => {
    expect(markdownTable(['a', 'b'], [['x|y', 'one\ntwo']])).toBe('| a | b |\n| --- | --- |\n| x\\|y | one<br>two |\n');
  });

  it('HTML pages are self-contained, escaped and themed for light and dark', () => {
    const html = htmlDocument('Run <1>', [{ table: { columns: ['name'], rows: [['<script>alert(1)</script>']] } }, { title: 'Log', pre: '</pre><img src=x onerror=alert(1)>' }]);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).not.toMatch(/(src|href)=["']?https?:/i);
    expect(html).toContain("default-src 'none'");
  });

  it('JUnit XML counts failures and escapes', () => {
    const x = junitXml('suite "a"', [
      { name: 'ok <1>', passed: true, durationMs: 1500 },
      { name: 'bad', passed: false, message: 'expected 200 & got 500' },
    ]);
    expect(x).toContain('tests="2" failures="1"');
    expect(x).toContain('name="ok &lt;1&gt;"');
    expect(x).toContain('expected 200 &amp; got 500');
    expect(x).toContain('time="1.500"');
  });

  it('a HAR 1.2 log of one exchange has the fields HAR readers need', () => {
    const har = harFromExchange({
      method: 'post',
      url: 'https://api.test/patients?page=2&q=a%20b',
      status: 201,
      statusText: 'Created',
      headers: [
        ['content-type', 'application/json'],
        ['location', '/patients/7'],
      ],
      body: '{"id":7}',
      contentType: 'application/json',
      timeline: [{ name: 'DNS lookup', durationMs: 3 }],
    }) as { log: { version: string; creator: { name: string }; entries: Array<Record<string, any>> } };
    expect(har.log.version).toBe('1.2');
    const e = har.log.entries[0]!;
    expect(e.request.method).toBe('POST');
    expect(e.request.queryString).toEqual([
      { name: 'page', value: '2' },
      { name: 'q', value: 'a b' },
    ]);
    expect(e.response.redirectURL).toBe('/patients/7');
    expect(e.response.content).toMatchObject({ mimeType: 'application/json', text: '{"id":7}' });
    expect(e.timings.dns).toBe(3);
    for (const k of ['startedDateTime', 'time', 'request', 'response', 'cache', 'timings']) expect(e).toHaveProperty(k);
  });

  it('cookies.txt has the Netscape header and seven tab-separated fields', () => {
    const t = netscapeCookies([{ name: 'sid', value: 'x', attributes: { Path: '/', Secure: 'true', Domain: '.api.test' } }], 'api.test');
    expect(t.split('\n')[0]).toBe('# Netscape HTTP Cookie File');
    expect(t.split('\n')[1]!.split('\t')).toEqual(['.api.test', 'TRUE', '/', 'TRUE', '0', 'sid', 'x']);
  });
});

describe('ZIP', () => {
  it('stores the files with their names, sizes and CRC-32 (readable by any unzip)', () => {
    const zip = zipFiles([
      { name: 'report.html', data: '<p>hi</p>' },
      { name: 'dir/résumé.csv', data: 'a,b\r\n' },
    ]);
    const buf = Buffer.from(zip);
    // end of central directory: 2 entries
    const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    expect(buf.readUInt16LE(eocd + 10)).toBe(2);
    // walk the local headers
    const names: string[] = [];
    let p = 0;
    while (buf.readUInt32LE(p) === 0x04034b50) {
      const method = buf.readUInt16LE(p + 8);
      const crc = buf.readUInt32LE(p + 14);
      const size = buf.readUInt32LE(p + 18);
      const nameLen = buf.readUInt16LE(p + 26);
      const name = buf.toString('utf8', p + 30, p + 30 + nameLen);
      const data = buf.subarray(p + 30 + nameLen, p + 30 + nameLen + size);
      expect(method).toBe(0);
      expect(crc32(new Uint8Array(data))).toBe(crc);
      names.push(name);
      p += 30 + nameLen + size;
    }
    expect(names).toEqual(['report.html', 'dir/résumé.csv']);
  });

  it('crc32 matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('file names', () => {
  const when = new Date(2026, 9, 17, 14, 5);

  it('method, name, local time and status', () => {
    expect(outputFileName({ method: 'get', url: 'https://api.test/v1/patients?x=1', status: 200, when, ext: 'json' })).toBe('GET-patients-2026-10-17-1405-200.json');
    expect(outputFileName({ name: 'run smoke', status: 'passed', when, ext: 'html' })).toBe('run-smoke-2026-10-17-1405-passed.html');
    expect(outputFileName({ name: 'console', when, ext: '' })).toBe('console-2026-10-17-1405');
  });

  it('removes reserved characters, control characters and trailing dots or spaces', () => {
    expect(sanitizeFileName('a<b>c:d"e/f\\g|h?i*j\u0001k.json')).toBe('a-b-c-d-e-f-g-h-i-j-k.json');
    expect(sanitizeFileName('  report.  ')).toBe('report');
    expect(sanitizeFileName('...')).toBe('output');
    expect(sanitizeFileName('../../etc/passwd')).toBe('etc-passwd');
  });

  it('prefixes Windows reserved device names, with or without an extension', () => {
    for (const n of ['CON', 'con.txt', 'PRN.json', 'aux', 'NUL.tar.gz', 'COM1', 'lpt9.csv']) expect(sanitizeFileName(n), n).toBe(`_${n}`);
    for (const n of ['CONIN$', 'conout$.txt']) expect(sanitizeFileName(n), n).toBe(`_${n}`);
    // Windows ignores trailing spaces before the extension: still the device
    expect(sanitizeFileName('CON .txt')).toBe('_CON.txt');
    expect(sanitizeFileName('console.txt')).toBe('console.txt');
    expect(sanitizeFileName('COM10.txt')).toBe('COM10.txt');
  });

  it('keeps the extension and a whole character when cutting a long name', () => {
    const long = sanitizeFileName(`${'é'.repeat(300)}.json`);
    expect(long.endsWith('.json')).toBe(true);
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(200);
    expect(long).not.toContain('�');
    const emoji = sanitizeFileName(`${'😀'.repeat(100)}.csv`);
    expect(Buffer.byteLength(emoji)).toBeLessThanOrEqual(200);
    expect([...emoji.replace(/\.csv$/, '')].every((c) => c === '😀')).toBe(true);
  });

  it('keeps right-to-left text and NFC-normalises', () => {
    expect(sanitizeFileName('تقرير.html')).toBe('تقرير.html');
    // macOS hands out decomposed (NFD) names: the same name, NFC, whatever the source
    expect(sanitizeFileName('résumé.pdf')).toBe('résumé.pdf');
    // ':' is a separator on macOS (Finder) and reserved on Windows
    expect(sanitizeFileName('10:30 report.md')).toBe('10-30 report.md');
  });

  it('drops invisible bidi and zero-width characters that disguise the extension, keeps ZWJ emoji', () => {
    expect(sanitizeFileName('invoice‮fdp.exe')).toBe('invoicefdp.exe');
    expect(sanitizeFileName('a​b⁦c⁩﻿.txt')).toBe('abc.txt');
    expect(sanitizeFileName('👨‍👩‍👧.json')).toBe('👨‍👩‍👧.json');
    expect(sanitizeFileName('é.txt')).toBe('é.txt');
  });

  it('reads the Content-Disposition name (filename* first), sanitised', () => {
    expect(fileNameFromContentDisposition(`attachment; filename="plain.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20v2.pdf`)).toBe('résumé v2.pdf');
    expect(fileNameFromContentDisposition('attachment; filename="a\\"b.txt"')).toBe('a-b.txt');
    expect(fileNameFromContentDisposition('attachment; filename=../../evil.sh')).toBe('evil.sh');
    expect(fileNameFromContentDisposition('inline')).toBeUndefined();
    expect(fileNameFromContentDisposition(undefined)).toBeUndefined();
  });

  it('the extension follows the Content-Type', () => {
    expect(extensionForMime('application/json; charset=utf-8')).toBe('json');
    expect(extensionForMime('application/vnd.api+json')).toBe('json');
    expect(extensionForMime('image/png')).toBe('png');
    expect(extensionForMime('application/pdf')).toBe('pdf');
    expect(extensionForMime('text/x-whatever')).toBe('txt');
    expect(extensionForMime('application/x-unknown')).toBe('bin');
  });

  it('adds -2, -3 … where no dialog asks before replacing', () => {
    const taken = new Set(['a.json', 'a-2.json']);
    expect(uniqueFileName('a.json', (n) => taken.has(n))).toBe('a-3.json');
    expect(uniqueFileName('b.json', (n) => taken.has(n))).toBe('b.json');
  });
});

describe('the surfaces registry', () => {
  it('every surface has known formats, its default among them, and a unique id', () => {
    const ids = new Set<string>();
    for (const s of OUTPUT_SURFACES) {
      expect(ids.has(s.id), s.id).toBe(false);
      ids.add(s.id);
      expect(s.formats.length, s.id).toBeGreaterThan(0);
      expect(s.formats).toContain(s.default);
      for (const f of s.formats) expect(OUTPUT_FORMATS[f], `${s.id} ${f}`).toBeDefined();
    }
  });

  it('log-like outputs are redacted by default; the raw response body is the person’s own data', () => {
    const policy = Object.fromEntries(OUTPUT_SURFACES.map((s) => [s.id, s.redaction]));
    for (const id of ['console', 'logs', 'terminal', 'run.results', 'debugger.session', 'response.trace', 'response.curl']) expect(policy[id], id).toBe('redacted-default');
    for (const id of ['response.body', 'grpc.response', 'graphql.response', 'ws.log']) expect(policy[id], id).toBe('raw-notice');
  });
});
