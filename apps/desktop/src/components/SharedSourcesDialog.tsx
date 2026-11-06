import { FolderOpen, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { asError, call } from '../api';
import { hasNativeDialogs } from '../lib/files';
import { attempt } from '../store';
import { Button, Callout, Field, IconButton, Input, Modal } from './ui';

/** What the workspace reads from other workspaces' folders (workspace.json `shared`), and the environments it gives. */
export interface SharedSources {
  shared: Array<{ path: string; kinds: string[] }>;
  environments: Array<{ name: string; from: string; problem?: string }>;
}

/**
 * Environments shared from another workspace (a sibling checkout or a git submodule): read here, changed there. The same
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
  const remove = (p: string) =>
    void attempt(async () => {
      setState(await call<SharedSources>('ws.shareRemove', { path: p }));
      onChanged();
    });
  return (
    <Modal title="Environments from another workspace" onClose={onClose} width={560} footer={<Button onClick={onClose}>Close</Button>}>
      <div className="grid gap-3 text-sm" data-shared-sources="">
        <p className="text-muted">
          A team with a repository of its own can use the environments another workspace keeps (a sibling checkout or a git submodule), without copying them. They are listed after this
          workspace&apos;s own with a <b>shared</b> badge, and changed where they live. Secret values stay on each computer.
        </p>
        {state?.shared.length ? (
          <div className="grid gap-1">
            {state.shared.map((s) => {
              const envs = state.environments.filter((e) => s.path.replace(/\/+$/, '').endsWith(e.from));
              return (
                <div key={s.path} className="flex items-center gap-2 rounded-md border border-line px-2 py-1.5" data-shared-source={s.path}>
                  <span className="mono truncate">{s.path}</span>
                  <span className="text-muted text-xs truncate flex-1">{envs.length ? envs.map((e) => e.name).join(', ') : 'no environments yet'}</span>
                  <IconButton size="md" label={`Stop reading from ${s.path}`} onClick={() => remove(s.path)}>
                    <Trash2 />
                  </IconButton>
                </div>
              );
            })}
          </div>
        ) : (
          state && <p className="text-muted">Nothing is shared into this workspace yet.</p>
        )}
        <Field label="Another workspace's folder" hint="Relative to this workspace, e.g. ../platform-shared">
          <div className="flex gap-2">
            <Input className="mono flex-1" value={path} placeholder="../platform-shared" onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && path.trim() && void add(path)} aria-label="Folder to share from" />
            {hasNativeDialogs() && (
              <Button icon={<FolderOpen size={13} />} onClick={() => void add()}>
                Browse…
              </Button>
            )}
            <Button variant="primary" icon={<Plus size={13} />} disabled={!path.trim()} title={path.trim() ? undefined : 'Type the folder first, or Browse…'} onClick={() => void add(path)}>
              Add
            </Button>
          </div>
        </Field>
        {error && <Callout tone="bad">{error}</Callout>}
      </div>
    </Modal>
  );
}
