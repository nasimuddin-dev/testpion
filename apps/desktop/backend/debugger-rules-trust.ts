/**
 * Which Debugger rules may act on traffic on this computer. The rules live in debugger/rules.json, a file the team shares
 * through git: one that arrives with a pull or a clone could redirect this computer's traffic to another host, answer
 * for a real server, change headers or run a script on every request the Debugger forwards, with no click at all. So the
 * rules that change traffic (everything but filter, capture only and highlight) act only once the person approved the
 * file as it is here: by changing the rules in this app while they were allowed, or with "Allow on this computer". A
 * pulled change to a rule that changes traffic waits again. Kept in the app's own folder, never in the workspace.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DebuggerRule, DebuggerRulesFile } from '@testpion/core';
import type { Backend } from './backend.js';

/** Rules that only decide what is listed or how it looks: they act without asking. */
const LOOK_ONLY = new Set<DebuggerRule['kind']>(['ignore', 'only', 'highlight']);

/** Whether a rule changes traffic (and so waits for approval when it came from elsewhere). */
export const changesTraffic = (r: Pick<DebuggerRule, 'kind'>) => !LOOK_ONLY.has(r.kind);

/** What an approval covers: the rules that change traffic, in every profile. A highlight's color is not part of it. */
export function rulesFingerprint(f: DebuggerRulesFile): string {
  const acting = Object.keys(f.profiles)
    .sort()
    .map((name) => [name, (f.profiles[name] ?? []).filter(changesTraffic).map((r) => JSON.stringify(r, Object.keys(r).sort()))]);
  return createHash('sha256').update(JSON.stringify(acting)).digest('hex').slice(0, 32);
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
  return nothingToApprove(f) || stored(be) === rulesFingerprint(f);
}

/** The person allowed the rules as they are now (or changed them here while they were allowed). */
export function approveRules(be: Backend, f: DebuggerRulesFile): void {
  const file = fileOf(be);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ approved: rulesFingerprint(f) }, null, 2));
  } catch (e) {
    be.logger.warn(`Could not save which Debugger rules may act here: ${(e as Error).message}`);
  }
}
