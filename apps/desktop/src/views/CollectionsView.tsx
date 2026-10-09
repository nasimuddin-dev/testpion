import { CollectionOverview } from '../components/CollectionOverview';
import { ReplaceDialog } from '../components/ReplaceDialog';
import { MoveVariablesDialog } from '../components/MoveVariablesDialog';
import { TidyDialog } from '../components/TidyDialog';
import {
  ArchiveRestore,
  ArrowRightLeft,
  Wrench,
  Brush,
  Download,
  FileCode,
  FileJson,
  FilePlus2,
  FolderPlus,
  FolderTree,
  Package,
  Play,
  Radio,
  Replace,
  Send,
  ShieldCheck,
  Trash2,
  Upload,
  FolderOpen,
  Workflow,
} from 'lucide-react';
import { downloadContent, generateFlows } from '../lib/files';
import { useCallback, useEffect, useState } from 'react';
import { call } from '../api';
import { confirmAction, promptText, toastError, useApp } from '../store';
import { useIntent } from '../hooks';
import type { Collection, CollectionNode } from '../types';
import { timeAgo, uid, plural } from '../lib/format';
import { AuthEditor } from '../components/AuthEditor';
import { ScriptsPanel } from '../components/ScriptsPanel';
import { CollectionRunner } from '../components/CollectionRunner';
import { MockPanel } from '../components/MockPanel';
import { CollectionDocs } from '../components/CollectionDocs';
import { addToFolder, CollectionTree } from '../components/CollectionTree';
import { TrashDialog } from '../components/TrashDialog';
import { KeyValueEditor } from '../components/KeyValueEditor';
import { Badge, Button, cx, Empty, IconButton, Menu, SectionTitle, Split, Tabs } from '../components/ui';
import { InlineRename } from '../components/TreeParts';
import { closeTabsFor } from '../components/EditorTabs';
import { subtreeIds } from '../components/MoveDialog';
import { ImportModal } from './rest/dialogs';
import { SecurityReviewDialog } from '../components/SecurityReviewDialog';
import { refreshCollections, useCollectionTree } from '../lib/collections-store';

