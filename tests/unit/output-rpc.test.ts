import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { WorkspaceStore } from '../../packages/core/src/index.js';
import { OUTPUT_FORMATS, OUTPUT_SURFACES } from '../../packages/shared/src/index.js';
import { partPathFor } from '../../apps/desktop/backend/handlers/output.js';
import { tempDir } from '../helpers.js';

// output.save / output.copy / output.cancel / output.reveal: the backend half of the down arrow on every output. Files
// go where the Save-as dialog says (written to .part, then renamed), sources are streamed, the surface's secrets policy
// comes from OUTPUT_SURFACES, and the browser host gets the bytes to download instead.
// through an aliased path (a junction / symlink, like macOS's /var → /private/var): payload paths and folders still match
const tmp = tempDir('tp-output-rpc-', { alias: true });
const TOKEN = 'Bearer abc123def456ghi789jkl';
const events: Array<{ channel: string; payload: any }> = [];
let next = '';
let lastDefault: string | undefined;
const revealed: string[] = [];
let openFails = '';
let be: Backend;
let web: Backend;
let root = '';

const dest = (name: string) => {
  const d = join(tmp.dir, 'out', name);
  mkdirSync(dirname(d), { recursive: true });
  next = d;
  return d;
};
const save = (p: Record<string, unknown>) => be.invoke('output.save', p) as Promise<Record<string, any>>;

beforeAll(() => {
  root = join(tmp.dir, 'ws');
  WorkspaceStore.create(root, 'Out').close();
  be = new Backend({
    appDir: join(tmp.dir, 'app'),
    emit: (channel, payload) => void events.push({ channel, payload }),
    noMonitors: true,
    saveDialog: async (o) => ((lastDefault = o.defaultPath), next || undefined),
    openPath: async () => openFails,
    showItemInFolder: (p) => void revealed.push(p),
  });
  be.openStore(root);
  web = new Backend({ appDir: join(tmp.dir, 'web'), emit: () => {}, noMonitors: true });
  web.openStore(root);
});
afterAll(async () => {
  await be.dispose();
  await web.dispose();
  tmp.cleanup();
});

