import { Copy, UserPlus } from 'lucide-react';
import { copyText } from '../lib/clipboard';
import { inviteText, shareableRemote } from '../lib/git-invite';
import { Button, Modal } from './ui';

/**
 * "Invite a teammate…" (Git view ⋯): the clone address and the steps for someone who has not used TestPion, as one message to copy.
 * Nothing is sent from here: you paste it into your chat or e-mail. Who may read the repository is set on the Git host, not here.
 */
export function GitInviteDialog({ remote, workspace, onClose }: { remote: string; workspace?: string; onClose(): void }) {
  const text = inviteText(remote, workspace);
  const hadSignIn = shareableRemote(remote) !== remote.trim();
  return (
    <Modal
      title={
        <span className="flex items-center gap-2">
          <UserPlus size={16} />
          Invite a teammate
        </span>
      }
      onClose={onClose}
      onSubmit={() => void copyText(text, 'the invitation')}
      width={640}
      footer={
        <>
          <Button variant="primary" icon={<Copy size={13} />} onClick={() => void copyText(text, 'the invitation')} data-invite-copy>
            Copy the invitation
          </Button>
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      <div className="grid gap-3 text-sm" data-invite>
        <p className="text-muted">Paste this into a chat or an e-mail. It tells a colleague how to get the workspace and what it shares with them.</p>
        <pre className="mono text-xs whitespace-pre-wrap rounded-md border border-line p-3 bg-surface" data-invite-text>
          {text}
        </pre>
        {hadSignIn && <p className="text-xs text-warn">The remote address had a sign-in typed into it; it is left out of the invitation.</p>}
        <p className="text-xs text-muted">Who can read or change the repository is set on the Git host (GitHub, GitLab …), not here. Secrets are never in the repository: each person keeps their own.</p>
      </div>
    </Modal>
  );
}
