import { useMemo, useState } from 'react';
import type { OwnedComment } from '@testpion/core';
import { timeAgo, plural } from '../lib/format';
import { FilterChips } from './FilterChips';
import { RefLink } from './RefLink';
import { Badge, EmptyNote, Modal } from './ui';

/** One open comment of the workspace: its item (a link), the item's team, For you, who and when, and its text. The same row on Home and in the full list. */
export function OpenCommentRow({ c }: { c: OwnedComment }) {
  return (
    <div className="flex flex-col gap-0.5 px-2 py-1.5 text-sm" data-home-comment>
      <span className="flex items-center gap-2 min-w-0">
        <RefLink to={c.ref} className="font-medium min-w-0" />
        {c.owners?.length > 0 && <Badge title="The team that owns this item (CODEOWNERS)">{c.owners.join(' ')}</Badge>}
        {c.forYou && (
          <Badge tone="accent" title="It mentions you (@ and your git name or e-mail) or one of your teams, or answers a comment of yours" data-home-comment-for-you="">
            For you
          </Badge>
        )}
        <span className="text-xs text-muted shrink-0 ml-auto">
          {c.by} · {timeAgo(c.at)}
        </span>
      </span>
      <span className="text-muted truncate">
        {c.replyTo ? '↳ ' : ''}
        {c.text}
      </span>
    </div>
  );
}

type Chip = 'for-you' | `team:${string}`;

/**
 * Every open comment of the workspace (Home shows the first few): For you first, then newest; chips keep those that
 * mention you or one team's items. The same rows as Home; a click on an item opens it.
 */
export function OpenCommentsDialog({ comments, onClose }: { comments: OwnedComment[]; onClose(): void }) {
  const [on, setOn] = useState<Chip[]>([]);
  const teams = useMemo(() => [...new Set(comments.flatMap((c) => c.owners ?? []))].sort(), [comments]);
  const keep = (c: OwnedComment, chip: Chip) => (chip === 'for-you' ? !!c.forYou : (c.owners ?? []).includes(chip.slice(5)));
  const shown = on.length ? comments.filter((c) => on.some((chip) => keep(c, chip))) : comments;
  const options = [
    { value: 'for-you' as Chip, label: 'For you', count: comments.filter((c) => c.forYou).length },
    ...teams.map((t) => ({ value: `team:${t}` as Chip, label: t, count: comments.filter((c) => keep(c, `team:${t}`)).length })),
  ];
  return (
    <Modal title={`Your team is asking (${plural(comments.length, 'open comment')})`} onClose={onClose} width={720}>
      <div className="grid gap-2" data-open-comments={shown.length}>
        <FilterChips label="Show" value={on} options={options} onChange={setOn} className="pb-1" />
        {shown.length ? (
          // opening an item from the list closes it (the item opens in the window, not behind the dialog)
          <div className="max-h-[60vh] overflow-auto divide-y divide-line/60" onClick={(e) => (e.target as HTMLElement).closest('a, button, [role=link]') && onClose()}>
            {shown.map((c) => (
              <OpenCommentRow key={c.id} c={c} />
            ))}
          </div>
        ) : (
          <EmptyNote>No open comment matches.</EmptyNote>
        )}
      </div>
    </Modal>
  );
}
