/**
 * Snoozed problems: a Needs-attention item a person has read and set aside, for a while (an hour, until tomorrow) or until
 * it changes (its words change: a different failure, a new count). Personal and local (`.local/attention-snooze.json`): a
 * teammate pulling the workspace still sees the problem. An expired snooze goes away by itself.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { itemRefKey } from '@testpion/shared';
import { ApsError } from '../errors.js';
import { sha256Hex } from '../util/hash.js';
import { readJson, writeJson } from './fsutil.js';
import type { AttentionItem } from './attention.js';
import type { WorkspaceStore } from './workspace.js';

export interface AttentionSnooze {
  /** Until this time (ISO); absent: until the problem changes. */
  until?: string;
  /** The words of the problem when it was snoozed: when they change, the snooze ends. */
  hash: string;
  at: string;
}

type Store = Pick<WorkspaceStore, 'root'>;
const FILE = ['.local', 'attention-snooze.json'] as const;
const fileOf = (store: Store) => join(store.root, ...FILE);

/** The key of a problem: what it is about (its kind and the whole ref: an environment's id is optional in a ref, yet tells two apart), not its words (the same monitor failing twice is one problem). */
export const attentionKey = (item: Pick<AttentionItem, 'kind' | 'ref'>): string => `${item.kind}|${itemRefKey(item.ref)}`;

/** The words of a problem, hashed: a snooze "until it changes" ends when they do. */
export const attentionHash = (item: Pick<AttentionItem, 'message'>): string => sha256Hex(item.message).slice(0, 12);

export function listSnoozes(store: Store): Record<string, AttentionSnooze> {
  const f = fileOf(store);
  if (!existsSync(f)) return {};
  const raw = readJson<Record<string, AttentionSnooze>>(f, {});
  return raw && typeof raw === 'object' ? raw : {};
}

function save(store: Store, all: Record<string, AttentionSnooze>): void {
  writeJson(fileOf(store), all);
}

/** Snooze a problem: for `minutes`, else until it changes. Returns what is kept. */
export function snoozeAttention(store: Store, item: Pick<AttentionItem, 'kind' | 'ref' | 'message'>, o: { minutes?: number } = {}, now = Date.now()): AttentionSnooze {
  if (o.minutes !== undefined && !(o.minutes >= 1 && o.minutes <= 30 * 1440)) throw new ApsError('ValidationError', 'A snooze is 1 minute to 30 days');
  const s: AttentionSnooze = { hash: attentionHash(item), at: new Date(now).toISOString(), ...(o.minutes !== undefined ? { until: new Date(now + o.minutes * 60_000).toISOString() } : {}) };
  const all = listSnoozes(store);
  all[attentionKey(item)] = s;
  save(store, all);
  return s;
}

export function unsnoozeAttention(store: Store, key: string): boolean {
  const all = listSnoozes(store);
  if (!(key in all)) return false;
  delete all[key];
  save(store, all);
  return true;
}

/** Whether a snooze still holds for a problem now (its time not passed, its words unchanged). */
export function snoozeHolds(s: AttentionSnooze | undefined, item: Pick<AttentionItem, 'message'>, now = Date.now()): boolean {
  if (!s) return false;
  if (s.until && Date.parse(s.until) <= now) return false;
  return s.hash === attentionHash(item);
}

/**
 * The problems to show and the ones set aside, each item with its `key` (to snooze it) and, when snoozed, `snoozed`.
 * Snoozes that no longer hold (the time passed, the problem changed) are dropped from the file.
 */
export function splitSnoozed<T extends Pick<AttentionItem, 'kind' | 'ref' | 'message'>>(store: Store, items: T[], now = Date.now()): { shown: Array<T & { key: string }>; snoozed: Array<T & { key: string; snoozed: AttentionSnooze }> } {
  const all = listSnoozes(store);
  const shown: Array<T & { key: string }> = [];
  const snoozed: Array<T & { key: string; snoozed: AttentionSnooze }> = [];
  const kept = new Set<string>();
  for (const item of items) {
    const key = attentionKey(item);
    const s = all[key];
    if (snoozeHolds(s, item, now)) {
      kept.add(key);
      snoozed.push({ ...item, key, snoozed: s! });
    } else shown.push({ ...item, key });
  }
  // a snooze that ended, or whose problem is gone, is forgotten
  const stale = Object.keys(all).filter((k) => !kept.has(k) && (!items.some((i) => attentionKey(i) === k) || !snoozeHolds(all[k], items.find((i) => attentionKey(i) === k)!, now)));
  if (stale.length) {
    for (const k of stale) delete all[k];
    save(store, all);
  }
  return { shown, snoozed };
}
