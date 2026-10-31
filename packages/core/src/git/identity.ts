/**
 * Who a commit is from. A person who has never used git on this computer has no name and e-mail set, and git refuses to commit with
 * "Author identity unknown". `gitIdentity` says whether one is set (git's own config, or the GIT_AUTHOR_* variables), and
 * `setGitIdentity` sets it for this workspace's repository only (never the computer's global git config).
 */
import { ApsError } from '../errors.js';
import { runGit } from './git.js';

export interface GitIdentity {
  name?: string;
  email?: string;
  /** Both a name and an e-mail are known: commits work. */
  ok: boolean;
}

/** The start of the message a commit gives when no identity is set (the app opens its "Who are you?" dialog on it). */
export const IDENTITY_ERROR = 'Git does not know who you are';

const read = async (ws: string, key: string) => (await runGit(ws, ['config', '--get', key]).catch(() => '')).trim();

export async function gitIdentity(ws: string, env: NodeJS.ProcessEnv = process.env): Promise<GitIdentity> {
  const name = env.GIT_AUTHOR_NAME?.trim() || (await read(ws, 'user.name'));
  const email = env.GIT_AUTHOR_EMAIL?.trim() || (await read(ws, 'user.email'));
  return { ...(name ? { name } : {}), ...(email ? { email } : {}), ok: !!name && !!email };
}

/** Set the name and e-mail of commits made in this workspace's repository (not the global git config). */
export async function setGitIdentity(ws: string, o: { name: string; email: string }): Promise<GitIdentity> {
  const name = o.name.trim();
  const email = o.email.trim();
  if (!name) throw new ApsError('ValidationError', 'Give your name');
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new ApsError('ValidationError', 'Give an e-mail address, for example ana@example.com');
  await runGit(ws, ['config', 'user.name', name]);
  await runGit(ws, ['config', 'user.email', email]);
  return { name, email, ok: true };
}

/** The error a commit gives when nobody is set, with the way out. */
export const identityError = () =>
  new ApsError('ConfigurationError', `${IDENTITY_ERROR}, so it cannot sign a commit`, {
    suggestions: ['Tell git your name and e-mail for this workspace: `testpion git identity --name "Your Name" --email you@example.com`. The Git view asks for them too.'],
  });
