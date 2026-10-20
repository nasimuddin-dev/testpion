/** RPC handlers: Fix git setup, big files, Share session, CODEOWNERS and the secret scan's allowlist (release C of planning/git-everything.md). */
import {
  allowSecret,
  checkReferences,
  disallowSecret,
  findLargeFiles,
  fixGitSetup,
  listSharedSessions,
  planCodeowners,
  readSecretsAllow,
  shareSession,
  trackByReference,
  trackWithLfs,
  unshareSession,
  writeCodeowners,
  ApsError,
} from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';

export function gitSetupHandlers(be: Backend): Handlers {
  const ws = () => be.ws.root;
  /** After an operation wrote workspace files: reload and tell the views, without the "changed outside TestPion" notice. */
  const rewritten = async <T>(op: () => Promise<T> | T): Promise<T> => {
    try {
      return await op();
    } finally {
      be.adoptDiskState();
      be.ws.reloadWorkspaceFile();
      be.host.emit('data.changed', { method: 'git' });
      be.host.emit('git.changed', {});
    }
  };
  /** This app is the merge driver (`--merge-driver`) and the readable-diff driver (`--textconv`) of the repositories it sets up; else the CLI. */
  const drivers = () => {
    const self = be.host.mcpCommand;
    const q = (a: string) => `"${a.split('\\').join('/')}"`;
    const base = self ? [self.command, ...self.args].map(q).join(' ') : undefined;
    return {
      mergeDriverCommand: base ? `${base} --merge-driver` : 'testpion merge-driver',
      textconvCommand: base ? `${base} --textconv` : 'testpion git textconv',
      hookCli: base,
    };
  };
  const fix = (p: { hook?: boolean; untrack?: boolean }, dryRun: boolean) => {
    const d = drivers();
    return fixGitSetup(be.ws, { dryRun, mergeDriverCommand: d.mergeDriverCommand, textconvCommand: d.textconvCommand, hook: p.hook ? { cli: d.hookCli } : false, untrack: !!p.untrack });
  };

  return {
    /** What Fix git setup would do (nothing is written): the steps, the files it would rewrite, the advice. */
    'git.fixPlan': (p: { hook?: boolean; untrack?: boolean }) => fix(p ?? {}, true),
    /** Fix git setup: the ignore and attribute files, the drivers, the stable format once. Undo with git.undo (the result's `undoId`). */
    'git.fix': (p: { hook?: boolean; untrack?: boolean }) => rewritten(() => fix(p ?? {}, false)),
    /** Files over the size policy (warn 5 MB, offer LFS or a reference at 50 MB, refused in a commit at 100 MB). */
    'git.large': () => findLargeFiles(ws()),
    /** Every `.ref` file against the data on this computer. */
    'git.largeCheck': () => checkReferences(ws()),
    /** Take a big file out of plain git: Git LFS, or by reference (`dryRun`: the plan only). */
    'git.largeTrack': ({ file, mode, source, dryRun }: { file: string; mode: 'lfs' | 'reference'; source?: string; dryRun?: boolean }) => {
      if (mode !== 'lfs' && mode !== 'reference') throw new ApsError('ValidationError', 'mode is "lfs" or "reference"');
      const run = () => (mode === 'lfs' ? trackWithLfs(ws(), file, { dryRun }) : trackByReference(ws(), file, { dryRun, source }));
      return dryRun ? run() : rewritten(run);
    },
    /** Share a saved Debugger session: a masked copy in debugger/shared/ (tracked). */
    'git.shareSession': async ({ name, dryRun }: { name: string; dryRun?: boolean }) => {
      const r = shareSession(be.ws, name, { redactor: be.logger.redactor, dryRun });
      if (r.applied) be.host.emit('data.changed', { method: 'git' });
      return r;
    },
    'git.unshareSession': ({ name }: { name: string }) => {
      const r = unshareSession(be.ws, name);
      be.host.emit('data.changed', { method: 'git' });
      return r;
    },
    'git.sharedSessions': () => listSharedSessions(be.ws),
    /** A starter CODEOWNERS (the text, and whether it can be written here); `git.codeownersWrite` writes it, never over one that exists. */
    'git.codeownersPlan': ({ owner }: { owner?: string }) => planCodeowners(ws(), { owner }),
    'git.codeownersWrite': async ({ owner }: { owner?: string }) => {
      const r = await writeCodeowners(ws(), { owner });
      if (r.written) be.host.emit('data.changed', { method: 'git' });
      return r;
    },
    /** Let one reviewed value through the staged secret scan (.testpion/secrets-allow.json); the reason is required. */
    'git.allowSecret': ({ finding, reason }: { finding: { file: string; item: string; field: string; hash: string }; reason: string }) => {
      const r = allowSecret(ws(), finding, reason);
      be.host.emit('git.changed', {});
      return r;
    },
    'git.disallowSecret': ({ hash }: { hash: string }) => {
      const r = disallowSecret(ws(), hash);
      be.host.emit('git.changed', {});
      return r;
    },
    'git.allowedSecrets': () => readSecretsAllow(ws()),
  };
}
