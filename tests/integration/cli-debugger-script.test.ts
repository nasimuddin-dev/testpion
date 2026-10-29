import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { copyExample, runCliSync, tempDir } from '../helpers.js';

// `testpion debugger script test|add|list`: JS rule scripts (FG-21) from the terminal; the twin of the rules panel's test button and of MCP `debugger_scripts`.
let tmp: ReturnType<typeof tempDir>;
const run = (args: string[]) => runCliSync(args, { cwd: tmp.dir, home: join(tmp.dir, 'home'), env: { CI: '1' }, timeout: 90_000 });
const json = (r: { out: string }) => (JSON.parse(r.out) as { data: Record<string, any> }).data;
let har = '';
let script = '';
let ws = '';

beforeAll(() => {
  tmp = tempDir('tp-cli-debug-script-');
  har = join(tmp.dir, 's.har');
  writeFileSync(
    har,
    JSON.stringify({
      log: {
        version: '1.2',
        entries: [
          {
            startedDateTime: '2026-10-28T10:00:00Z',
            time: 1,
            request: { method: 'GET', url: 'http://api.test/items/1', headers: [{ name: 'authorization', value: 'Bearer abc' }] },
            response: { status: 500, headers: [{ name: 'content-type', value: 'application/json' }], content: { size: 11, mimeType: 'application/json', text: '{"ok":false}' } },
            _testpion: { id: 'e1' },
          },
        ],
      },
    }),
  );
  ws = join(tmp.dir, 'ws');
  copyExample('public-workspace', ws);
  mkdirSync(join(ws, 'debugger', 'scripts'), { recursive: true });
  script = join(ws, 'debugger', 'scripts', 'fix.js');
  writeFileSync(script, `function onRequest(ctx) { ctx.request.headers['x-env'] = 'staging'; console.log('saw', ctx.request.method); }\nfunction onResponse(ctx) { if (ctx.response.status === 500) ctx.response.status = 503; }\n`);
});
afterAll(() => tmp.cleanup());

describe('debugger script', () => {
  it('test: says what the script would do on a captured exchange, sending nothing', () => {
    const r = run(['debugger', 'script', 'test', script, har, '#1', '--json']);
    expect(r.status, r.err).toBe(0);
    const d = json(r);
    expect(d).toMatchObject({ id: 'e1', ok: true, matches: true });
    expect(d.phases[0]).toMatchObject({ phase: 'request', does: ['sets the request header x-env: staging'], logs: ['saw GET'] });
    expect(d.phases[1]).toMatchObject({ phase: 'response', does: ['changes the response status to 503'] });
    expect(run(['debugger', 'script', 'test', script, har, 'e1']).out).toContain('it changes the response status to 503');
  });

  it('test: a script that fails exits 2 with the reason, and a missing entry is refused', () => {
    const bad = join(tmp.dir, 'bad.js');
    writeFileSync(bad, 'function onRequest(ctx) { nope(); }');
    const r = run(['debugger', 'script', 'test', bad, har, '#1', '--json']);
    expect(json(r)).toMatchObject({ ok: false });
    expect(json(r).phases[0].error).toMatch(/nope/);
    expect(run(['debugger', 'script', 'test', script, har, 'zzz']).status).toBe(2);
    const none = join(tmp.dir, 'none.js');
    writeFileSync(none, 'const a = 1;');
    expect(run(['debugger', 'script', 'test', none, har, '#1']).status).toBe(2);
  });

  it('add and list: a rule that reads the file from the workspace, or keeps the text with --inline', () => {
    const rules = join(tmp.dir, 'rules.json');
    const added = run(['debugger', 'script', 'add', script, '--host', 'api.test', '--rules', rules, '-w', ws, '--json']);
    expect(added.status, added.err).toBe(0);
    expect(json(added).added).toMatchObject({ kind: 'script', match: { host: 'api.test' }, script: { file: 'debugger/scripts/fix.js' }, enabled: true });
    const inline = run(['debugger', 'script', 'add', script, '--inline', '--name', 'Inline fix', '--rules', rules, '-w', ws, '--json']);
    expect(json(inline).added).toMatchObject({ name: 'Inline fix', script: { code: expect.stringContaining('onRequest') } });
    const list = json(run(['debugger', 'script', 'list', '--rules', rules, '--json']));
    expect(list.scripts.map((s: { script: string }) => s.script)).toEqual(['debugger/scripts/fix.js', 'inline']);
    const saved = JSON.parse(readFileSync(rules, 'utf8')) as { profiles: Record<string, unknown[]> };
    expect((Object.values(saved.profiles)[0] as Array<{ kind: string }>).filter((r) => r.kind === 'script')).toHaveLength(2); // beside the default rules
  });

  it('add: --dry-run writes nothing; a script outside the workspace needs --inline', () => {
    const rules = join(tmp.dir, 'rules2.json');
    expect(run(['debugger', 'script', 'add', script, '--dry-run', '--rules', rules, '-w', ws]).status).toBe(0);
    expect(() => readFileSync(rules, 'utf8')).toThrow();
    const other = tempDir('tp-outside-');
    try {
      const out = join(other.dir, 'o.js');
      writeFileSync(out, 'function onRequest(ctx) {}');
      expect(run(['debugger', 'script', 'add', out, '--rules', rules, '-w', ws]).status).toBe(2);
      expect(run(['debugger', 'script', 'add', out, '--inline', '--rules', rules, '-w', ws]).status).toBe(0);
    } finally {
      other.cleanup();
    }
  });
});
