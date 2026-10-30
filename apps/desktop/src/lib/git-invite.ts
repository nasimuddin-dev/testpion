/** What an invitation to a teammate says (pure text, so it can be tested without the UI). */
const SITE = 'https://nasimuddin-dev.github.io/testpion';

/**
 * The address of a remote as it is safe to share: a sign-in typed into an https address (`https://user:token@host/repo.git`) is
 * dropped, so an invitation never carries a credential. An ssh address (`git@host:team/repo.git`) is already free of one.
 */
export function shareableRemote(url: string): string {
  return url.trim().replace(/^(https?:\/\/)[^@/\s]+@/i, '$1');
}

/** The message to send a teammate: what to install, where to click, what to paste, and where the first-time guide is. */
export function inviteText(remote: string, workspace?: string): string {
  return [
    `Join our TestPion workspace${workspace ? ` "${workspace}"` : ''}`,
    '',
    `1. Install TestPion: ${SITE}/download`,
    '2. Open TestPion, click the workspace name at the top left, then Clone.',
    `3. Paste this address: ${shareableRemote(remote)}`,
    '4. If the Git host asks you to sign in, do it the way you do in a terminal; TestPion uses the same sign-in.',
    '',
    `New to TestPion? ${SITE}/getting-started/start-here`,
    `How sharing works: ${SITE}/getting-started/git#the-short-version-for-a-team`,
  ].join('\n');
}
