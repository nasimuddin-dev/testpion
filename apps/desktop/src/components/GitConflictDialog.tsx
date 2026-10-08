import { Check, GitMerge } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { call } from '../api';
import { toastError, useApp } from '../store';
import { Badge, Button, Empty, Modal, Segmented } from './ui';
import { PartsTable } from './PartsTable';

/**
 * GIT-302's side-by-side view: every conflict of one collection file (a request changed on both sides, changed on one
 * side and deleted on the other, a setting changed differently) with its parts in three columns: the common version,
 * mine, theirs. A choice per conflict, then the file is merged with those choices and marked resolved.
 */

interface Part {
  part: string;
  base?: string;
  ours?: string;
  theirs?: string;
  differs: boolean;
}
interface ConflictItem {
  key: string;
  where: string;
  kind: 'changed-both' | 'deleted-theirs' | 'deleted-ours' | 'setting';
  parts: Part[];
}
interface Detail {
  path: string;
  collection: boolean;
  items: ConflictItem[];
}

const KIND: Record<ConflictItem['kind'], string> = {
  'changed-both': 'changed on both sides',
  'deleted-theirs': 'changed here, deleted by them',
  'deleted-ours': 'deleted here, changed by them',
  setting: 'setting changed on both sides',
};


export function GitConflictDialog({ path, onClose, onResolved }: { path: string; onClose(): void; onResolved(): void }) {
  const [detail, setDetail] = useState<Detail>();
  const [choices, setChoices] = useState<Record<string, 'ours' | 'theirs'>>({});
  const [onlyDiffs, setOnlyDiffs] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void call<Detail>('git.conflictDetail', { path }).then((d) => {
      setDetail(d);
      setChoices(Object.fromEntries(d.items.map((i) => [i.key, 'ours'])));
    }, toastError);
  }, [path]);
  const counts = useMemo(() => {
    const v = Object.values(choices);
    return { ours: v.filter((x) => x === 'ours').length, theirs: v.filter((x) => x === 'theirs').length };
  }, [choices]);
  const resolve = async () => {
    setBusy(true);
    try {
      await call('git.resolve', { path, resolutions: choices });
      useApp.getState().toast(`${path} resolved: ${counts.ours} kept as mine, ${counts.theirs} taken from theirs`, 'success');
      onResolved();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const all = (side: 'ours' | 'theirs') => setChoices(Object.fromEntries((detail?.items ?? []).map((i) => [i.key, side])));
  return (
    <Modal
      title={
        <span className="flex items-center gap-2">
          <GitMerge size={16} /> Resolve {path}
        </span>
      }
      onClose={onClose}
      width={1080}
      footer={
        <>
          <span className="mr-auto text-xs text-muted self-center">
            Every change that did not conflict, from both sides, stays. {counts.ours} mine · {counts.theirs} theirs.
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Check size={13} />} loading={busy} disabled={!detail?.items.length} onClick={() => void resolve()}>
            Resolve with these choices
          </Button>
        </>
      }
    >
      {!detail ? (
        <Empty title="Reading the three versions…" />
      ) : !detail.items.length ? (
        <Empty title="Nothing left to choose">This file merges cleanly now; resolve it to mark it done.</Empty>
      ) : (
        <div className="grid gap-4">
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <span className="text-muted">{detail.items.length} conflicts</span>
            <Button size="sm" onClick={() => all('ours')}>
              Keep all mine
            </Button>
            <Button size="sm" onClick={() => all('theirs')}>
              Take all theirs
            </Button>
            <label className="ml-auto flex items-center gap-1 text-muted">
              <input type="checkbox" checked={onlyDiffs} onChange={(e) => setOnlyDiffs(e.target.checked)} /> Only the parts that differ
            </label>
          </div>
          {detail.items.map((item) => {
            const choice = choices[item.key] ?? 'ours';
            const parts = onlyDiffs ? item.parts.filter((p) => p.differs) : item.parts;
            return (
              <section key={item.key} className="rounded-lg border border-line" data-conflict={item.key}>
                <header className="flex items-center gap-2 px-3 py-2 border-b border-line">
                  <span className="font-medium text-sm truncate">{item.where}</span>
                  <Badge tone="warn">{KIND[item.kind]}</Badge>
                  <span className="ml-auto">
                    <Segmented
                      label={`Which version of ${item.where}`}
                      value={choice}
                      onChange={(v) => setChoices({ ...choices, [item.key]: v })}
                      options={[
                        { value: 'ours', label: item.kind === 'deleted-ours' ? 'Delete it (mine)' : 'Mine' },
                        { value: 'theirs', label: item.kind === 'deleted-theirs' ? 'Delete it (theirs)' : 'Theirs' },
                      ]}
                    />
                  </span>
                </header>
                <PartsTable
                  rows={parts.map((p) => ({ part: p.part, differs: p.differs, values: { base: p.base, ours: p.ours, theirs: p.theirs } }))}
                  emptyText="No part differs between mine and theirs."
                  columns={[
                    { key: 'base', label: 'Before (common)' },
                    { key: 'ours', label: 'Mine', missing: item.kind === 'deleted-ours' ? 'deleted here' : '—', chosen: choice === 'ours', highlight: true },
                    { key: 'theirs', label: 'Theirs', missing: item.kind === 'deleted-theirs' ? 'deleted by them' : '—', chosen: choice === 'theirs', highlight: true },
                  ]}
                />
              </section>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
