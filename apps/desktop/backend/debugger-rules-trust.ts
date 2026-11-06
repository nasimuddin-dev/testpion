/**
 * Which Debugger rules may act on traffic on this computer. The rules live in debugger/rules.json, a file the team shares
 * through git: one that arrives with a pull or a clone could redirect this computer's traffic to another host, answer
 * for a real server, change headers or run a script on every request the Debugger forwards, with no click at all. So the
 * rules that change traffic (everything but filter, capture only and highlight) act only once the person approved the
 * file as it is here: by changing the rules in this app while they were allowed, or with "Allow on this computer". A
 * pulled change to a rule that changes traffic waits again. Kept in the app's own folder, never in the workspace.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DebuggerRule, DebuggerRulesFile } from '@testpion/core';
import type { Backend } from './backend.js';

/** Rules that only decide what is listed or how it looks: they act without asking. */
const LOOK_ONLY = new Set<DebuggerRule['kind']>(['ignore', 'only', 'highlight']);

/** Whether a rule changes traffic (and so waits for approval when it came from elsewhere). */
export const changesTraffic = (r: Pick<DebuggerRule, 'kind'>) => !LOOK_ONLY.has(r.kind);

/** A value as text with the keys of every object, at every depth, in one order (so the same rule is the same text). */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

/**
 * What a rule acts with that lives in a workspace file: a script rule's `script.file`, a reply's `file` or `folder`.
 * A pulled change to that file is a change to what the rule does, so it is part of the approval (the content of a file,
 * the names, sizes and times of a folder's files).
 */
function filesOf(r: DebuggerRule, root: string | undefined): string[] {
  if (!root) return [];
  const out: string[] = [];
  const at = (p: unknown) => (typeof p === 'string' && p ? resolve(root, p) : undefined);
  const reply = r.reply as { file?: unknown; folder?: unknown } | undefined;
  for (const f of [at(r.script?.file), at(reply?.file)])
    if (f)
      try {
        out.push(createHash('sha256').update(readFileSync(f)).digest('hex'));
      } catch {
        out.push('missing');
      }
  const folder = at(reply?.folder);
  if (folder)
    try {
      out.push(
        readdirSync(folder, { recursive: true })
          .map(String)
          .sort()
          .map((n) => ((s) => `${n}:${s.size}:${s.mtimeMs}`)(statSync(join(folder, n))))
          .join('|'),
      );
    } catch {
      out.push('missing');
    }
  return out;
}

/** What an approval covers: the rules that change traffic, in every profile, all their fields and the files they read. A highlight's color is not part of it. */
export function rulesFingerprint(f: DebuggerRulesFile, root?: string): string {
  const acting = Object.keys(f.profiles)
    .sort()
    .map((name) => [name, (f.profiles[name] ?? []).filter(changesTraffic).map((r) => [stable(r), ...filesOf(r, root)])]);
  return createHash('sha256').update(stable(acting)).digest('hex').slice(0, 32);
}

/** No rule of the file changes traffic: nothing to approve. */
const nothingToApprove = (f: DebuggerRulesFile) => !Object.values(f.profiles).some((list) => list.some(changesTraffic));

const fileOf = (be: Backend) => join(be.host.appDir, 'debugger-trust', `${be.ws.id}.json`);

function stored(be: Backend): string | undefined {
  const file = fileOf(be);
  if (!existsSync(file)) return undefined;
  try {
    const v = (JSON.parse(readFileSync(file, 'utf8')) as { approved?: unknown }).approved;
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the rules of this file that change traffic may act on this computer. */
export function rulesApproved(be: Backend, f: DebuggerRulesFile): boolean {
  return nothingToApprove(f) || stored(be) === rulesFingerprint(f, be.ws.root);
}

/** The person allowed the rules as they are now (or changed them here while they were allowed). */
export function approveRules(be: Backend, f: DebuggerRulesFile): void {
  const file = fileOf(be);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ approved: rulesFingerprint(f, be.ws.root) }, null, 2));
  } catch (e) {
    be.logger.warn(`Could not save which Debugger rules may act here: ${(e as Error).message}`);
  }
}
