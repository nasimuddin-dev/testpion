import { Download } from 'lucide-react';
import { useState } from 'react';
import { call } from '../api';
import { toastError, useApp } from '../store';
import { Button, Field, Modal, Select } from './ui';
import { downloadContent } from '../lib/files';

type Format = 'testpion' | 'postman' | 'openapi' | 'bruno' | 'http' | 'asyncapi';

const FORMATS: Array<[Format, string, string]> = [
  ['testpion', 'TestPion collection (.json)', 'Everything: requests, scripts, examples, and its gRPC calls and connections. Imports back as it was.'],
  ['postman', 'Postman v2.1 collection (.json)', 'For Postman and tools that read its format. gRPC calls and connections are left out.'],
  ['openapi', 'OpenAPI 3.1 (.yaml)', "A description of the collection's HTTP requests, for documentation and code generators."],
  ['http', '.http file', 'One file of requests for VS Code REST Client and the JetBrains HTTP Client. HTTP requests only; scripts are left out.'],
  ['asyncapi', 'AsyncAPI 3.0 (.yaml)', "The collection's Kafka, MQTT, WebSocket and Socket.IO connections as channels, with their saved messages as examples."],
  ['bruno', 'Bruno collection folder', 'A folder of .bru files, with the environments (secret values never). Desktop app only.'],
];

/**
 * Export from the Collections sidebar: one collection in a chosen format, or the whole workspace (every
 * collection, environment, test and saved item, secret values never). Saved where you choose in the desktop
 * app; downloaded in a browser.
 */
export function ExportDialog({ collections, initial, onClose }: { collections: Array<{ id: string; name: string }>; initial?: string; onClose(): void }) {
  const workspace = useApp((s) => s.workspace);
  const [what, setWhat] = useState(initial ?? collections[0]?.id ?? 'workspace');
  const [format, setFormat] = useState<Format>('testpion');
  const [busy, setBusy] = useState(false);
  const toast = useApp.getState().toast;
  const run = async () => {
    setBusy(true);
    try {
      if (what === 'workspace') {
        if (!workspace) return;
        const r = await call<{ path?: string; bundle?: unknown }>('ws.export', { ref: workspace.path });
        if (r.bundle) downloadContent(`${workspace.name}.apsworkspace.json`, JSON.stringify(r.bundle, null, 2), { type: 'application/json' });
        if (r.bundle || r.path) toast(`Workspace exported${r.path ? ` to ${r.path}` : ''} (secret values are never exported)`, 'success');
        if (r.bundle || r.path) onClose();
        return;
      }
      const r = await call<{ path?: string; collection?: unknown; text?: string; name: string; notes: string[] }>('col.export', { id: what, format });
      if (r.collection) downloadContent(r.name, JSON.stringify(r.collection, null, 2), { type: 'application/json' });
      else if (r.text !== undefined) downloadContent(r.name, r.text, { type: format === 'openapi' || format === 'asyncapi' ? 'application/yaml' : 'text/plain' });
      else if (!r.path) return; // the save dialog was cancelled
      const extra = r.notes.length ? ` Not exported: ${r.notes.join('; ')}.` : '';
      toast(`${r.path ? `Exported to ${r.path}.` : 'Exported.'}${extra}`, r.notes.length ? 'info' : 'success');
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const hint = FORMATS.find(([f]) => f === format)?.[2];
  return (
    <Modal
      title="Export"
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Download size={13} />} loading={busy} onClick={() => void run()}>
            Export
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="What">
          <Select value={what} onChange={(e) => setWhat(e.target.value)} aria-label="What to export">
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                Collection: {c.name}
              </option>
            ))}
            <option value="workspace">The whole workspace{workspace ? ` (${workspace.name})` : ''}</option>
          </Select>
        </Field>
        {what === 'workspace' ? (
          <p className="text-sm text-muted">Every collection, environment, test file, saved item and setting of the workspace in one file, which Open workspace ▸ Import brings back. Secret values are never exported.</p>
        ) : (
          <Field label="Format" hint={hint}>
            <Select value={format} onChange={(e) => setFormat(e.target.value as Format)} aria-label="Format">
              {FORMATS.map(([f, label]) => (
                <option key={f} value={f}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
    </Modal>
  );
}
