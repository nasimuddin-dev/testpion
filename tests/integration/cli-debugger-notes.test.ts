import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCliSync, tempDir } from '../helpers.js';

// `testpion debugger breakpoints | annotate | presets`: the terminal twins of the Debugger's Breakpoints button, its note and mark
// menu, and its ready-made rules. They edit the files they are given (a rules file, a HAR file) and never a real profile.
let tmp: ReturnType<typeof tempDir>;
const run = (args: string[]) => runCliSync(args, { cwd: tmp.dir, home: join(tmp.dir, 'home'), env: { CI: '1' }, timeout: 60_000 });
const json = (r: { out: string }) => (JSON.parse(r.out) as { data: Record<string, any> }).data;

beforeAll(() => {
  tmp = tempDir('tp-cli-debug-notes-');
});
afterAll(() => tmp.cleanup());

describe('debugger breakpoints', () => {
  it('writes one managed rule, shows the mode, and removes it for off; --dry-run writes nothing', () => {
    const file = join(tmp.dir, 'rules.json');
    writeFileSync(file, JSON.stringify([{ id: 'h', name: 'Mine', enabled: true, kind: 'highlight', match: {}, color: 'red' }]));
    const dry = run(['debugger', 'breakpoints', 'errors', '--rules', file, '--dry-run', '--json']);
    expect(dry.status, dry.err).toBe(0);
    expect(json(dry)).toMatchObject({ mode: 'errors', changed: false });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(1);

    const set = run(['debugger', 'breakpoints', 'post', '--rules', file, '--json']);
    expect(set.status, set.err).toBe(0);
    expect(json(set)).toMatchObject({ mode: 'post', label: 'Only POST', changed: true });
    const rules = JSON.parse(readFileSync(file, 'utf8')) as Array<{ id: string; kind: string; match: { method?: string } }>;
    expect(rules.map((r) => r.id)).toEqual(['h', 'auto-breakpoint']);
    expect(rules[1]).toMatchObject({ kind: 'breakpoint', match: { method: 'POST' } });

    expect(json(run(['debug', 'breakpoints', '--rules', file, '--json'])).mode).toBe('post');
    expect(json(run(['debugger', 'breakpoints', 'off', '--rules', file, '--json'])).mode).toBe('off');
    expect((JSON.parse(readFileSync(file, 'utf8')) as unknown[]).length).toBe(1);
    expect(run(['debugger', 'breakpoints', 'sometimes', '--rules', file, '--json']).status).toBe(2);
  });

  it('keeps the profiles of the app’s rules file', () => {
    const file = join(tmp.dir, 'profiles.json');
    writeFileSync(file, JSON.stringify({ active: 'Mine', profiles: { Mine: [], Other: [] } }));
    expect(run(['debugger', 'breakpoints', 'request', '--rules', file, '--json']).status).toBe(0);
    const f = JSON.parse(readFileSync(file, 'utf8')) as { profiles: Record<string, Array<{ id: string }>> };
    expect(f.profiles.Mine!.map((r) => r.id)).toEqual(['auto-breakpoint']);
    expect(f.profiles.Other).toEqual([]);
  });
});

describe('debugger annotate', () => {
  it('sets a note and a mark on one HAR entry, by id or place, and removes them', () => {
    const file = join(tmp.dir, 's.har');
    const entry = (id: string) => ({ startedDateTime: '2026-10-28T10:00:00Z', time: 1, request: { method: 'GET', url: `http://api.test/${id}`, headers: [] }, response: { status: 200, headers: [], content: { size: 0 } }, _testpion: { id } });
    writeFileSync(file, JSON.stringify({ log: { version: '1.2', entries: [entry('a'), entry('b')] } }));
    const r = run(['debugger', 'annotate', file, 'b', '--note', 'slow login', '--mark', 'orange', '--json']);
    expect(r.status, r.err).toBe(0);
    expect(json(r)).toMatchObject({ entry: 'b', note: 'slow login', mark: 'orange' });
    const har = JSON.parse(readFileSync(file, 'utf8')) as { log: { entries: Array<{ comment?: string; _testpion: { mark?: string } }> } };
    expect(har.log.entries[1]).toMatchObject({ comment: 'slow login', _testpion: { mark: 'orange' } });
    expect(har.log.entries[0]!.comment).toBeUndefined();
    expect(run(['debugger', 'annotate', file, '#2', '--note', '', '--mark', '', '--json']).status).toBe(0);
    expect((JSON.parse(readFileSync(file, 'utf8')) as typeof har).log.entries[1]!.comment).toBeUndefined();
    expect(run(['debugger', 'annotate', file, 'zzz', '--note', 'x', '--json']).status).toBe(2);
    expect(run(['debugger', 'annotate', file, 'a', '--json']).status).toBe(2);
    expect(run(['debugger', 'annotate', file, 'a', '--mark', 'pink', '--json']).status).toBe(2);
  });
});

