import { Check, GitMerge } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { call } from '../api';
import { toastError, useApp } from '../store';
import { Badge, Button, Empty, Modal, Segmented, Textarea } from './ui';
import { PartsTable } from './PartsTable';

/**
 * The conflict screen for every kind of file (GIT-302, release B of planning/git-everything.md §4g). A file merged by
 * meaning (collections, environments, library files, MCP servers, providers, the workspace and Debugger settings) lists
 * each item changed on both sides, and inside it the fields that clash; a text file (tests, flows, API definitions,
 * datasets) lists its clashing hunks; a database is taken whole. Each one is settled with Keep mine, Keep theirs or Edit;
 * everything that did not clash stays, and the result is written in the stable form.
 */

interface Part {
  part: string;
  base?: string;
  ours?: string;
  theirs?: string;
  differs: boolean;
}
interface Field {
  path: string;
  key: string;
  base?: string;
  ours?: string;
  theirs?: string;
  oursJson?: string;
  theirsJson?: string;
}
interface ConflictItem {
  key: string;
  where: string;
  kind: 'changed-both' | 'deleted-theirs' | 'deleted-ours' | 'setting';
  parts: Part[];
  fields?: Field[];
  editable?: string;
}
interface Hunk {
  key: string;
  where: string;
  ours: string;
  base: string;
  theirs: string;
}
interface Detail {
  path: string;
  mode: 'items' | 'text' | 'binary';
  items: ConflictItem[];
  hunks: Hunk[];
  sizes?: { ours?: number; theirs?: number };
}
type Choice = 'ours' | 'theirs' | 'edit';

const KIND: Record<ConflictItem['kind'], string> = {
  'changed-both': 'changed on both sides',
  'deleted-theirs': 'changed here, deleted by them',
  'deleted-ours': 'deleted here, changed by them',
  setting: 'setting changed on both sides',
};

const LABELS = (item?: ConflictItem) => [
  { value: 'ours' as const, label: item?.kind === 'deleted-ours' ? 'Delete it (mine)' : 'Keep mine' },
  { value: 'theirs' as const, label: item?.kind === 'deleted-theirs' ? 'Delete it (theirs)' : 'Keep theirs' },
  { value: 'edit' as const, label: 'Edit' },
];

