import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { WorkspaceStore } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

// output.save / output.copy / output.cancel / output.reveal: the backend half of the down arrow on every output. Files
// go where the Save-as dialog says (written to .part, then renamed), sources are streamed, the surface's secrets policy
// comes from OUTPUT_SURFACES, and the browser host gets the bytes to download instead.
const tmp = tempDir('tp-output-rpc-');
const TOKEN = 'Bearer abc123def456ghi789jkl';
const events: Array<{ channel: string; payload: any }> = [];
let next = '';
let lastDefault: string | undefined;
const revealed: string[] = [];
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
    openPath: async () => undefined,
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

  it('log-like outputs are redacted by default; Include secrets keeps them', async () => {
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
    dest('console-secrets.txt');
    const all = await save({ surface: 'console', format: 'text', suggestedName: 'console.txt', source: { kind: 'console' }, includeSecrets: true });
    expect(readFileSync(all.path, 'utf8')).toContain('abc123def456ghi789jkl');
    expect(all.redacted).toBe(false);
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
    expect(peak - before).toBeLessThan(64 * 1024 * 1024);
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
  });

  it('without a native dialog (browser, cloud) the bytes come back to download', async () => {
    const r = (await web.invoke('output.save', { surface: 'response.headers', format: 'csv', suggestedName: 'h.csv', content: { text: 'a,b\r\n' } })) as Record<string, any>;
    expect(r.download.name).toBe('h.csv');
    expect(r.download.type).toBe('text/csv');
    expect(Buffer.from(r.download.content, 'base64').toString()).toBe('a,b\r\n');
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
