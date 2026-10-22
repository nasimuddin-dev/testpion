import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { arch, release } from 'node:os';
import { join } from 'node:path';
import { ENGINE_VERSION } from '../version.js';
import { Redactor } from '../util/redact.js';
import { maskReportText } from './feedback.js';
import { writeZip, type ZipEntry } from '../transfer/zip.js';

/**
 * What a person sends when something is wrong (Settings ▸ Privacy & security ▸ Save diagnostics, `testpion diagnostics --json`): versions,
 * settings without secrets, the end of the application log, the shape of the workspace, the slowest calls. Every text goes through
 * `maskReportText` (home folders, tokens, passwords) and the settings through the redactor, so the file can be attached to a public issue.
 */
export interface DiagnosticsInput {
  /** The app's version when it differs from the engine's (the desktop shell). */
  appVersion?: string;
  electron?: string;
  settings?: unknown;
  /** The app folder (`logs/app.log` is read from it) or the log lines directly. */
  appDir?: string;
  logLines?: string[];
  /** Counts and sizes of the open workspace: no names, no paths. */
  workspace?: Record<string, unknown>;
  /** The slowest calls of this session. */
  slowRpcs?: Array<{ method: string; ms: number; at: string }>;
  /** Problems the app reported (a damaged database, a stopped watch, a full disk). */
  problems?: string[];
  secretBackend?: string;
  metaBackend?: string;
}

export interface Diagnostics {
  generatedAt: string;
  versions: Record<string, string | undefined>;
  process: { uptimeSec: number; memoryMb: Record<string, number>; activeHandles?: number };
  backends: { secrets?: string; history?: string };
  settings: unknown;
  workspace?: Record<string, unknown>;
  slowRpcs: Array<{ method: string; ms: number; at: string }>;
  problems: string[];
  /** The last records of the application log (all levels), masked. */
  log: string[];
}

const LOG_LINES = 500;

/** The last `n` lines of a text file (the whole file is read only when it is small; a big log is read from its end). */
export function tailLines(file: string, n = LOG_LINES): string[] {
  try {
    const size = statSync(file).size;
    const take = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(take);
    const fd = openSync(file, 'r');
    try {
      readSync(fd, buf, 0, take, size - take);
    } finally {
      closeSync(fd);
    }
    return buf.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-n);
  } catch {
    return [];
  }
}

/** The value with every string in it masked (objects and lists are walked, not turned into JSON text, where backslashes are doubled). */
function maskStrings<T>(v: T): T {
  if (typeof v === 'string') return maskReportText(v) as T;
  if (Array.isArray(v)) return v.map(maskStrings) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskStrings(x)])) as T;
  return v;
}

const mb = (n: number) => Math.round((n / 1048576) * 10) / 10;

export function collectDiagnostics(i: DiagnosticsInput): Diagnostics {
  const redactor = new Redactor();
  const mem = process.memoryUsage();
  const logFile = i.appDir ? join(i.appDir, 'logs', 'app.log') : undefined;
  const raw = i.logLines ?? (logFile && existsSync(logFile) ? tailLines(logFile) : []);
  const handles = (process as unknown as { getActiveResourcesInfo?: () => string[] }).getActiveResourcesInfo?.().length;
  const d: Diagnostics = {
    generatedAt: new Date().toISOString(),
    versions: {
      testpion: i.appVersion ?? ENGINE_VERSION,
      engine: ENGINE_VERSION,
      electron: i.electron,
      node: process.versions.node,
      platform: `${process.platform} ${release()} ${arch()}`,
    },
    process: {
      uptimeSec: Math.round(process.uptime()),
      memoryMb: { rss: mb(mem.rss), heapUsed: mb(mem.heapUsed), heapTotal: mb(mem.heapTotal), external: mb(mem.external) },
      ...(handles !== undefined ? { activeHandles: handles } : {}),
    },
    backends: { secrets: i.secretBackend, history: i.metaBackend },
    settings: redactor.redact(i.settings ?? {}),
    workspace: i.workspace,
    slowRpcs: (i.slowRpcs ?? []).slice(0, 100),
    problems: i.problems ?? [],
    log: raw.slice(-LOG_LINES),
  };
  // every string, wherever it sits, is masked once more as text (a path in a settings value, a token in a log line)
  return maskStrings(d);
}

/** The text a person reads first. */
export function diagnosticsSummary(d: Diagnostics): string {
  const lines = [
    `TestPion ${d.versions.testpion} (engine ${d.versions.engine})${d.versions.electron ? ` · Electron ${d.versions.electron}` : ''} · Node ${d.versions.node}`,
    d.versions.platform ?? '',
    `Secret storage: ${d.backends.secrets ?? '-'} · History: ${d.backends.history ?? '-'}`,
    `Up ${d.process.uptimeSec} s · memory ${d.process.memoryMb.rss} MB (heap ${d.process.memoryMb.heapUsed} MB)`,
    ...(d.workspace
      ? [
          `Workspace: ${Object.entries(d.workspace)
            .map(([k, v]) => `${k} ${String(v)}`)
            .join(', ')}`,
        ]
      : []),
    ...(d.problems.length ? ['Problems:', ...d.problems.map((p) => `  - ${p}`)] : ['No problems reported.']),
    ...(d.slowRpcs.length ? ['Slowest calls:', ...d.slowRpcs.slice(0, 10).map((s) => `  ${s.ms} ms  ${s.method}`)] : []),
  ];
  return lines.filter((l) => l !== '').join('\n') + '\n';
}

/** The diagnostics as a zip: a summary, the data as JSON and the log as text. */
export function diagnosticsZip(d: Diagnostics): Buffer {
  const entries: ZipEntry[] = [
    { name: 'summary.txt', data: Buffer.from(diagnosticsSummary(d)) },
    { name: 'diagnostics.json', data: Buffer.from(JSON.stringify({ ...d, log: undefined }, null, 2)) },
    { name: 'app-log.txt', data: Buffer.from(d.log.join('\n') + '\n') },
  ];
  return writeZip(entries);
}
