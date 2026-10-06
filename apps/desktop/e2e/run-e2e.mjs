#!/usr/bin/env node
/**
 * End-to-end UI regression suite: each plan in e2e/plans runs in the real app against a fresh copy of the examples
 * workspace, and every step's result is checked against the plan's expectation. Run it before every release.
 *
 *   npm run e2e -w @testpion/desktop                      the development build (run `npm run build` first)
 *   npm run e2e -w @testpion/desktop -- --exe "<path to TestPion.exe>"   the installed app
 *   ... -- --only rename,layout                           some plans
 *   ... -- --out <dir>                                    where screenshots and reports go (default: a temp folder)
 *
 * A plan is a CommonJS module exporting an array of steps [name, code, shot?, expect?]: `code` is an expression run in
 * the window (it may use the helpers in e2e/helpers.js as __t); `expect` is a RegExp the result must match, or a
 * function (result) => true | 'reason'. Without one, the result must not show a failure marker (NO …, ERR, NOT …).
 * The array may carry `prepare(workspaceDir, outDir)` (fixtures before the app starts) and `env` (extra variables).
 * A plan that fails is run once more; passing then is reported as flaky. Exit code 1 when anything failed.
 */
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const exe = opt('exe');
const only = opt('only')
  ?.split(',')
  .map((s) => s.trim());
const out = resolve(opt('out') ?? mkdtempSync(join(tmpdir(), 'testpion-e2e-')));
const timeoutSec = Number(opt('timeout') ?? 600);

const FAILURE = /^(NO\b|ERR\b)|\bNO (INPUT|MENU|ROW|DIALOG|BUTTON|TAB|PICKER|OVERFLOW)|NOT RENAMED|NOTHING$/;

/** A fresh home: the examples workspace (as committed) and settings that open it. */
function freshHome(name, settings = {}) {
  const home = join(out, 'homes', name);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  const ws = join(home, 'ws');
  const src = join(repo, 'examples', 'public-workspace');
  cpSync(src, ws, { recursive: true, filter: (p) => !/[\\/](runs|traces|payloads|reports|\.local)([\\/]|$)|database\.sqlite|AGENTS\.md$/.test(p) });
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ schemaVersion: '1.0', theme: 'dark', fontSize: 14, telemetry: false, lastWorkspace: ws, workspacePaths: [ws], ...settings }, null, 2));
  return { home, ws };
}

function launch(planFile, home, planOut, env) {
  const electron = exe ? exe : join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const appArgs = exe ? [] : [join(repo, 'apps', 'desktop')];
  return new Promise((done) => {
    const child = spawn(electron, appArgs, {
      env: { ...process.env, TESTPION_HOME: home, TESTPION_CAPTURE_SCRIPT: join(here, 'harness.cjs'), E2E_PLAN: planFile, E2E_OUT: planOut, ...env },
      stdio: 'ignore',
    });
    const timer = setTimeout(() => child.kill(), timeoutSec * 1000);
    child.on('exit', () => (clearTimeout(timer), done()));
  });
}

function check(step, plan) {
  const def = plan.find((s) => s[0] === step.name);
  const expect = def?.[3];
  const r = step.result ?? '';
  if (step.errors?.length && !def?.[4]?.allowErrors) return `console errors: ${step.errors.join(' | ').slice(0, 200)}`;
  if (expect instanceof RegExp) return expect.test(r) ? undefined : `expected ${expect}`;
  if (typeof expect === 'function') {
    const v = expect(r);
    return v === true || v === undefined ? undefined : typeof v === 'string' ? v : 'expectation not met';
  }
  return FAILURE.test(r) ? 'failure marker in the result' : undefined;
}

async function runPlan(file, attempt) {
  const name = basename(file, '.cjs');
  const plan = require(file);
  const { home, ws } = freshHome(`${name}-${attempt}`, plan.settings);
  const planOut = join(out, `${name}${attempt > 1 ? `-retry` : ''}`);
  rmSync(planOut, { recursive: true, force: true });
  mkdirSync(planOut, { recursive: true });
  if (typeof plan.prepare === 'function') await plan.prepare(ws, planOut);
  const env = typeof plan.env === 'function' ? plan.env(planOut) : (plan.env ?? {});
  const t0 = Date.now();
  await launch(file, home, planOut, env);
  const reportFile = join(planOut, 'report.json');
  if (!existsSync(reportFile)) return { name, ok: false, seconds: Math.round((Date.now() - t0) / 1000), failures: [{ step: '(plan)', why: 'no report: the app exited or timed out' }], out: planOut };
  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  const failures = [];
  for (const step of report.steps) {
    const why = check(step, plan);
    if (why) failures.push({ step: step.name, why, result: String(step.result).slice(0, 300) });
  }
  const missing = plan.filter((s) => !report.steps.some((r) => r.name === s[0])).map((s) => s[0]);
  for (const m of missing) failures.push({ step: m, why: 'did not run' });
  return { name, ok: failures.length === 0, seconds: Math.round((Date.now() - t0) / 1000), steps: report.steps.length, failures, out: planOut };
}

/** The local demo servers (REST on 4010, GraphQL, WebSocket, gRPC, …) some plans send to; started unless already up. */
const portOpen = (port) =>
  new Promise((ok) => {
    const s = connect(port, '127.0.0.1', () => (s.destroy(), ok(true))).on('error', () => ok(false));
  });
async function demoServers() {
  if (await portOpen(4010)) return undefined;
  const child = spawn(process.execPath, [join(repo, 'examples', 'servers', 'demo-servers.mjs')], { stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await portOpen(4010)); i++) await new Promise((r) => setTimeout(r, 200));
  return child;
}

const plans = readdirSync(join(here, 'plans'))
  .filter((f) => f.endsWith('.cjs') && (only ? only.includes(basename(f, '.cjs')) : !f.startsWith('_')))
  .sort()
  .map((f) => join(here, 'plans', f));
if (!plans.length) {
  console.error('No plans to run');
  process.exit(2);
}
console.log(`TestPion e2e: ${plans.length} plans against ${exe ? exe : 'the development build'}; output in ${out}\n`);
const servers = await demoServers();
const results = [];
for (const file of plans) {
  let r = await runPlan(file, 1);
  if (!r.ok) {
    const again = await runPlan(file, 2);
    if (again.ok) r = { ...again, flaky: r.failures };
    else r = { ...again, firstFailures: r.failures };
  }
  results.push(r);
  console.log(`${r.ok ? (r.flaky ? 'FLAKY' : 'PASS ') : 'FAIL '} ${r.name.padEnd(22)} ${String(r.steps ?? 0).padStart(3)} steps  ${r.seconds}s`);
  for (const f of r.ok ? (r.flaky ?? []) : r.failures) console.log(`        ${r.ok ? '(first run) ' : ''}${f.step}: ${f.why}${f.result ? `\n          → ${f.result}` : ''}`);
}
servers?.kill();
writeFileSync(join(out, 'summary.json'), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
const flaky = results.filter((r) => r.flaky);
console.log(
  `\n${results.length - failed.length}/${results.length} plans passed${flaky.length ? ` (${flaky.length} flaky: ${flaky.map((r) => r.name).join(', ')})` : ''}. Screenshots and reports: ${out}`,
);
process.exit(failed.length ? 1 : 0);
