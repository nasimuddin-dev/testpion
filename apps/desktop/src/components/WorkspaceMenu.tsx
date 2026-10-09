import { Check, ChevronDown, Copy, Download, FolderOpen, FolderPlus, GitBranch, Layers, MoreHorizontal, Pencil, Plus, Search, Trash2, Upload } from 'lucide-react';
import { runMenuCommand } from '../menu-commands';
import { useEffect, useMemo, useRef, useState } from 'react';
import { asError, call } from '../api';
import { promptText, toastError, useApp } from '../store';
import { downloadContent, hasNativeDialogs, pickTextFile } from '../lib/files';
import { Badge, Button, cx, IconButton, Input, Menu, Modal, Spinner, type MenuItem } from './ui';
import { plural } from '../lib/format';
import { convertedScriptsText, toastUnchangedScripts, type ImportScriptsSummary } from '../lib/import-scripts';

interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
  updatedAt?: string;
}
interface WorkspaceDetails extends WorkspaceInfo {
  managed: boolean;
  current: boolean;
  collections: number;
  environments: number;
  tests: number;
}
type NameDialog = { mode: 'create' | 'rename' | 'duplicate'; target?: WorkspaceInfo; value: string };


/**
 * The workspace switcher (top bar): search, switch, and a menu per workspace (the ⋯ button or a
 * right-click) with Open, Rename, Duplicate, Show in folder, Export and Delete.
 */
