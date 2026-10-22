import { Download } from 'lucide-react';
import { useState } from 'react';
import { call } from '../api';
import { toastError, useApp } from '../store';
import { Button, Field, Modal, Select } from './ui';
import { deliverSave, type SaveResult } from '../lib/files';
import { exportWorkspace } from '../lib/workspace-export';

type Format = 'testpion' | 'postman' | 'openapi' | 'bruno' | 'http' | 'asyncapi' | 'postman-package' | 'bruno-package';

const FORMATS: Array<[Format, string, string]> = [
  ['testpion', 'TestPion collection (.json)', 'Everything: requests, scripts, examples, and its gRPC calls and connections. Imports back as it was.'],
  ['postman', 'Postman v2.1 collection (.json)', 'For Postman and tools that read its format. gRPC calls and connections are left out.'],
  ['openapi', 'OpenAPI 3.1 (.yaml)', "A description of the collection's HTTP requests, for documentation and code generators."],
  ['http', '.http file', 'One file of requests for VS Code REST Client and the JetBrains HTTP Client. HTTP requests only; scripts are left out.'],
  ['asyncapi', 'AsyncAPI 3.0 (.yaml)', "The collection's Kafka, MQTT, WebSocket and Socket.IO connections as channels, with their saved messages as examples."],
  ['bruno', 'Bruno collection folder', 'A folder of .bru files, with the environments (secret values never). Desktop app only.'],
  ['postman-package', 'Postman package with what it uses (.zip)', 'The Postman collection, the environments it uses, the workspace variables as Postman globals, API definitions, data files and an .mcp.json. Secret values never. Test files, monitors and saved calls are listed as not included.'],
  ['bruno-package', 'Bruno collection with what it uses (.zip)', 'The Bruno folder (extract it), with the API definitions, data files and an .mcp.json beside it. Secret values never.'],
];

/**
 * Export from the Collections sidebar: one collection in a chosen format, or the whole workspace (every
 * collection, environment, test, saved item and the files of specs/, datasets/, mocks/ and protos/; secret values
 * never). Saved where you choose in the desktop app; downloaded in a browser.
 */
export function ExportDialogBody({ collections, initial, onClose }: { collections: Array<{ id: string; name: string }>; initial?: string; onClose(): void }) {
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
        if (await exportWorkspace(workspace.path)) onClose();
        return;
      }
      const r = await call<SaveResult & { name: string; notes: string[] }>('col.export', { id: what, format });
      if (!deliverSave(r)) return; // the save dialog was cancelled
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
      onSubmit={() => void run()}
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
          <p className="text-sm text-muted">
            One bundle file (<code>{workspace ? `${workspace.name}.testpion.zip` : '.testpion.zip'}</code>, or <code>.testpion.json</code> when it is small and all text) that Open workspace ▸ Import brings back: every collection, environment, test file, saved item, MCP server and setting, and the files in specs/, datasets/, mocks/ and protos/. Secret values are never exported: typed-in tokens, passwords and keys become {'{{variables}}'}, and the message after export lists each one. Datasets over 10 MB travel by reference; run results, history and Recently deleted are left out, and the message names any file it left out.
          </p>
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
