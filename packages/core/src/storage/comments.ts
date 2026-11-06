/**
 * Comments for your team on an item (a request, a folder, a test file, an evaluation, a monitor …): "Why does this send
 * X-Trace twice?", "Flaky since the 2nd: who owns it?". They are kept in the workspace under `comments/`, one file per item
 * (two people commenting on different items never conflict), so with git they travel to the team; nothing leaves the
 * computer otherwise. The app’s Info panel, `testpion item comment` and the RPC all go through here.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { itemRefIdentity, toItemRef, type ItemRef } from '@testpion/shared';
import { ApsError } from '../errors.js';
import { readJson, removeOwned, writeJson } from './fsutil.js';
import { sha256Hex } from '../util/hash.js';
import type { WorkspaceStore } from './workspace.js';

export const COMMENT_LIMIT = 2000;
export const COMMENTS_DIR = 'comments';

export interface ItemComment {
  id: string;
  /** Who wrote it: the git identity's name, else the computer's user name. */
  by: string;
  /** ISO time. */
  at: string;
  text: string;
  /** Set when someone marked it as settled. */
  resolvedAt?: string;
  resolvedBy?: string;
  /** A reply: the id of the comment it answers (always a thread's first comment). It is shown under it, settled and deleted with it. */
  replyTo?: string;
}

export interface ItemCommentThread {
  ref: ItemRef;
  comments: ItemComment[];
}

/** An open comment with the item it is on: the list of the whole workspace. */
export interface OpenComment extends ItemComment {
  ref: ItemRef;
}

/** The workspace the comments are in; `warn` (the store's) is told of a thread file that cannot be read. */
type Store = Pick<WorkspaceStore, 'root'> & { warn?(message: string): void };

/** A thread file that cannot be read (git conflict markers, a hand edit gone wrong): said once as a warning, the file is left as it is. */
function skipBroken(store: Store, file: string, e: unknown): void {
  const why = (e as { details?: { problem?: string } }).details?.problem ?? (e as Error).message;
  store.warn?.(`The comments in ${COMMENTS_DIR}/${file} are left out: ${why}`);
}

/** The file of an item's thread: the ref's identity (its required ids: any ref of the item finds it), made safe for every file system (a short hash keeps two refs apart). */
export function commentFileOf(ref: ItemRef): string {
  const key = itemRefIdentity(ref);
  const safe = key.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `${safe}.${sha256Hex(key).slice(0, 8)}.json`;
}

const fileOf = (store: Store, ref: ItemRef) => join(store.root, COMMENTS_DIR, commentFileOf(ref));

/**
 * The thread of an item. A file that cannot be read fails a change (adding to it would replace what is in the file); a
 * reader (`lenient`) gets no comments and a warning instead, so one broken file never empties a panel with an error.
 */
function readThread(store: Store, ref: ItemRef, o: { lenient?: boolean } = {}): ItemCommentThread {
  const f = fileOf(store, ref);
  if (!existsSync(f)) return { ref, comments: [] };
  let raw: Partial<ItemCommentThread> | null;
  try {
    raw = readJson<Partial<ItemCommentThread>>(f, {});
  } catch (e) {
    if (!o.lenient) throw e;
    skipBroken(store, commentFileOf(ref), e);
    return { ref, comments: [] };
  }
  if (!raw || typeof raw !== 'object') return { ref, comments: [] };
  return { ref, comments: Array.isArray(raw.comments) ? raw.comments.filter((c) => c && typeof c.text === 'string') : [] };
}

function writeThread(store: Store, t: ItemCommentThread): void {
  const f = fileOf(store, t.ref);
  if (!t.comments.length) {
    if (existsSync(f)) removeOwned(f); // the app's own change: the watcher does not report it as made outside
    return;
  }
  mkdirSync(join(store.root, COMMENTS_DIR), { recursive: true });
  writeJson(f, { schemaVersion: '1.0', ref: t.ref, comments: t.comments });
}

/** The comments on one item, oldest first. */
export function listComments(store: Store, ref: ItemRef): ItemComment[] {
  return readThread(store, ref, { lenient: true }).comments;
}

