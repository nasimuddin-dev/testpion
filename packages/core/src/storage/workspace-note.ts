/**
 * The note of a workspace: a few lines everyone who opens it sees on Home, kept in `workspace.json` (so with git it travels to the team).
 * One place checks it for the app, `testpion workspace note` and anything else that sets it.
 */
import { WORKSPACE_NOTE_LIMIT } from '@testpion/shared';
import { ApsError } from '../errors.js';
import type { WorkspaceStore } from './workspace.js';

export function workspaceNote(store: Pick<WorkspaceStore, 'workspace'>): string {
  return (store.workspace.description ?? '').trim();
}

/** Set the note (an empty text clears it). Returns what is kept. */
export function setWorkspaceNote(store: Pick<WorkspaceStore, 'updateWorkspace'>, text: string): string {
  const note = text.trim();
  if (note.length > WORKSPACE_NOTE_LIMIT) throw new ApsError('ValidationError', `The note is ${note.length - WORKSPACE_NOTE_LIMIT} characters too long (at most ${WORKSPACE_NOTE_LIMIT})`, { suggestions: ['Keep it to a few lines; the docs are for the rest.'] });
  store.updateWorkspace({ description: note });
  return note;
}
