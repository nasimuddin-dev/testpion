import { FolderPlus } from 'lucide-react';
import { useState } from 'react';
import { call } from '../../api';
import { toastError, useApp } from '../../store';
import { useCollectionTree } from '../../lib/collections-store';
import { plural } from '../../lib/format';
import { Button, Field, Input, Modal, Segmented, Select } from '../ui';

interface Saved {
  collectionId: string;
  collection: string;
  created: boolean;
  requests: Array<{ id: string; name: string; folder?: string }>;
  secrets: string[];
  dropped: unknown[];
}

const NEW = '';

/**
 * WF-12 Save to collection: the selected exchanges (or everything recorded since "Record…" started) as saved requests,
 * next to Create flow. A new collection or an existing one (in a folder), a folder per host or path. Origins become
 * collection variables; secrets become {{variables}} that are listed, never saved (the toast says which to set). The
 * backend (`debug.saveToCollection`, core collectionFromExchanges) is the one `debugger_save_to_collection` and
 * `testpion debug --save-collection` use.
 */
export function SaveToCollectionDialog({ ids, since, onClose }: { ids?: string[]; since?: string; onClose(): void }) {
  const collections = useCollectionTree().filter((c) => !c.problem);
  const [target, setTarget] = useState(NEW);
  const [name, setName] = useState(() => `Captured ${new Date().toISOString().slice(0, 10)}`);
  const [group, setGroup] = useState<'host' | 'path' | 'none'>('host');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await call<Saved>('debug.saveToCollection', {
        ids,
        since,
        collectionId: target || undefined,
        name: name.trim() || undefined,
        group,
        environment: useApp.getState().environment || undefined,
      });
      const where = r.created ? `the new collection "${r.collection}"` : `"${r.collection}"`;
      useApp
        .getState()
        .toast(`Saved ${plural(r.requests.length, 'request')} to ${where}${r.dropped.length ? ` (${r.dropped.length} left out as noise)` : ''}`, 'success', {
          ref: { kind: 'collection', collectionId: r.collectionId },
        });
      // secrets are never saved: say which variables to set, and where
      if (r.secrets.length)
        useApp
          .getState()
          .toast(`Set ${r.secrets.map((s) => `{{${s}}}`).join(', ')} in an environment: secrets are never saved in the collection`, 'warning', {
            ref: { kind: 'environment' },
            label: 'Open environments',
          });
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Save to collection"
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<FolderPlus size={13} />} loading={busy} onClick={() => void save()} data-save-to-collection>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-3 text-sm" data-save-to-collection-dialog>
        <p className="text-muted">
          {ids?.length ? plural(ids.length, 'exchange') : 'The recorded exchanges'} as saved requests. Each address becomes a collection variable; tokens, cookies, API keys and passwords become
          variables to set in an environment (their values are never saved). Values a later request took from a response are kept by the script of the request that returned them.
        </p>
        <Field label="Collection">
          <Select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Collection to save to">
            <option value={NEW}>New collection</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={target ? 'Folder' : 'Name'} hint={target ? 'The requests go in this folder (empty: at the top of the collection).' : undefined}>
          <Input value={name} onChange={(e) => setName(e.target.value)} aria-label={target ? 'Folder name' : 'Collection name'} />
        </Field>
        <Field label="Folders">
          <Segmented
            label="Group requests"
            value={group}
            onChange={setGroup}
            options={[
              { value: 'host', label: 'By host' },
              { value: 'path', label: 'By path' },
              { value: 'none', label: 'None' },
            ]}
          />
        </Field>
      </div>
    </Modal>
  );
}
