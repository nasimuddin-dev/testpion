import { useState } from 'react';
import type { CollectionFolder } from '../types';
import { AuthEditor } from './AuthEditor';
import { KeyValueEditor } from './KeyValueEditor';
import { InheritedHeaders } from './InheritedHeaders';
import { ScriptsPanel } from './ScriptsPanel';
import { RequestSettings } from './RequestSettings';
import { Button, Field, Modal, Tabs, Textarea } from './ui';

/**
 * Folder settings: scripts that run around every request inside, folder variables, headers, the auth the
 * folder's requests inherit, request settings (timeout, redirects, TLS, cookies … the defaults of its requests) and a description. Order of scripts: collection → outer folders → this folder → request.
 */
export function FolderEditorBody({ folder, onSave, onClose }: { folder: CollectionFolder; onSave(f: CollectionFolder): void; onClose(): void }) {
  const [draft, setDraft] = useState<CollectionFolder>(folder);
  const [tab, setTab] = useState<'scripts' | 'variables' | 'headers' | 'auth' | 'settings' | 'docs'>('scripts');
  return (
    <Modal
      title={`Folder: ${folder.name}`}
      onClose={onClose}
      width={880}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onSave({
                ...draft,
                preRequestScript: draft.preRequestScript?.trim() ? draft.preRequestScript : undefined,
                testScript: draft.testScript?.trim() ? draft.testScript : undefined,
                variables: draft.variables?.some((v) => v.key) ? draft.variables.filter((v) => v.key) : undefined,
                headers: draft.headers?.some((h) => h.key) ? draft.headers.filter((h) => h.key) : undefined,
                settings: draft.settings && Object.keys(draft.settings).length ? draft.settings : undefined,
                description: draft.description?.trim() ? draft.description : undefined,
              });
              onClose();
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'scripts', label: 'Scripts', badge: (draft.preRequestScript?.trim() ? 1 : 0) + (draft.testScript?.trim() ? 1 : 0) || undefined },
          { id: 'variables', label: 'Variables', badge: draft.variables?.filter((v) => v.key).length || undefined },
          { id: 'headers', label: 'Headers', badge: draft.headers?.filter((h) => h.key).length || undefined },
          { id: 'auth', label: 'Authorization' },
          { id: 'settings', label: 'Settings', badge: Object.keys(draft.settings ?? {}).length || undefined },
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
