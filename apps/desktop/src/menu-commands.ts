import { call } from './api';
import { promptText, toastError, useApp } from './store';
import { openRef } from './lib/open-ref';
import { reopenClosedTab } from './lib/closed-tabs';
import { downloadFocusedOutput } from './components/output/output-core';
import { deliverSave, hasNativeDialogs, type SaveResult } from './lib/files';
import { exportWorkspace } from './lib/workspace-export';
import { openExportBundle, openImportBundle } from './lib/transfer';
import { plural, uid } from './lib/format';

/**
 * Commands of the application menu (File ▸ New, Import, Export …) and the command palette. The menu
 * lives in the desktop shell and sends a command name; everything here runs through RPC, so the same
 * commands work in the browser version (from the palette).
 */
export type MenuCommand =
  | 'git-ready'
  | 'git-fix'
  | 'git-clone'
  | 'new-http'
  | 'new-graphql'
  | 'new-grpc'
  | 'new-websocket'
  | 'new-mcp-server'
  | 'new-collection'
  | 'new-monitor'
  | 'new-environment'
  | 'new-workspace'
  | 'open-workspace'
  | 'open-examples'
  | 'shortcuts'
  | 'import'
  | 'export-collection'
  | 'export-environment'
  | 'export-workspace'
  | 'export-bundle'
  | 'import-bundle'
  | 'save'
  | 'settings'
  | 'feedback'
  | 'open-recent'
  | 'reopen-closed-tab'
  | 'download-output';


