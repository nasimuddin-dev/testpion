import { RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ItemRef } from '@testpion/shared';
import { call } from '../api';
import { confirmAction, toastError } from '../store';
import { partsLines, toastWithUndo, type ItemWritePlan } from '../lib/git-items';
import { Button, Callout, cx, Empty, Modal, Segmented, Spinner, Toggle, VirtualList } from './ui';
import { asError } from '../api';
import { PartsTable } from './PartsTable';

interface Commit {
  hash: string;
  short: string;
  author: string;
  date: string;
  subject: string;
}
interface Version {
  commit: Commit;
  /** What this version changed. */
  changed: string[];
}
interface ItemDiff {
  title: string;
  parts: Array<{ part: string; before?: string; after?: string; differs: boolean }>;
}
interface Blame {
  title: string;
  fields: Array<{ field: string; value: string; commit?: Commit; uncommitted?: boolean }>;
}
interface Target {
  file: string;
  itemId?: string;
}

/** A read of the history that failed: the reason and Retry (never an empty list, which would say there is no history). */
function ReadFailed({ what, message, onRetry }: { what: string; message: string; onRetry(): void }) {
  return (
    <Callout tone="bad" role="alert" action={<Button size="sm" onClick={onRetry}>Retry</Button>}>
      Could not read {what}: {message}
    </Callout>
  );
}

/**
 * One item in git, for any versioned kind (release B of planning/git-everything.md): its versions, each with what it
 * changed and compared with now part by part, Restore this version (a reviewed change to commit, with Undo), and who last
 * changed each of its fields.
 */
