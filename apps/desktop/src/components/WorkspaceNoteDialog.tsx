import { useState } from 'react';
import { WORKSPACE_NOTE_LIMIT } from '@testpion/shared';
import { call } from '../api';
import { attempt, useApp } from '../store';
import { Button, Field, Modal, Textarea } from './ui';

const NOTE_LIMIT = WORKSPACE_NOTE_LIMIT;

/**
 * "A note for your team" (Home): a few lines about this workspace that everyone who opens it sees under its name. It is kept in the
 * workspace file, so in git it travels with the workspace: how to get the secrets, which environment to start with, who to ask.
 * Never put a password in it: the file is shared.
 */
export function WorkspaceNoteDialog({ note, onClose }: { note: string; onClose(): void }) {
  const [text, setText] = useState(note);
  const [busy, setBusy] = useState(false);
  const over = text.length > NOTE_LIMIT;
  const why = over ? `The note is ${text.length - NOTE_LIMIT} characters too long` : text.trim() === note.trim() ? 'Nothing changed' : '';
  const save = async () => {
    if (why) return;
    setBusy(true);
    const ok = await attempt(async () => {
      await call('ws.update', { description: text.trim() });
      await useApp.getState().refreshWorkspace();
    });
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Modal
      title="A note for your team"
      onClose={onClose}
      onSubmit={() => void save()}
      width={560}
      footer={
        <>
          <Button variant="primary" onClick={() => void save()} disabled={!!why || busy} title={why || undefined} data-note-save>
            Save note
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <div className="grid gap-3 text-sm" data-workspace-note>
        <p className="text-muted">Everyone who opens this workspace sees it on Home. It is saved in the workspace file, so with git it travels to your team. Do not write a password in it.</p>
        <Field label="Note" hint={`${text.length} of ${NOTE_LIMIT} characters`}>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} placeholder="For example: Start with the Staging environment. Ask Ana for the API key, then type it under Environments." data-note-text />
        </Field>
      </div>
    </Modal>
  );
}