export async function runMenuCommand(cmd: MenuCommand): Promise<void> {
  const s = useApp.getState();
  try {
    switch (cmd) {
      case 'new-http':
        return s.openIntent('rest', { newTab: true });
      case 'feedback':
        return s.set({ feedback: {} });
      // WF-10: the items opened lately (Quick Open with nothing typed), and the tab closed last
      case 'open-recent':
        return s.set({ paletteOpen: true, paletteQuery: '' });
      case 'reopen-closed-tab':
        return void reopenClosedTab();
      // File ▸ Download Output…: the format menu of the output nearest to the focus
      case 'download-output':
        return downloadFocusedOutput(true);
      case 'new-graphql':
        return s.setView('graphql');
      case 'new-grpc':
        return s.setView('grpc');
      case 'new-websocket':
        return s.setView('websocket');
      case 'new-mcp-server':
        return s.openIntent('mcp', { addServer: true });
      case 'new-collection': {
        const name = await promptText('New collection', { message: 'Collection name', placeholder: 'My API', okLabel: 'Create' });
        if (!name) return;
        const id = uid('col-');
        await call('col.save', { schemaVersion: '1.0', id, name, version: 0, variables: [], items: [], updatedAt: '' });
        return void openRef({ kind: 'collection', collectionId: id });
      }
      case 'new-monitor':
        return s.openIntent('monitors', { create: { collectionId: '' } });
      case 'new-environment': {
        const name = await promptText('New environment', { message: 'Environment name', value: 'Staging', okLabel: 'Create' });
        if (!name) return;
        const env = { id: uid('env-'), name, variables: [{ key: 'baseUrl', value: '', enabled: true }] };
        await call('env.save', { env });
        await s.refreshWorkspace();
        return void openRef({ kind: 'environment', environmentId: env.id });
      }
      case 'new-workspace': {
        const name = await promptText('New workspace', { message: 'Workspace name', placeholder: 'My API tests', okLabel: 'Create' });
        if (!name) return;
        await call('ws.create', { name });
        await s.refreshWorkspace();
        s.toast(`Created and opened workspace "${name}"`, 'success');
        return s.setView('home');
      }
      case 'open-workspace': {
        if (hasNativeDialogs()) await call('ws.open', {});
        else {
          const path = await promptText('Open workspace folder', { message: 'Path of a folder that contains workspace.json', placeholder: 'e.g. D:/work/api-tests', okLabel: 'Open' });
          if (!path) return;
          await call('ws.open', { ref: path });
        }
        return void (await s.refreshWorkspace());
      }
      case 'git-ready': {
        // the open workspace: .gitignore, .gitattributes and git-friendly collection files (safe to repeat)
        const r = await call<{ files: string[]; collections: string[]; inRepository: boolean }>('ws.gitReady');
        const did = [...r.files, ...(r.collections.length ? [`${plural(r.collections.length, 'collection file')} tidied`] : [])];
        const repo = r.inRepository ? '' : ' It is not a git repository yet: run git init in its folder (Show in folder).';
        return s.toast(did.length ? `Ready for git: ${did.join(', ')}.${repo}` : `This workspace is already ready for git.${repo}`, 'success');
      }
      case 'git-fix':
        // Fix git setup: previewed and undoable, in the Git view (release C of Everything under Git)
        return s.openIntent('git', { fix: true });
      case 'git-clone': {
        // GIT-202: clone a repository that holds a TestPion workspace, and open it
        const url = await promptText('Clone from Git', { message: 'The repository URL (HTTPS or SSH). Sign-in uses your git setup: SSH keys or the credential manager.', placeholder: 'https://github.com/team/api-tests.git', okLabel: 'Next' });
        if (!url) return;
        let dest: string | undefined;
        if (!hasNativeDialogs()) {
          dest = (await promptText('Clone into', { message: 'A new or empty folder', placeholder: 'e.g. D:/work/api-tests', okLabel: 'Clone' })) ?? undefined;
          if (!dest) return;
        }
        s.toast('Cloning…', 'info');
        const r = await call<{ path: string; workspaces: string[]; opened?: string } | null>('git.clone', { url, dest });
        if (!r) return;
        if (r.opened) {
          await s.refreshWorkspace();
          return s.toast(`Cloned and opened ${r.opened}`, 'success');
        }
        if (!r.workspaces.length) return s.toast(`Cloned to ${r.path}, but it holds no TestPion workspace (no workspace.json). Create one there with New ▸ in a folder, or Make ready for git.`, 'warning');
        const pick = await promptText('Open which workspace?', { message: `The repository holds ${r.workspaces.length} workspaces: ${r.workspaces.join(', ')}`, value: r.workspaces[0], okLabel: 'Open' });
        if (!pick) return;
        await call('git.openFolder', { path: pick });
        await s.refreshWorkspace();
        return s.toast(`Opened ${pick}`, 'success');
      }
      case 'open-examples': {
        await call('ws.openExamples', {});
        await s.refreshWorkspace();
        s.toast('Opened the TestPion Examples workspace', 'success');
        return s.setView('home');
      }
      case 'import':
        return s.openIntent('collections', { import: true });
      case 'export-collection':
        return s.openIntent('collections', { export: 'postman' });
      case 'export-environment': {
        const env = s.workspace?.environments.find((e) => e.name === s.environment);
        if (!env) return s.toast('Select an environment first (top bar), then export it.', 'error');
        const r = await call<SaveResult & { name: string }>('env.export', { id: env.id });
        if (!deliverSave(r)) return; // the save dialog was cancelled
        return s.toast(r.path ? `Exported "${env.name}" to ${r.path} (secret values are never exported)` : `Exported "${env.name}" (secret values are never exported)`, 'success');
      }
      case 'export-workspace': {
        const ws = s.workspace;
        if (!ws) return;
        await exportWorkspace(ws.path);
        return;
      }
      // File ▸ Export ▸ Bundle…: everything in one file; File ▸ Import Bundle…: the picker, then the preview
      case 'export-bundle':
        return openExportBundle({ all: true });
      case 'import-bundle':
        return openImportBundle();
      case 'save':
        // the active view saves on Ctrl/Cmd+S; the menu accelerator takes the key, so pass it on
        return void window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, metaKey: navigator.platform.startsWith('Mac'), bubbles: true }));
      case 'shortcuts':
        return s.set({ shortcutsOpen: true });
      case 'settings':
        return s.setView('settings');
    }
  } catch (e) {
    toastError(e);
  }
}