export function GitItemHistoryBody({ itemRef, name, tab: first = 'versions', onClose }: { itemRef: ItemRef; name: string; tab?: 'versions' | 'blame'; onClose(): void }) {
  const [tab, setTab] = useState(first);
  const [target, setTarget] = useState<Target>();
  const [history, setHistory] = useState<{ title: string; versions: Version[] }>();
  const [blame, setBlame] = useState<Blame>();
  // a read that failed says so, with Retry: an empty list or a spinner that never ends would read as "no history"
  const [failed, setFailed] = useState<{ versions?: string; blame?: string }>();
  const [attempt, setAttempt] = useState(0);
  const [sel, setSel] = useState(0);
  const [diff, setDiff] = useState<ItemDiff>();
  const [onlyDiffs, setOnlyDiffs] = useState(true);
  const key = JSON.stringify(itemRef);
  useEffect(() => {
    setFailed((f) => ({ ...f, versions: undefined }));
    void call<Target>('git.target', { ref: itemRef }).then(setTarget, toastError);
    void call<{ title: string; versions: Version[] }>('git.itemVersions', { ref: itemRef }).then(setHistory, (e) => setFailed((f) => ({ ...f, versions: asError(e).message })));
  }, [key, attempt]);
  useEffect(() => {
    if (tab !== 'blame' || blame) return;
    setFailed((f) => ({ ...f, blame: undefined }));
    void call<Blame>('git.itemBlame', { ref: itemRef }).then(setBlame, (e) => setFailed((f) => ({ ...f, blame: asError(e).message })));
  }, [tab, key, attempt]);
  const v = history?.versions[sel];
  useEffect(() => {
    if (!target || !v) return setDiff(undefined);
    setDiff(undefined);
    void call<ItemDiff>('git.itemDiff', { file: target.file, itemId: target.itemId, rev: v.commit.hash }).then(setDiff, () => setDiff({ title: '', parts: [] }));
  }, [target?.file, target?.itemId, v?.commit.hash]);
  const title = history?.title || name;
  const restore = async () => {
    if (!v) return;
    try {
      // the preview first: what would change in the item
      const plan = await call<ItemWritePlan>('git.itemRestore', { ref: itemRef, rev: v.commit.hash, dryRun: true });
      if (!plan.changed) return toastWithUndo(`${title} is already the same as in ${v.commit.short}`, undefined);
      const ok = await confirmAction({
        title: 'Restore this version',
        message: `Put ${title} back as it was in ${v.commit.short} (${v.commit.subject})?`,
        detail: `Only this ${plan.itemId ? 'item' : 'file'} changes; the rest of ${plan.file} stays. Commit to keep it; Undo puts it back as it is now.\n\n${partsLines(plan.parts)}`,
        confirmLabel: 'Restore',
      });
      if (!ok) return;
      const done = await call<ItemWritePlan>('git.itemRestore', { ref: itemRef, rev: v.commit.hash });
      toastWithUndo(`Restored ${title} from ${v.commit.short}`, done.undoId);
      onClose();
    } catch (e) {
      toastError(e);
    }
  };
  const rows = (diff?.parts ?? []).filter((p) => !onlyDiffs || p.differs).map((p) => ({ part: p.part, differs: p.differs, values: { then: p.before, now: p.after } }));
  return (
    <Modal
      title={`History of ${title}`}
      onClose={onClose}
      width={1000}
      footer={
        <>
          {tab === 'versions' && (
            <span className="mr-auto text-xs text-muted">
              <Toggle checked={onlyDiffs} onChange={setOnlyDiffs} label="Only the parts that differ from now" />
            </span>
          )}
          <Button onClick={onClose}>Close</Button>
          {tab === 'versions' && (
            <Button variant="primary" icon={<RotateCcw size={13} />} disabled={!v} onClick={() => void restore()}>
              Restore this version
            </Button>
          )}
        </>
      }
    >
      <div className="grid gap-3">
        <Segmented
          label="What to show"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'versions', label: 'Versions' },
            { value: 'blame', label: 'Who changed what' },
          ]}
        />
        {tab === 'versions' && failed?.versions ? (
          <ReadFailed what="the versions" message={failed.versions} onRetry={() => setAttempt((n) => n + 1)} />
        ) : tab === 'blame' && failed?.blame ? (
          <ReadFailed what="who changed what" message={failed.blame} onRetry={() => setAttempt((n) => n + 1)} />
        ) : !history && tab === 'versions' ? (
          <div className="h-40 grid place-items-center" role="status">
            <Spinner />
          </div>
        ) : tab === 'blame' ? (
          !blame ? (
            <div className="h-24 grid place-items-center" role="status">
              <Spinner />
            </div>
          ) : (
            <table className="w-full text-sm" data-git-blame>
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="py-1 pr-3">Field</th>
                  <th className="pr-3">Value</th>
                  <th className="pr-3">Last changed by</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {blame.fields.map((f) => (
                  <tr key={f.field} className="border-t border-line align-top" data-blame-field={f.field}>
                    <td className="py-1 pr-3 font-medium">{f.field}</td>
                    <td className="pr-3 font-mono text-xs whitespace-pre-wrap break-all max-w-[360px]">{f.value || '—'}</td>
                    <td className="pr-3">{f.uncommitted ? <span className="text-warn">not committed yet</span> : `${f.commit?.author} · ${f.commit?.short} ${f.commit?.subject}`}</td>
                    <td className="text-muted whitespace-nowrap">{f.commit ? new Date(f.commit.date).toLocaleDateString() : 'now'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : !history!.versions.length ? (
          <Empty title="No commits changed this yet">Commit the workspace (Git view) to start its history.</Empty>
        ) : (
          <div className="grid grid-cols-[280px_1fr] gap-3 h-[55vh]">
            <VirtualList
              className="border border-line rounded-md"
              role="list"
              label="Versions"
              name="GitItemVersions"
              items={history!.versions}
              rowHeight={66}
              keyOf={(x) => x.commit.hash}
              render={(x, i) => (
                <button className={cx('w-full h-full text-left px-2 py-1 text-sm border-b border-line', i === sel ? 'bg-accent-soft' : 'hover:bg-hover')} onClick={() => setSel(i)} title={`${x.commit.subject}\n${x.changed.join(', ')}\n${new Date(x.commit.date).toLocaleString()}`} data-version={x.commit.short}>
                  <div className="truncate">{x.commit.subject}</div>
                  <div className="text-xs text-muted truncate">{x.changed.join(', ')}</div>
                  <div className="text-xs text-muted truncate">
                    <span className="font-mono">{x.commit.short}</span> · {x.commit.author} · {new Date(x.commit.date).toLocaleString()}
                  </div>
                </button>
              )}
            />
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
                    { key: 'then', label: `In ${v?.commit.short ?? ''}`, missing: 'not there' },
                    { key: 'now', label: 'Now', missing: 'deleted since', highlight: true },
                  ]}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
