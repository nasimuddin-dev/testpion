import { useState } from 'react';
import type { CollectionFolder } from '../types';
import { AuthEditor } from './AuthEditor';
import { KeyValueEditor } from './KeyValueEditor';
import { InheritedHeaders } from './InheritedHeaders';
import { ScriptsPanel } from './ScriptsPanel';
import { RequestSettings } from './RequestSettings';
import { Button, Field, Modal, Tabs, Textarea } from './ui';
import { confirmAction } from '../store';

/**
 * Folder settings: scripts that run around every request inside, folder variables, headers, the auth the
 * folder's requests inherit, request settings (timeout, redirects, TLS, cookies … the defaults of its requests) and a description. Order of scripts: collection → outer folders → this folder → request.
 */
export function FolderEditorBody({ folder, onSave, onClose }: { folder: CollectionFolder; onSave(f: CollectionFolder): void; onClose(): void }) {
  const [draft, setDraft] = useState<CollectionFolder>(folder);
  const [tab, setTab] = useState<'scripts' | 'variables' | 'headers' | 'auth' | 'settings' | 'docs'>('scripts');
  // Esc, the ✕, a click outside and Cancel keep what was typed unless the person says to drop it
  const dirty = JSON.stringify(draft) !== JSON.stringify(folder);
  const close = async () => {
    if (dirty && !(await confirmAction({ title: 'Unsaved changes', message: `The settings of the folder "${folder.name}" have unsaved changes.`, detail: 'Close anyway and discard them? Save keeps them.', confirmLabel: 'Discard changes', danger: true }))) return;
    onClose();
  };
  const save = () => {
    onSave({
      ...draft,
      preRequestScript: draft.preRequestScript?.trim() ? draft.preRequestScript : undefined,
      testScript: draft.testScript?.trim() ? draft.testScript : undefined,
      variables: draft.variables?.some((v) => v.key) ? draft.variables.filter((v) => v.key) : undefined,
      headers: draft.headers?.some((h) => h.key) ? draft.headers.filter((h) => h.key) : undefined,
      settings: draft.settings && Object.values(draft.settings).some((v) => v !== undefined) ? draft.settings : undefined,
      description: draft.description?.trim() ? draft.description : undefined,
    });
    onClose();
  };
  return (
    <Modal
      title={`Folder: ${folder.name}`}
      onClose={() => void close()}
      onSubmit={save}
      width={880}
      footer={
        <>
          <Button variant="ghost" onClick={() => void close()}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <Tabs label="Folder settings"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'scripts', label: 'Scripts', badge: (draft.preRequestScript?.trim() ? 1 : 0) + (draft.testScript?.trim() ? 1 : 0) || undefined },
          { id: 'variables', label: 'Variables', badge: draft.variables?.filter((v) => v.key).length || undefined },
          { id: 'headers', label: 'Headers', badge: draft.headers?.filter((h) => h.key).length || undefined },
          { id: 'auth', label: 'Authorization' },
          { id: 'settings', label: 'Settings', badge: Object.values(draft.settings ?? {}).filter((v) => v !== undefined).length || undefined },
          { id: 'docs', label: 'Docs', badge: draft.description?.trim() ? 1 : undefined },
        ]}
      />
      <div className="h-[48vh] mt-2">
        {tab === 'scripts' && (
          <div className="h-full flex flex-col">
            <p className="text-xs text-muted pb-2">These scripts run for every request in the folder: after the collection's scripts and before the request's own.</p>
            <div className="flex-1 min-h-0">
              <ScriptsPanel
                pre={draft.preRequestScript ?? ''}
                post={draft.testScript ?? ''}
                onPre={(preRequestScript) => setDraft({ ...draft, preRequestScript })}
                onPost={(testScript) => setDraft({ ...draft, testScript })}
              />
            </div>
          </div>
        )}
        {tab === 'variables' && (
          <div className="overflow-auto h-full">
            <p className="text-xs text-muted pb-2">
              Folder variables are visible to the requests inside. Inner folders override outer ones; request and iteration data variables override folder variables.
            </p>
            <KeyValueEditor rows={draft.variables ?? []} onChange={(variables) => setDraft({ ...draft, variables })} keyPlaceholder="Variable" />
          </div>
        )}
        {tab === 'headers' && (
          <div className="overflow-auto h-full">
            <InheritedHeaders where="folder" rows={draft.headers} onChange={(headers) => setDraft({ ...draft, headers })} />
          </div>
        )}
        {tab === 'settings' && (
          <div className="h-full flex flex-col" data-folder-settings>
            <p className="text-xs text-muted pb-2">Settings the requests in this folder start from: their own settings win, an inner folder's win over an outer one's, and the collection's are the base.</p>
            <div className="flex-1 min-h-0">
              <RequestSettings settings={draft.settings ?? {}} onChange={(settings) => setDraft({ ...draft, settings })} />
            </div>
          </div>
        )}
        {tab === 'docs' && (
          <div className="overflow-auto h-full">
            <Field label="Description" hint="What the folder is for (Markdown). Shown in the generated docs.">
              <Textarea autoGrow={false} className="field w-full h-56 text-sm" aria-label="Folder description" value={draft.description ?? ''} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </Field>
          </div>
        )}
        {tab === 'auth' && (
          <div className="overflow-auto h-full">
            <p className="text-xs text-muted pb-2">Requests in this folder set to “Inherit” use this auth. “Inherit” here means the collection's auth.</p>
            <AuthEditor auth={draft.auth ?? { type: 'inherit' }} onChange={(auth) => setDraft({ ...draft, auth })} />
          </div>
        )}
      </div>
    </Modal>
  );
}
