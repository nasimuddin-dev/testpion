import { useState } from 'react';
import type { CollectionFolder } from '../types';
import { AuthEditor } from './AuthEditor';
import { KeyValueEditor } from './KeyValueEditor';
import { ScriptsPanel } from './ScriptsPanel';
import { Button, Modal, Tabs } from './ui';

/**
 * Folder settings: scripts that run around every request inside, folder variables and the auth the
 * folder's requests inherit. Order of scripts: collection → outer folders → this folder → request.
 */
export function FolderEditorBody({ folder, onSave, onClose }: { folder: CollectionFolder; onSave(f: CollectionFolder): void; onClose(): void }) {
  const [draft, setDraft] = useState<CollectionFolder>(folder);
  const [tab, setTab] = useState<'scripts' | 'variables' | 'auth'>('scripts');
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
          { id: 'auth', label: 'Authorization' },
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
