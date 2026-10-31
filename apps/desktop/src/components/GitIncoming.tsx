import type { IncomingChanges } from '@testpion/core';
import { ArrowDown } from 'lucide-react';
import { useRpc } from '../lib/use-rpc';
import { plural } from '../lib/format';

/**
 * "Waiting on origin/main": what a pull would bring in, by meaning, before it is pulled (the commits and the items they change in words).
 * It reads what the last fetch left, so it costs nothing and writes nothing. Shown when the remote has commits this branch has not.
 */
export function GitIncoming({ behind }: { behind: number }) {
  const inc = useRpc<IncomingChanges | undefined>('git.incoming', {}, { enabled: behind > 0, reloadOn: ['git.changed'], keep: true });
  if (!behind || !inc || !inc.commits.length) return null;
  return (
    <details className="rounded-md border border-line text-sm" data-git-incoming>
      <summary className="px-3 py-1.5 cursor-pointer select-none flex items-center gap-2">
        <ArrowDown size={13} className="text-muted" />
        <span className="font-medium">Waiting on {inc.upstream}</span>
        <span className="text-xs text-muted truncate">{inc.text}</span>
      </summary>
      <div className="px-3 pb-2 grid gap-2">
        {inc.changes.length > 0 && (
          <ul className="grid gap-0.5" data-git-incoming-changes>
            {inc.changes.map((c, i) => (
              <li key={i} className="text-xs flex gap-2">
                <span className={c.change === 'added' ? 'text-ok' : c.change === 'removed' ? 'text-bad' : 'text-warn'}>{c.change === 'added' ? '+' : c.change === 'removed' ? '−' : '~'}</span>
                <span>
                  {c.title}
                  {c.details.length > 0 && <span className="text-muted">: {c.details.join(', ')}</span>}
                </span>
              </li>
            ))}
            {inc.more > 0 && <li className="text-xs text-muted">and {plural(inc.more, 'more item')}</li>}
          </ul>
        )}
        <ul className="grid gap-0.5 text-xs text-muted" data-git-incoming-commits>
          {inc.commits.map((c) => (
            <li key={c.hash}>
              <span className="mono">{c.short}</span> {c.author}: {c.subject}
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
