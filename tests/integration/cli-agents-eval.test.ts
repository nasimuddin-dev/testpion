import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { WorkspaceStore } from '../../packages/core/src/index.js';
import { cliPath, tempDir, cliData } from '../helpers.js';

// From the command line: `testpion agents init` (AGENTS.md, CLAUDE.md, the Cursor rule; the report; exit codes) and
// `testpion eval compare` / `eval matrix` on real evaluation runs (the mock provider, a similarity evaluator): exit 1
// on regressions beyond the threshold, 0 within it, 2 for a run that is not there.
const run = promisify(execFile);
const tmp = tempDir('tp-cli-agents-eval-');
const ws = join(tmp.dir, 'ws');

const cli = async (...args: string[]) => {
  try {
    const r = await run(process.execPath, [cliPath, ...args], { encoding: 'utf8', cwd: ws, env: { ...process.env, NO_COLOR: '1', TESTPION_HOME: join(tmp.dir, 'home') }, maxBuffer: 64 * 1024 * 1024 });
    return { status: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { status: x.code ?? -1, out: x.stdout ?? '', err: x.stderr ?? '' };
  }
};

/** A saved evaluation of 20 cases: `words` are added to the prompt, so the mock's answer (the prompt) scores differently. */
const evaluation = (name: string, words: string) => ({
  id: name.toLowerCase().replace(/\W+/g, '-'),
  name,
  data: {
    name,
    type: 'llm',
    provider: 'mock',
    model: 'mock',
    prompt: `{{input}} ${words}`,
    format: 'text',
    datasetFormat: 'jsonl',
    dataset: Array.from({ length: 20 }, (_, i) =>
      JSON.stringify({ id: String(i + 1), input: `case ${i + 1} refund`, expected: i % 2 ? 'refund booking' : 'refund cancel', tags: i % 4 ? ['core'] : ['edge'] }),
    ).join('\n'),
    expectedField: 'expected',
    evaluators: [{ type: 'similarity', expected: '{{expected}}', threshold: 0.3 }],
    concurrency: 4,
    retries: 0,
  },
});

beforeAll(() => {
  const s = WorkspaceStore.create(ws, 'CLI agents');
  s.saveCollection({ id: 'pets', name: 'Pets', items: [{ kind: 'http', id: 'r', name: 'List', request: { method: 'GET', url: '{{baseUrl}}/pets' } }] } as never);
  s.saveEnvironment({ id: 'prod', name: 'Prod', isProduction: true, variables: [{ key: 'token', value: 'tok-SECRET-VALUE', secret: false, enabled: true }] } as never);
  mkdirSync(join(ws, 'library'), { recursive: true });
  // "good" answers with the words the expected texts hold; "worse" without them
  writeFileSync(
    join(ws, 'library', 'evaluations.json'),
    JSON.stringify({ schemaVersion: '1.0', folders: [], items: [evaluation('Good', 'booking cancel'), evaluation('Worse', 'zzz'), evaluation('Same', 'booking cancel')] }),
  );
  s.close();
});
afterAll(() => tmp.cleanup());

describe('testpion agents init', () => {
  it('writes AGENTS.md, CLAUDE.md and the Cursor rule, reports them as JSON, and is idempotent', async () => {
    const r = await cli('agents', 'init', '--targets', 'claude,cursor', '--json');
    expect(r.status).toBe(0);
    const doc = cliData(r.out) as { workspace: string; files: Array<{ path: string; status: string }> };
    expect(doc.workspace).toBe('CLI agents');
    expect(doc.files.map((f) => `${f.path}=${f.status}`)).toEqual(['AGENTS.md=created', 'CLAUDE.md=created', '.cursor/rules/testpion.mdc=created']);
    const md = readFileSync(join(ws, 'AGENTS.md'), 'utf8');
    expect(md).toContain('Pets (1 request)');
    expect(md).toContain('Prod — **production**');
    expect(md).not.toContain('tok-SECRET-VALUE');
    expect(md).not.toContain(ws);
    const again = await cli('agents', 'init', '--targets', 'agents,claude,cursor');
    expect(again.status).toBe(0);
    expect(again.out).toMatch(/unchanged\s+AGENTS\.md/);
    expect(again.out).toMatch(/unchanged\s+CLAUDE\.md/);
  }, 60_000);

  it('keeps the user text, skips a file with broken markers (exit 2) and repairs it with --force', async () => {
    writeFileSync(join(ws, 'AGENTS.md'), '# Our rules\r\n\r\nRun lint first.\r\n<!-- testpion:begin -->\r\nhalf a block\r\n');
    const broken = await cli('agents', 'init', '--json');
    expect(broken.status).toBe(2);
    expect(cliData(broken.out).files[0]).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/without its end/) });
    expect(readFileSync(join(ws, 'AGENTS.md'), 'utf8')).toContain('half a block');
    const forced = await cli('agents', 'init', '--force', '--yes', '--json');
    expect(forced.status).toBe(0);
    const text = readFileSync(join(ws, 'AGENTS.md'), 'utf8');
    expect(text.startsWith('# Our rules\r\n\r\nRun lint first.\r\nhalf a block\r\n\r\n<!-- testpion:begin -->\r\n')).toBe(true);
    expect((await cli('agents', 'init', '--json')).out).toMatch(/"status": "unchanged"/);
  }, 60_000);

  it('an unknown target and no workspace are configuration errors; agents-md still works and --stdout prints the block', async () => {
    const bad = await cli('agents', 'init', '--targets', 'windsurf');
    expect(bad.status).toBe(2);
    expect(bad.err).toMatch(/Unknown target "windsurf"/);
    const printed = await cli('agents-md', '--stdout');
    expect(printed.status).toBe(0);
    expect(printed.out.startsWith('<!-- testpion:begin -->')).toBe(true);
    const nowhere = await run(process.execPath, [cliPath, 'agents', 'init'], { cwd: tmp.dir, env: { ...process.env, NO_COLOR: '1', TESTPION_HOME: join(tmp.dir, 'home2') } }).then(
      () => 0,
      (e: { code?: number }) => e.code,
    );
    expect(nowhere).toBe(2);
    expect(existsSync(join(tmp.dir, 'AGENTS.md'))).toBe(false);
  }, 60_000);

  it('agent-info and AGENTS.md share the commands and exit codes', async () => {
    const info = JSON.parse((await cli('agent-info')).out) as { commands: Record<string, string>; exitCodes: Record<string, string> };
    expect(info.commands.agentsInit).toMatch(/testpion agents init/);
    expect(info.commands.evaluation).toMatch(/testpion eval compare/);
    expect(readFileSync(join(ws, 'AGENTS.md'), 'utf8')).toContain(`\`0\` ${info.exitCodes['0']}`);
  }, 60_000);
});