export function GitConflictDialog({ path, onClose, onResolved }: { path: string; onClose(): void; onResolved(): void }) {
  const [detail, setDetail] = useState<Detail>();
  // a choice per key (an item, one of its fields, a hunk); an edit's text beside it
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [onlyDiffs, setOnlyDiffs] = useState(true);
  const [busy, setBusy] = useState(false);
  const [whole, setWhole] = useState<'ours' | 'theirs'>('ours');
  useEffect(() => {
    void call<Detail>('git.conflictDetail', { path }).then((d) => {
      setDetail(d);
      setChoices(Object.fromEntries([...d.items.map((i) => [i.key, 'ours' as Choice]), ...d.hunks.map((h) => [h.key, 'ours' as Choice])]));
      setEdits(Object.fromEntries([...d.items.map((i) => [i.key, i.editable ?? '']), ...d.items.flatMap((i) => (i.fields ?? []).map((f) => [f.key, f.oursJson ?? ''])), ...d.hunks.map((h) => [h.key, h.ours])]));
    }, toastError);
  }, [path]);
  const keys = useMemo(() => [...(detail?.items ?? []).map((i) => i.key), ...(detail?.hunks ?? []).map((h) => h.key)], [detail]);
  const counts = useMemo(() => {
    const v = keys.map((k) => choices[k] ?? 'ours');
    return { ours: v.filter((x) => x === 'ours').length, theirs: v.filter((x) => x === 'theirs').length, edited: v.filter((x) => x === 'edit').length };
  }, [choices, keys]);
  const resolve = async () => {
    setBusy(true);
    try {
      let resolutions: Record<string, unknown> | undefined;
      if (detail?.mode !== 'binary') {
        resolutions = {};
        const put = (k: string, c: Choice) => (resolutions![k] = c === 'edit' ? { edit: edits[k] ?? '' } : c);
        for (const i of detail?.items ?? []) {
          const c = choices[i.key] ?? 'ours';
          put(i.key, c);
          // a field settled differently from its item
          if (c !== 'edit') for (const f of i.fields ?? []) if (choices[f.key] && choices[f.key] !== c) put(f.key, choices[f.key]!);
        }
        for (const h of detail?.hunks ?? []) put(h.key, choices[h.key] ?? 'ours');
      }
      await call('git.resolve', { path, side: detail?.mode === 'binary' ? whole : 'ours', ...(resolutions ? { resolutions } : {}) });
      useApp.getState().toast(`${path} resolved${counts.ours + counts.theirs + counts.edited ? `: ${counts.ours} kept as mine, ${counts.theirs} taken from theirs${counts.edited ? `, ${counts.edited} edited` : ''}` : ''}`, 'success');
      onResolved();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const all = (side: 'ours' | 'theirs') => setChoices(Object.fromEntries(keys.map((k) => [k, side])));
  const empty = detail && !detail.items.length && !detail.hunks.length && detail.mode !== 'binary';
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
            {detail?.mode === 'binary' ? 'A database or an image cannot be merged: one side is taken whole.' : `Every change that did not conflict, from both sides, stays. ${counts.ours} mine · ${counts.theirs} theirs${counts.edited ? ` · ${counts.edited} edited` : ''}.`}
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Check size={13} />} loading={busy} disabled={!detail} onClick={() => void resolve()}>
            Resolve with these choices
          </Button>
        </>
      }
    >
      {!detail ? (
        <Empty title="Reading the three versions…" />
      ) : detail.mode === 'binary' ? (
        <div className="grid gap-3" data-conflict-binary>
          <Segmented
            label="Which version"
            value={whole}
            onChange={setWhole}
            options={[
              { value: 'ours', label: `Keep mine${detail.sizes?.ours !== undefined ? ` (${detail.sizes.ours.toLocaleString()} bytes)` : ''}` },
              { value: 'theirs', label: `Keep theirs${detail.sizes?.theirs !== undefined ? ` (${detail.sizes.theirs.toLocaleString()} bytes)` : ''}` },
            ]}
          />
        </div>
      ) : empty ? (
        <Empty title="Nothing left to choose">This file merges cleanly now; resolve it to mark it done.</Empty>
      ) : (
        <div className="grid gap-4">
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <span className="text-muted">{keys.length} conflicts</span>
            <Button size="sm" onClick={() => all('ours')}>
              Keep all mine
            </Button>
            <Button size="sm" onClick={() => all('theirs')}>
              Keep all theirs
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
                    <Segmented label={`Which version of ${item.where}`} value={choice} onChange={(v) => setChoices({ ...choices, [item.key]: v })} options={LABELS(item)} />
                  </span>
                </header>
                {choice === 'edit' ? (
                  <EditBox label={`Edit ${item.where} (JSON)`} value={edits[item.key] ?? ''} onChange={(v) => setEdits({ ...edits, [item.key]: v })} />
                ) : item.fields?.length ? (
                  <div className="grid gap-2 p-2" data-conflict-fields>
                    <div className="text-xs text-muted">Only these fields clash; every other field of the item was merged.</div>
                    {item.fields.map((f) => {
                      const fc = choices[f.key] ?? choice;
                      return (
                        <div key={f.key} className="rounded-md border border-line" data-conflict-field={f.key}>
                          <div className="flex items-center gap-2 px-2 py-1 border-b border-line">
                            <span className="font-mono text-xs">{f.path}</span>
                            <span className="ml-auto">
                              <Segmented label={`Which version of ${f.path}`} value={fc} onChange={(v) => setChoices({ ...choices, [f.key]: v })} options={LABELS()} />
                            </span>
                          </div>
                          {fc === 'edit' ? (
                            <EditBox label={`Edit ${f.path} (JSON)`} value={edits[f.key] ?? ''} onChange={(v) => setEdits({ ...edits, [f.key]: v })} />
                          ) : (
                            <PartsTable
                              rows={[{ part: f.path, differs: true, values: { base: f.base, ours: f.ours, theirs: f.theirs } }]}
                              emptyText=""
                              columns={[
                                { key: 'base', label: 'Before (common)' },
                                { key: 'ours', label: 'Mine', chosen: fc === 'ours', highlight: true },
                                { key: 'theirs', label: 'Theirs', chosen: fc === 'theirs', highlight: true },
                              ]}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <PartsTable
                    rows={parts.map((p) => ({ part: p.part, differs: p.differs, values: { base: p.base, ours: p.ours, theirs: p.theirs } }))}
                    emptyText="No part differs between mine and theirs."
                    columns={[
                      { key: 'base', label: 'Before (common)' },
                      { key: 'ours', label: 'Mine', missing: item.kind === 'deleted-ours' ? 'deleted here' : '—', chosen: choice === 'ours', highlight: true },
                      { key: 'theirs', label: 'Theirs', missing: item.kind === 'deleted-theirs' ? 'deleted by them' : '—', chosen: choice === 'theirs', highlight: true },
                    ]}
                  />
                )}
              </section>
            );
          })}
          {detail.hunks.map((h) => {
            const choice = choices[h.key] ?? 'ours';
            return (
              <section key={h.key} className="rounded-lg border border-line" data-conflict={h.key}>
                <header className="flex items-center gap-2 px-3 py-2 border-b border-line">
                  <span className="font-medium text-sm truncate">{h.where}</span>
                  <Badge tone="warn">lines changed on both sides</Badge>
                  <span className="ml-auto">
                    <Segmented label={`Which version of ${h.where}`} value={choice} onChange={(v) => setChoices({ ...choices, [h.key]: v })} options={LABELS()} />
                  </span>
                </header>
                {choice === 'edit' ? (
                  <EditBox label={`Edit ${h.where}`} value={edits[h.key] ?? ''} onChange={(v) => setEdits({ ...edits, [h.key]: v })} />
                ) : (
                  <PartsTable
                    rows={[{ part: 'Lines', differs: true, values: { base: h.base, ours: h.ours, theirs: h.theirs } }]}
                    emptyText=""
                    columns={[
                      { key: 'base', label: 'Before (common)' },
                      { key: 'ours', label: 'Mine', chosen: choice === 'ours', highlight: true },
                      { key: 'theirs', label: 'Theirs', chosen: choice === 'theirs', highlight: true },
                    ]}
                  />
                )}
              </section>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

/** The one edit box of a conflict (an item or field as JSON, a hunk as text). */
function EditBox({ label, value, onChange }: { label: string; value: string; onChange(v: string): void }) {
  return <Textarea className="field w-full min-h-32 font-mono text-xs m-0 rounded-none" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} />;
}
