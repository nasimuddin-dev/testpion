import { existsSync, statSync, watch, type FSWatcher } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { WorkspaceManager } from '@testpion/core';
import { dim, bold, findWorkspaceUp } from './shared.js';

/** Files a run writes itself (results, reports, traces, the database): changes there never trigger a re-run. */
const IGNORED = /(^|[\\/])(runs|reports|traces|payloads|baselines|\.git|node_modules|\.testpion)([\\/]|$)|\.(sqlite|sqlite-journal|sqlite-wal|sqlite-shm|db|log)$|~$|\.swp$/;

/** The folders to watch: the workspace (when there is one) and the folders of the given files or folders. */
export function watchTargets(workspace: string | undefined, paths: string[] = []): string[] {
  const out = new Set<string>();
  const mgr = new WorkspaceManager();
  const root = workspace ? (mgr.resolve(workspace) ?? (existsSync(join(resolve(workspace), 'workspace.json')) ? resolve(workspace) : undefined)) : findWorkspaceUp(process.cwd());
  if (root) out.add(resolve(root));
  for (const p of paths) {
    if (/^https?:\/\//i.test(p) || /[*?]/.test(p)) continue;
    const abs = resolve(p);
    if (!existsSync(abs)) continue;
    const dir = statSync(abs).isDirectory() ? abs : dirname(abs);
    // already inside a watched folder?
    const inside = [...out].some((d) => {
      const r = relative(d, dir);
      return !r.startsWith('..') && !isAbsolute(r);
    });
    if (!inside) out.add(dir);
  }
  return [...out];
}

/**
 * Run, then run again whenever a file in `dirs` changes (collections, tests, environments, data
 * files …), until Ctrl+C. A change during a run queues one more run.
 */
export async function runWatching(dirs: string[], run: () => Promise<number>): Promise<number> {
  if (!dirs.length) throw new Error('Nothing to watch: give a workspace (-w) or test files');
  let last = await run();
  let running = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let changed = '';
  const again = async () => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    console.log(`\n${bold(`Changed: ${changed}`)} ${dim(new Date().toLocaleTimeString())}\n`);
    try {
      last = await run();
    } catch (e) {
      console.error((e as Error).message);
      last = 1;
    } finally {
      running = false;
    }
    if (pending) {
      pending = false;
      void again();
    } else console.log(dim(`\nWatching for changes (Ctrl+C to stop)…`));
  };
  const watchers: FSWatcher[] = dirs.map((d) =>
    watch(d, { recursive: true }, (_event, file) => {
      const name = String(file ?? '');
      if (!name || IGNORED.test(name)) return;
      changed = name.replace(/\\/g, '/');
      clearTimeout(timer);
      timer = setTimeout(() => void again(), 300);
    }),
  );
  console.log(dim(`\nWatching ${dirs.join(', ')} for changes (Ctrl+C to stop)…`));
  await new Promise<void>((done) => {
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      done();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  clearTimeout(timer);
  for (const w of watchers) w.close();
  return last;
}
