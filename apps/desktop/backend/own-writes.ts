import { AsyncLocalStorage } from 'node:async_hooks';
import { sep } from 'node:path';
import { changeKind, onOwnWrite, relativeInside, type WorkspaceChangeKind } from '@testpion/core';

/** Workspace files the app itself wrote, as the folder watcher would describe them (GIT-103). */
export interface OwnWriteBatch {
  kinds: WorkspaceChangeKind[];
  /** Paths inside the workspace (forward slashes), the first 50. */
  paths: string[];
}

export function batchOf(paths: Iterable<string>): OwnWriteBatch {
  const all = [...paths];
  return { kinds: [...new Set(all.map((p) => changeKind(p)!))], paths: all.slice(0, 50) };
}

/**
 * Every change the app makes to the open workspace's files (fsutil reports each one it writes, removes, renames or
 * copies) becomes the same `data.changed` the watcher sends for changes made outside: `{ method, kinds, paths }`. So a
 * view that lists files refreshes whoever wrote them — an RPC from this window (`tests.write`), the AI assistant, a run
 * — without each handler having to say so. Writes are attributed to the RPC that made them (AsyncLocalStorage: RPCs run
 * at the same time keep their own); writes made outside an RPC, or after it answered (a run it started), are sent in a
 * batch once they settle.
 */
export class OwnWrites {
  private readonly als = new AsyncLocalStorage<{ paths: Set<string>; open: boolean }>();
  private background = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly off: () => void;

  constructor(
    private readonly root: () => string | undefined,
    private readonly emitBackground: (b: OwnWriteBatch) => void,
    private readonly settleMs = 150,
  ) {
    this.off = onOwnWrite((abs) => this.note(abs));
  }

  /** The path inside the workspace when it is a file the watcher would report (not results, not local state). */
  private inside(abs: string): string | undefined {
    const root = this.root();
    if (!root) return undefined;
    // as named or really: a write may name the workspace by its real path while it is open through a link
    const rel = relativeInside(root, abs);
    if (!rel) return undefined;
    const p = rel.split(sep).join('/');
    return changeKind(p) ? p : undefined;
  }

  private note(abs: string): void {
    const p = this.inside(abs);
    if (!p) return;
    const ctx = this.als.getStore();
    if (ctx?.open) return void ctx.paths.add(p);
    this.background.add(p);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.settleMs);
  }

  private flush(): void {
    this.timer = undefined;
    if (!this.background.size) return;
    const b = batchOf(this.background);
    this.background = new Set();
    this.emitBackground(b);
  }

  /** Run one RPC; `done` gets what it wrote (also when it failed part way), once it is over. */
  async run<T>(fn: () => Promise<T>, done: (b: OwnWriteBatch) => void): Promise<T> {
    const ctx = { paths: new Set<string>(), open: true };
    try {
      return await this.als.run(ctx, fn);
    } finally {
      ctx.open = false;
      if (ctx.paths.size) done(batchOf(ctx.paths));
    }
  }

  dispose(): void {
    this.off();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.background.clear();
  }
}