export function WorkspaceMenu() {
  const ws = useApp((s) => s.workspace);
  const { toast, refreshWorkspace } = useApp.getState();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<WorkspaceInfo[]>([]);
  const [q, setQ] = useState('');
  const [menuFor, setMenuFor] = useState<string>();
  const [nameDialog, setNameDialog] = useState<NameDialog>();
  const [deleting, setDeleting] = useState<WorkspaceInfo>();
  const load = () => void call<WorkspaceInfo[]>('ws.list').then(setList);
  useEffect(() => {
    if (open) {
      load();
      setQ('');
    }
  }, [open]);
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n ? list.filter((w) => w.name.toLowerCase().includes(n) || w.path.toLowerCase().includes(n)) : list;
  }, [list, q]);
  const isCurrent = (w: WorkspaceInfo) => w.path === ws?.path;

  /** Run an action, refresh the app's workspace state and report the result. */
  const act = async (fn: () => Promise<unknown>, msg?: string) => {
    try {
      await fn();
      await refreshWorkspace();
      if (msg) toast(msg, 'success');
      load();
      return true;
    } catch (e) {
      toastError(e);
      return false;
    }
  };
  const switchTo = (w: WorkspaceInfo) => {
    setOpen(false);
    if (!isCurrent(w)) void act(() => call('ws.open', { ref: w.path }), `Switched to "${w.name}"`);
  };
  type ImportResult = { kind: string; name?: string; format?: string; collection?: string; environment?: string; workspace?: string; scripts?: ImportScriptsSummary } | null;
  const imported = (r: ImportResult) => {
    if (r?.kind === 'workspace') toast(`Workspace "${r.name}" imported and opened`, 'success');
    else if (r) {
      const what = [r.collection && `collection "${r.collection}"`, r.environment && `environment "${r.environment}"`].filter(Boolean).join(' and ');
      toast(`Imported ${what || r.format} (${r.format}) into "${r.workspace}"${convertedScriptsText(r.scripts) ? `. ${convertedScriptsText(r.scripts)}` : ''}`, 'success');
      toastUnchangedScripts(r.scripts);
      useApp.getState().openIntent('collections', {});
    }
  };
  const importFile = () => {
    // a workspace export opens as a new workspace; Postman / Insomnia / Bruno / OpenAPI / HAR / .env files are added to this one
    if (hasNativeDialogs()) {
      let r: ImportResult = null;
      return void act(async () => (r = await call<ImportResult>('ws.importPick'))).then(() => imported(r));
    }
    // browser / cloud: pick the file in the page
    void pickTextFile('.json,.yaml,.yml,.har,.env,.wsdl,.xml,.http,.rest,.bru').then(async (f) => {
      if (!f) return;
      let r: ImportResult = null;
      await act(async () => (r = await call<ImportResult>('ws.importFile', { text: f.text, fileName: f.name })));
      imported(r);
    });
  };
  /** Export a workspace to one .json file (asks where; in the browser it downloads). Secret values are never exported. */
  const exportWorkspace = (w: { name: string; path: string }) =>
    void call<{ path?: string; bundle?: unknown; cancelled?: boolean; collections?: number; environments?: number }>('ws.export', { ref: w.path }).then(
      (r) => {
        if (r.cancelled) return;
        if (r.bundle) downloadContent(`${w.name}.apsworkspace.json`, JSON.stringify(r.bundle, null, 2), { type: 'application/json' });
        toast(`Exported "${w.name}" (${plural(r.collections ?? 0, 'collection')}, ${plural(r.environments ?? 0, 'environment')})${r.path ? ` to ${r.path}` : ''}. Secret values are never exported.`, 'success');
      },
      (e) => toastError(e),
    );
  const rowMenu = (w: WorkspaceInfo): MenuItem[] => [
    { label: isCurrent(w) ? 'Open (current)' : 'Open', icon: <Check size={14} />, disabled: isCurrent(w), onSelect: () => switchTo(w) },
    { label: 'Rename', icon: <Pencil size={14} />, onSelect: () => setNameDialog({ mode: 'rename', target: w, value: w.name }) },
    { label: 'Duplicate…', icon: <Copy size={14} />, onSelect: () => setNameDialog({ mode: 'duplicate', target: w, value: `${w.name} copy` }) },
    { label: 'Show in folder', icon: <FolderOpen size={14} />, onSelect: () => void call('app.openPath', { path: w.path }) },
    ...(isCurrent(w) ? [{ label: 'Make ready for git', icon: <GitBranch size={14} />, onSelect: () => (setOpen(false), void runMenuCommand('git-ready')) }] : []),
    {
      label: 'Export…',
      icon: <Download size={14} />,
      onSelect: () => exportWorkspace(w),
    },
    { label: 'Delete…', icon: <Trash2 size={14} />, danger: true, separator: true, onSelect: () => (setOpen(false), setDeleting(w)) },
  ];

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        onContextMenu={(e) => {
          e.preventDefault();
          setOpen(true);
        }}
        className={cx('flex items-center gap-1.5 h-8 px-2.5 rounded-md hover:bg-hover text-sm font-medium max-w-64 transition-colors', open && 'bg-hover')}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Switch workspace (right-click a workspace in the list for more)"
      >
        <Layers size={14} className="text-muted" />
        <span className="truncate">{ws?.name ?? 'No workspace'}</span>
        <ChevronDown size={13} className="text-muted" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div
            role="dialog"
            aria-label="Workspaces"
            className="absolute left-0 top-9 z-40 w-[420px] rounded-xl border border-line bg-popover shadow-lg text-sm animate-in fade-in-0 zoom-in-95 slide-in-from-top-1 duration-150"
            onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
          >
            <div className="flex items-center gap-2 p-2 border-b border-line">
              <div className="relative flex-1">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
                <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a workspace" aria-label="Find a workspace" className="w-full h-8 min-h-0 pl-8"
                  onKeyDown={(e) => e.key === 'Enter' && shown[0] && switchTo(shown[0])} />
              </div>
              <IconButton label="New workspace" onClick={() => setNameDialog({ mode: 'create', value: '' })}>
                <Plus size={16} />
              </IconButton>
            </div>
            <div className="max-h-[340px] overflow-auto p-1" role="list">
              {!shown.length && <div className="px-3 py-4 text-center text-muted text-xs">{list.length ? 'No workspace matches.' : <Spinner />}</div>}
              {shown.map((w) => (
                <div
                  key={w.path}
                  role="listitem"
                  className={cx('group flex items-center gap-2 rounded-lg px-2 py-1.5 cursor-pointer transition-colors', isCurrent(w) ? 'bg-accent-soft' : 'hover:bg-hover', menuFor === w.path && 'bg-hover')}
                  onClick={() => switchTo(w)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenuFor(w.path);
                  }}
                  title={w.path}
                >
                  <span className="w-4 shrink-0">{isCurrent(w) && <Check size={14} className="text-accent" />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className={cx('truncate', isCurrent(w) && 'font-medium')}>{w.name}</span>
                      {isCurrent(w) && <Badge tone="accent">current</Badge>}
                    </span>
                    <span className="block truncate text-[0.72rem] text-muted">{w.path}</span>
                  </span>
                  <Menu
                    open={menuFor === w.path}
                    onOpenChange={(o) => setMenuFor(o ? w.path : undefined)}
                    width={200}
                    items={rowMenu(w)}
                    trigger={
                      <button
                        aria-label={`More actions for ${w.name}`}
                        className={cx('shrink-0 grid place-items-center h-7 w-7 rounded-md text-muted hover:text-fg hover:bg-panel2', menuFor === w.path ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100')}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <MoreHorizontal size={15} />
                      </button>
                    }
                  />
                </div>
              ))}
            </div>
            <div className="grid grid-cols-5 gap-1 p-2 border-t border-line">
              <Button size="sm" variant="ghost" icon={<FolderPlus size={13} />} onClick={() => setNameDialog({ mode: 'create', value: '' })}>
                New
              </Button>
              <Button size="sm" variant="ghost" icon={<FolderOpen size={13} />} title="Open a workspace that lives elsewhere on disk, e.g. one kept in a git repository with your code. Choose the folder that contains workspace.json; it's added to this list and used in place (nothing is copied)." onClick={async () => {
                  setOpen(false);
                  if (hasNativeDialogs()) return void act(() => call('ws.open', {}));
                  // no folder picker in the browser: ask for the workspace folder's path
                  const path = await promptText('Open workspace folder', { message: 'Path of a folder that contains workspace.json', placeholder: 'e.g. D:/work/api-tests', okLabel: 'Open' });
                  if (path) void act(() => call('ws.open', { ref: path }));
                }}>
                Open folder
              </Button>
              <Button size="sm" variant="ghost" icon={<GitBranch size={13} />} title="Clone a git repository that holds a TestPion workspace, and open it" onClick={() => (setOpen(false), void runMenuCommand('git-clone'))}>
                Clone
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={<Upload size={13} />}
                title="Import a workspace export (opens as a new workspace), or a Postman / Insomnia / Bruno collection, OpenAPI, HAR or .env file into this workspace"
                onClick={() => (setOpen(false), importFile())}
              >
                Import
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={<Download size={13} />}
                disabled={!ws}
                title="Export the open workspace (collections, environments, tests, providers, MCP servers) to one .json file; secret values are never exported"
                onClick={() => {
                  setOpen(false);
                  if (ws) exportWorkspace(ws);
                }}
              >
                Export
              </Button>
            </div>
          </div>
        </>
      )}
      {nameDialog && <NameModal dialog={nameDialog} onClose={() => setNameDialog(undefined)} act={act} onDone={() => setOpen(false)} />}
      {deleting && <DeleteWorkspaceDialog target={deleting} onClose={() => setDeleting(undefined)} act={act} />}
    </div>
  );
}