describe('output.save', () => {
  it('writes content where the dialog says, with no .part left, and says how much', async () => {
    const d = dest('headers.csv');
    const r = await save({ surface: 'response.headers', format: 'csv', suggestedName: 'GET-patients-headers.csv', content: { text: 'name,value\r\nx,1\r\n' } });
    expect(r.path).toBe(d);
    expect(r.bytes).toBe(17);
    expect(readFileSync(d, 'utf8')).toBe('name,value\r\nx,1\r\n');
    expect(readdirSync(dirname(d)).filter((f) => f.endsWith('.part'))).toEqual([]);
    expect(r.canReveal).toBe(true);
  });

  it('opens the dialog in the folder used last for that kind of output, with the sanitised name', async () => {
    const d = dest('sub/one.json');
    await save({ surface: 'response.body', format: 'json', suggestedName: 'one.json', content: { text: '{}' } });
    next = join(dirname(d), 'two.json');
    await save({ surface: 'response.headers', format: 'json', suggestedName: 'NUL.json', content: { text: '[]' } });
    expect(lastDefault).toBe(join(dirname(d), '_NUL.json'));
  });

  it('refuses an unknown surface, a format the surface does not offer, and content plus source', async () => {
    await expect(save({ surface: 'nope', format: 'json', suggestedName: 'x', content: { text: '' } })).rejects.toThrow(/unknown surface/);
    await expect(save({ surface: 'response.headers', format: 'zip', suggestedName: 'x', content: { text: '' } })).rejects.toThrow(/cannot be saved as zip/);
    await expect(save({ surface: 'response.headers', format: 'json', suggestedName: 'x' })).rejects.toThrow(/content or a source/);
    await expect(save({ surface: 'response.headers', format: 'json', suggestedName: 7 })).rejects.toThrow(/suggestedName must be a string/);
  });

  it('a cancelled dialog writes nothing', async () => {
    next = '';
    const r = await save({ surface: 'response.headers', format: 'json', suggestedName: 'x.json', content: { text: '[]' } });
    expect(r.cancelled).toBe(true);
  });

  it('log-like outputs are redacted by default; the console is masked even with includeSecrets (its secrets are never kept)', async () => {
    be.consoleBuffer.push({
      id: 'c1',
      time: '2026-10-17T10:00:00Z',
      source: 'request',
      name: 'Login',
      method: 'POST',
      url: 'https://api.test/login?api_key=abcdef123456',
      status: 200,
      request: { headers: [['Authorization', TOKEN]] },
      logs: [{ phase: 'test', message: `sent ${TOKEN}` }],
    });
    const d = dest('console.jsonl');
    const r = await save({ surface: 'console', format: 'jsonl', suggestedName: 'console.jsonl', source: { kind: 'console' } });
    const text = readFileSync(d, 'utf8');
    expect(r.redacted).toBe(true);
    expect(text).not.toContain('abc123def456ghi789jkl');
    expect(text).not.toContain('abcdef123456');
    expect(JSON.parse(text.split('\n')[0]!).name).toBe('Login');
    // the console's entries are redacted as they are captured (console-log.ts): the window offers no "Include secrets…"
    // for it, and a caller that asks anyway still gets the masked file
    dest('console-secrets.txt');
    const all = await save({ surface: 'console', format: 'text', suggestedName: 'console.txt', source: { kind: 'console' }, includeSecrets: true });
    expect(readFileSync(all.path, 'utf8')).not.toContain('abc123def456ghi789jkl');
    expect(all.redacted).toBe(true);
  });

  it('Include secrets keeps them on a redacted surface that holds them (text the window built)', async () => {
    const d = dest('jwt-secrets.json');
    const r = await save({ surface: 'response.jwt', format: 'json', suggestedName: 'jwt.json', content: { text: JSON.stringify([{ token: TOKEN, headers: { Authorization: TOKEN } }]) }, includeSecrets: true });
    expect(readFileSync(d, 'utf8')).toContain('abc123def456ghi789jkl');
    expect(r.redacted).toBe(false);
  });

  it('text the window built for a redacted surface is redacted here (header lines, curl -H, shapes)', async () => {
    const d = dest('curl.sh');
    await save({
      surface: 'response.curl',
      format: 'curl',
      suggestedName: 'curl.sh',
      content: { text: `curl -H 'Authorization: ${TOKEN}' -H 'X-Trace: 1' https://api.test\nCookie: sid=s3cr3t-value\n` },
    });
    const text = readFileSync(d, 'utf8');
    expect(text).not.toContain('abc123def456ghi789jkl');
    expect(text).not.toContain('s3cr3t-value');
    expect(text).toContain('X-Trace: 1');
  });

  it('the raw body is the person’s own data: saved as is, with a notice when it looks like a credential', async () => {
    const d = dest('body.json');
    const r = await save({ surface: 'response.body', format: 'json', suggestedName: 'body.json', content: { text: '{"access_token":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc"}' } });
    expect(readFileSync(d, 'utf8')).toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(r.notice).toMatch(/looks like a credential/);
    dest('plain.json');
    expect((await save({ surface: 'response.body', format: 'json', suggestedName: 'p.json', content: { text: '{"ok":true}' } })).notice).toBeUndefined();
  });

  it('binary content round-trips through base64', async () => {
    const d = dest('img.bin');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 10, 13]);
    await save({ surface: 'response.body', format: 'raw', suggestedName: 'img.png', content: { base64: bytes.toString('base64') } });
    expect(readFileSync(d).equals(bytes)).toBe(true);
  });

  it('a spooled body is copied raw, or re-indented as it streams; paths outside payloads/ are refused', async () => {
    const payload = join(root, 'payloads', 'resp-test.bin');
    mkdirSync(dirname(payload), { recursive: true });
    const doc = { items: [{ id: 1, name: 'a, "b"' }], empty: {}, list: [] };
    writeFileSync(payload, JSON.stringify(doc));
    const raw = dest('raw.json');
    await save({ surface: 'response.body', format: 'raw', suggestedName: 'raw.json', source: { kind: 'response', payloadPath: payload, part: 'body' } });
    expect(readFileSync(raw, 'utf8')).toBe(JSON.stringify(doc));
    const pretty = dest('pretty.json');
    await save({ surface: 'response.body', format: 'json', suggestedName: 'pretty.json', source: { kind: 'response', payloadPath: payload, part: 'pretty' } });
    expect(readFileSync(pretty, 'utf8')).toBe(JSON.stringify(doc, null, 2) + '\n');
    const outside = join(tmp.dir, 'secret.txt');
    writeFileSync(outside, 'secret');
    dest('evil.txt');
    await expect(save({ surface: 'response.body', format: 'raw', suggestedName: 'x', source: { kind: 'response', payloadPath: outside } })).rejects.toThrow(/no longer on disk/);
    await expect(save({ surface: 'response.body', format: 'raw', suggestedName: 'x', source: { kind: 'response', payloadPath: join(root, 'payloads', '..', '..', 'secret.txt') } })).rejects.toThrow(
      /no longer on disk/,
    );
  });

  it('streams a 50 MB body with progress events and bounded memory', async () => {
    const payload = join(root, 'payloads', 'resp-big.bin');
    const row = JSON.stringify({ id: 123456, name: 'patient name here', tags: ['alpha', 'beta'], ok: true });
    const count = Math.ceil((50 * 1024 * 1024) / (row.length + 1));
    writeFileSync(payload, `[${Array.from({ length: count }, () => row).join(',')}]`);
    const d = dest('big.json');
    events.length = 0;
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().heapUsed)), 5);
    const r = await save({ surface: 'response.body', format: 'json', suggestedName: 'big.json', source: { kind: 'response', payloadPath: payload, part: 'pretty' } });
    clearInterval(timer);
    expect(r.bytes).toBeGreaterThan(50 * 1024 * 1024);
    const progress = events.filter((e) => e.channel === 'output.progress');
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.at(-1)!.payload.bytes).toBe(r.bytes);
    // never the whole document in memory (the file is 50 MB, the pretty one more)
    // buffering the whole 50 MB body costs more than 100 MB (a 50 MB string alone is ~100 MB in memory); the margin absorbs garbage not yet collected when the suite is busy (the real-app perf plan measures ~0 MB)
    expect(peak - before).toBeLessThan(96 * 1024 * 1024);
    const head = readFileSync(d, 'utf8').slice(0, 200);
    expect(head.startsWith('[\n  {\n    "id": 123456,')).toBe(true);
  }, 60_000);

  it('cancel stops a running save and leaves neither the file nor a .part', async () => {
    const payload = join(root, 'payloads', 'resp-big.bin');
    const d = dest('cancelled.json');
    events.length = 0;
    const jobId = 'job-cancel-1';
    const stop = setInterval(() => {
      if (events.some((e) => e.channel === 'output.progress' && e.payload.jobId === jobId)) void be.invoke('output.cancel', { jobId });
    }, 1);
    const r = await save({ surface: 'response.body', format: 'json', suggestedName: 'c.json', jobId, source: { kind: 'response', payloadPath: payload, part: 'pretty' } });
    clearInterval(stop);
    expect(r.cancelled).toBe(true);
    expect(existsSync(d)).toBe(false);
    expect(existsSync(`${d}.part`)).toBe(false);
  }, 60_000);

  it('a run’s reports and results as a ZIP', async () => {
    const runDir = be.ws.runDir('run-zip');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'report.html'), '<p>report</p>');
    writeFileSync(join(runDir, 'report.json'), `{"auth":"${TOKEN}"}`);
    writeFileSync(
      join(runDir, 'results.jsonl'),
      JSON.stringify({ id: 'r1', name: '=cmd', type: 'http', status: 'passed', startedAt: '2026-10-17T10:00:00Z', durationMs: 5, attempts: 1, checks: [] }) + '\n',
    );
    const d = dest('run.zip');
    await save({ surface: 'run.results', format: 'zip', suggestedName: 'run.zip', source: { kind: 'run', runId: 'run-zip' } });
    const zip = readFileSync(d);
    const text = zip.toString('latin1');
    expect(text).toContain('report.html');
    expect(text).toContain('results.csv');
    expect(text).toContain("'=cmd");
    expect(text).not.toContain('abc123def456ghi789jkl');
    await expect(save({ surface: 'run.results', format: 'zip', suggestedName: 'x', source: { kind: 'run', runId: '../../x' } })).rejects.toThrow(/unknown run/);
  });

  it('Show in folder and Open take the job, never a path', async () => {
    const d = dest('shown.json');
    const r = await save({ surface: 'response.body', format: 'json', suggestedName: 'shown.json', content: { text: '{}' } });
    await be.invoke('output.reveal', { jobId: r.jobId });
    expect(revealed.at(-1)).toBe(d);
    await expect(be.invoke('output.reveal', { jobId: 'unknown-job' })).rejects.toThrow(/no longer there/);
    // no app for the type: Electron answers with a message, said as an error rather than nothing happening
    openFails = 'No application is associated with the specified file';
    try {
      await expect(be.invoke('output.reveal', { jobId: r.jobId, open: true })).rejects.toThrow(/Could not open shown\.json: No application/);
    } finally {
      openFails = '';
    }
    await be.invoke('output.reveal', { jobId: r.jobId, open: true });
  });

  it('without a native dialog (browser, cloud) the bytes come back to download', async () => {
    const r = (await web.invoke('output.save', { surface: 'response.headers', format: 'csv', suggestedName: 'h.csv', content: { text: 'a,b\r\n' } })) as Record<string, any>;
    expect(r.download.name).toBe('h.csv');
    expect(r.download.type).toBe('text/csv');
    expect(Buffer.from(r.download.content, 'base64').toString()).toBe('a,b\r\n');
  });
});

