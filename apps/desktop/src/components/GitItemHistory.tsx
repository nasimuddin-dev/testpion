import { RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { call } from '../api';
import { confirmAction, toastError, useApp } from '../store';
import { Button, cx, Empty, Modal, Spinner } from './ui';
import { PartsTable } from './PartsTable';

interface Commit {
  hash: string;
  short: string;
  author: string;
  date: string;
  subject: string;
}
interface ItemDiff {
  title: string;
  parts: Array<{ part: string; before?: string; after?: string; differs: boolean }>;
}

/** What the history is of: a request of a collection, a whole collection, or an environment. */
export type HistoryTarget = { collectionId: string; itemId?: string } | { environmentId: string };

/**
 * The versions of a request, a collection or an environment in git (GIT-209): the commits that changed it, each
 * compared with now part by part, and Restore this version (a change to commit; the current one stays in history).
 */
export function GitItemHistory({ target, name, onClose }: { target: HistoryTarget; name: string; onClose(): void }) {
  const [history, setHistory] = useState<{ file: string; itemId?: string; versions: Commit[] }>();
  const [sel, setSel] = useState(0);
  const [diff, setDiff] = useState<ItemDiff>();
  const [onlyDiffs, setOnlyDiffs] = useState(true);
  const what = 'environmentId' in target ? 'environment' : target.itemId ? 'request' : 'collection';
  useEffect(() => {
    void call<{ file: string; itemId?: string; versions: Commit[] }>('git.history', target).then(setHistory, (e) => {
      toastError(e);
      setHistory({ file: '', versions: [] });
    });
  }, [JSON.stringify(target)]);
  const v = history?.versions[sel];
  useEffect(() => {
    if (!history?.file || !v) return setDiff(undefined);
    setDiff(undefined);
    void call<ItemDiff>('git.itemDiff', { file: history.file, itemId: history.itemId, rev: v.hash }).then(setDiff, () => setDiff({ title: '', parts: [] }));
  }, [history, v?.hash]);
  const restore = async () => {
    if (!v) return;
    if (
      !(await confirmAction({
        title: 'Restore this version',
        message: `Put ${what === 'request' ? `"${name}"` : `the ${what} ${name}`} back as it was in ${v.short} (${v.subject})?`,
        detail:
          what === 'request'
            ? 'Only this request changes; commit to keep it. Your current version stays in git history.'
            : `The whole ${what} goes back; commit to keep it. Your current version stays in git history.`,
        confirmLabel: 'Restore',
      }))
    )
      return;
    try {
      if ('collectionId' in target && target.itemId) await call('git.restoreItem', { collectionId: target.collectionId, itemId: target.itemId, rev: v.hash });
      else await call('git.restoreFile', { ...target, rev: v.hash });
      useApp.getState().toast(`Restored ${name} from ${v.short}`, 'success');
      onClose();
    } catch (e) {
      toastError(e);
    }
  };
  const rows = (diff?.parts ?? []).filter((p) => !onlyDiffs || p.differs).map((p) => ({ part: p.part, differs: p.differs, values: { then: p.before, now: p.after } }));
  return (
    <Modal
      title={`History of ${name}`}
      onClose={onClose}
      width={1000}
      footer={
        <>
          <label className="mr-auto flex items-center gap-1 text-xs text-muted">
            <input type="checkbox" checked={onlyDiffs} onChange={(e) => setOnlyDiffs(e.target.checked)} /> Only the parts that differ from now
          </label>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" icon={<RotateCcw size={13} />} disabled={!v} onClick={() => void restore()}>
            Restore this version
          </Button>
        </>
      }
    >
      {!history ? (
        <div className="h-40 grid place-items-center">
          <Spinner />
        </div>
      ) : !history.versions.length ? (
        <Empty title={`No commits changed this ${what} yet`}>Commit the workspace (Git view) to start its history.</Empty>
      ) : (
        <div className="grid grid-cols-[260px_1fr] gap-3 h-[55vh]">
          <ul className="overflow-auto border border-line rounded-md" aria-label="Versions">
            {history.versions.map((x, i) => (
              <li key={x.hash}>
                <button className={cx('w-full text-left px-2 py-1.5 text-sm border-b border-line', i === sel ? 'bg-accent-soft' : 'hover:bg-hover')} onClick={() => setSel(i)}>
                  <div className="truncate">{x.subject}</div>
                  <div className="text-xs text-muted">
                    <span className="font-mono">{x.short}</span> · {x.author} · {new Date(x.date).toLocaleDateString()}
                  </div>
                </button>
              </li>
            ))}
          </ul>
          <div className="overflow-auto border border-line rounded-md" data-history-diff>
            {!diff ? (
              <div className="h-24 grid place-items-center">
                <Spinner />
              </div>
            ) : (
              <PartsTable
                rows={rows}
                emptyText="This version is the same as now."
                columns={[
                  { key: 'then', label: `In ${v?.short ?? ''}`, missing: 'not there' },
                  { key: 'now', label: 'Now', missing: 'deleted since', highlight: true },
                ]}
              />
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
