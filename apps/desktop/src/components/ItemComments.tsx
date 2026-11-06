import { Check, MessageSquare, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ItemRef } from '@testpion/shared';
import { call, on } from '../api';
import { useSticky } from '../lib/sticky';
import { timeAgo } from '../lib/format';
import { toastError } from '../store';
import { deleteWithUndo } from '../lib/undo-delete';
import { Button, EmptyNote, IconButton, SectionTitle, Textarea, cx } from './ui';

type Comment = { id: string; by: string; at: string; text: string; resolvedAt?: string; resolvedBy?: string };

/**
 * Comments for your team on the open item (the Info panel): the thread, oldest first, settled ones greyed; a box to add one.
 * They are kept in the workspace under comments/, so git carries them to the team; the author is the git identity's name.
 */
export function ItemComments({ ref }: { ref: ItemRef }) {
  const key = JSON.stringify(ref);
  const [comments, setComments] = useState<Comment[]>();
  // what is being typed is kept per item (in memory, per workspace): the panel unmounts this when the tab or the
  // active environment changes, and the comment must still be there when the item is shown again
  const [text, setText] = useSticky(`comment-draft:${key}`, '');
  const [busy, setBusy] = useState(false);
  // (a ref too: two key presses in a row arrive before `busy` is drawn)
  const working = useRef(false);
  const [showSettled, setShowSettled] = useState(false);
  // the item shown now: an answer for another item (a slow read, then a tab switch) is dropped
  const shown = useRef(key);
  shown.current = key;
  const load = () => call<Comment[]>('comments.list', { ref }).then((list) => shown.current === key && setComments(list), () => shown.current === key && setComments([]));
  useEffect(() => {
    setComments(undefined);
    void load();
    // a comment added, settled or deleted elsewhere (another window, an agent, the CLI, a pull): the thread is read again
    const offs = [on('comments.changed', () => void load()), on('workspace.changedOnDisk', () => void load())];
    return () => offs.forEach((off) => off());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const run = async (fn: () => Promise<unknown>) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      toastError(e);
    } finally {
      working.current = false;
      setBusy(false);
    }
  };
  const add = () => run(() => call('comments.add', { ref, text }).then(() => setText('')));
  const open = (comments ?? []).filter((c) => !c.resolvedAt);
  const settled = (comments ?? []).filter((c) => c.resolvedAt);
  return (
    <section data-item-comments={comments ? open.length : 'loading'}>
      <SectionTitle>
        <span className="inline-flex items-center gap-1.5">
          <MessageSquare size={13} />
          Comments for your team
          {open.length > 0 && <span className="text-2xs text-muted font-normal">{open.length} open</span>}
        </span>
      </SectionTitle>
      {comments && !comments.length && <EmptyNote>No comments yet. A question or a note here is saved in the workspace, so with git your team reads it next to the item.</EmptyNote>}
      {comments && comments.length > 0 && (
        <ul className="flex flex-col gap-2" data-comment-list>
          {[...open, ...(showSettled ? settled : [])].map((c) => (
            <li key={c.id} className={cx('group flex flex-col gap-0.5 min-w-0 rounded border border-line px-2 py-1.5', c.resolvedAt && 'opacity-60')} data-comment={c.resolvedAt ? 'settled' : 'open'}>
              <div className="flex items-center gap-2 text-xs min-w-0">
                <span className="font-semibold truncate">{c.by}</span>
                <span className="text-muted shrink-0" title={c.at}>
                  {timeAgo(c.at)}
                </span>
                <span className="ml-auto inline-flex gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                  <IconButton size="sm" label={c.resolvedAt ? 'Open this comment again' : 'Mark as settled'} disabled={busy} reason="Wait for the last change to save" onClick={() => void run(() => call('comments.resolve', { ref, id: c.id, resolved: !c.resolvedAt }))} data-comment-resolve>
                    {c.resolvedAt ? <RotateCcw /> : <Check />}
                  </IconButton>
                  <IconButton size="sm" label="Delete this comment" disabled={busy} reason="Wait for the last change to save" onClick={() => void run(() => deleteWithUndo({ what: 'the comment', run: () => call('comments.delete', { ref, id: c.id }), undo: () => call('comments.restore', { ref, comment: c }).then(load) }))} data-comment-delete>
                    <Trash2 />
                  </IconButton>
                </span>
              </div>
              <div className="text-sm whitespace-pre-wrap break-words">{withMentions(c.text)}</div>
              {c.resolvedAt && <div className="text-2xs text-muted">Settled by {c.resolvedBy} {timeAgo(c.resolvedAt)}</div>}
            </li>
          ))}
        </ul>
      )}
      {settled.length > 0 && (
        <button type="button" className="mt-1 text-xs text-muted hover:text-fg" onClick={() => setShowSettled((v) => !v)} data-comment-settled-toggle>
          {showSettled ? 'Hide settled' : `Show ${settled.length} settled`}
        </button>
      )}
      <div className="mt-2 flex flex-col gap-1.5">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          autoGrow
          maxRows={8}
          placeholder="Ask or note something for your team…"
          aria-label="New comment"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim() && !busy) void add();
          }}
          data-comment-text
        />
        <div className="flex items-center gap-2">
          <Button size="sm" variant="primary" disabled={busy || !text.trim()} title={text.trim() ? 'Add the comment (Ctrl+Enter)' : 'Type the comment first'} onClick={() => void add()} data-comment-add>
            Add comment
          </Button>
        </div>
        <p className="text-2xs text-muted">Saved in the workspace under comments/; commit it and your team reads it next to this item.</p>
      </div>
    </section>
  );
}

/** A comment's text with its @mentions (`@Ana`, `@org/payments`) stand out, as the people they name read them. */
function withMentions(text: string): ReactNode {
  const parts = text.split(/((?:^|(?<=[\s(,;:]))@[A-Za-z0-9][\w.-]*(?:\/[\w.-]+)?)/);
  return parts.map((p, i) =>
    i % 2 ? (
      <span key={i} className="text-accent font-medium" data-mention="">
        {p}
      </span>
    ) : (
      p
    ),
  );
}
