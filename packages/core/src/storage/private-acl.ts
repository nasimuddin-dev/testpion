import { execFileSyncChecked } from '../net/process.js';

/**
 * The Windows counterpart of mode 0600 / 0700. A file written "private" (secrets.json, current values, the log, saved Debugger
 * sessions) and its folder get an ACL with inheritance removed and one entry: the current user, full control. The folder's
 * entry is inherited by the files created in it afterwards. Best effort: icacls missing, a folder on a share that has no ACLs, a
 * denied change — none of it stops a save (the file is then as private as its profile folder already makes it). Run once per
 * path per process. Arguments go to icacls as an array, never through a shell.
 */
export type AclRunner = (file: string, args: string[]) => void;

const defaultRunner: AclRunner = (file, args) => {
  execFileSyncChecked('file permissions (icacls)', file, args, { stdio: 'ignore', timeout: 5000, windowsHide: true });
};

let runner: AclRunner = defaultRunner;
let platform: NodeJS.Platform = process.platform;
let user: string | undefined;
// bounded: one entry per private path this process writes (a handful of fixed files and folders)
const done = new Set<string>();

/** For tests: a stand-in for icacls, a platform, and the account name; call with no argument to restore. */
export function setAclTestHooks(h: { runner?: AclRunner; platform?: NodeJS.Platform; user?: string } = {}): void {
  runner = h.runner ?? defaultRunner;
  platform = h.platform ?? process.platform;
  user = h.user;
  done.clear();
}

const account = () => user ?? (process.env.USERDOMAIN && process.env.USERNAME ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME);

/** Make `path` (a file, or a folder with `dir`) readable by the current user only. Returns whether icacls was run and succeeded. */
export function restrictToOwner(path: string, kind: 'file' | 'dir'): boolean {
  if (platform !== 'win32') return false;
  const key = `${kind}:${path.toLowerCase()}`;
  if (done.has(key)) return false;
  done.add(key);
  const who = account();
  if (!who) return false;
  try {
    runner('icacls', [path, '/inheritance:r', '/grant:r', `${who}:${kind === 'dir' ? '(OI)(CI)F' : 'F'}`]);
    return true;
  } catch {
    return false; // never fatal
  }
}
