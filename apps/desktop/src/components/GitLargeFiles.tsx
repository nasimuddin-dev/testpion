import { Database, FileArchive } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { LargeFile, LargeResult } from '@testpion/core';
import { call, on } from '../api';
import { confirmAction, promptText, toastError } from '../store';
import { plural } from '../lib/format';
import { toastWithUndo } from '../lib/git-items';
import { Button, Callout } from './ui';

const mb = (n: number) => `${(n / 1048576).toFixed(n >= 10485760 ? 0 : 1)} MB`;

/**
 * Big files (release C of planning/git-everything.md §4f). A dataset over 50 MB makes every clone slower and GitHub rejects
 * 100 MB, so the Git view offers the two ways out: Git LFS (a pointer in the repository, the data on the LFS server) or by
 * reference (a small `.ref` file with the checksum is committed and the data is git-ignored). Each shows what it will write
 * first, and has Undo. Smaller files over 5 MB are only named. Nothing is shown when no file is over the limit.
 */
export function GitLargeFiles({ afterChange }: { afterChange(): void }) {
  const [files, setFiles] = useState<LargeFile[]>([]);
  const [busy, setBusy] = useState<string>();
  const load = useCallback(() => void call<LargeFile[]>('git.large').then(setFiles, () => setFiles([])), []);
  useEffect(() => {
    load();
    // a file that grew or arrived (a run wrote data, another editor, a pull): read again once things settled
    let settle: ReturnType<typeof setTimeout> | undefined;
    const later = () => {
      clearTimeout(settle);
      settle = setTimeout(load, 1500);
    };
    const offs = [on('git.changed', load), on('data.changed', later), on('workspace.changedOnDisk', later)];
    return () => (clearTimeout(settle), offs.forEach((o) => o()));
  }, [load]);
  const offer = files.filter((f) => f.level !== 'warn');
  const warn = files.filter((f) => f.level === 'warn');
  if (!offer.length && !warn.length) return null;

  const track = async (f: LargeFile, mode: 'lfs' | 'reference') => {
    setBusy(f.file + mode);
    try {
      const source =
        mode === 'reference'
          ? await promptText('Where is the data kept?', {
              message: `Teammates who pull get ${f.file}.ref and fetch the data from here. A URL, a bucket, a share: optional.`,
              placeholder: 's3://team-data/…',
              okLabel: 'Continue',
            })
          : '';
      if (source === null || source === undefined) return;
      const plan = await call<LargeResult>('git.largeTrack', { file: f.file, mode, source: source.trim() || undefined, dryRun: true });
      const ok = await confirmAction({
        title: mode === 'lfs' ? `Track ${f.file} with Git LFS` : `Track ${f.file} by reference`,
        message: `${f.file} (${mb(plan.bytes)})`,
        detail: [...plan.notes, `Writes: ${plan.writes.join(', ')}${plan.untrack ? '; leaves git (stays on disk)' : ''}`].join('\n\n'),
        confirmLabel: mode === 'lfs' ? 'Track with LFS' : 'Track by reference',
      });
      if (!ok) return;
      const r = await call<LargeResult>('git.largeTrack', { file: f.file, mode, source: source.trim() || undefined });
      toastWithUndo(`${f.file} is tracked ${mode === 'lfs' ? 'with Git LFS' : 'by reference'}`, r.undoId);
      load();
      afterChange();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <section className="grid gap-2" data-git-large="">
      {offer.length > 0 && (
        <Callout tone={offer.some((f) => f.level === 'refuse') ? 'bad' : 'warn'} block role="status" data-large-offer="">
          <div className="font-medium flex items-center gap-2">
            <Database size={15} /> {plural(offer.length, 'big file')} {offer.length === 1 ? 'is' : 'are'} over the limit for plain git
          </div>
          <div className="text-xs text-muted">Every clone downloads them, and GitHub rejects a file over 100 MB. Keep them out of the repository: with Git LFS, or by reference.</div>
          <ul className="rounded-md border border-line bg-panel" aria-label="Big files">
            {offer.map((f) => (
              <li key={f.file} className="flex items-center gap-2 px-2 py-1 text-xs border-b border-line last:border-b-0" data-large-file={f.file}>
                <FileArchive size={13} className="text-muted shrink-0" />
                <span className="font-mono truncate">{f.file}</span>
                <span className="text-muted shrink-0">{mb(f.bytes)}</span>
                {f.level === 'refuse' && <span className="text-bad shrink-0">a commit is refused</span>}
                <span className="ml-auto flex gap-1 shrink-0">
                  <Button
                    size="sm"
                    loading={busy === f.file + 'lfs'}
                    onClick={() => void track(f, 'lfs')}
                    title="A pointer is committed; the data goes to the LFS server (git-lfs must be installed)"
                    data-large-lfs=""
                  >
                    Git LFS…
                  </Button>
                  <Button
                    size="sm"
                    loading={busy === f.file + 'reference'}
                    onClick={() => void track(f, 'reference')}
                    title="A small .ref file with the checksum is committed; the data file is git-ignored"
                    data-large-reference=""
                  >
                    By reference…
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </Callout>
      )}
      {warn.length > 0 && (
        <div className="text-xs text-muted px-1" data-large-warn="">
          {plural(warn.length, 'file')} over 5 MB:{' '}
          {warn
            .slice(0, 3)
            .map((f) => `${f.file} (${mb(f.bytes)})`)
            .join(', ')}
          {warn.length > 3 ? ' …' : ''}
        </div>
      )}
    </section>
  );
}