/** Add a comment (with `replyTo`, a reply to that comment; a reply to a reply answers the same first comment); returns it. */
export function addComment(store: Store, ref: ItemRef, text: string, by: string, o: { replyTo?: string } = {}): ItemComment {
  const body = text.trim();
  if (!body) throw new ApsError('ValidationError', 'The comment is empty');
  if (body.length > COMMENT_LIMIT) throw new ApsError('ValidationError', `The comment is ${body.length - COMMENT_LIMIT} characters too long (at most ${COMMENT_LIMIT})`, { suggestions: ['Keep it to the point; a long explanation belongs in the item’s description.'] });
  const t = readThread(store, ref);
  let replyTo: string | undefined;
  if (o.replyTo) {
    const parent = t.comments.find((x) => x.id === o.replyTo);
    if (!parent) throw new ApsError('ValidationError', `No comment ${o.replyTo} on this item to reply to`, { suggestions: ['`testpion item comment list <item>` (or team_comments list) shows the ids.'] });
    replyTo = parent.replyTo ?? parent.id;
  }
  const c: ItemComment = { id: `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, by: by.trim() || 'someone', at: new Date().toISOString(), text: body, ...(replyTo ? { replyTo } : {}) };
  t.comments.push(c);
  writeThread(store, t);
  return c;
}

/** Mark a comment settled (or open again). */
export function resolveComment(store: Store, ref: ItemRef, id: string, by: string, resolved = true): ItemComment {
  const t = readThread(store, ref);
  const c = t.comments.find((x) => x.id === id);
  if (!c) throw new ApsError('ValidationError', `No comment ${id} on this item`);
  if (resolved) {
    c.resolvedAt = new Date().toISOString();
    c.resolvedBy = by.trim() || 'someone';
  } else {
    delete c.resolvedAt;
    delete c.resolvedBy;
  }
  writeThread(store, t);
  return c;
}

/** Remove a comment for good, with its replies; returns what was removed (Undo puts each back). */
export function deleteComment(store: Store, ref: ItemRef, id: string): ItemComment[] {
  const t = readThread(store, ref);
  if (!t.comments.some((x) => x.id === id)) throw new ApsError('ValidationError', `No comment ${id} on this item`);
  const removed = t.comments.filter((x) => x.id === id || x.replyTo === id);
  t.comments = t.comments.filter((x) => !removed.includes(x));
  writeThread(store, t);
  return removed;
}

/** Put a deleted comment back as it was (Undo in the app). */
export function restoreComment(store: Store, ref: ItemRef, comment: ItemComment): ItemComment {
  if (!comment || typeof comment.text !== 'string' || !comment.id) throw new ApsError('ValidationError', 'Not a comment');
  const t = readThread(store, ref);
  if (!t.comments.some((x) => x.id === comment.id)) t.comments.push(comment);
  t.comments.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  writeThread(store, t);
  return comment;
}

/** Every comment of the workspace that is still open, newest first (the list a person or an agent works through). */
export function openComments(store: Store): OpenComment[] {
  const dir = join(store.root, COMMENTS_DIR);
  if (!existsSync(dir)) return [];
  const out: OpenComment[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    // each file on its own: one that cannot be read (git conflict markers) is left out with a warning, the others are listed
    let raw: Partial<ItemCommentThread> | null;
    try {
      raw = readJson<Partial<ItemCommentThread>>(join(dir, f), {});
    } catch (e) {
      skipBroken(store, f, e);
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const ref = toItemRef(raw.ref);
    if (!ref || !Array.isArray(raw.comments)) continue;
    // a reply is open while the comment it answers is (settling a thread settles its replies)
    const settled = new Set(raw.comments.filter((c) => c?.resolvedAt).map((c) => c.id));
    for (const c of raw.comments) if (c && typeof c.text === 'string' && !c.resolvedAt && !(c.replyTo && settled.has(c.replyTo))) out.push({ ...c, ref });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** How many open comments each item has: `itemRefIdentity(ref)` → count (the rows' marks). */
export function openCommentCounts(store: Store): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of openComments(store)) {
    const k = itemRefIdentity(c.ref);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
