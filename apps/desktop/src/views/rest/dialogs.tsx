/** Save-to-collection and Import dialogs of the REST view. */
import { FolderOpen, Link2, Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
import { call } from '../../api';
import { toastError, useApp } from '../../store';
import type { Collection, CollectionNode } from '../../types';
import { uid } from '../../lib/format';

import { pickTextFile, pickFolderFiles } from '../../lib/files';
import { convertedScriptsText, toastUnchangedScripts, type ImportScriptsSummary } from '../../lib/import-scripts';
import { Button, Field, Input, Modal, Select, Textarea } from '../../components/ui';

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
      width={460}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!canSave} loading={busy} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} />
        </Field>
        <Field label={creating ? 'New collection' : 'Collection'} hint={creating && !collections.length ? 'You have no collections yet — this one will be created.' : undefined}>
          <div className="flex gap-2">
            {creating ? (
              <Input className="flex-1" value={newCollection} placeholder="Collection name" onChange={(e) => setNewCollection(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} />
            ) : (
              <Select className="flex-1" value={cid} onChange={(e) => (setCid(e.target.value), setFolder(''))}>
                {collections.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
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
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
    </Modal>
  );
}

export function ImportModal({ onClose, onDone }: { onClose(): void; onDone(): void }) {
  const [text, setText] = useState('');
  const [link, setLink] = useState('');
  const linkOk = /^https?:\/\/\S+$/i.test(link.trim());
  const [busy, setBusy] = useState(false);
  // Postman / Insomnia scripts come over as tp.* unless this is ticked (pm.* runs either way)
  const [keepPm, setKeepPm] = useState(false);
  const run = async (
    fn: () => Promise<{
      format: string;
      collection?: string;
      environment?: string;
      request?: string;
      placeholders?: Array<{ variable: string }>;
      specPath?: string;
      contractChecks?: number;
      savedItems?: Record<string, number>;
      notes?: string[];
      scriptWarnings?: Array<{ where: string; script: string; api: string; hint: string }>;
      scripts?: ImportScriptsSummary;
    } | null>,
  ) => {
    setBusy(true);
    try {
      const r = await fn();
      if (r) {
        if (r.request)
          useApp.getState().toast(
            `Imported ${r.format} request "${r.request}" into "${r.collection}"${r.placeholders?.length ? `. Secrets were replaced by variables: set ${r.placeholders.map((p) => p.variable).join(', ')} as secret environment variables` : ''}`,
            'success',
          );
        else
          useApp.getState().toast(
            `Imported ${r.format}${r.collection ? `: ${r.collection}` : ''}${r.environment ? ` (${r.environment.includes(', ') ? 'environments' : 'environment'} ${r.environment})` : ''}${r.contractChecks ? `. Each request checks the OpenAPI contract (${r.specPath})` : ''}${r.savedItems ? `, with ${[r.savedItems.grpc ? `${r.savedItems.grpc} gRPC call${r.savedItems.grpc > 1 ? 's' : ''}` : '', r.savedItems.websocket ? `${r.savedItems.websocket} connection${r.savedItems.websocket > 1 ? 's' : ''}` : ''].filter(Boolean).join(' and ')}` : ''}${convertedScriptsText(r.scripts) ? `. ${convertedScriptsText(r.scripts)}` : ''}`,
            'success',
          );
        toastUnchangedScripts(r.scripts);
        if (r.notes?.length) useApp.getState().toast(`Not imported: ${r.notes.slice(0, 3).join('; ')}${r.notes.length > 3 ? ` (+${r.notes.length - 3} more)` : ''}`, 'warning');
        const w = r.scriptWarnings ?? [];
        if (w.length) {
          const apis = [...new Set(w.map((x) => x.api))].join(', ');
          const where = [...new Set(w.map((x) => x.where))];
          useApp.getState().toast(`${where.length} request${where.length > 1 ? 's' : ''} use${where.length > 1 ? '' : 's'} script APIs TestPion doesn't have (${apis}): ${where.slice(0, 3).join('; ')}${where.length > 3 ? ' …' : ''}. Tip: ${w[0]!.hint}.`, 'warning');
        }
        onDone();
        await useApp.getState().refreshWorkspace();
        onClose();
      }
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Import"
      onClose={onClose}
      width={640}
      footer={
        <>
          <Button
            icon={<Upload size={13} />}
            onClick={() =>
              run(async () => {
                // the browser picker works in the desktop app and in the browser / cloud alike
                const f = await pickTextFile('.json,.yaml,.yml,.har,.env,.wsdl,.xml,.bru,.txt,.sh,.ps1');
                return f ? call('col.import', { text: f.text, fileName: f.name, keepPm }) : null;
              })
            }
          >
            Choose file…
          </Button>
          <Button
            icon={<FolderOpen size={13} />}
            title="Import a Bruno collection folder (bruno.json and .bru files, as kept in git)"
            onClick={() =>
              run(async () => {
                const f = await pickFolderFiles((p) => p.endsWith('.bru') || p === 'bruno.json');
                return f ? call('col.importBrunoFolder', { name: f.name, files: f.files }) : null;
              })
            }
          >
            Bruno folder…
          </Button>
          <Button variant="primary" loading={busy} disabled={!text.trim()} onClick={() => run(() => call('col.import', { text, keepPm }))}>
            Import pasted content
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted mb-2">OpenAPI 3 / Swagger 2 (JSON or YAML), Postman v2.1 collections and environments, Insomnia exports (v4 JSON, v5 YAML), Bruno collection folders (<b>Bruno folder…</b>), exports and .bru files, Hoppscotch collections, WSDL 1.1 and 2.0 (SOAP services), AsyncAPI 2 and 3 (Kafka, MQTT and WebSocket channels as connections), HAR files, .env files, TestPion collections (as a file, pasted, or a link), or a request copied as cURL, fetch, PowerShell or HTTPie (saved to the <b>Imported</b> collection, with secrets replaced by variables).</p>
      <form
        className="flex gap-2 mb-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (linkOk && !busy) void run(() => call('col.importUrl', { url: link.trim(), keepPm }));
        }}
      >
        <Input className="flex-1" aria-label="Link to import" placeholder="Or a link: https://…/openapi.json, a GitHub file, a Postman API link" value={link} onChange={(e) => setLink(e.target.value)} />
        <Button type="submit" icon={<Link2 size={13} />} disabled={!linkOk} loading={busy && linkOk}>
          Import link
        </Button>
      </form>
      <Textarea autoGrow={false} className="field mono w-full h-64 text-xs" placeholder="Paste a document here…" value={text} onChange={(e) => setText(e.target.value)} />
      <label className="flex items-center gap-2 mt-2 text-sm" title="Postman and Insomnia scripts are converted to TestPion's tp.* (pm.* still runs). Exporting to Postman turns tp.* back into pm.*.">
        <input type="checkbox" checked={keepPm} onChange={(e) => setKeepPm(e.target.checked)} /> Keep pm.* in scripts (for collections you also use in Postman)
      </label>
    </Modal>
  );
}
