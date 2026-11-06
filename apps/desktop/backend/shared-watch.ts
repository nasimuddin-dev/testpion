/**
 * Environments shared from another workspace's folder (workspace.json `shared`) live outside this workspace, where its
 * watcher does not look: a pull in that folder would leave the window showing the old ones. Every few seconds the
 * names, sizes and times of those files are compared with the last look (a readdir and a stat per file, only when the
 * workspace shares something); a change is announced as the watcher announces one (`data.changed`, kind environments).
 */
import { environmentFilesSignature, sharedDirs } from '@testpion/core';
import type { Backend } from './backend.js';

const EVERY_MS = 5_000;
const started = new WeakSet<Backend>();

export function watchSharedEnvironments(be: Backend): void {
  if (started.has(be)) return;
  started.add(be);
  let last: { root: string; sig: string } | undefined;
  const look = () => {
    try {
      if (!be.store) return;
      const dirs = sharedDirs(be.ws.workspace, be.ws.root, 'environments').map((s) => s.dir);
      const sig = dirs.length ? environmentFilesSignature(dirs) : '';
      // a workspace opened (or switched): what is there now is the start, not a change
      if (last?.root === be.ws.root && last.sig !== sig) be.host.emit('data.changed', { method: 'disk', kinds: ['environments'], paths: dirs.slice(0, 10) });
      last = { root: be.ws.root, sig };
    } catch {
      /* a folder going away while it is read: the next look sees what is left */
    }
  };
  const timer = setInterval(look, EVERY_MS);
  // never keeps the process alive (the CLI and tests end when their work does), and stops with the backend (dispose
  // clears `deferred`, and clearTimeout stops an interval in Node)
  timer.unref?.();
  be.deferred.push(timer);
}
