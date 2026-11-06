/**
 * Which monitors may run on their schedule on this computer. Monitors live in library/monitors.json, a file the team
 * shares through git: one that arrives with a pull or a clone (or was changed outside this app) could send requests
 * every minute, with this person's secrets, to wherever its author chose, with no click at all. So the schedule runs a
 * monitor only once the person approved it here: by saving it in this app, or with "Allow on this computer". The
 * approval is for what the monitor does (its target, environment, schedule, webhook and production consent): a pulled
 * change to any of those waits again. Kept in the app's own folder, never in the workspace. Run now always works: the
 * person clicked.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { lastMonitorResult, listMonitorDefinitions, type Monitor } from '@testpion/core';
import type { Backend } from './backend.js';

interface TrustFile {
  approved: Record<string, string>;
}

const fileOf = (be: Backend) => join(be.host.appDir, 'monitor-trust', `${be.ws.id}.json`);
/** The definition a monitor comes from (a tenant "<id>@<environment>" is its definition's). */
const definitionId = (m: Pick<Monitor, 'id' | 'tenant'>) => m.tenant?.of ?? m.id.split('@')[0]!;

/** What an approval covers: change any of it and the monitor waits again. */
export function monitorFingerprint(m: Monitor): string {
  const what = [m.collectionId ?? '', m.selection ?? [], m.testFile ?? '', m.evaluation ?? '', m.environment ?? '', m.environmentGroup ?? '', m.everyMinutes, m.enabled, m.webhook ?? '', !!m.allowProduction, [...(m.allowProductionFor ?? [])].sort()];
  return createHash('sha256').update(JSON.stringify(what)).digest('hex').slice(0, 32);
}

const cache = new WeakMap<Backend, { file: string; data: TrustFile }>();

function read(be: Backend): TrustFile {
  const file = fileOf(be);
  const hit = cache.get(be);
  if (hit?.file === file) return hit.data;
  let data: TrustFile;
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<TrustFile>;
      data = { approved: raw.approved && typeof raw.approved === 'object' ? { ...raw.approved } : {} };
    } catch {
      data = { approved: {} };
    }
  } else {
    // the first time on this computer: the monitors that already ran here were this person's (an older version ran
    // them without asking); one that never ran here (a fresh clone) waits
    data = { approved: {} };
    try {
      for (const m of listMonitorDefinitions(be.ws)) {
        const ran = lastMonitorResult(be.ws, m.id) ?? (m.environmentGroup ? firstTenantResult(be, m) : undefined);
        if (ran) data.approved[m.id] = monitorFingerprint(m);
      }
    } catch {
      /* an unreadable monitors file: nothing is approved */
    }
    write(be, file, data);
  }
  cache.set(be, { file, data });
  return data;
}

function firstTenantResult(be: Backend, m: Monitor) {
  for (const e of be.ws.listEnvironments()) {
    const r = lastMonitorResult(be.ws, `${m.id}@${e.id}`);
    if (r) return r;
  }
  return undefined;
}

function write(be: Backend, file: string, data: TrustFile): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    be.logger.warn(`Could not save which monitors may run here: ${(e as Error).message}`);
  }
}

/** Whether the schedule may run this monitor on this computer. */
export function monitorApproved(be: Backend, m: Monitor): boolean {
  try {
    const id = definitionId(m);
    const def = m.tenant || m.id !== id ? listMonitorDefinitions(be.ws).find((d) => d.id === id) : m;
    return !!def && read(be).approved[id] === monitorFingerprint(def);
  } catch {
    return false;
  }
}

/** The person saved or allowed this monitor here: its schedule runs on this computer. */
export function approveMonitor(be: Backend, m: Monitor): void {
  const id = definitionId(m);
  const def = listMonitorDefinitions(be.ws).find((d) => d.id === id);
  if (!def) return;
  const data = read(be);
  data.approved[id] = monitorFingerprint(def);
  write(be, fileOf(be), data);
}