describe('debugger presets', () => {
  it('lists the ready-made rules with the new ones, and adds one to a rules file', () => {
    const list = json(run(['debugger', 'presets', '--host', 'shop.test', '--json'])) as { presets: Array<{ id: string; label: string }> };
    const ids = list.presets.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['no-cache', 'no-encoding', 'gzip', 'ua-chrome', 'ua-iphone', 'ua-bot', 'require-auth']));
    const file = join(tmp.dir, 'p.json');
    writeFileSync(file, '[]');
    const added = run(['debugger', 'presets', '--add', 'ua-iphone', '--host', 'shop.test', '--rules', file, '--json']);
    expect(added.status, added.err).toBe(0);
    const rules = JSON.parse(readFileSync(file, 'utf8')) as Array<{ name: string; match: { host: string } }>;
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ name: 'User agent: iPhone', match: { host: 'shop.test' } });
    expect(run(['debugger', 'presets', '--add', 'nope', '--rules', file, '--json']).status).toBe(2);
  });
});

describe('debugger capture --paused', () => {
  it('--dry-run still changes nothing and the flag is known', () => {
    const r = run(['debugger', 'capture', '--paused', '--dry-run', '--json']);
    expect(r.status, r.err).toBe(0);
  });
});

describe('debugger remap and rule (FG-4, FG-6, FG-7, FG-26)', () => {
  it('adds, lists and removes host remaps, and imports a hosts file switched off', () => {
    const file = join(tmp.dir, 'remap.json');
    writeFileSync(file, '[]');
    const added = run(['debugger', 'remap', 'api.test=localhost:3000', '--keep-host', '--rules', file, '--json']);
    expect(added.status, added.err).toBe(0);
    expect(json(added).remaps).toEqual([expect.objectContaining({ host: 'api.test', to: 'localhost:3000', keepHost: true, enabled: true })]);
    expect(JSON.parse(readFileSync(file, 'utf8'))[0]).toMatchObject({ kind: 'remap', match: { host: 'api.test' }, remap: { to: 'localhost:3000', preserveHost: true } });
    const hosts = join(tmp.dir, 'hosts');
    writeFileSync(hosts, '# test\n127.0.0.1 localhost\n10.1.1.1 shop.test api.test\n');
    const imported = run(['debugger', 'remap', '--import-hosts', hosts, '--rules', file, '--json']);
    expect(imported.status, imported.err).toBe(0);
    expect(json(imported).added).toBe(1); // api.test is already remapped
    expect(JSON.parse(readFileSync(file, 'utf8'))[1]).toMatchObject({ enabled: false, match: { host: 'shop.test' } });
    expect(run(['debugger', 'remap', 'bad', '--rules', file, '--json']).status).toBe(2);
    expect(json(run(['debugger', 'remap', '--remove', 'api.test', '--rules', file, '--json'])).removed).toBe(1);
    expect(run(['debugger', 'remap', '--remove', 'nope.test', '--rules', file, '--json']).status).toBe(2);
    const dry = run(['debugger', 'remap', 'x.test=y.test', '--dry-run', '--rules', file, '--json']);
    expect(json(dry)).toMatchObject({ changed: false, dryRun: true });
  });

  it('adds a rule of any kind from JSON and refuses one that cannot work', () => {
    const file = join(tmp.dir, 'rule.json');
    writeFileSync(file, '[]');
    const fault = run(['debugger', 'rule', '--add', '{"kind":"fault","match":{"host":"api.test"},"fault":{"action":"error","status":503,"percent":20}}', '--rules', file, '--json']);
    expect(fault.status, fault.err).toBe(0);
    expect(json(fault).added.summary).toBe('For api.test: answer 503 in 20% of requests');
    const local = run(['debugger', 'rule', '--add', '{"kind":"reply","match":{"url":"*/users"},"reply":{"status":200,"file":"mocks/users.json"}}', '--rules', file, '--json']);
    expect(local.status, local.err).toBe(0);
    expect(run(['debugger', 'rule', '--add', '{"kind":"reply","match":{},"reply":{"status":200,"file":"../secret"}}', '--rules', file, '--json']).status).toBe(2);
    expect(run(['debugger', 'rule', '--add', '{"kind":"fault","match":{},"fault":{"action":"explode"}}', '--rules', file, '--json']).status).toBe(2);
    expect(run(['debugger', 'rule', '--add', '{"kind":"frame","match":{},"frame":{"action":"replace","find":"(a+)+b","regex":true,"replace":"x"}}', '--rules', file, '--json']).status).toBe(2);
    const rules = json(run(['debugger', 'rule', '--list', '--rules', file, '--json'])).rules as Array<{ id: string; kind: string }>;
    expect(rules.map((r) => r.kind)).toEqual(['fault', 'reply']);
    expect(run(['debugger', 'rule', '--remove', rules[0]!.id, '--rules', file, '--json']).status).toBe(0);
    expect((JSON.parse(readFileSync(file, 'utf8')) as unknown[]).length).toBe(1);
  });

  it('capture knows --throttle', () => {
    expect(run(['debugger', 'capture', '--throttle', '3g', '--dry-run', '--json']).status).toBe(0);
  });
});
