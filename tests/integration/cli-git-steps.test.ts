import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
import { gitStatus } from '../../packages/core/src/index.js';
import { runCliSync } from '../helpers';
import { makeRepo, type TestRepo } from '../helpers-git';

// a conflict in a flow file is listed and settled by step on the command line (the same core as the app and MCP)

let r: TestRepo;
beforeAll(async () => {
  r = await makeRepo();
  r.write('tests/flows/two.yaml', 'name: Two\nowner: base\nsteps:\n  - id: a\n    request:\n      url: "{{h}}/a"\n  - id: b\n    request:\n      url: "{{h}}/b"\n');
  await r.commit('two steps');
  await r.git('checkout', '-b', 'theirs');
  r.edit('tests/flows/two.yaml', (t) => t.replace('/a"', '/a-theirs"').replace('/b"', '/b-theirs"'));
  await r.commit('theirs');
  await r.git('checkout', 'main');
  r.edit('tests/flows/two.yaml', (t) => t.replace('/a"', '/a-ours"').replace('/b"', '/b-ours"'));
  await r.commit('ours');
  await r.git('merge', 'theirs').catch(() => undefined);
  expect((await gitStatus(r.ws)).files.find((f) => f.path === 'tests/flows/two.yaml')?.state).toBe('conflicted');
});
afterAll(() => r.cleanup());

describe('testpion git conflicts / resolve, by step', () => {
  it('lists the steps with their hunks, refuses an edit of a step, and settles a step in one choice', () => {
    const listed = runCliSync(['git', 'conflicts', '--json', '-w', r.ws]);
    expect(listed.status).toBe(0);
    const env = JSON.parse(listed.out);
    const detail = env.data[0];
    expect(detail.steps.map((s: { key: string }) => s.key)).toEqual(['step:a', 'step:b']);
    const bad = runCliSync(['git', 'resolve', 'tests/flows/two.yaml', '--edit', 'step:a=x', '--yes', '--json', '-w', r.ws]);
    expect(bad.status).toBe(2);
    expect(JSON.parse(bad.out).errors[0].message).toMatch(/a step is settled with --pick step:a=ours\|theirs/);
    const unknown = runCliSync(['git', 'resolve', 'tests/flows/two.yaml', '--pick', 'step:zzz=theirs', '--yes', '--json', '-w', r.ws]);
    expect(unknown.status).toBe(2);
    const ok = runCliSync(['git', 'resolve', 'tests/flows/two.yaml', '--pick', 'step:a=theirs', '--pick', 'step:b=ours', '--yes', '--json', '-w', r.ws]);
    expect(ok.status).toBe(0);
    const text = r.read('tests/flows/two.yaml');
    expect(text).toContain('/a-theirs"');
    expect(text).toContain('/b-ours"');
    expect(text).not.toContain('<<<<<<<');
  });
});
