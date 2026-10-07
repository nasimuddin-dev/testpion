import { FileDiff, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { call } from '../api';
import { plural } from '../lib/format';
import { Badge, cx, Empty, IconButton, Spinner } from './ui';

interface CommitDetail {
  hash: string;
  short: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  body: string;
  files: Array<{ path: string; state: 'added' | 'deleted' | 'modified' | 'renamed' | 'untracked' | 'conflicted'; additions: number; deletions: number }>;
}

/** A unified diff, line by line: additions and removals in their colours, hunk heads muted. */
export function DiffText({ text }: { text: string }) {
  if (!text.trim()) return <div className="p-3 text-sm text-muted">No text difference (a binary file, or a rename).</div>;
  return (
    <pre className="p-3 text-xs mono whitespace-pre overflow-auto leading-relaxed" aria-label="Diff">
      {text.split('\n').map((line, i) => (
        <div
          key={i}
          className={cx(
            line.startsWith('+') && !line.startsWith('+++') && 'text-ok bg-ok/10',
            line.startsWith('-') && !line.startsWith('---') && 'text-bad bg-bad/10',
            line.startsWith('@@') && 'text-muted',
            /^(diff|index|---|\+\+\+) /.test(line) && 'text-muted',
          )}
        >
          {line || ' '}
        </div>
      ))}
    </pre>
  );
}

const TONE = { added: 'ok', deleted: 'bad', renamed: 'accent', modified: 'default', untracked: 'default', conflicted: 'warn' } as const;

/** A picked commit: its message, the files it changed in the workspace with their lines added and removed, and a file's diff. */
export function GitCommitPanel({ hash, onClose }: { hash: string; onClose(): void }) {
  const [detail, setDetail] = useState<CommitDetail | null>();
  const [file, setFile] = useState<string>();
  const [diff, setDiff] = useState<string>();
  useEffect(() => {
    setDetail(undefined);
    setFile(undefined);
    setDiff(undefined);
    void call<CommitDetail | undefined>('git.commitDetail', { hash }).then((d) => {
      setDetail(d ?? null);
      if (d?.files[0]) setFile(d.files[0].path);
    });
  }, [hash]);
  useEffect(() => {
    if (!file) return;
    setDiff(undefined);
    void call<string>('git.commitDiff', { hash, path: file }).then(setDiff, () => setDiff(''));
  }, [hash, file]);
  if (detail === undefined) return <Empty icon={<Spinner size={20} />} title="Reading the commit…" />;
  if (!detail) return <Empty title="Commit not found">It may be on another branch, or the repository changed.</Empty>;
  const added = detail.files.reduce((n, f) => n + f.additions, 0);
  const removed = detail.files.reduce((n, f) => n + f.deletions, 0);
  return (
    <div className="h-full flex flex-col min-h-0" data-commit-detail={detail.short}>
      <div className="px-4 py-3 border-b border-line">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="font-medium break-words">{detail.subject}</div>
            <div className="text-xs text-muted mt-0.5 flex flex-wrap gap-x-3">
              <span className="font-mono">{detail.short}</span>
              <span>{detail.author}</span>
              <span>{new Date(detail.date).toLocaleString()}</span>
              <span>
                {plural(detail.files.length, 'file')} · <span className="text-ok">+{added}</span> <span className="text-bad">−{removed}</span>
              </span>
            </div>
          </div>
          <IconButton label="Close the commit" onClick={onClose}>
            <X size={14} />
          </IconButton>
        </div>
        {detail.body && <pre className="mt-2 text-xs text-muted whitespace-pre-wrap font-sans">{detail.body}</pre>}
      </div>
      <ul className="border-b border-line max-h-[40%] overflow-auto text-sm" aria-label="Files changed">
        {detail.files.map((f) => (
          <li key={f.path}>
            <button
              className={cx('w-full flex items-center gap-2 px-4 py-1 text-left hover:bg-hover', file === f.path && 'bg-accent/10')}
              onClick={() => setFile(f.path)}
              aria-current={file === f.path || undefined}
            >
              <FileDiff size={13} className="text-muted shrink-0" />
              <span className="truncate mono text-xs flex-1 min-w-0">{f.path}</span>
              <Badge tone={TONE[f.state] ?? 'default'}>{f.state}</Badge>
              <span className="text-xs tabular-nums whitespace-nowrap">
                <span className="text-ok">+{f.additions}</span> <span className="text-bad">−{f.deletions}</span>
              </span>
            </button>
          </li>
        ))}
        {!detail.files.length && <li className="px-4 py-2 text-muted text-sm">This commit changed nothing in this workspace's folder.</li>}
      </ul>
      <div className="flex-1 min-h-0 overflow-auto">{file && (diff === undefined ? <Empty icon={<Spinner size={18} />} title="Reading the diff…" /> : <DiffText text={diff} />)}</div>
    </div>
  );
}