export function CollectionsView() {
  const [trashOpen, setTrashOpen] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState<boolean | { find: string; replace: string }>(false);
  const [tidyOpen, setTidyOpen] = useState(false);
  const [moveVarsOpen, setMoveVarsOpen] = useState(false);
  const [moveVarsInitial, setMoveVarsInitial] = useState<string[]>();
  // the list shows the outline (names, counts); the selected collection is read whole on its own
  const cols = useCollectionTree();
  const [sel, setSel] = useState<string>();
  const selOutline = cols.find((c) => c.id === sel);
  const [stored, setStored] = useState<Collection>();
  useEffect(() => {
    if (!selOutline) return setStored(undefined);
    let live = true;
    // read again whenever its outline changed (a save here or elsewhere, a change on disk)
    call<Collection>('col.get', { id: selOutline.id }).then(
      (c) => live && setStored(c),
      () => live && setStored(selOutline),
    );
    return () => void (live = false);
  }, [selOutline]);
  const [draft, setDraft] = useState<Collection>();
  const [tab, setTab] = useState<'overview' | 'requests' | 'variables' | 'auth' | 'scripts' | 'docs' | 'run' | 'mock'>('requests');
  const [runFolder, setRunFolder] = useState<string>();
  // a dataset chosen before the collection (the sidebar's "Run a collection with it"): the runner starts with it
  const [runData, setRunData] = useState<string>();
  const [importing, setImporting] = useState(false);
  const newCollection = async () => {
    const name = await promptText('New collection', { message: 'Collection name', placeholder: 'My API', okLabel: 'Create' });
    if (name) {
      const id = uid('col-');
      await save({ schemaVersion: '1.0', id, name, version: 0, variables: [], items: [], updatedAt: '' });
      setSel(id);
    }
  };
  const load = useCallback(async () => {
    const c = await refreshCollections();
    setSel((s) => s ?? c[0]?.id);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => setDraft(stored && stored.id === sel ? stored : undefined), [sel, stored]);
  useIntent('collections', (p) => {
    if (p?.collectionId) setSel(p.collectionId);
    // straight to a part of the collection's settings (e.g. its variables, from the variable popover or the quick look)
    if (p?.tab === 'variables' || p?.tab === 'auth' || p?.tab === 'scripts' || p?.tab === 'docs' || p?.tab === 'overview') setTab(p.tab);
    if (p?.run) {
      setTab('run');
      setRunFolder(p.folderId);
      setRunData(typeof p.dataPath === 'string' ? p.dataPath : undefined);
    }
    if (p?.mock) setTab('mock');
    // from a variable's Where it's set: move it (pre-selected) to the environments
    if (Array.isArray(p?.moveVariables)) {
      setMoveVarsInitial(p.moveVariables as string[]);
      setMoveVarsOpen(true);
    }
    if (p?.import) setImporting(true);
    // File ▸ Export ▸ Collection: the selected collection (or the first one)
    if (p?.export) {
      const id = p.collectionId ?? sel ?? cols[0]?.id;
      if (id) void exportAs(id, p.export === 'testpion' ? 'testpion' : 'postman');
      else useApp.getState().toast('There is no collection to export yet.', 'error');
    }
  });
  const [renamingName, setRenamingName] = useState(false);
  // another collection: no rename left open
  useEffect(() => setRenamingName(false), [draft?.id]);
  /** Rename in place: only the name is saved (other unsaved edits of the collection stay unsaved), like a rename in the tree. */
  const renameCollection = async (name: string) => {
    setRenamingName(false);
    if (!draft || name === draft.name) return;
    try {
      await call('col.save', { ...(stored?.id === draft.id ? stored : draft), name });
      setDraft({ ...draft, name });
      await load();
    } catch (e) {
      toastError(e);
    }
  };
  const save = async (c: Collection) => {
    await call('col.save', c);
    await load();
    useApp.getState().toast('Collection saved', 'success');
  };
  const exportAs = async (id: string, format: 'testpion' | 'postman' | 'openapi' | 'bruno' | 'http' | 'asyncapi') => {
    try {
      const r = await call<{ path?: string; collection?: unknown; text?: string; name: string; notes: string[] }>('col.export', { id, format });
      if (r.collection) downloadContent(r.name, JSON.stringify(r.collection, null, 2), { type: 'application/json' });
      else if (r.text !== undefined) downloadContent(r.name, r.text, { type: 'application/json' });
      else if (!r.path) return;
      const extra = r.notes.length ? ` Not exported (no Postman equivalent): ${r.notes.join('; ')}.` : '';
      useApp.getState().toast(`${r.path ? `Exported to ${r.path}.` : 'Exported.'}${extra}`, r.notes.length ? 'info' : 'success');
    } catch (e) {
      toastError(e);
    }
  };
  const open = (c: Collection, n: CollectionNode) => useApp.getState().openIntent(n.kind === 'graphql' ? 'graphql' : 'rest', { collectionId: c.id, requestId: n.id });
  const count = (nodes: CollectionNode[]): number => nodes.reduce((a, n) => a + (n.kind === 'folder' ? count(n.items) : 1), 0);
  return (
    <>
      <Split id="collections" sidebar collapsed initial={24}>
        <div className="h-full flex flex-col bg-panel/50">
          <SectionTitle
            right={
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" icon={<Upload size={12} />} onClick={() => setImporting(true)}>
                  Import
                </Button>
                <Menu
                  width={260}
                  trigger={
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Download size={12} />}
                      disabled={!cols.length}
                      title={cols.length ? 'Export a collection or the whole workspace' : 'Nothing to export yet'}
                    >
                      Export
                    </Button>
                  }
                  items={(() => {
                    const target = cols.find((c) => c.id === sel) ?? cols[0];
                    if (!target) return [];
                    return [
                      { label: `"${target.name}" as TestPion (.json)`, icon: <FileJson size={14} />, onSelect: () => void exportAs(target.id, 'testpion') },
                      { label: 'as Postman collection v2.1', icon: <Send size={14} />, onSelect: () => void exportAs(target.id, 'postman') },
                      { label: 'as OpenAPI 3.1 (.yaml)', icon: <FileCode size={14} />, onSelect: () => void exportAs(target.id, 'openapi') },
                      { label: 'as Bruno collection folder…', icon: <FolderOpen size={14} />, onSelect: () => void exportAs(target.id, 'bruno') },
                      {
                        label: 'Integration flows → tests/ (create, read, update, list, delete)',
                        icon: <Workflow size={14} />,
                        separator: true,
                        onSelect: () => void generateFlows({ collectionId: target.id, name: target.name }, confirmAction),
                      },
                      {
                        label: 'Whole workspace (.json)…',
                        icon: <Package size={14} />,
                        separator: true,
                        onSelect: () =>
                          void call<{ path?: string; bundle?: unknown }>('ws.export', {}).then(
                            (r) => {
                              // no native save dialog (browser / cloud): download the export instead
                              if (r.bundle) downloadContent(`${useApp.getState().workspace?.name ?? 'workspace'}.apsworkspace.json`, JSON.stringify(r.bundle, null, 2), { type: 'application/json' });
                              if (r.path || r.bundle) useApp.getState().toast('Workspace exported (secret values are never exported)', 'success');
                            },
                            (e) => toastError(e),
                          ),
                      },
                    ];
                  })()}
                />
                <Button size="sm" variant="ghost" icon={<FolderPlus size={12} />} onClick={() => void newCollection()}>
                  New
                </Button>
                <IconButton label="Record traffic into a collection (reverse proxy)" onClick={() => useApp.getState().set({ recordOpen: true })}>
                  <Radio size={13} />
                </IconButton>
                <IconButton label="Recently deleted" onClick={() => setTrashOpen(true)}>
                  <ArchiveRestore size={13} />
                </IconButton>
              </div>
            }
          >
            Collections
          </SectionTitle>
          <div className="flex-1 overflow-auto">
            {cols.map((c) => (
              <button key={c.id} onClick={() => setSel(c.id)} className={cx('w-full text-left px-3 py-2 border-b border-line/60', sel === c.id ? 'bg-accent/10' : 'hover:bg-hover')}>
                <div className={cx('text-sm font-medium', c.problem && 'text-bad')}>{c.name}</div>
                <div className="text-xs text-muted">{c.problem ? c.problem : `${plural(count(c.items), 'request')} · v${c.version} · ${c.updatedAt ? timeAgo(c.updatedAt) : ''}`}</div>
              </button>
            ))}
            {!cols.length && (
              <Empty
                icon={<FolderTree size={24} />}
                title="No collections"
                actions={[
                  { label: 'New collection', icon: <FolderPlus size={12} />, onClick: () => void newCollection() },
                  { label: 'Import…', icon: <Upload size={12} />, onClick: () => setImporting(true) },
                ]}
              >
                A collection groups requests that share a base URL, auth and scripts; run it, mock it, or watch it with a monitor. Import OpenAPI, Postman, Insomnia, Bruno, Hoppscotch or HAR.
              </Empty>
            )}
          </div>
        </div>
        <div className="h-full flex flex-col min-w-0">
          {draft ? (
            <>
              <div className="flex items-center gap-2 px-3 h-11 border-b border-line">
                {renamingName ? (
                  <InlineRename value={draft.name} label="Collection name" className="font-semibold w-72" onCommit={(name) => void renameCollection(name)} onCancel={() => setRenamingName(false)} />
                ) : (
                  // the name like a request's: plain text, renamed in place on a double-click (or F2 / Enter)
                  <span
                    role="button"
                    tabIndex={0}
                    className="font-semibold truncate max-w-[24rem] px-1 rounded hover:bg-hover cursor-text"
                    title="Double-click to rename"
                    onDoubleClick={() => setRenamingName(true)}
                    onKeyDown={(e) => (e.key === 'F2' || e.key === 'Enter') && (e.preventDefault(), setRenamingName(true))}
                    data-collection-name
                  >
                    {draft.name}
                  </span>
                )}
                <Badge>v{draft.version}</Badge>
                <div className="ml-auto flex gap-2">
                  <Button size="sm" icon={<FilePlus2 size={12} />} onClick={() => useApp.getState().openIntent('rest', { newTab: true })}>
                    New HTTP request
                  </Button>
                  <Button
                    size="sm"
                    icon={<Play size={12} />}
                    onClick={() => {
                      setRunFolder(undefined);
                      setTab('run');
                    }}
                  >
                    Run
                  </Button>
                  <Menu
                    trigger={
                      <Button size="sm" icon={<Wrench size={12} />} title="Find and replace, tidy up, move variables, security review">
                        Tools
                      </Button>
                    }
                    width={300}
                    items={[
                      { label: 'Find and replace…', icon: <Replace size={14} />, onSelect: () => setReplaceOpen(true) },
                      { label: 'Tidy up…', icon: <Brush size={14} />, onSelect: () => setTidyOpen(true) },
                      { label: 'Move variables to environments…', icon: <ArrowRightLeft size={14} />, onSelect: () => setMoveVarsOpen(true) },
                      { label: 'Security review…', icon: <ShieldCheck size={14} />, separator: true, onSelect: () => setSecurityOpen(true) },
                    ]}
                  />
                  <Menu
                    trigger={
                      <Button size="sm" icon={<Download size={12} />}>
                        Export
                      </Button>
                    }
                    width={230}
                    items={[
                      { label: 'TestPion collection (.json)', icon: <FileJson size={14} />, onSelect: () => void exportAs(draft.id, 'testpion') },
                      { label: 'Postman collection v2.1', icon: <Send size={14} />, onSelect: () => void exportAs(draft.id, 'postman') },
                      { label: 'OpenAPI 3.1 (.yaml)', icon: <FileCode size={14} />, onSelect: () => void exportAs(draft.id, 'openapi') },
                      { label: 'Bruno collection folder…', icon: <FolderOpen size={14} />, onSelect: () => void exportAs(draft.id, 'bruno') },
                      { label: '.http file (REST Client, JetBrains)', icon: <FileCode size={14} />, onSelect: () => void exportAs(draft.id, 'http') },
                      { label: 'AsyncAPI 3.0 (its connections)', icon: <Radio size={14} />, onSelect: () => void exportAs(draft.id, 'asyncapi') },
                    ]}
                  />
                  <Button size="sm" variant="primary" onClick={() => save(draft)}>
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-bad"
                    icon={<Trash2 size={12} />}
                    onClick={async () => {
                      if (
                        !(await confirmAction({
                          title: 'Delete collection',
                          message: `Delete the collection "${draft.name}" and all its requests?`,
                          detail: 'You can restore it from Recently deleted for 30 days.',
                          confirmLabel: 'Delete collection',
                          danger: true,
                        }))
                      )
                        return;
                      await call('col.delete', { id: draft.id });
                      closeTabsFor(draft.items.flatMap(subtreeIds));
                      setSel(undefined);
                      await load();
                    }}
                  />
                </div>
              </div>
              <Tabs
                value={tab}
                onChange={setTab}
                tabs={[
                  { id: 'overview', label: 'Overview' },
                  { id: 'requests', label: 'Requests', badge: count(draft.items) },
                  { id: 'variables', label: 'Variables', badge: draft.variables.length },
                  { id: 'auth', label: 'Authorization' },
                  { id: 'scripts', label: 'Scripts' },
                  { id: 'docs', label: 'Docs' },
                  { id: 'run', label: 'Run' },
                  { id: 'mock', label: 'Mock' },
                ]}
              />
              <div className={cx('flex-1 min-h-0', tab !== 'run' && tab !== 'docs' && 'overflow-auto')}>
                {tab === 'mock' && <MockPanel collectionId={draft.id} onOpenRequest={(requestId) => useApp.getState().openIntent('rest', { collectionId: draft.id, requestId })} />}
                {tab === 'overview' && (
                  <CollectionOverview
                    collection={draft}
                    onOpen={(n) => open(draft, n)}
                    onRun={() => {
                      setRunFolder(undefined);
                      setTab('run');
                    }}
                  />
                )}
                {tab === 'run' && <CollectionRunner collection={draft} folderId={runFolder} onFolderChange={setRunFolder} dataPath={runData} />}
                {tab === 'requests' && (
                  <div className="p-2">
                    <CollectionTree
                      collections={[draft]}
                      onOpen={open}
                      onChange={save}
                      onRun={(_, folderId) => {
                        setRunFolder(folderId);
                        setTab('run');
                      }}
                      onNewRequest={async (c, folderId) => {
                        const node = { kind: 'http' as const, id: uid('req-'), name: 'New request', request: { method: 'GET', url: '{{baseUrl}}/' }, assertions: [{ type: 'status', expected: 200 }] };
                        await save({ ...c, items: addToFolder(c.items, folderId, node) });
                        open(c, node);
                      }}
                    />
                  </div>
                )}
                {tab === 'variables' && (
                  <div className="p-2">
                    <div className="flex items-center gap-2 px-1 pb-2">
                      <p className="text-xs text-muted">
                        Collection variables override environment variables (so they are the same in every environment) and are overridden by request and runtime variables.
                      </p>
                      {draft.variables.length > 0 && (
                        <Button size="sm" className="ml-auto shrink-0" icon={<ArrowRightLeft size={12} />} title="So each environment can set its own value" onClick={() => setMoveVarsOpen(true)}>
                          Move to environments…
                        </Button>
                      )}
                    </div>
                    <KeyValueEditor rows={draft.variables} onChange={(variables) => setDraft({ ...draft, variables })} keyPlaceholder="Variable" />
                  </div>
                )}
                {tab === 'auth' && (
                  <>
                    <p className="text-xs text-muted px-3 pt-3">Requests with “Inherit” use this auth (folders can override it).</p>
                    <AuthEditor auth={draft.auth ?? { type: 'none' }} onChange={(auth) => setDraft({ ...draft, auth })} allowInherit={false} />
                  </>
                )}
                {tab === 'scripts' && (
                  <div className="h-full">
                    <ScriptsPanel
                      pre={draft.preRequestScript ?? ''}
                      post={draft.testScript ?? ''}
                      onPre={(preRequestScript) => setDraft({ ...draft, preRequestScript })}
                      onPost={(testScript) => setDraft({ ...draft, testScript })}
                    />
                  </div>
                )}
                {tab === 'docs' && <CollectionDocs collection={draft} onDescription={(description) => setDraft({ ...draft, description })} />}
              </div>
            </>
          ) : (
            <Empty title="Select a collection">Pick one on the left: its requests, variables, auth, documentation, runner and mock server are here.</Empty>
          )}
        </div>
      </Split>
      {/* outside the Split: its first pane (the old collection list) is collapsed, which leaves it out of the page */}
      {moveVarsOpen && draft && (
        <MoveVariablesDialog
          collection={stored?.id === draft.id ? stored : draft}
          initial={moveVarsInitial}
          onClose={() => (setMoveVarsOpen(false), setMoveVarsInitial(undefined))}
          onDone={() => void load().then(() => useApp.getState().set({ envsVersion: (useApp.getState().envsVersion ?? 0) + 1 }))}
        />
      )}
      {tidyOpen && draft && (
        <TidyDialog
          collection={stored?.id === draft.id ? stored : draft}
          onClose={() => setTidyOpen(false)}
          onDone={() => void load().then(() => setSel(draft.id))}
          onReplace={(host) => (setTidyOpen(false), setReplaceOpen({ find: host, replace: '{{baseUrl}}' }))}
        />
      )}
      {replaceOpen && draft && (
        <ReplaceDialog
          initialFind={typeof replaceOpen === 'object' ? replaceOpen.find : undefined}
          initialReplace={typeof replaceOpen === 'object' ? replaceOpen.replace : undefined}
          collection={stored?.id === draft.id ? stored : draft}
          onClose={() => setReplaceOpen(false)}
          onDone={() => void load().then(() => setSel(draft.id))}
        />
      )}
      {securityOpen && draft && <SecurityReviewDialog collectionId={draft.id} name={draft.name} onClose={() => setSecurityOpen(false)} />}
      {trashOpen && <TrashDialog kind="collection" onClose={() => setTrashOpen(false)} onRestored={(r) => void load().then(() => setSel(r.id))} />}
      {importing && <ImportModal onClose={() => setImporting(false)} onDone={load} />}
    </>
  );
}
