#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';

// `testpion --version` and `testpion --help` are asked all the time (an install check, a shell, an agent finding its
// way) and the whole command line is about 500 modules to load. Those two are answered from dist/fast-index.json, which
// the build writes from the real program (scripts/fast-index.mjs); anything else, or an index older than the build, loads
// the command line as usual. TESTPION_FULL_CLI=1 skips the shortcut.
const only = process.argv.length === 3 ? process.argv[2] : undefined;

async function answerQuickly() {
  if (process.env.TESTPION_FULL_CLI || !['--version', '-V', '--help', '-h'].includes(only ?? '')) return false;
  // (the npm package copies this file and points the one import below at its bundle: this is the only place that names the build's folder)
  const dist = '../dist/';
  const file = new URL(`${dist}fast-index.json`, import.meta.url);
  let index;
  try {
    if (statSync(file).mtimeMs < statSync(new URL(`${dist}index.js`, import.meta.url)).mtimeMs) return false;
    index = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  if (only === '--version' || only === '-V') {
    process.stdout.write(`${index.version}\n`);
    return true;
  }
  const { Command } = await import('commander');
  const program = new Command(index.name).description(index.description).version(index.version);
  for (const c of index.commands) {
    const sub = program.command(c.name).description(c.description);
    if (c.summary) sub.summary(c.summary);
    if (c.aliases.length) sub.aliases(c.aliases);
    for (const a of c.args) sub.argument(a);
    if (c.hasOptions) sub.option('--x');
    if (c.group) sub.helpGroup(c.group);
  }
  program.outputHelp();
  return true;
}

// The command line is about 1,000 files of dist/ (cli, core, shared): loading them one by one is most of a command's
// start (about 1.9 s, 0.5 s as one file). The build also writes dist/bundle.js (scripts/bundle.mjs); it is used while it
// is newer than the last build of each of the three packages (tsc rewrites every output file, so any rebuild makes it
// stale and the files load as before). TESTPION_UNBUNDLED=1 skips it. (the npm package copies this file and points the
// one import of dist/index.js below at its own bundle, so that name appears once)
async function loadMain() {
  const entry = '../dist/index.js';
  if (!process.env.TESTPION_UNBUNDLED) {
    try {
      const mtime = (p) => statSync(new URL(p, import.meta.url)).mtimeMs;
      if (mtime('../dist/bundle.js') >= Math.max(mtime(entry), mtime('../../core/dist/index.js'), mtime('../../shared/dist/index.js'))) {
        // V8's compile cache (Node 22.1+) keeps the compiled bundle between runs
        (await import('node:module')).enableCompileCache?.();
        return (await import('../dist/bundle.js')).main;
      }
    } catch {
      // no bundle (a source checkout that was not built with it, the npm package): the files
    }
  }
  return (await import(entry)).main;
}

if (!(await answerQuickly())) {
  const main = await loadMain();

  // Let the event loop drain instead of calling process.exit() right away: exiting while libuv is still
  // finishing file work aborts Node on Windows ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)").
  // Pending stdout writes are flushed before a natural exit. If something keeps the loop alive (an MCP
  // child process, a keep-alive socket), the unref'd timer forces the exit after a grace period.
  const exitWith = (code) => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 3000).unref();
  };

  main().then(exitWith, (err) => {
    console.error(err);
    exitWith(3);
  });
}
