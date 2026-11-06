import { Check, MessageSquare, Pencil, Reply, RotateCcw, Trash2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { MENTION, type ItemRef } from '@testpion/shared';
import { call, on } from '../api';
import { useSticky } from '../lib/sticky';
import { timeAgo } from '../lib/format';
import { toastError } from '../store';
import { deleteWithUndo } from '../lib/undo-delete';
import { Button, EmptyNote, IconButton, SectionTitle, Textarea, cx } from './ui';
import { SuggestList, suggestKey } from './SuggestInput';

type Comment = { id: string; by: string; at: string; text: string; resolvedAt?: string; resolvedBy?: string; replyTo?: string; editedAt?: string; mine?: boolean };

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
  // @mentions: who can be named (the repository's people, CODEOWNERS teams), read once; the @word before the caret
  const box = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [people, setPeople] = useState<Array<{ handle: string; label: string; kind: 'person' | 'team' }>>([]);
  useEffect(() => {
    void call<typeof people>('comments.people').then(setPeople, () => setPeople([]));
  }, []);
  // (the caret of this item's box: another item's draft starts at its end)
  useEffect(() => setCaret(text.length), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const typing = /(?:^|[\s(,;:])@([\p{L}\p{N}_./-]*)$/u.exec(text.slice(0, caret))?.[1];
  const suggestions =
    typing === undefined ? [] : people.filter((p) => !typing || p.handle.toLowerCase().includes(typing.toLowerCase()) || p.label.toLowerCase().includes(typing.toLowerCase())).slice(0, 6);
  // the list of them under the box: its active row, closed by Esc where the caret is (typing on opens it again)
  const listId = useId();
  const [active, setActive] = useState(0);
  const [closedAt, setClosedAt] = useState<number>();
  const listed = suggestions.length > 0 && closedAt !== caret;
  useEffect(() => setActive(0), [typing]);
  /** Put `@handle ` in place of the @word being typed, and the caret after it. */
  const mention = (handle: string) => {
    const before = text.slice(0, caret).replace(/@[\p{L}\p{N}_./-]*$/u, `@${handle} `);
    const next = before + text.slice(caret);
    setText(next);
    setCaret(before.length);
    requestAnimationFrame(() => box.current?.setSelectionRange(before.length, before.length));
  };
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
  // a reply answers a thread's first comment: the box says which, × makes it a comment of its own again
  const [replyTo, setReplyTo] = useState<Comment>();
  useEffect(() => setReplyTo(undefined), [key]);
  const add = () => run(() => call('comments.add', { ref, text, ...(replyTo ? { replyTo: replyTo.id } : {}) }).then(() => (setText(''), setReplyTo(undefined))));
  // (a reply whose comment is gone, after a merge, is shown as a comment of its own: never hidden)
  const ids = new Set((comments ?? []).map((c) => c.id));
  const roots = (comments ?? []).filter((c) => !c.replyTo || !ids.has(c.replyTo));
  const repliesOf = (id: string) => (comments ?? []).filter((c) => c.replyTo === id);
  // the comment being answered deleted or settled meanwhile (a pull, another window): no longer a reply
  useEffect(() => {
    if (replyTo && comments && !comments.some((c) => c.id === replyTo.id && !c.resolvedAt)) setReplyTo(undefined);
  }, [comments, replyTo]);
  const open = roots.filter((c) => !c.resolvedAt);
  const settled = roots.filter((c) => c.resolvedAt);
  // a comment of yours being changed in place: its text, Save (Ctrl+Enter) or Cancel (Esc)
  const [editing, setEditing] = useState<{ id: string; text: string }>();
  useEffect(() => setEditing(undefined), [key]);
  const saveEdit = () => editing && run(() => call('comments.edit', { ref, id: editing.id, text: editing.text }).then(() => setEditing(undefined)));
  /** One comment: who, when, its text, and its actions (a reply: delete only; it is settled with its thread). */
  const row = (c: Comment, parent?: Comment) => (
    <div className={cx('group flex flex-col gap-0.5 min-w-0 rounded border border-line px-2 py-1.5', (c.resolvedAt || parent?.resolvedAt) && 'opacity-60')} data-comment={c.resolvedAt || parent?.resolvedAt ? 'settled' : 'open'}>
      <div className="flex items-center gap-2 text-xs min-w-0">
        <span className="font-semibold truncate">{c.by}</span>
        <span className="text-muted shrink-0" title={c.at}>
          {timeAgo(c.at)}
        </span>
        {c.editedAt && (
          <span className="text-2xs text-muted shrink-0" title={`Changed ${c.editedAt}`} data-comment-edited>
            edited
          </span>
        )}
        <span className="ml-auto inline-flex gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
          {c.mine && !c.resolvedAt && !parent?.resolvedAt && (
            <IconButton size="sm" label="Change this comment" disabled={busy} reason="Wait for the last change to save" onClick={() => setEditing({ id: c.id, text: c.text })} data-comment-edit>
              <Pencil />
            </IconButton>
          )}
          {!parent && !c.resolvedAt && (
            <IconButton size="sm" label={`Reply to ${c.by}`} onClick={() => (setReplyTo(c), box.current?.focus())} data-comment-reply-button>
              <Reply />
            </IconButton>
          )}
          {!parent && (
            <IconButton size="sm" label={c.resolvedAt ? 'Open this comment again' : 'Mark as settled'} disabled={busy} reason="Wait for the last change to save" onClick={() => void run(() => call('comments.resolve', { ref, id: c.id, resolved: !c.resolvedAt }))} data-comment-resolve>
              {c.resolvedAt ? <RotateCcw /> : <Check />}
            </IconButton>
          )}
          <IconButton
            size="sm"
            label={parent ? 'Delete this reply' : 'Delete this comment'}
            disabled={busy}
            reason="Wait for the last change to save"
            onClick={() => {
              let removed: Comment[] = [c];
              void run(() =>
                deleteWithUndo({
                  what: parent ? 'the reply' : repliesOf(c.id).length ? `the comment and its ${repliesOf(c.id).length === 1 ? 'reply' : 'replies'}` : 'the comment',
                  run: () => call<{ removed?: Comment[] }>('comments.delete', { ref, id: c.id }).then((r) => void (removed = r.removed ?? removed)),
                  undo: async () => {
                    for (const x of removed) await call('comments.restore', { ref, comment: x });
                    await load();
                  },
                }),
              );
            }}
            data-comment-delete
          >
            <Trash2 />
          </IconButton>
        </span>
      </div>
      {editing?.id === c.id ? (
        <div className="flex flex-col gap-1">
          <Textarea
            value={editing.text}
            autoFocus
            rows={2}
            autoGrow
            maxRows={8}
            aria-label="Change the comment"
            onChange={(e) => setEditing({ id: c.id, text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') return void (e.preventDefault(), e.stopPropagation(), setEditing(undefined));
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && editing.text.trim()) void saveEdit();
            }}
            data-comment-edit-text
          />
          <div className="flex items-center gap-1">
            <Button size="sm" variant="primary" disabled={busy || !editing.text.trim()} reason={busy ? 'Wait for the last change to save' : 'Type the comment first (or delete it)'} onClick={() => void saveEdit()} data-comment-edit-save>
              Save
            </Button>
            <Button size="sm" onClick={() => setEditing(undefined)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="text-sm whitespace-pre-wrap break-words">{withMentions(c.text)}</div>
      )}
      {c.resolvedAt && <div className="text-2xs text-muted">Settled by {c.resolvedBy} {timeAgo(c.resolvedAt)}</div>}
    </div>
  );
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
            <li key={c.id} className="flex flex-col gap-1 min-w-0">
              {row(c)}
              {/* its replies, under it (settled with it) */}
              {repliesOf(c.id).map((r) => (
                <div key={r.id} className="ml-4" data-comment-reply={c.id}>
                  {row(r, c)}
                </div>
              ))}
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
        {replyTo && (
          <div className="flex items-center gap-1 text-xs text-muted min-w-0" data-comment-replying={replyTo.id}>
            <Reply size={12} className="shrink-0" />
            <span className="truncate">
              Replying to {replyTo.by}: {replyTo.text}
            </span>
            <IconButton size="sm" label="Not a reply" onClick={() => setReplyTo(undefined)}>
              <X />
            </IconButton>
          </div>
        )}
        <Textarea
          ref={box}
          value={text}
          onChange={(e) => (setText(e.target.value), setCaret(e.target.selectionStart ?? e.target.value.length))}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? text.length)}
          rows={2}
          autoGrow
          maxRows={8}
          placeholder={replyTo ? `Reply to ${replyTo.by}…` : 'Ask or note something for your team…'}
          aria-label="New comment"
          role="combobox"
          aria-expanded={listed}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={listed ? `${listId}-${Math.min(active, suggestions.length - 1)}` : undefined}
          onKeyDown={(e) => {
            // the suggestions of the @word being typed, as every list of suggestions (↑ ↓, Enter or Tab, Esc); a bare @
            // shows them but leaves the keys to the box (Enter is a new line, Tab moves on) until a name is started
            if (listed && typing && suggestKey(e, { count: suggestions.length, index: active, setIndex: setActive, take: (i) => mention(suggestions[i]!.handle), close: () => setClosedAt(caret) })) return;
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim() && !busy) void add();
          }}
          data-comment-text
        />
        {listed && (
          <div className="relative" data-mention-suggestions={suggestions.length}>
            <SuggestList
              id={listId}
              label="Mention"
              rows={suggestions.map((s) => ({ key: s.handle, content: s.kind === 'team' ? s.label : `@${s.handle} · ${s.label}`, title: s.kind === 'team' ? 'A team of CODEOWNERS' : 'Someone of the repository’s history' }))}
              index={active}
              setIndex={setActive}
              take={(i) => mention(suggestions[i]!.handle)}
            />
          </div>
        )}
        <div className="flex items-center gap-2">
          <Button size="sm" variant="primary" disabled={busy || !text.trim()} reason={busy ? 'Wait for the last change to save' : 'Type the comment first'} title="Add the comment (Ctrl+Enter)" onClick={() => void add()} data-comment-add>
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
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(MENTION)) {
    const start = m.index! + m[1]!.length;
    out.push(text.slice(at, start));
    out.push(
      <span key={start} className="text-accent font-medium" data-mention="">
        @{m[2]}
      </span>,
    );
    at = start + 1 + m[2]!.length;
  }
  out.push(text.slice(at));
  return out;
}
