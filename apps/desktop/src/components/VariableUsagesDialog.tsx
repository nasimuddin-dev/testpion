import { Code, FileText, KeyRound, Link2, PenLine } from 'lucide-react';
import { useEffect, useState } from 'react';
import { call } from '../api';
import { confirmAction, toastError, useApp } from '../store';
import { plural } from '../lib/format';
import { Button, Field, Input, Modal } from './ui';

interface VariableUsage {
  where: string;
  kind: 'request' | 'script' | 'definition' | 'test-file';
  field: string;
  collectionId?: string;
  requestId?: string;
}

const ICONS = { request: <Link2 size={13} />, script: <Code size={13} />, definition: <KeyRound size={13} />, 'test-file': <FileText size={13} /> };

/** Where a variable is used in the workspace, and renaming it everywhere (secret values move with it). */
export function VariableUsagesDialog({ names, initial, onClose, onRenamed }: { names: string[]; initial?: string; onClose(): void; onRenamed?(): void }) {
  const [name, setName] = useState(initial ?? names[0] ?? '');
  const [uses, setUses] = useState<VariableUsage[]>();
  const [renameTo, setRenameTo] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!name.trim()) return setUses(undefined);
    const t = setTimeout(() => void call<VariableUsage[]>('vars.usages', { name: name.trim() }).then(setUses), 200);
    return () => clearTimeout(t);
  }, [name]);
  const open = (u: VariableUsage) => {
    if (!u.requestId || !u.collectionId) return;
    useApp.getState().openIntent('rest', { collectionId: u.collectionId, requestId: u.requestId });
    onClose();
  };
  const rename = async () => {
    const to = renameTo.trim();
    if (!to || !uses) return;
    if (!(await confirmAction({ title: 'Rename everywhere', message: `Rename {{${name}}} to {{${to}}} in ${plural(uses.length, 'place')}?`, detail: 'Requests, scripts, environments, collection and folder variables and test files are updated. Open tabs with unsaved changes keep the old name.', confirmLabel: 'Rename' }))) return;
    setBusy(true);
    try {
      const r = await call<{ files: number }>('vars.rename', { from: name.trim(), to });
      useApp.getState().toast(`Renamed {{${name}}} to {{${to}}} (${plural(r.files, 'file')} updated)`, 'success');
      await useApp.getState().refreshWorkspace();
      // the Environments view reloads, so an open environment shows (and saves) the new name
      useApp.getState().set({ envsVersion: (useApp.getState().envsVersion ?? 0) + 1 });
      onRenamed?.();
      setName(to);
      setRenameTo('');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Variable usages" onClose={onClose} width={680}>
      <div className="flex flex-col gap-3">
        <Field label="Variable">
          <Input className="mono" list="variable-usage-names" value={name} onChange={(e) => setName(e.target.value)} placeholder="baseUrl" aria-label="Variable name" />
          <datalist id="variable-usage-names">
            {names.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </Field>
        {uses && (
          <div className="flex flex-col gap-1 max-h-[45vh] overflow-auto">
            <div className="text-sm text-muted">{uses.length ? `${plural(uses.length, 'place')}:` : `{{${name}}} isn't used or defined anywhere in this workspace.`}</div>
            <ul className="flex flex-col">
              {uses.map((u, i) => (
                <li key={i}>
                  <button className="w-full text-left flex items-center gap-2 px-2 py-1 rounded hover:bg-panel disabled:hover:bg-transparent disabled:cursor-default" disabled={!u.requestId} onClick={() => open(u)} title={u.requestId ? 'Open the request' : undefined}>
                    <span className="text-muted shrink-0">{ICONS[u.kind]}</span>
                    <span className="text-sm truncate">{u.where}</span>
                    <span className="text-xs text-muted ml-auto shrink-0">{u.field}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {!!uses?.length && (
          <div className="flex items-end gap-2 border-t border-line pt-3">
            <Field label="Rename everywhere to" className="flex-1">
              <Input className="mono" value={renameTo} onChange={(e) => setRenameTo(e.target.value)} placeholder="newName" aria-label="New name" />
            </Field>
            <Button icon={<PenLine size={13} />} loading={busy} disabled={!/^[\w.-]+$/.test(renameTo.trim()) || renameTo.trim() === name.trim()} onClick={() => void rename()}>
              Rename
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
