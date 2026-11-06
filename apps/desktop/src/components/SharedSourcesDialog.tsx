import { FolderOpen, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { asError, call, on } from '../api';
import { hasNativeDialogs } from '../lib/files';
import { LABEL } from '../lib/vocabulary';
import { attempt, useApp } from '../store';
import { ApprovalNotice, Button, Callout, EmptyNote, Field, IconButton, Input, Modal } from './ui';

/** What the workspace reads from other workspaces' folders (workspace.json `shared`), and the environments and API definitions they give. */
export interface SharedSources {
  shared: Array<{ path: string; kinds: string[] }>;
  environments: Array<{ name: string; from: string; problem?: string }>;
  /** As every command takes them: ../platform-shared/specs/clinic.yaml */
  specs: string[];
  /** Entries that came with a pull: not read on this computer until allowed. */
  waiting?: Array<{ path: string; kinds: string[] }>;
}

/** What waits says: the folders and what they would give. */
const waitingText = (w: Array<{ path: string; kinds: string[] }>) =>
  `workspace.json reads ${w.map((s) => `${s.kinds.join(' and ')} from ${s.path}`).join('; ')}: it came with a pull or a clone (or was changed outside this app), so nothing of ${w.length === 1 ? 'that folder' : 'those folders'} is read on this computer until you allow it. Check that it is the folder you expect first.`;

/**
 * The notice of `shared` entries that wait for "Allow on this computer", where shared items are listed (Environments,
 * API definitions): nothing when none waits. Reads again when the workspace changes.
 */
export function SharedWaitingNotice({ onAllowed }: { onAllowed?(): void }) {
  const [waiting, setWaiting] = useState<SharedSources['waiting']>([]);
  useEffect(() => {
    const load = () => void call<NonNullable<SharedSources['waiting']>>('ws.shareWaiting').then(setWaiting, () => undefined);
    load();
    const offs = [on('data.changed', load), on('workspace.changedOnDisk', load)];
    return () => offs.forEach((off) => off());
  }, []);
  if (!waiting?.length) return null;
  return (
    <ApprovalNotice
      data-shared-waiting={waiting.length}
      onAllow={() =>
        attempt(async () => {
          setWaiting((await call<SharedSources>('ws.shareAllow')).waiting ?? []);
          onAllowed?.();
        })
      }
    >
      {waitingText(waiting)}
    </ApprovalNotice>
  );
}

/**
 * Environments and API definitions shared from another workspace (a sibling checkout or a git submodule): read here, changed there. The same
 * as `testpion workspace share`; the folder is kept relative to the workspace, so it is the same on every computer.
 */
export function SharedSourcesDialog({ onClose, onChanged }: { onClose(): void; onChanged(): void }) {
  const [state, setState] = useState<SharedSources>();
  const [path, setPath] = useState('');
  const [error, setError] = useState<string>();
  useEffect(() => {
    void call<SharedSources>('ws.shared').then(setState, (e) => setError(asError(e).message));
  }, []);
  const add = async (p?: string) => {
    setError(undefined);
    try {
      const next = await call<SharedSources | undefined>('ws.shareAdd', p !== undefined ? { path: p } : {});
      if (!next) return; // the folder picker was closed
      setState(next);
      setPath('');
      onChanged();
    } catch (e) {
      setError(asError(e).message);
    }
  };
  // at once, with Undo (the entry comes back as it was, with its kinds)
  const remove = (s: { path: string; kinds: string[] }) =>
    void attempt(async () => {
      // one that waited for Allow comes back waiting: Undo never allows it
      const waited = !!state?.waiting?.some((w) => w.path === s.path);
      setState(await call<SharedSources>('ws.shareRemove', { path: s.path }));
      onChanged();
      useApp.getState().toast(`Stopped reading from ${s.path}`, 'info', {
        label: 'Undo',
        onClick: () =>
          void attempt(async () => {
            const back = await call<SharedSources | undefined>('ws.shareAdd', { path: s.path, kinds: s.kinds, ...(waited ? { waiting: true } : {}) });
            if (back) setState(back);
            onChanged();
          }),
      });
    });
  return (
    <Modal title={LABEL.sharedFromWorkspace.replace(/…$/, '')} onClose={onClose} width={560} footer={<Button onClick={onClose}>Close</Button>}>
      <div className="grid gap-3 text-sm" data-shared-sources="">
        <p className="text-muted">
          A team with a repository of its own can use the environments and API definitions another workspace keeps (a sibling checkout or a git submodule), without copying them.
          They are listed after this workspace&apos;s own, marked <b>shared</b>, and changed where they live. Secret values stay on each computer.
        </p>
        {state?.shared.length ? (
          <div className="grid gap-1">
            {state.shared.map((s) => {
              const base = s.path.replace(/\/+$/, '');
              const envs = state.environments.filter((e) => base.endsWith(e.from));
              const specs = (state.specs ?? []).filter((p) => p.startsWith(`${base}/specs/`)).map((p) => p.replace(/^.*\//, ''));
              const gives = [...envs.map((e) => e.name), ...specs];
              return (
                <div key={s.path} className="flex items-center gap-2 rounded-md border border-line px-2 py-1.5" data-shared-source={s.path}>
                  <span className="mono truncate">{s.path}</span>
                  <span className="text-muted text-xs truncate flex-1" title={gives.join(', ')}>
                    {gives.length ? gives.join(', ') : 'nothing yet'}
                  </span>
                  <IconButton label={`Stop reading from ${s.path}`} onClick={() => remove(s)}>
                    <Trash2 />
                  </IconButton>
                </div>
              );
            })}
          </div>
        ) : (
          state && <EmptyNote>Nothing is shared into this workspace yet.</EmptyNote>
        )}
        <Field label="Another workspace's folder" hint="Relative to this workspace, e.g. ../platform-shared">
          <div className="flex gap-2">
            <Input className="mono flex-1" value={path} placeholder="../platform-shared" onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && path.trim() && void add(path)} aria-label="Folder to share from" />
            {hasNativeDialogs() && (
              <Button icon={<FolderOpen size={13} />} onClick={() => void add()}>
                Browse…
              </Button>
            )}
            <Button variant="primary" icon={<Plus size={13} />} disabled={!path.trim()} reason="Type the folder first, or Browse…" onClick={() => void add(path)}>
              Add
            </Button>
          </div>
        </Field>
        {!!state?.waiting?.length && (
          <ApprovalNotice
            data-shared-waiting={state.waiting.length}
            onAllow={() =>
              attempt(async () => {
                setState(await call<SharedSources>('ws.shareAllow'));
                onChanged();
              })
            }
          >
            {waitingText(state.waiting)}
          </ApprovalNotice>
        )}
        {error && <Callout tone="bad">{error}</Callout>}
      </div>
    </Modal>
  );
}
