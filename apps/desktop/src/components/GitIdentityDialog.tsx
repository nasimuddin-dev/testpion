import { useState } from 'react';
import { call } from '../api';
import { attempt } from '../store';
import { Button, Field, Input, Modal } from './ui';

/**
 * "Who are you?": git signs every commit with a name and an e-mail, and a computer that has never used git has none. This asks for
 * them once and keeps them for this workspace's repository only (never the computer's global git config); the commit that was refused
 * runs again right after.
 */
export function GitIdentityDialog({ onDone, onClose }: { onDone(): void; onClose(): void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const why = !name.trim() ? 'Give your name' : !/^[^\s@]+@[^\s@]+$/.test(email.trim()) ? 'Give an e-mail address, for example ana@example.com' : '';
  const save = async () => {
    if (why) return;
    setBusy(true);
    const ok = await attempt(() => call('git.setIdentity', { name: name.trim(), email: email.trim() }));
    setBusy(false);
    if (ok) onDone();
  };
  return (
    <Modal
      title="Who are you?"
      onClose={onClose}
      onSubmit={() => void save()}
      width={480}
      footer={
        <>
          <Button variant="primary" onClick={() => void save()} disabled={!!why || busy} title={why || undefined} data-identity-save>
            Save and commit
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <div className="grid gap-3 text-sm" data-git-identity>
        <p className="text-muted">Git puts a name and an e-mail on every commit, and this computer has none yet. They are kept for this workspace only, and your teammates see them in the history.</p>
        <Field label="Your name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="first and last name" data-identity-name />
        </Field>
        <Field label="Your e-mail" hint="the one your Git host knows you by, so your commits are credited to you">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ana@example.com" data-identity-email />
        </Field>
      </div>
    </Modal>
  );
}