function NameModal({ dialog, onClose, act, onDone }: { dialog: NameDialog; onClose(): void; act(fn: () => Promise<unknown>, msg?: string): Promise<boolean>; onDone(): void }) {
  const [name, setName] = useState(dialog.value);
  const title = dialog.mode === 'create' ? 'New workspace' : dialog.mode === 'rename' ? `Rename "${dialog.target?.name}"` : `Duplicate "${dialog.target?.name}"`;
  const submit = async () => {
    const n = name.trim();
    if (!n) return;
    const ok =
      dialog.mode === 'create'
        ? await act(() => call('ws.create', { name: n }), `Workspace "${n}" created`)
        : dialog.mode === 'rename'
          ? await act(() => call('ws.rename', { ref: dialog.target!.path, name: n }), `Renamed to "${n}"`)
          : await act(async () => call('ws.open', { ref: (await call<{ path: string }>('ws.duplicate', { ref: dialog.target!.path, name: n })).path }), `Duplicated as "${n}" and opened it`);
    if (ok) {
      onClose();
      onDone();
    }
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      width={440}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} onClick={() => void submit()}>
            {dialog.mode === 'create' ? 'Create' : dialog.mode === 'rename' ? 'Rename' : 'Duplicate'}
          </Button>
        </>
      }
    >
      <Input autoFocus className="w-full" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} placeholder="Workspace name" />
      {dialog.mode === 'duplicate' && <p className="text-xs text-muted mt-2">Copies collections, environments, tests and settings. Run history, traces and secret values are not copied.</p>}
    </Modal>
  );
}

