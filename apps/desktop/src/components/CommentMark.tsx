import { MessageSquare } from 'lucide-react';
import type { ItemRef } from '@testpion/shared';
import { useOpenCommentCount } from '../lib/comments-live';
import { plural } from '../lib/format';

/** The mark of a row whose item has open comments from the team (the Info panel shows them): the count beside a speech bubble. */
export function CommentMark({ to }: { to: ItemRef }) {
  const n = useOpenCommentCount(to);
  if (!n) return null;
  return (
    <span className="inline-flex items-center gap-0.5 text-2xs text-muted" title={`${plural(n, 'open comment')} from your team (Info panel)`} data-comment-mark={n}>
      <MessageSquare size={11} />
      {n}
    </span>
  );
}
