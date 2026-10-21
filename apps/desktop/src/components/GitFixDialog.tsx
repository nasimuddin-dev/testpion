import { Check, Info, Wrench } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { GitFixResult, GitFixStep } from '@testpion/core';
import { call } from '../api';
import { toastError, useApp } from '../store';
import { plural } from '../lib/format';
import { toastWithUndo } from '../lib/git-items';
import { asError } from '../api';
import { Badge, Button, Callout, Empty, Modal, Toggle } from './ui';

const STATE: Record<GitFixStep['state'], { label: string; tone: 'accent' | 'warn' | undefined }> = {
  todo: { label: 'Will fix', tone: 'accent' },
  advice: { label: 'Note', tone: undefined },
  skipped: { label: 'Not here', tone: 'warn' },
};

/**
 * Fix git setup (release C of planning/git-everything.md §4d): one previewed, undoable action. It shows every step it will take
 * (the ignore and attribute files, the merge and diff drivers, existing files rewritten once into the fixed layout) before
 * anything is written, applies them together, says what it changed and offers Undo. Idempotent: on a workspace that is in order
 * it says so. The same plan is `testpion git fix --dry-run` and the MCP tool git_fix_setup.
 */
export function GitFixDialog({ onClose, onDone }: { onClose(): void; onDone(): void }) {
  const [hook, setHook] = useState(false);
  const [untrack, setUntrack] = useState(false);
  const [plan, setPlan] = useState<GitFixResult>();
  const [done, setDone] = useState<GitFixResult>();
  const [busy, setBusy] = useState(false);
  // a plan that cannot be made says why and offers Retry; the dialog stays open (closing after a toast leaves no hint what to try)
  const [problem, setProblem] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setPlan(undefined);
    setProblem(undefined);
    void call<GitFixResult>('git.fixPlan', { hook, untrack }).then(setPlan, (e) => setProblem(asError(e).message));
  }, [hook, untrack, attempt]);

  const apply = async () => {
    setBusy(true);
    try {
      const r = await call<GitFixResult>('git.fix', { hook, untrack });
      setDone(r);
      toastWithUndo(r.message, r.undoId);
      onDone();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const todo = plan?.steps.filter((s) => s.state === 'todo').length ?? 0;
  const shown = done ?? plan;
  return (
    <Modal
      title={
        <span className="flex items-center gap-2">
          <Wrench size={16} /> Fix git setup
        </span>
      }
      onClose={onClose}
      width={680}
      footer={
        done ? (
          <>
            {done.undoId && (
              <Button
                onClick={async () => {
                  try {
                    await call('git.undo', { id: done.undoId });
                    useApp.getState().toast('Put back as it was', 'success');
                    onDone();
                    onClose();
                  } catch (e) {
                    toastError(e);
                  }
                }}
              >
                Undo
              </Button>
            )}
            <Button variant="primary" onClick={onClose}>
              Close
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" icon={<Wrench size={13} />} loading={busy} disabled={!plan || !todo} onClick={() => void apply()} data-fix-apply="">
              Fix{todo ? ` ${plural(todo, 'thing')}` : ''}
            </Button>
          </>
        )
      }
    >
      {problem ? (
        <Callout tone="bad" role="alert" action={<Button size="sm" onClick={() => setAttempt((n) => n + 1)}>Retry</Button>}>
          Could not look at the workspace: {problem}. Check that git is installed and the workspace folder is readable, then retry.
        </Callout>
      ) : !shown ? (
        <Empty title="Looking at the workspace…" />
      ) : (
        <div className="grid gap-3" data-fix-dialog="">
          <p className="text-sm text-muted">
            {done ? done.message : todo ? 'Nothing is written until you press Fix. Every file it changes is copied aside first, so Undo puts them back.' : 'Git setup is complete: nothing to fix.'}
          </p>
          <ul className="grid gap-2" aria-label="Steps">
            {shown.steps.map((s) => (
              <li key={s.id} className="rounded-md border border-line bg-panel px-3 py-2 text-sm" data-fix-step={s.id} data-fix-state={s.state}>
                <div className="flex items-center gap-2">
                  {done && s.state === 'todo' ? <Check size={14} className="text-ok" /> : <Info size={14} className="text-muted" />}
                  <span className="font-medium">{s.title}</span>
                  <Badge tone={STATE[s.state].tone} className="ml-auto">
                    {done && s.state === 'todo' ? 'Done' : STATE[s.state].label}
                  </Badge>
                </div>
                {s.detail.length > 0 && (
                  <ul className="mt-1 grid gap-0.5 text-xs text-muted font-mono break-all">
                    {s.detail.slice(0, 8).map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                    {s.detail.length > 8 && <li>… {s.detail.length - 8} more</li>}
                  </ul>
                )}
              </li>
            ))}
          </ul>
          {shown.rewritten.length > 0 && (
            <details className="text-xs" data-fix-rewritten="">
              <summary className="cursor-pointer text-muted">
                {plural(shown.rewritten.length, 'file')} {done ? 'rewritten' : 'will be rewritten'} in the layout that merges cleanly (one request per block, in a fixed order)
              </summary>
              <ul className="mt-1 grid gap-0.5 font-mono max-h-40 overflow-auto">
                {shown.rewritten.map((r) => (
                  <li key={r.file}>
                    {r.file} <span className="text-muted">{r.reason === 'line-endings' ? 'line endings only' : `${r.lines.before} → ${r.lines.after} lines`}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {shown.problems.length > 0 && (
            <ul className="text-xs text-warn">
              {shown.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {!done && (
            <div className="grid gap-1 text-sm">
              {shown.inRepository && (
                <Toggle checked={hook} onChange={setHook} label="Also refuse a commit that would publish a secret" title="Adds a check that runs before every commit made in a terminal and stops it when a password, token or key is in the files" />
              )}
              {(plan?.steps.some((s) => s.id === 'untrack') || untrack) && (
                <Toggle checked={untrack} onChange={setUntrack} label="Stop sharing files that should stay on this computer (they stay on disk)" title="Files such as local history and caches were committed once; this takes them out of git so they are not shared again" />
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