describe('output.save: the secrets policy of every surface', () => {
  // what a secret looks like in each text format (JSON for the JSON ones, header lines and a bearer token elsewhere)
  const SECRET = 'abc123def456ghi789jkl';
  const fixture = (format: string): string => {
    const obj = { headers: { Authorization: TOKEN, 'X-Api-Key': 'k3y-value-123456' }, note: `sent ${TOKEN}` };
    if (format === 'json' || format === 'har') return JSON.stringify(obj, null, 2);
    if (format === 'json-min') return JSON.stringify(obj);
    if (format === 'jsonl') return `${JSON.stringify(obj)}\n${JSON.stringify({ line: 2, auth: TOKEN })}\n`;
    if (format === 'csv' || format === 'tsv') return `name,value\r\nAuthorization,${TOKEN}\r\n`;
    if (format === 'curl') return `curl -H 'Authorization: ${TOKEN}' https://api.test\n`;
    return `Authorization: ${TOKEN}\nnote: sent ${TOKEN}\n`;
  };
  const redactedSurfaces = OUTPUT_SURFACES.filter((s) => s.redaction === 'redacted-default' && s.state === true);

  it('covers every shipped redacted surface', () => {
    expect(redactedSurfaces.map((s) => s.id)).toEqual(expect.arrayContaining(['console', 'logs', 'run.results', 'response.curl', 'response.trace', 'response.jwt', 'terminal', 'debugger.session']));
  });

  for (const surface of redactedSurfaces)
    for (const format of surface.formats.filter((f) => OUTPUT_FORMATS[f].text))
      it(`${surface.id} as ${format}: no secret unless Include secrets (and never when masked at capture)`, async () => {
        const masked = dest(`policy/${surface.id}-${format}.out`);
        const r = await save({ surface: surface.id, format, suggestedName: `x.${OUTPUT_FORMATS[format].ext}`, content: { text: fixture(format) } });
        const text = readFileSync(masked, 'utf8');
        expect(text, `${surface.id} ${format}`).not.toContain(SECRET);
        expect(r.redacted).toBe(true);
        const kept = dest(`policy/${surface.id}-${format}-secrets.out`);
        await save({ surface: surface.id, format, suggestedName: `x.${OUTPUT_FORMATS[format].ext}`, content: { text: fixture(format) }, includeSecrets: true });
        // a surface masked at capture holds no secrets to put back, so the backend never unmasks it (the window offers no
        // "Include secrets…" for it); every other redacted surface keeps them once the person confirmed
        if (surface.capturedRedacted) expect(readFileSync(kept, 'utf8')).not.toContain(SECRET);
        else expect(readFileSync(kept, 'utf8')).toContain(SECRET);
      });

  it('the surfaces masked before they are built say so (run reports, traces, cURL, the timeline, data-run rows, the Debugger HAR)', () => {
    const captured = OUTPUT_SURFACES.filter((s) => s.capturedRedacted).map((s) => s.id);
    expect(captured.sort()).toEqual(['console', 'debugger.session', 'flow.grid', 'flow.timeline', 'logs', 'response.curl', 'response.trace', 'run.results']);
    for (const id of captured) expect(OUTPUT_SURFACES.find((s) => s.id === id)!.redaction).toBe('redacted-default');
  });
});

