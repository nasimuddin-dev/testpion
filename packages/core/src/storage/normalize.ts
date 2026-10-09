import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Collection, CollectionNode, Environment } from '../model/types.js';
import { readTextCached } from './fsutil.js';

/**
 * Workspace files as the engine expects them: a workspace.json that is TestPion's (not another tool's file of the
 * same name), and collections and environments that are valid JSON but incomplete, filled in on read.
 */
/** Whether a parsed workspace.json is TestPion's (not an Nx / Angular / other tool's file of the same name). */
export function looksLikeWorkspace(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const w = raw as Record<string, unknown>;
  if ('projects' in w) return false;
  return typeof w.id === 'string' || typeof w.name === 'string' || typeof w.schemaVersion === 'string';
}

/** Whether a folder's workspace.json is a TestPion workspace (a cheap check for "find the nearest workspace"). */
export function isWorkspaceDir(dir: string): boolean {
  const file = join(dir, 'workspace.json');
  if (!existsSync(file)) return false;
  try {
    return looksLikeWorkspace(JSON.parse((readTextCached(file) ?? '').replace(/^\uFEFF/, '')));
  } catch {
    return true; // a broken workspace.json is still meant to be one: opening it says what is wrong
  }
}

/** The first `"key": "value"` string in a file's text (for naming a file that does not parse). */
export function scanString(text: string | undefined, key: string): string | undefined {
  const m = text ? new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.){0,200})"`).exec(text) : null;
  if (!m) return undefined;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return m[1];
  }
}

const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : v === undefined || v === null ? fallback : String(v));

/** A collection as the rest of the engine expects it, from a file that is valid JSON but incomplete (no items, a numeric name …). */
export function normalizeCollection(c: Collection): Collection {
  const raw = (c && typeof c === 'object' && !Array.isArray(c) ? c : {}) as Collection;
  const items = (nodes: unknown): CollectionNode[] =>
    (Array.isArray(nodes) ? nodes : [])
      .filter((n): n is CollectionNode => !!n && typeof n === 'object')
      .map((n) => (n.kind === 'folder' ? { ...n, name: str(n.name, 'Folder'), items: items(n.items) } : { ...n, name: str(n.name, 'Request') }));
  return { ...raw, id: str(raw.id, ''), name: str(raw.name, str(raw.id, 'Collection')), variables: Array.isArray(raw.variables) ? raw.variables : [], items: items(raw.items) };
}

/** An environment as the rest of the engine expects it: an id, a name and a variables list. */
export function normalizeEnvironment(e: Environment, fileId: string): Environment {
  const raw = (e && typeof e === 'object' && !Array.isArray(e) ? e : {}) as Environment;
  const id = str(raw.id, fileId) || fileId;
  return { ...raw, id, name: str(raw.name, id), variables: Array.isArray(raw.variables) ? raw.variables.filter((v) => !!v && typeof v === 'object') : [] };
}
