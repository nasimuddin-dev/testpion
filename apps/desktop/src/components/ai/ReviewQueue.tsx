import { Check, ThumbsDown, ThumbsUp } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { plural } from '@testpion/shared';
import type { ReviewQueue as Queue } from '@testpion/core';
import { call } from '../../api';
import { toastError, useApp } from '../../store';
import { Badge, Button, cx, Modal, Spinner } from '../ui';

/**
 * Review answers (A-6): read each answer of a run and grade it good or bad, one at a time, from the keyboard — <kbd>G</kbd> good,
 * <kbd>B</kbd> bad, <kbd>J</kbd> / <kbd>K</kbd> (or the arrows) next and back. The failed cases come first and the rest are spread
 * across the run. What the checks decided stays hidden until the case is graded, so your reading is your own; after grading, how
 * often the checks agreed with you, and the good answers can become the expected answers of the test cases. The grades are the run's
 * reviews (`runs.review`), the same as the good / bad buttons of a result.
 */
export function ReviewQueue({ runId, onClose }: { runId: string; onClose(): void }) {
  const [q, setQ] = useState<Queue>();
  const [at, setAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(() => call<Queue>('eval.reviewQueue', { run: runId, count: 10 }).then(setQ, (e) => (toastError(e), onClose())), [runId, onClose]);
  useEffect(() => void load(), [load]);
  // start at the first answer that is not graded yet (once: a grade moves on by one, not by a second jump)
  const placed = useRef(false);
  useEffect(() => {
    if (q && !placed.current) {
      placed.current = true;
      const first = q.cases.findIndex((c) => !c.rating);
      if (first > 0) setAt(first);
    }
  }, [q]);
  const c = q?.cases[at];
  useEffect(() => setNote(c?.note ?? ''), [c?.resultId, c?.note]);

  const grade = useCallback(
    async (rating: 'good' | 'bad') => {
      if (!q || !c || busy) return;
      setBusy(true);
      try {
        await call('runs.review', { runId, resultId: c.resultId, rating: c.rating === rating ? null : rating, note: note.trim() || null });
        await load();
        if (c.rating !== rating) setAt((i) => Math.min(i + 1, q.cases.length - 1));
      } catch (e) {
        toastError(e);
      } finally {
        setBusy(false);
      }
    },
    [q, c, busy, runId, note, load],
  );
  const go = useCallback((d: number) => setAt((i) => (q ? Math.max(0, Math.min(q.cases.length - 1, i + d)) : i)), [q]);

  // the keys, unless a text field has the focus (the note)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'g') (e.preventDefault(), void grade('good'));
      else if (k === 'b') (e.preventDefault(), void grade('bad'));
      else if (k === 'j' || k === 'arrowright') (e.preventDefault(), go(1));
      else if (k === 'k' || k === 'arrowleft') (e.preventDefault(), go(-1));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [grade, go]);

  const addGood = async () => {
    try {
      const r = await call<{ text: string }>('eval.reviewToDataset', { run: runId });
      useApp.getState().toast(r.text, 'success');
    } catch (e) {
      toastError(e);
    }
  };

  const good = q?.cases.filter((x) => x.rating === 'good').length ?? 0;
  return (
    <Modal
      title="Review answers"
      onClose={onClose}
      width={760}
      footer={
        <>
          <span className="mr-auto text-xs text-muted" data-review-keys>
            <kbd>G</kbd> good · <kbd>B</kbd> bad · <kbd>J</kbd> next · <kbd>K</kbd> back
          </span>
          {q && good > 0 && q.canAddToDataset && (
            <Button size="sm" icon={<Check size={12} />} onClick={() => void addGood()} title="Each answer you graded good becomes the expected answer of its test case (one that already has an expected answer keeps it)" data-review-add>
              Add the {plural(good, 'good answer')} to the test cases
            </Button>
          )}
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {!q || !c ? (
        <Spinner />
      ) : (
        <div className="flex flex-col gap-3 text-sm" ref={box} data-review-queue data-review-done={q.done ? 'true' : 'false'}>
          <div className="flex items-center gap-2 text-xs text-muted">
            <span data-review-position>
              {at + 1} of {q.total}
            </span>
            <div className="flex gap-1" aria-hidden>
              {q.cases.map((x, i) => (
                <span key={x.resultId} className={cx('size-2 rounded-full border', i === at && 'ring-1 ring-accent', x.rating === 'good' ? 'bg-ok border-ok' : x.rating === 'bad' ? 'bg-bad border-bad' : 'border-line')} />
              ))}
            </div>
            <span className="ml-auto" data-review-text>
              {q.text}
            </span>
          </div>
          <div data-review-case={c.key} data-review-rating={c.rating ?? 'none'}>
            {c.input && (
              <div className="mb-2">
                <div className="text-xs text-muted">Asked</div>
                <div className="whitespace-pre-wrap break-words max-h-32 overflow-auto">{c.input}</div>
              </div>
            )}
            <div>
              <div className="text-xs text-muted">Answered</div>
              <div className="whitespace-pre-wrap break-words max-h-56 overflow-auto rounded-md border border-line px-2.5 py-2" data-review-answer>
                {c.answer || '(empty)'}
              </div>
            </div>
            {c.rating && c.verdict && (
              <div className="mt-2 text-xs" data-review-verdict>
                <Badge tone={c.verdict.status === 'passed' ? 'ok' : 'bad'}>The checks: {c.verdict.status}</Badge>
                {c.verdict.failedChecks.length > 0 && <span className="text-muted"> {c.verdict.failedChecks.join(', ')}</span>}
                <span className={cx('ml-2', (c.rating === 'good') === (c.verdict.status === 'passed') ? 'text-ok' : 'text-warn')}>{(c.rating === 'good') === (c.verdict.status === 'passed') ? 'agrees with you' : 'disagrees with you'}</span>
              </div>
            )}
          </div>
          <textarea
            className="field text-sm min-h-14"
            placeholder="A note (optional): why this answer is good or bad"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label="Note about this answer"
            data-review-note
          />
          <div className="flex items-center gap-2">
            <Button variant={c.rating === 'good' ? 'primary' : undefined} icon={<ThumbsUp size={13} />} onClick={() => void grade('good')} disabled={busy} reason="Saving your grade" data-review-good>
              Good
            </Button>
            <Button variant={c.rating === 'bad' ? 'primary' : undefined} icon={<ThumbsDown size={13} />} onClick={() => void grade('bad')} disabled={busy} reason="Saving your grade" data-review-bad>
              Bad
            </Button>
            <Button onClick={() => go(-1)} disabled={at === 0} reason="This is the first answer">
              Back
            </Button>
            <Button onClick={() => go(1)} disabled={at >= q.total - 1} reason="This is the last answer">
              Next
            </Button>
          </div>
          {q.agreement && (
            <div className="text-xs text-muted" data-review-agreement>
              The checks agreed with you on {q.agreement.agreed} of {q.agreement.graded} you graded ({q.agreement.percent}%).
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
