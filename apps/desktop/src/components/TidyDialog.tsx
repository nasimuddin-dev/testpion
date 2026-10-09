import { Brush, Copy, FolderX, Globe, KeyRound, Replace, Variable } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { call } from '../api';
import { toastError, useApp } from '../store';
import type { Collection } from '../types';
import { Badge, Button, Empty, Modal, Toggle } from './ui';

type Kind = 'duplicate' | 'hard-coded-host' | 'empty-folder' | 'unused-variable' | 'repeated-auth-header';
interface Finding {
  kind: Kind;
  message: string;
  ids: string[];
  where: string[];
  host?: string;
  variable?: string;
}

const KINDS: Array<{ kind: Kind; title: string; icon: ReactNode; fix?: string }> = [
  { kind: 'duplicate', title: 'Duplicate requests', icon: <Copy size={13} />, fix: 'Remove the copies (the first of each stays)' },
  { kind: 'repeated-auth-header', title: 'The same Authorization header on many requests', icon: <KeyRound size={13} />, fix: 'Set it as the collection auth (they inherit it)' },
  { kind: 'hard-coded-host', title: 'Hosts typed into URLs', icon: <Globe size={13} /> },
  { kind: 'empty-folder', title: 'Empty folders', icon: <FolderX size={13} />, fix: 'Remove the empty folders' },
  { kind: 'unused-variable', title: 'Unused variables', icon: <Variable size={13} />, fix: 'Remove the unused variables' },
];

/**
 * Tidy up a collection: duplicate requests, hosts typed into URLs, empty folders and unused variables, each with its
 * fix. Removing is saved with Undo; a host opens Replace to put a {{variable}} in its place.
 */
export function TidyDialog({ collection, onClose, onDone, onReplace }: { collection: Collection; onClose(): void; onDone(): void; onReplace(find: string): void }) {
  const [findings, setFindings] = useState<Finding[]>();
  const [fix, setFix] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void call<Finding[]>('col.tidy', { collectionId: collection.id }).then(setFindings, (e) => (toastError(e), setFindings([])));
  }, [collection.id]);
  const apply = async () => {
    setBusy(true);
    try {
      const r = await call<{ removed: number }>('col.tidyApply', {
        collectionId: collection.id,
        removeDuplicates: !!fix.duplicate,
        removeEmptyFolders: !!fix['empty-folder'],
        removeUnusedVariables: !!fix['unused-variable'],
        useCollectionAuth: !!fix['repeated-auth-header'],
      });
      onDone();
      onClose();
      useApp.getState().toast(`${r.removed} removed from ${collection.name}`, 'success', { label: 'Undo', onClick: () => void call('col.save', collection).then(onDone).catch(toastError) });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const any = Object.values(fix).some(Boolean);
  return (
    <Modal
      title={`Tidy up ${collection.name}`}
      onClose={onClose}
      width={760}
      footer={
        <Button variant="primary" icon={<Brush size={13} />} disabled={!any || busy} onClick={() => void apply()}>
          Remove what is ticked
        </Button>
      }
    >
      <div className="grid gap-3 text-sm max-h-[60vh] overflow-auto" data-tidy-dialog>
        {!findings ? (
          <p className="text-xs text-muted">Looking through the collection…</p>
        ) : !findings.length ? (
          <Empty icon={<Brush size={22} />} title="Nothing to tidy">
            No duplicate requests, typed-in hosts, empty folders or unused variables.
          </Empty>
        ) : (
          KINDS.map((k) => {
            const list = findings.filter((f) => f.kind === k.kind);
            if (!list.length) return null;
            return (
              <section key={k.kind} className="grid gap-1" data-tidy-kind={k.kind}>
                <div className="flex items-center gap-2">
                  {k.icon}
                  <span className="font-semibold">{k.title}</span>
                  <Badge>{list.length}</Badge>
                  {k.fix && (
                    <span className="ml-auto">
                      <Toggle checked={!!fix[k.kind]} onChange={(v) => setFix({ ...fix, [k.kind]: v })} label={k.fix} />
                    </span>
                  )}
                </div>
                <ul className="border border-line rounded-md divide-y divide-line/60">
                  {list.slice(0, 100).map((f, i) => (
                    <li key={i} className="px-2 py-1.5 grid gap-0.5">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="min-w-0 break-all">{f.message}</span>
                        {f.host && (
                          <Button size="sm" variant="ghost" className="ml-auto shrink-0" icon={<Replace size={12} />} onClick={() => onReplace(f.host!)}>
                            Use a variable…
                          </Button>
                        )}
                      </div>
                      {f.where.slice(0, 3).map((w, j) => (
                        <div key={j} className="text-[0.7rem] text-muted truncate pl-2">
                          {w}
                        </div>
                      ))}
                      {f.where.length > 3 && <div className="text-[0.7rem] text-muted pl-2">… and {f.where.length - 3} more</div>}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })
        )}
      </div>
    </Modal>
  );
}