describe('output.save: files and folders', () => {
  it('a name too long for <name>.part (255 bytes) writes a short hidden .part in the same folder', () => {
    const long = join(tmp.dir, 'out', `${'é'.repeat(125)}.json`);
    const part = partPathFor(long);
    expect(dirname(part)).toBe(dirname(long));
    expect(Buffer.byteLength(part.slice(dirname(part).length + 1))).toBeLessThan(64);
    expect(partPathFor(join(tmp.dir, 'out', 'a.json'))).toBe(join(tmp.dir, 'out', 'a.json.part'));
  });

  it('replaces an existing file (the dialog asked), with no .part left', async () => {
    const d = dest('replace/existing.txt');
    writeFileSync(d, 'old content that is longer than the new one');
    await save({ surface: 'response.headers', format: 'text', suggestedName: 'existing.txt', content: { text: 'new\n' } });
    expect(readFileSync(d, 'utf8')).toBe('new\n');
    expect(readdirSync(dirname(d))).toEqual(['existing.txt']);
  });

  it('a folder that is gone, or cannot be written, is a plain error and leaves no .part', async () => {
    next = join(tmp.dir, 'out', 'missing-folder', 'x.json');
    await expect(save({ surface: 'response.headers', format: 'json', suggestedName: 'x.json', content: { text: '[]' } })).rejects.toThrow(/is no longer there/);
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const ro = dest('readonly/x.json');
      chmodSync(dirname(ro), 0o555);
      try {
        await expect(save({ surface: 'response.headers', format: 'json', suggestedName: 'x.json', content: { text: '[]' } })).rejects.toThrow(/permission denied/);
        expect(readdirSync(dirname(ro))).toEqual([]);
      } finally {
        chmodSync(dirname(ro), 0o755);
      }
    }
  });

  it('a second save with a running job id is refused; cancel after the end and an unknown job are no-ops', async () => {
    const payload = join(root, 'payloads', 'resp-big.bin');
    dest('dup.json');
    const first = save({ surface: 'response.body', format: 'json', suggestedName: 'dup.json', jobId: 'job-dup', source: { kind: 'response', payloadPath: payload, part: 'pretty' } });
    await expect(save({ surface: 'response.headers', format: 'json', suggestedName: 'y.json', jobId: 'job-dup', content: { text: '[]' } })).rejects.toThrow(/already running/);
    await first;
    expect(await be.invoke('output.cancel', { jobId: 'job-dup' })).toEqual({ cancelled: false });
    expect(await be.invoke('output.cancel', { jobId: 'nope' })).toEqual({ cancelled: false });
  }, 60_000);

  it('a 10,000-row data run saves as CSV page by page: one header, every row, CRLF, bounded time and memory', async () => {
    const real = be.handlers['tests.scaleRows'];
    const pages: number[] = [];
    be.handlers['tests.scaleRows'] = async (p: { offset: number; limit: number }) => {
      pages.push(p.offset);
      const rows = Array.from({ length: Math.max(0, Math.min(p.limit, 10_000 - p.offset)) }, (_, i) => {
        const index = p.offset + i;
        return { index, status: index % 7 ? 'passed' : 'failed', durationMs: 12, startedAt: '2026-10-17T10:00:00Z', values: { code: 200, name: `row ${index}`, note: index === 5 ? '=HYPERLINK("x")' : 'ok' } };
      });
      return { rows, matched: 10_000, total: 10_000 };
    };
    try {
      const d = dest('grid/rows.csv');
      const heap0 = process.memoryUsage().heapUsed;
      const t0 = performance.now();
      const r = await save({ surface: 'flow.grid', format: 'csv', suggestedName: 'rows.csv', source: { kind: 'grid', grid: 'scale-rows', params: { id: 'x' } } });
      const ms = performance.now() - t0;
      const text = readFileSync(d, 'utf8');
      const lines = text.split('\r\n');
      expect(lines[0]).toBe('row,status,durationMs,startedAt,failedStep,error,code,name,note');
      expect(lines.length).toBe(10_002); // header + 10,000 rows + the empty string after the last CRLF
      expect(text.includes('\n') && !/[^\r]\n/.test(text)).toBe(true);
      expect(text).toContain(`"'=HYPERLINK(""x"")"`);
      expect(pages).toEqual(Array.from({ length: 21 }, (_, i) => i * 500));
      expect(r.bytes).toBe(Buffer.byteLength(text));
      console.log(`10k-row grid CSV: ${Math.round(ms)} ms, ${(r.bytes / 1024 / 1024).toFixed(1)} MB, heap +${((process.memoryUsage().heapUsed - heap0) / 1024 / 1024).toFixed(1)} MB`);
      expect(ms).toBeLessThan(10_000);
    } finally {
      be.handlers['tests.scaleRows'] = real!;
    }
  }, 60_000);

  it('concurrent saves to different files all complete', async () => {
    const names = Array.from({ length: 6 }, (_, i) => join(tmp.dir, 'out', 'concurrent', `c${i}.json`));
    mkdirSync(dirname(names[0]!), { recursive: true });
    let i = 0;
    const multi = new Backend({ appDir: join(tmp.dir, 'app-multi'), emit: () => {}, noMonitors: true, saveDialog: async () => names[i++] });
    multi.openStore(root);
    try {
      await Promise.all(names.map((_, k) => multi.invoke('output.save', { surface: 'response.headers', format: 'json', suggestedName: `c${k}.json`, content: { text: `[${k}]` } })));
      expect(names.map((n) => readFileSync(n, 'utf8')).sort()).toEqual(['[0]', '[1]', '[2]', '[3]', '[4]', '[5]']);
      expect(readdirSync(dirname(names[0]!)).filter((f) => f.endsWith('.part'))).toEqual([]);
    } finally {
      await multi.dispose();
    }
  });

  it('bad input is a normalised validation error (huge names, traversal, unknown sources, huge content)', async () => {
    dest('bad.json');
    const r = await save({ surface: 'response.headers', format: 'json', suggestedName: `../../${'x'.repeat(5000)}‮txt.exe`, content: { text: '[]' } });
    expect(r.name).not.toMatch(/[\\/‮]/);
    expect(Buffer.byteLength(r.name)).toBeLessThanOrEqual(200);
    await expect(save({ surface: 'run.results', format: 'html', suggestedName: 'x', source: { kind: 'nope' } })).rejects.toThrow(/unknown source/);
    await expect(save({ surface: 'flow.grid', format: 'csv', suggestedName: 'x', source: { kind: 'grid', grid: 'nope', params: {} } })).rejects.toThrow(/unknown grid/);
    await expect(save({ surface: 'response.headers', format: 'text', suggestedName: 'x', content: { text: 'x'.repeat(17 * 1024 * 1024) } })).rejects.toThrow(/too large to send/);
    await expect(be.invoke('output.save', undefined)).rejects.toThrow(/missing surface|surface/);
  });
});

describe('output.copy', () => {
  it('copies a format’s text with the same redaction as a save', async () => {
    const r = (await be.invoke('output.copy', { surface: 'console', format: 'text', source: { kind: 'console' } })) as { text: string; redacted: boolean };
    expect(r.text).toContain('POST https://api.test/login');
    expect(r.text).not.toContain('abc123def456ghi789jkl');
    expect(r.redacted).toBe(true);
    await expect(be.invoke('output.copy', { surface: 'run.results', format: 'zip', source: { kind: 'run', runId: 'run-zip' } })).rejects.toThrow(/not text/);
  });
});
