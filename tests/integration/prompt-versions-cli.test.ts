import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { WorkspaceStore, EVALUATIONS_LIBRARY, SAMPLE_NAME, type SavedEvaluation } from '../../packages/core/src/index.js';
import { cliData, runCli, tempDir } from '../helpers.js';

/**
 * A-4 and A-5: prompt versions. Each version is tied to the runs made with exactly its prompt; making one current is gated by the
 * pass line and by the prompt in use, and the prompt in use is kept when it was not a version.
 */
const tmp = tempDir('tp-prompt-versions-');
let ws: string;
let env: NodeJS.ProcessEnv;

const edit = (change: (d: SavedEvaluation) => SavedEvaluation) => {
  const store = WorkspaceStore.open(ws);
  try {
    const lib = store.getLibrary<SavedEvaluation>(EVALUATIONS_LIBRARY);
    store.saveLibrary(EVALUATIONS_LIBRARY, { folders: lib.folders, items: lib.items.map((i) => (i.name === SAMPLE_NAME ? { ...i, data: change(i.data) } : i)) });
  } finally {
    store.close();
  }
};

beforeAll(async () => {
  ws = join(tmp.dir, 'ws');
  WorkspaceStore.create(ws, 'PV').close();
  env = { ...process.env, TESTPION_HOME: join(tmp.dir, 'home') };
  // the sample is made and run once (10 of 10 with the offline demo model)
  expect((await runCli(['eval', 'sample', '-w', ws, '-q'], { env })).status).toBe(0);
  edit((d) => ({ ...d, passLine: 80 }));
}, 120_000);
afterAll(() => tmp.cleanup());

const cli = (args: string[]) => runCli(args, { env });
const versions = async () => cliData((await cli(['eval', 'versions', SAMPLE_NAME, '-w', ws, '--json'])).out);

describe('prompt versions of a saved evaluation', () => {
  it('has none at first, and the prompt in use is not saved as one', async () => {
    const v = await versions();
    expect(v).toMatchObject({ evaluation: SAMPLE_NAME, currentSaved: false, versions: [], passLine: 80 });
    // the run of the prompt in use is known by what it ran
    expect(v.currentRun).toMatchObject({ passed: 10, total: 10 });
    expect((await cli(['eval', 'versions', SAMPLE_NAME, '-w', ws])).out).toContain('The prompt in use is not saved as a version');
  }, 120_000);

  it('saving the prompt as a version ties the run made with it to that version', async () => {
    const save = cliData((await cli(['eval', 'version-save', SAMPLE_NAME, 'Original', '--note', 'the first wording', '-w', ws, '--json'])).out);
    expect(save).toMatchObject({ name: 'Original', note: 'the first wording' });
    const v = await versions();
    expect(v.currentSaved).toBe(true);
    expect(v.versions).toHaveLength(1);
    expect(v.versions[0]).toMatchObject({ name: 'Original', current: true, run: { passed: 10, total: 10, passRate: 1 } });
    expect(v.text).toBe('* Original: 10 of 10 passed (100%)');
    // the same prompt is not saved twice, and a name is not used twice
    expect((await cli(['eval', 'version-save', SAMPLE_NAME, 'Again', '-w', ws])).status).not.toBe(0);
    // the report card names the version
    const report = cliData((await cli(['eval', 'summary', 'last', '-w', ws, '--json'])).out);
    expect(report.promptVersion).toMatchObject({ name: 'Original', current: true });
    expect(report.text).toContain('Prompt version: Original.');
  }, 120_000);

  it('a worse prompt is a version of its own with its own result', async () => {
    // a prompt that no longer tells the model what to answer: the demo model echoes it, and the expected word is not in most of them
    edit((d) => ({ ...d, prompt: 'Reply to: {{input}}' }));
    expect((await cli(['eval', 'run', SAMPLE_NAME, '-w', ws, '-q', '-r', 'console'])).status).toBe(1);
    expect((await cli(['eval', 'version-save', SAMPLE_NAME, 'Vague', '-w', ws])).status).toBe(0);
    const v = await versions();
    const byName = Object.fromEntries(v.versions.map((x: { name: string }) => [x.name, x]));
    expect(byName.Vague.current).toBe(true);
    expect(byName.Vague.run.passed).toBeLessThan(10);
    expect(byName.Original.run.passed).toBe(10);
  }, 120_000);

  it('making a better version current goes through; the one before is kept', async () => {
    const r = cliData((await cli(['eval', 'version-use', SAMPLE_NAME, 'Original', '-w', ws, '--json'])).out);
    expect(r).toMatchObject({ version: 'Original', gated: [] });
    expect(r.kept).toBeUndefined();
    const v = await versions();
    expect(v.versions.find((x: { name: string }) => x.name === 'Original').current).toBe(true);
  }, 120_000);

  it('making a version under the pass line current asks first and says the numbers; --confirm does it', async () => {
    const refused = await cli(['eval', 'version-use', SAMPLE_NAME, 'Vague', '-w', ws]);
    expect(refused.status).not.toBe(0);
    expect(refused.out + refused.err).toMatch(/"Vague" passed \d+ of 10 .*the pass line is 80%\./);
    expect(refused.out + refused.err).toMatch(/the prompt in use \("Original"\) passed 100%/);
    expect(refused.out + refused.err).toContain('Confirm to make it current anyway.');
    expect((await versions()).versions.find((x: { name: string }) => x.name === 'Vague').current).toBe(false);
    const ok = cliData((await cli(['eval', 'version-use', SAMPLE_NAME, 'Vague', '--confirm', '-w', ws, '--json'])).out);
    expect(ok.gated.length).toBe(2);
    expect((await versions()).versions.find((x: { name: string }) => x.name === 'Vague').current).toBe(true);
  }, 120_000);

  it('a prompt in use that is not a version is kept as "Before …" when another is made current; a version never run asks first', async () => {
    edit((d) => ({ ...d, prompt: `${d.prompt}\nAnswer briefly.` }));
    const unrun = await cli(['eval', 'version-use', SAMPLE_NAME, 'Original', '-w', ws]);
    // Original has a run and passes: no gate, so it goes through and the unsaved prompt is kept
    expect(unrun.status).toBe(0);
    const v = await versions();
    expect(v.versions.map((x: { name: string }) => x.name)).toContain('Before Original');
    const kept = v.versions.find((x: { name: string }) => x.name === 'Before Original');
    expect(kept.run).toBeUndefined();
    // using that never-run version asks first
    const gated = await cli(['eval', 'version-use', SAMPLE_NAME, 'Before Original', '-w', ws]);
    expect(gated.status).not.toBe(0);
    expect(gated.out + gated.err).toContain('has not been run');
    expect((await cli(['eval', 'version-use', SAMPLE_NAME, 'Nope', '-w', ws])).status).not.toBe(0);
  }, 120_000);
});
