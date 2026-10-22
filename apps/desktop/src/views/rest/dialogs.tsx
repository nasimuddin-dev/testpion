/** Save-to-collection and Import dialogs of the REST view. */
import { useMemo, useState } from 'react';
import type { Collection, CollectionNode } from '../../types';
import { uid } from '../../lib/format';
import { Button, Field, Input, Modal, Select, NamedOptions } from '../../components/ui';

/**
 * The one "save into a collection" dialog: name, collection (or a new one) and folder. Every saved request
 * belongs to a collection. A request's folders are the collection's folders (the folder's id is passed back);
 * gRPC calls and connections pass `folderNames`, their folders in that collection (the name is passed back).
 */
export function SaveModal({
  collections,
  defaultName,
  title = 'Save request',
  defaultCollectionId,
  defaultFolder,
  folderNames,
  onClose,
  onSave,
  onCreate,
}: {
  collections: Collection[];
  defaultName: string;
  title?: string;
  defaultCollectionId?: string;
  defaultFolder?: string;
  folderNames?(collectionId: string): string[];
  onClose(): void;
  onSave(collectionId: string, name: string, folder?: string): void;
  onCreate(c: Collection): Promise<void>;
}) {
  const [name, setName] = useState(defaultName);
  const [cid, setCid] = useState((defaultCollectionId && collections.some((x) => x.id === defaultCollectionId) ? defaultCollectionId : collections[0]?.id) ?? '');
  const [folder, setFolder] = useState(defaultFolder ?? '');
  // a name here means "create this collection and save into it" (the default when there are none yet)
  const [newCollection, setNewCollection] = useState<string | null>(collections.length ? null : 'My collection');
  const [busy, setBusy] = useState(false);
  const creating = newCollection !== null;
  const canSave = !!name.trim() && (creating ? !!newCollection.trim() : !!cid);
  const submit = async () => {
    if (!canSave || busy) return;
    if (!creating) return onSave(cid, name.trim(), folder || undefined);
    setBusy(true);
    try {
      const id = uid('col-');
      await onCreate({ schemaVersion: '1.0', id, name: newCollection.trim(), version: 0, variables: [], items: [], updatedAt: '' });
      onSave(id, name.trim());
    } finally {
      setBusy(false);
    }
  };
  const c = collections.find((x) => x.id === cid);
  const folders = useMemo(() => {
    if (folderNames) return c ? folderNames(c.id).map((f) => ({ id: f, name: f })) : [];
    const out: Array<{ id: string; name: string }> = [];
    const walk = (nodes: CollectionNode[], prefix: string) => {
      for (const n of nodes) if (n.kind === 'folder') (out.push({ id: n.id, name: prefix + n.name }), walk(n.items, `${prefix}${n.name} / `));
    };
    if (c) walk(c.items, '');
    return out;
  }, [c, folderNames]);
  return (
    <Modal
      title={title}
      onClose={onClose}
      onSubmit={submit}
      width={460}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!canSave} reason={!name.trim() ? 'Give it a name first' : creating ? 'Name the new collection first' : 'Choose a collection first'} loading={busy} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={creating ? 'New collection' : 'Collection'} hint={creating && !collections.length ? 'You have no collections yet — this one will be created.' : undefined}>
          <div className="flex gap-2">
            {creating ? (
              <Input className="flex-1" value={newCollection} placeholder="Collection name" onChange={(e) => setNewCollection(e.target.value)} />
            ) : (
              <Select className="flex-1" value={cid} onChange={(e) => (setCid(e.target.value), setFolder(''))}>
                <NamedOptions items={collections} />
              </Select>
            )}
            {creating ? (
              collections.length > 0 && <Button onClick={() => setNewCollection(null)}>Choose existing</Button>
            ) : (
              <Button onClick={() => setNewCollection('')}>New</Button>
            )}
          </div>
        </Field>
        {!creating && folders.length > 0 && (
          <Field label="Folder">
            <Select value={folder} onChange={(e) => setFolder(e.target.value)}>
              <option value="">(collection root)</option>
              <NamedOptions items={folders} />
            </Select>
          </Field>
        )}
      </div>
    </Modal>
  );
}

/** The one Import dialog (components/ImportDialog.tsx): source, preview with the compatibility report, result with Undo. */
export { ImportDialog as ImportModal } from '../../components/ImportDialog';
