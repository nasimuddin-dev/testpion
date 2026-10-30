import { describe, expect, it } from 'vitest';
import { inviteText, shareableRemote } from '../../apps/desktop/src/lib/git-invite';

/** "Invite a teammate…": the message carries the clone address and never a credential typed into it. */
describe('the invitation', () => {
  it('drops a sign-in typed into an https address, and leaves ssh and clean addresses alone', () => {
    expect(shareableRemote('https://ana:ghp_secret123@github.com/team/api-tests.git')).toBe('https://github.com/team/api-tests.git');
    expect(shareableRemote('https://token@gitlab.com/team/x.git')).toBe('https://gitlab.com/team/x.git');
    expect(shareableRemote('git@github.com:team/api-tests.git')).toBe('git@github.com:team/api-tests.git');
    expect(shareableRemote('https://github.com/team/api-tests.git')).toBe('https://github.com/team/api-tests.git');
    expect(shareableRemote('  https://github.com/team/x.git  ')).toBe('https://github.com/team/x.git');
  });

  it('says what to install, where to click and what to paste, in order, without the credential', () => {
    const t = inviteText('https://ana:ghp_secret123@github.com/team/api-tests.git', 'API tests');
    expect(t).not.toContain('ghp_secret123');
    expect(t).toContain('Join our TestPion workspace "API tests"');
    const lines = t.split('\n');
    expect(lines.findIndex((l) => l.startsWith('1. Install'))).toBeLessThan(lines.findIndex((l) => l.startsWith('2. Open')));
    expect(lines.findIndex((l) => l.startsWith('2. Open'))).toBeLessThan(lines.findIndex((l) => l.startsWith('3. Paste')));
    expect(t).toContain('3. Paste this address: https://github.com/team/api-tests.git');
    expect(t).toContain('/getting-started/start-here');
  });
});
