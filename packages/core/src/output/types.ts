/**
 * The shapes of the output builders (sources.ts): what is written (chunks, as they come), and what the builders need
 * from the host (OutputDeps). The window's backend, the CLI and the MCP server each give their deps; the bytes are built
 * here, once, so all of them save the same file.
 */
import type { GridSourceId } from '@testpion/shared';
import type { TestResult } from '../model/types.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import type { Redactor } from '../util/redact.js';
import type { LogRecord } from '../log/logger.js';

/** What is written: chunks, as they come (a source streams; content is one chunk). */
export type Chunks = AsyncIterable<Buffer | string>;

export interface Built {
  chunks: Chunks;
  /** Bytes, when known before writing (progress). */
  total?: number;
  /** A sample of the output's text, for the raw-notice check. */
  sample?: () => string | Promise<string>;
  redacted: boolean;
}

/** How much of a raw output is looked at for the "looks like it holds a secret" notice. */
export const SAMPLE_BYTES = 1024 * 1024;

export async function* one(x: Buffer | string): Chunks {
  yield x;
}

/** A line of the console (the window's bottom panel): what the builders read of an entry. */
export interface ConsoleLine {
  time: string;
  kind?: string;
  method: string;
  url: string;
  status?: number | string;
  durationMs?: number;
  error?: string;
  logs: Array<{ phase: string; message: string }>;
}

/** A page of a grid's rows, as the grid's RPC gives it (GRID_SOURCES). */
export interface GridPage {
  rows: Array<Record<string, unknown>>;
  matched?: number;
  total?: number;
  columns?: Array<{ label: string }>;
}

/** The Debugger session as HAR, as far as the builders read it. */
interface HarLike {
  log: {
    entries: Array<{ startedDateTime: string; time: number; request: { method: string; url: string }; response: { status: number; content?: { size?: number; mimeType?: string } } }>;
  };
}

/**
 * What the builders need from their host, by what it is (never by the name of an RPC). The workspace and the redactor
 * are always there; a run's results, the evaluation matrix and the flow timeline are read from the workspace by default
 * (`storeOutputDeps`); the host gives what only it holds: the console and the log of a running app, the Debugger's
 * session, a data run in progress. A source whose dependency the host lacks is refused with a message saying so.
 */
export interface OutputDeps {
  store: WorkspaceStore;
  redactor: Redactor;
  /** The results of a finished run, one at a time. */
  results(runId: string): AsyncIterable<TestResult>;
  /** A page of a data run's rows (the run in progress when the host has it, else from disk). */
  scaleRows(params: Record<string, unknown>): Promise<GridPage> | GridPage;
  /** A page of an evaluation matrix. */
  evalMatrix(params: Record<string, unknown>): Promise<GridPage> | GridPage;
  /** A run or flow timeline, as data. */
  flowTimeline(p: { file?: string; runId?: string }): Promise<unknown> | unknown;
  /** The console of the running app (a host without one lacks this). */
  consoleEntries?(): readonly ConsoleLine[];
  /** The application log of the running app. */
  logEntries?(): readonly LogRecord[];
  /** The Debugger's session as HAR. */
  har?(): Promise<HarLike> | HarLike;
}

/** The grid ids the builders know (GRID_SOURCES). */
export type { GridSourceId };
