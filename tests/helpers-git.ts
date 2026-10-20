import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WorkspaceStore, runGit } from '../packages/core/src/index.js';
import { tempDir } from './helpers';

/**
 * A scripted git repository for the release-B tests: a TestPion workspace (the kinds fixture) committed on `main`, a
 * `git()` that has an identity (no global config is read), and helpers to edit files. No network.
 */
export const FIXTURE = join(__dirname, 'fixtures', 'kinds', 'workspace');

export interface TestRepo {
  /** The workspace folder (the repository itself, or a folder inside it with `inFolder`). */
  ws: string;
  /** The repository root. */
  repo: string;
  store: WorkspaceStore;
  git(...args: string[]): Promise<string>;
  edit(path: string, change: (text: string) => string): void;
  write(path: string, text: string): void;
  read(path: string): string;
  commit(message: string): Promise<void>;
  cleanup(): void;
}

export async function makeRepo(o: { inFolder?: boolean; autocrlf?: boolean; alias?: boolean } = {}): Promise<TestRepo> {
  const t = tempDir('tp-git-ops-', { alias: o.alias });
  const repo = t.dir;
  const ws = o.inFolder ? join(repo, 'apps', 'tests') : repo;
  mkdirSync(ws, { recursive: true });
  // files are made through the real folder; the calls use the (possibly linked) path the app would be given
  const real = o.alias ? (o.inFolder ? join(t.real, 'apps', 'tests') : t.real) : ws;
  mkdirSync(real, { recursive: true });
  const store = WorkspaceStore.create(real, 'Kinds');
  cpSync(FIXTURE, real, { recursive: true });
  const git = (...args: string[]) => runGit(ws, ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', '-c', 'commit.gpgsign=false', ...args]);
  await runGit(repo, ['init', '-b', 'main']);
  await runGit(repo, ['config', 'user.name', 'Tester']);
  await runGit(repo, ['config', 'user.email', 'tester@example.com']);
  await runGit(repo, ['config', 'commit.gpgsign', 'false']);
  if (o.autocrlf) await runGit(repo, ['config', 'core.autocrlf', 'true']);
  const api: TestRepo = {
    ws,
    repo,
    store,
    git,
    edit: (p, change) => api.write(p, change(readFileSync(join(ws, p), 'utf8'))),
    write: (p, text) => {
      mkdirSync(dirname(join(ws, p)), { recursive: true });
      writeFileSync(join(ws, p), text);
    },
    read: (p) => readFileSync(join(ws, p), 'utf8'),
    commit: async (message) => {
      await git('add', '-A', '.');
      await git('commit', '-m', message);
    },
    cleanup: () => {
      try {
        store.close();
      } catch {
        /* closed */
      }
      t.cleanup();
    },
  };
  await api.commit('base');
  return api;
}
