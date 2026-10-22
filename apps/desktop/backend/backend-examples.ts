import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { addTemplateAdditions, ENGINE_VERSION, readJson, samePath, type WorkspaceInfo } from '@testpion/core';
import type { Backend } from './backend.js';

/** The examples workspace that ships with the app: installed once, and given what later versions add (functions of the backend, in a module of their own so backend.ts stays small). */

export function installExamples(be: Backend): WorkspaceInfo | undefined {
  const dir = be.host.examplesDir;
  if (!dir || !existsSync(join(dir, 'workspace.json'))) return undefined;
  try {
    return be.manager.installTemplate(dir);
  } catch (e) {
    be.logger.warn(`Could not install the examples workspace: ${(e as Error).message}`);
    return undefined;
  }
}

/**
 * Examples that shipped with this version go into the user's copy: additions only, never a change
 * (addTemplateAdditions). Once per app version: the settings remember the version whose examples were offered.
 */
export function updateExamples(be: Backend): void {
  const dir = be.host.examplesDir;
  if (!dir || !existsSync(join(dir, 'workspace.json'))) return;
  if (be.settings.examplesOfferedVersion === ENGINE_VERSION) return;
  try {
    const id = readJson<{ id: string }>(join(dir, 'workspace.json')).id;
    const mine = be.manager.list().find((w) => w.id === id);
    if (!mine) return;
    // the files it adds are the app's own (copyOwned: no "changed on disk" for them)
    const added = addTemplateAdditions(dir, mine.path);
    be.examplesAdded = added;
    if (added.length && be.store && samePath(be.store.root, mine.path)) be.host.emit('data.changed', { method: 'ws.import' });
    be.settings = be.manager.saveSettings({ ...be.settings, examplesOfferedVersion: ENGINE_VERSION });
    if (added.length) be.logger.info(`Added to the examples workspace: ${added.join(', ')}`);
  } catch (e) {
    be.logger.warn(`Could not add the new examples: ${(e as Error).message}`);
  }
}
