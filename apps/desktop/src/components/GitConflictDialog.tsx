import { Check, GitMerge } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { call } from '../api';
import { confirmAction, toastError } from '../store';
import { toastWithUndo } from '../lib/git-items';
import { plural } from '../lib/format';
import { Badge, Button, Empty, Modal, Segmented, Textarea, Toggle } from './ui';
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
  /** The step of a test or flow file it is in. */
  step?: string;
}
/** The hunks of one step of a test or flow file: settled in one choice, or hunk by hunk. */
interface Step {
  key: string;
  step: string;
  hunks: string[];
}
interface Detail {
  path: string;
  mode: 'items' | 'text' | 'binary';
  items: ConflictItem[];
  hunks: Hunk[];
  steps?: Step[];
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
  // what the person actually chose: mine is where every conflict starts, so pressing the big button without choosing anything asks first
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const choose = (key: string, v: Choice) => {
    setChoices((c) => ({ ...c, [key]: v }));
    setPicked((p) => new Set(p).add(key));
  };
  useEffect(() => {
    void call<Detail>('git.conflictDetail', { path }).then((d) => {
      setDetail(d);
      const inSteps = new Set((d.steps ?? []).flatMap((s) => s.hunks));
      setChoices(Object.fromEntries([...d.items.map((i) => [i.key, 'ours' as Choice]), ...(d.steps ?? []).map((s) => [s.key, 'ours' as Choice]), ...d.hunks.filter((h) => !inSteps.has(h.key)).map((h) => [h.key, 'ours' as Choice])]));
      setEdits(Object.fromEntries([...d.items.map((i) => [i.key, i.editable ?? '']), ...d.items.flatMap((i) => (i.fields ?? []).map((f) => [f.key, f.oursJson ?? ''])), ...d.hunks.map((h) => [h.key, h.ours])]));
    }, toastError);
  }, [path]);
  // a test or flow file settles its clashes by step (a hunk of a step is settled with it); a hunk outside the steps stays a hunk
  const inSteps = useMemo(() => new Set((detail?.steps ?? []).flatMap((s) => s.hunks)), [detail]);
  const keys = useMemo(() => [...(detail?.items ?? []).map((i) => i.key), ...(detail?.steps ?? []).map((s) => s.key), ...(detail?.hunks ?? []).filter((h) => !inSteps.has(h.key)).map((h) => h.key)], [detail, inSteps]);
  const counts = useMemo(() => {
    const v = keys.map((k) => choices[k] ?? 'ours');
    return { ours: v.filter((x) => x === 'ours').length, theirs: v.filter((x) => x === 'theirs').length, edited: v.filter((x) => x === 'edit').length };
  }, [choices, keys]);
  const resolve = async () => {
    if (!picked.size && (keys.length || detail?.mode === 'binary')) {
      const what = detail?.mode === 'binary' ? 'this file' : plural(keys.length, 'conflict');
      const ok = await confirmAction({
        title: 'Keep all of mine?',
        message: `You have not chosen anything yet. Resolving now keeps your version of ${what} and drops what your teammate changed there.`,
        detail: 'Everything that did not clash stays, from both sides. You can undo this right after.',
        confirmLabel: 'Keep mine',
      });
      if (!ok) return;
    }
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
        for (const h of detail?.hunks ?? []) if (!inSteps.has(h.key)) put(h.key, choices[h.key] ?? 'ours');
        for (const st of detail?.steps ?? []) {
          const c = choices[st.key] ?? 'ours';
          put(st.key, c);
          // a hunk settled differently from its step
          for (const hk of st.hunks) if (choices[hk] && choices[hk] !== c) put(hk, choices[hk]!);
        }
      }
      const r = await call<{ undoId?: string }>('git.resolve', { path, side: detail?.mode === 'binary' ? whole : 'ours', ...(resolutions ? { resolutions } : {}) });
      toastWithUndo(`${path} resolved${counts.ours + counts.theirs + counts.edited ? `: ${counts.ours} kept as mine, ${counts.theirs} taken from theirs${counts.edited ? `, ${counts.edited} edited` : ''}` : ''}`, r.undoId);
      onResolved();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const all = (side: 'ours' | 'theirs') => {
    setChoices(Object.fromEntries(keys.map((k) => [k, side])));
    setPicked(new Set(keys));
  };
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
          <span className="mr-auto min-w-0 text-xs text-muted self-center" aria-live="polite" data-conflict-count="">
            {detail?.mode === 'binary' ? 'A database or an image cannot be merged: one side is taken whole.' : `Every change that did not conflict, from both sides, stays. Your choices: ${counts.ours} mine · ${counts.theirs} theirs${counts.edited ? ` · ${counts.edited} edited` : ''}${picked.size ? '' : ' (nothing chosen yet: it starts with mine)'}.`}
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
            onChange={(v) => (setWhole(v), setPicked(new Set(['whole'])))}
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
            <span className="ml-auto text-muted">
              <Toggle checked={onlyDiffs} onChange={setOnlyDiffs} label="Only the parts that differ" />
            </span>
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
                    <Segmented label={`Which version of ${item.where}`} value={choice} onChange={(v) => choose(item.key, v)} options={LABELS(item)} />
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
                              <Segmented label={`Which version of ${f.path}`} value={fc} onChange={(v) => choose(f.key, v)} options={LABELS()} />
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
          {(detail.steps ?? []).map((st) => {
            const choice = choices[st.key] ?? 'ours';
            return (
              <section key={st.key} className="rounded-lg border border-line" data-conflict={st.key}>
                <header className="flex items-center gap-2 px-3 py-2 border-b border-line">
                  <span className="font-medium text-sm truncate">Step {st.step}</span>
                  <Badge tone="warn">changed on both sides</Badge>
                  <span className="ml-auto">
                    <Segmented label={`Which version of step ${st.step}`} value={choice === 'edit' ? 'ours' : choice} onChange={(v) => choose(st.key, v)} options={LABELS().filter((o) => o.value !== 'edit')} />
                  </span>
                </header>
                <div className="grid gap-2 p-2" data-conflict-fields>
                  <div className="text-xs text-muted">Only these lines clash; every other line of the step was merged.</div>
                  {st.hunks.map((hk) => {
                    const h = detail.hunks.find((x) => x.key === hk)!;
                    const hc = choices[hk] ?? choice;
                    return (
                      <div key={hk} className="rounded-md border border-line" data-conflict-field={hk}>
                        <div className="flex items-center gap-2 px-2 py-1 border-b border-line">
                          <span className="font-mono text-xs truncate">{h.where}</span>
                          <span className="ml-auto">
                            <Segmented label={`Which version of ${h.where}`} value={hc} onChange={(v) => choose(hk, v)} options={LABELS()} />
                          </span>
                        </div>
                        {hc === 'edit' ? (
                          <EditBox label={`Edit ${h.where}`} value={edits[hk] ?? ''} onChange={(v) => setEdits({ ...edits, [hk]: v })} />
                        ) : (
                          <PartsTable
                            rows={[{ part: 'Lines', differs: true, values: { base: h.base, ours: h.ours, theirs: h.theirs } }]}
                            emptyText=""
                            columns={[
                              { key: 'base', label: 'Before (common)' },
                              { key: 'ours', label: 'Mine', chosen: hc === 'ours', highlight: true },
                              { key: 'theirs', label: 'Theirs', chosen: hc === 'theirs', highlight: true },
                            ]}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
          {detail.hunks.filter((h) => !inSteps.has(h.key)).map((h) => {
            const choice = choices[h.key] ?? 'ours';
            return (
              <section key={h.key} className="rounded-lg border border-line" data-conflict={h.key}>
                <header className="flex items-center gap-2 px-3 py-2 border-b border-line">
                  <span className="font-medium text-sm truncate">{h.where}</span>
                  <Badge tone="warn">lines changed on both sides</Badge>
                  <span className="ml-auto">
                    <Segmented label={`Which version of ${h.where}`} value={choice} onChange={(v) => choose(h.key, v)} options={LABELS()} />
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
