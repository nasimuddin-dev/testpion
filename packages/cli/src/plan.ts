/**
 * `--dry-run` for the commands that run git. The generic dry run (dry-run.ts) works on copies of files, and git changes
 * the repository itself (its commits, branches, remote), which a copy cannot show. These commands print what they would
 * do, from the repository's state, and run nothing.
 */
import { gitStatus } from '@testpion/core';
import { withWorkspace } from './shared.js';

type Opts = Record<string, unknown>;

/** Thrown by the dry run of a git command: the plan, and the command does not run. */
export class PlanOnly extends Error {
  constructor(readonly plan: Record<string, unknown>) {
    super('dry run');
  }
}

const n = (count: number, what: string) => `${count} ${what}${count === 1 ? '' : 's'}`;

/** The plan of a git command by its path: undefined when this call changes nothing (a listing). */
type Planner = (o: Opts, args: string[], root: string) => Promise<Record<string, unknown> | undefined>;

export const PLAN_ONLY: Record<string, Planner> = {
  'git commit': async (o, _a, root) => {
    const st = await gitStatus(root);
    const files = st.files.filter((f) => !o.staged || f.staged);
    return { would: `commit ${n(files.length, 'changed file')}${o.amend ? ', replacing the last commit' : ''} on ${st.branch ?? '(detached)'} with the message ${JSON.stringify(String(o.message ?? ''))}`, files: files.map((f) => f.path), secretScan: 'runs before the commit; a secret refuses it' };
  },
  'git push': async (_o, _a, root) => {
    const st = await gitStatus(root);
    return { would: `push ${n(st.ahead ?? 0, 'commit')} of ${st.branch ?? '(detached)'} to ${st.upstream ?? 'the remote'}`, ahead: st.ahead ?? 0 };
  },
  'git pull': async (o, _a, root) => {
    const st = await gitStatus(root);
    return { would: `bring in ${n(st.behind ?? 0, 'commit')} from ${st.upstream ?? 'the remote'} with a ${o.rebase ? 'rebase' : 'merge'}; stops on conflicts`, behind: st.behind ?? 0 };
  },
  'git sync': async (_o, _a, root) => {
    const st = await gitStatus(root);
    return { would: `fetch, merge ${n(st.behind ?? 0, 'incoming commit')} (uncommitted changes are set aside and put back), then push ${n(st.ahead ?? 0, 'commit')}`, ahead: st.ahead ?? 0, behind: st.behind ?? 0 };
  },
  'git resolve': async (o, a) => ({ would: `settle the conflicted file ${JSON.stringify(a[0] ?? '')} with ${o.ours ? '"ours"' : o.theirs ? '"theirs"' : 'the sides you chose'}; the other side's changes in it are dropped` }),
  'git switch': async (o, a) => ({ would: `${o.create ? 'create the branch ' : 'switch to the branch '}${JSON.stringify(a[0] ?? '')}` }),
  'git stash apply': async (_o, a) => ({ would: `put stash ${a[0] ?? '0'} back into the workspace files` }),
  'git stash pop': async (_o, a) => ({ would: `put stash ${a[0] ?? '0'} back into the workspace files and remove it from the list` }),
  'git stash drop': async (_o, a) => ({ would: `remove stash ${a[0] ?? '0'} for good` }),
  'git branch': async (o) => {
    if (o.rename) return { would: `rename the current branch to ${JSON.stringify(String(o.rename))}` };
    if (o.delete || o.forceDelete) return { would: `delete the local branch ${JSON.stringify(String(o.delete ?? o.forceDelete))}${o.forceDelete ? ' even if it is not merged' : ''}` };
    return undefined;
  },
  'git hook install': async () => ({ would: 'install the pre-commit hook that runs `testpion git check` (an existing hook of yours is never overwritten)' }),
};

/** The plan for `path` with these options, or undefined when the command has none (or this call is a listing). */
export async function planFor(path: string, workspace: unknown, o: Opts, args: string[]): Promise<Record<string, unknown> | undefined> {
  const planner = PLAN_ONLY[path];
  if (!planner) return undefined;
  return withWorkspace(typeof workspace === 'string' ? workspace : undefined, (store) => planner(o, args, store.root));
}
