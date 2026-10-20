import { Archive, ArchiveRestore, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { call, on } from '../api';
import { confirmAction, promptText, toastError, useApp } from '../store';
import { plural } from '../lib/format';
import { Button, SectionTitle } from './ui';

interface Stash {
  index: number;
  hash: string;
  name: string;
  branch?: string;
  date: string;
  ours: boolean;
}
interface Shown {
  changes: Array<{ title: string; details: string[] }>;
  newFiles: string[];
}

/**
 * Changes set aside, with names (release B of planning/git-everything.md): "Set changes aside…" takes every uncommitted
 * change of the workspace away (the workspace goes back to the last commit), "Put back" brings them in again, by item.
 */
export function GitStash({ changed, afterChange }: { changed: boolean; afterChange(): void }) {
  const [list, setList] = useState<Stash[]>([]);
  const [open, setOpen] = useState<string>();
  const [shown, setShown] = useState<Record<string, Shown>>({});
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => void call<Stash[]>('git.stashList').then(setList, () => setList([])), []);
  useEffect(() => {
    load();
    const off = on('git.changed', load);
    return () => off();
  }, [load]);
  const run = async (op: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await op();
      if (done) useApp.getState().toast(done, 'success');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
      load();
      afterChange();
    }
  };
  const setAside = async () => {
    const preview = await call<{ changes: unknown[] }>('git.stashPush', { name: 'preview', dryRun: true }).catch((e) => (toastError(e), undefined));
    if (!preview) return;
    const name = await promptText('Set changes aside', { message: `${plural(preview.changes.length, 'change')} go away until you put them back. The workspace returns to the last commit.`, placeholder: 'Before the pagination rewrite', okLabel: 'Set aside' });
    if (name?.trim()) await run(() => call('git.stashPush', { name: name.trim() }), `Set aside as "${name.trim()}"`);
  };
  const show = async (s: Stash) => {
    setOpen(open === s.hash ? undefined : s.hash);
    if (!shown[s.hash]) setShown({ ...shown, [s.hash]: await call<Shown>('git.stashShow', { hash: s.hash }).catch(() => ({ changes: [], newFiles: [] })) });
  };
  return (
    <section data-git-stash>
      <SectionTitle
        right={
          <Button size="sm" variant="ghost" icon={<Archive size={12} />} disabled={!changed || busy} onClick={() => void setAside()} title="Take the uncommitted changes away under a name, to put them back later">
            Set changes aside…
          </Button>
        }
      >
        Set aside {list.length ? <span className="text-muted font-normal">· {list.length}</span> : null}
      </SectionTitle>
      {!list.length ? (
        <div className="text-sm text-muted py-2">Nothing set aside.</div>
      ) : (
        <ul className="grid gap-1 text-sm" aria-label="Changes set aside">
          {list.map((s) => (
            <li key={s.hash} className="rounded-md border border-line bg-panel" data-stash={s.name}>
              <div className="flex items-center gap-2 px-2 py-1.5">
                <button className="truncate text-left hover:underline" onClick={() => void show(s)} title="What it holds">
                  {s.name}
                </button>
                <span className="text-xs text-muted shrink-0">
                  {s.branch ? `${s.branch} · ` : ''}
                  {new Date(s.date).toLocaleString()}
                </span>
                <span className="ml-auto flex gap-1 shrink-0">
                  <Button size="sm" variant="ghost" icon={<ArchiveRestore size={12} />} disabled={busy} onClick={() => void run(async () => {
                    const r = await call<{ conflicted: boolean; message: string }>('git.stashApply', { hash: s.hash, pop: true });
                    useApp.getState().toast(r.message, r.conflicted ? 'warning' : 'success');
                  })} title="Bring the changes back and remove them from this list">
                    Put back
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Trash2 size={12} />}
                    disabled={busy}
                    onClick={async () => {
                      if (await confirmAction({ title: 'Drop what was set aside', message: `Throw away "${s.name}" for good?`, detail: 'These changes were never committed: they cannot be brought back.', confirmLabel: 'Drop', danger: true })) await run(() => call('git.stashDrop', { hash: s.hash }), 'Dropped');
                    }}
                  >
                    Drop
                  </Button>
                </span>
              </div>
              {open === s.hash && (
                <ul className="border-t border-line px-3 py-1.5 grid gap-0.5 text-xs">
                  {(shown[s.hash]?.changes ?? []).map((c, i) => (
                    <li key={i}>
                      {c.title}
                      {c.details.length ? <span className="text-muted"> · {c.details.join(', ')}</span> : null}
                    </li>
                  ))}
                  {(shown[s.hash]?.newFiles ?? []).map((f) => (
                    <li key={f}>
                      new file {f}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