describe('testpion eval compare and eval matrix', () => {
  const runIdOf = (out: string) => /run: (run-[\w-]+)/.exec(out)?.[1];
  let good = '';
  let worse = '';
  let same = '';
  beforeAll(async () => {
    for (const [n, set] of [
      ['Good', (id: string) => (good = id)],
      ['Worse', (id: string) => (worse = id)],
      ['Same', (id: string) => (same = id)],
    ] as const) {
      const r = await cli('eval', 'run', n, '-r', 'json');
      expect([0, 1]).toContain(r.status);
      set(runIdOf(r.out)!);
    }
    expect(good && worse && same).toBeTruthy();
  }, 120_000);

  it('exits 1 on regressions beyond the threshold and lists them worst first', async () => {
    const r = await cli('eval', 'compare', worse, '--baseline', good, '--json');
    expect(r.status).toBe(1);
    const doc = cliData(r.out) as { passed: boolean; counts: { regressed: number }; regressions: Array<{ key: string; delta?: number; resultId: string }>; cases: number };
    expect(doc.passed).toBe(false);
    expect(doc.cases).toBe(20);
    expect(doc.counts.regressed).toBeGreaterThan(0);
    expect(doc.regressions[0]!.resultId).toMatch(/^worse:\d+$/);
    // the text report says the same
    const text = await cli('eval', 'compare', worse, '--baseline', good);
    expect(text.status).toBe(1);
    expect(text.out).toMatch(/Regressed/);
    // allowed regressions pass CI
    expect((await cli('eval', 'compare', worse, '--baseline', good, '--max-regressions', String(doc.counts.regressed))).status).toBe(0);
  }, 60_000);

  it('the same answers are no regression (by name: the newest run of it); a run that is not there is exit 2', async () => {
    const r = await cli('eval', 'compare', 'Same', '--baseline', good, '--json');
    expect(r.status).toBe(0);
    expect(cliData(r.out)).toMatchObject({ passed: true, counts: { regressed: 0, improved: 0, unchanged: 20, missing: 0, added: 0 } });
    const missing = await cli('eval', 'compare', 'run-nope', '--baseline', good);
    expect(missing.status).toBe(2);
    expect(missing.err).toMatch(/No finished run "run-nope"/);
    expect((await cli('eval', 'compare', same, '--baseline', good, '--threshold', '2')).status).toBe(2);
  }, 60_000);

  it('eval matrix prints a page as JSON: columns, counts, tags', async () => {
    const r = await cli('eval', 'matrix', good, worse, same, '--baseline', good, '--filter', 'regressed', '--tag', 'edge', '--json');
    expect(r.status).toBe(0);
    const p = cliData(r.out) as { columns: Array<{ label: string }>; cases: number; rows: Array<{ key: string; tags: string[] }>; tags: Array<{ tag: string }>; counts: { all: number } };
    expect(p.columns.map((c) => c.label)).toEqual(['Good · Mock/mock', 'Worse · Mock/mock', 'Same · Mock/mock']);
    expect(p.cases).toBe(20);
    expect(p.counts.all).toBe(5);
    expect(p.rows.every((x) => x.tags.includes('edge'))).toBe(true);
    expect(p.tags.map((t) => t.tag).sort()).toEqual(['core', 'edge']);
  }, 60_000);
});