/** Delete confirmation that says exactly what happens, and asks for the name (any case). */
function DeleteWorkspaceDialog({ target, onClose, act }: { target: WorkspaceInfo; onClose(): void; act(fn: () => Promise<unknown>, msg?: string): Promise<boolean> }) {
  const [d, setD] = useState<WorkspaceDetails>();
  const [error, setError] = useState<string>();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    call<WorkspaceDetails>('ws.details', { ref: target.path }).then(setD, (e) => setError(asError(e).message));
  }, [target.path]);
  const matches = typed.trim().toLowerCase() === target.name.trim().toLowerCase();
  const remove = async () => {
    if (!matches) return input.current?.focus();
    setBusy(true);
    let r: { deletedFiles: boolean; switchedTo?: string } | undefined;
    const ok = await act(async () => (r = await call('ws.delete', { ref: target.path })));
    setBusy(false);
    if (ok && r) {
      useApp
        .getState()
        .toast(`${r.deletedFiles ? `Deleted "${target.name}"` : `Removed "${target.name}" from the list (its folder was kept)`}${r.switchedTo ? `. Now in "${r.switchedTo}"` : ''}`, 'success');
      onClose();
    }
  };
  return (
    <Modal
      title={d && !d.managed ? 'Remove workspace from the list' : 'Delete workspace'}
      onClose={onClose}
      width={480}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" icon={<Trash2 size={13} />} loading={busy} disabled={!d || !matches} onClick={() => void remove()}>
            {d && !d.managed ? 'Remove from list' : 'Delete workspace'}
          </Button>
        </>
      }
    >
      {error ? (
        <p className="text-sm text-bad">{error}</p>
      ) : !d ? (
        <Spinner />
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          <div className="rounded-lg border border-line bg-panel px-3 py-2.5">
            <div className="font-medium">{d.name}</div>
            <div className="text-xs text-muted break-all">{d.path}</div>
            <div className="text-xs text-muted mt-1">
              {plural(d.collections, 'collection')} · {plural(d.environments, 'environment')} · {plural(d.tests, 'test file')}
            </div>
          </div>
          {d.managed ? (
            <p className="text-bad">This permanently deletes the workspace folder and everything in it: collections, environments, tests, run history and traces. It can't be undone. Export it first if you may need it.</p>
          ) : (
            <p className="text-muted">You opened this folder yourself, so its files stay on disk. It is only removed from TestPion's list; open the folder again to bring it back.</p>
          )}
          {d.current && <p className="text-muted">This is the open workspace. TestPion switches to another workspace first.</p>}
          <label className="flex flex-col gap-1.5 text-xs">
            <span className="text-fg/80 font-medium">
              Type <span className="mono text-fg">{d.name}</span> to confirm
            </span>
            <Input ref={input} autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void remove()} placeholder={d.name} />
          </label>
        </div>
      )}
    </Modal>
  );
}
