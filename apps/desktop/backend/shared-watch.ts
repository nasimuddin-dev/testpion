/**
 * Environments and API definitions shared from another workspace's folder (workspace.json `shared`) live outside this
 * workspace, where its watcher does not look: a pull in that folder would leave the window showing the old ones. Every few seconds the
 * names, sizes and times of those files are compared with the last look (a readdir and a stat per file, only when the
 * workspace shares something); a change is announced as the watcher announces one (`data.changed`, kind environments or specs).
 */
import { environmentFilesSignature, sharedDirs } from '@testpion/core';
import { join } from 'node:path';
import type { Backend } from './backend.js';

const EVERY_MS = 5_000;
const started = new WeakSet<Backend>();

export function watchSharedEnvironments(be: Backend): void {
  if (started.has(be)) return;
  started.add(be);
  let last: { root: string; sig: Record<string, string> } | undefined;
  const KINDS = [
    ['environments', /\.json$/i],
    ['specs', /\.(json|ya?ml)$/i],
  ] as const;
  const look = () => {
    try {
      if (!be.store) return;
      const sig: Record<string, string> = {};
      const changed: string[] = [];
      const paths: string[] = [];
      for (const [kind, files] of KINDS) {
        // (a shared specs/ folder's asyncapi/ too: the API definitions list shows those)
        const dirs = sharedDirs(be.ws.workspace, be.ws.root, kind).flatMap((s) => (kind === 'specs' ? [s.dir, join(s.dir, 'asyncapi')] : [s.dir]));
        sig[kind] = dirs.length ? environmentFilesSignature(dirs, files) : '';
        // a workspace opened (or switched): what is there now is the start, not a change
        if (last?.root === be.ws.root && last.sig[kind] !== sig[kind]) changed.push(kind), paths.push(...dirs);
      }
      if (changed.length) be.host.emit('data.changed', { method: 'disk', kinds: changed, paths: paths.slice(0, 10) });
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
