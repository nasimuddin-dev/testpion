import { Copy, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { CodeownersPlan, CodeownersResult } from '@testpion/core';
import { call } from '../api';
import { toastError, useApp } from '../store';
import { copyText } from '../lib/clipboard';
import { Button, Busy, FooterHint, Input, Modal } from './ui';

/**
 * A starter CODEOWNERS (release C of planning/git-everything.md §3): one line per kind folder of the workspace, so a team can
 * say who must review a change to the environments, the MCP servers or the AI providers. The owners are left to fill in (a
 * line naming a team that does not exist protects nothing), unless one is typed here. It is written to .github/CODEOWNERS only
 * when the workspace is the repository itself, and never over a file that exists; otherwise the text is copied by hand.
 */
export function GitCodeownersDialog({ onClose, onDone }: { onClose(): void; onDone(): void }) {
  const [owner, setOwner] = useState('');
  const [plan, setPlan] = useState<CodeownersPlan>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => void call<CodeownersPlan>('git.codeownersPlan', { owner: owner.trim() || undefined }).then(setPlan, toastError), 150);
    return () => clearTimeout(t);
  }, [owner]);
  const blocked = plan?.existing
    ? `${plan.existing} exists: it is never overwritten. Copy the lines you want into it.`
    : plan?.insideRepository
      ? 'This workspace is a folder of a bigger repository: CODEOWNERS belongs to the repository root, outside the workspace. Copy the lines into it.'
      : undefined;
  const write = async () => {
    setBusy(true);
    try {
      const r = await call<CodeownersResult>('git.codeownersWrite', { owner: owner.trim() || undefined });
      useApp.getState().toast(r.written ? `Wrote ${r.path}` : (r.reason ?? 'Nothing was written'), r.written ? 'success' : 'warning');
      if (r.written) {
        onDone();
        onClose();
      }
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={
        <span className="flex items-center gap-2">
          <Users size={16} /> Create CODEOWNERS
        </span>
      }
      onClose={onClose}
      width={720}
      footer={
        <>
          {blocked && <FooterHint>{blocked}</FooterHint>}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button icon={<Copy size={13} />} disabled={!plan} onClick={() => plan && void copyText(plan.text, 'CODEOWNERS')}>
            Copy
          </Button>
          <Button variant="primary" loading={busy} disabled={!plan || !!blocked || !plan.lines.length} onClick={() => void write()} data-codeowners-write="">
            Create .github/CODEOWNERS
          </Button>
        </>
      }
    >
      {!plan ? (
        <Busy>Reading the workspace…</Busy>
      ) : (
        <div className="grid gap-3" data-codeowners="">
          <p className="text-sm text-muted">
            One line per kind folder, so changes to environments, MCP servers or providers can need a reviewer you name. It only protects once the repository requires review from code owners.
          </p>
          <label className="grid gap-1 text-sm">
            Owner for every line (a user or team that has write access)
            <Input value={owner} placeholder="@your-org/platform  (leave empty to fill in later)" onChange={(e) => setOwner(e.target.value)} />
          </label>
          <pre className="rounded-md border border-line bg-panel p-2 text-xs font-mono overflow-auto max-h-72" aria-label="CODEOWNERS">
            {plan.text}
          </pre>
          {blocked && <p className="text-sm text-warn">{blocked}</p>}
        </div>
      )}
    </Modal>
  );
}
