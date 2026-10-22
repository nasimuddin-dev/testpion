/**
 * The CLI's one writer of machine-readable output. With `--json` every command prints one envelope:
 *
 *   { schema_version, command, status: 'ok' | 'failed' | 'error', data, errors: [{ code, message, hint, retryable }],
 *     warnings, metrics }
 *
 * `data` is what the command printed as JSON before the envelope (so migrating a script is `jq .data`). With `--jsonl`
 * (the commands that stream: runs, servers, data runs) every event is a line `{ schema_version, command, type, data }`
 * as it happens, and the last line is the envelope with `type: 'result'`. The envelope is written when the command
 * ends, so its status follows the exit code: 0 ok, 1 failed (a test or check failed), 2 / 3 error.
 */
import { errorEnvelope } from '@testpion/core';

export const SCHEMA_VERSION = 1;

interface EnvelopeError {
  code: string;
  message: string;
  hint?: string;
  retryable: boolean;
}

export interface Envelope {
  schema_version: number;
  command: string;
  status: 'ok' | 'failed' | 'error';
  data: unknown;
  errors: EnvelopeError[];
  warnings: string[];
  metrics: { duration_ms: number; exit_code: number };
  /** With --dry-run: what the command would have changed (see dry-run.ts). */
  dry_run?: unknown;
  /** A list that was cut: how many there are, and the cursor of the next page (see notePage). */
  page?: PageNote;
  type?: 'result';
}

/** What the envelope says of a list command's page (the data stays the plain list). */
export interface PageNote {
  total: number;
  limit: number;
  truncated: boolean;
  nextCursor?: string;
}

/** The command being run and what it asked for (set by the program's preAction hook). */
export const cli = {
  command: '',
  json: false,
  jsonl: false,
  nonInteractive: false,
  startedAt: Date.now(),
  outputs: [] as unknown[],
  warnings: [] as string[],
  /** The data part was streamed (a long run's rows): only the envelope's tail is left to write. */
  streamed: false,
  dryRun: undefined as unknown,
  page: undefined as PageNote | undefined,
  /** The command supports --json or --jsonl (a failure without it suggests it). */
  canJson: false,
  /** An error the command reported without throwing (it still printed its data, then set an error exit code). */
  error: undefined as unknown,
};

export function beginCommand(command: string, opts: { json?: unknown; jsonl?: unknown; nonInteractive?: unknown }, canJson: boolean): void {
  cli.command = command;
  cli.jsonl = opts.jsonl === true;
  cli.json = !cli.jsonl && opts.json === true;
  cli.nonInteractive = opts.nonInteractive === true || process.env.TESTPION_NON_INTERACTIVE === '1' || !!process.env.CI;
  cli.canJson = canJson;
  cli.startedAt = Date.now();
  cli.error = undefined;
  cli.page = undefined;
  // stdout is the JSON's alone: what a command prints for people goes to stderr
  if (cli.json || cli.jsonl) console.log = console.info = (...a: unknown[]) => console.error(...a);
}

/** console.log as it was (a command that prints JSON without --json still prints it on stdout). */
const log = console.log.bind(console);

/** Machine-readable output is on (envelope or lines): human text must stay off stdout. */
export const machine = () => cli.json || cli.jsonl;

const write = (s: string) => process.stdout.write(s);

/**
 * `--json` output of a command: kept for the envelope (written when the command ends). Without --json / --jsonl (a
 * command that always prints JSON, e.g. a decoded token) it is printed as it is, as before.
 */
export function printJson(value: unknown): void {
  if (machine()) cli.outputs.push(value);
  else log(JSON.stringify(value, null, 2));
}

/**
 * The result of a command: with --json / --jsonl it is the envelope's data; otherwise `human` prints it for people. For
 * the commands that used to print only text (or a raw file), so every command answers in the same envelope.
 */
export function respond(data: unknown, human: () => void): void {
  if (machine()) cli.outputs.push(data);
  else human();
}

/** One event of a streaming command (`--jsonl`): a line now. Without --jsonl nothing is printed. */
export function emitEvent(type: string, data: unknown): void {
  if (!cli.jsonl) return;
  write(`${JSON.stringify({ schema_version: SCHEMA_VERSION, command: cli.command, type, data })}\n`);
}

/** The page a list command printed: the envelope's `page` says how many there are and the cursor of the next page. */
export function notePage(p: PageNote): void {
  cli.page = p;
}

/** A warning: on stderr as always, and in the envelope's warnings. */
export function noteWarning(message: string): void {
  cli.warnings.push(message);
}

/**
 * The data of the envelope written as it comes (a run of 100,000 rows needs no memory): the head goes out now, the
 * command writes the data's JSON text with the returned function, and the tail is written when the command ends.
 */
export function streamData(): (chunk: string) => void {
  cli.streamed = true;
  write(`{"schema_version":${SCHEMA_VERSION},"command":${JSON.stringify(cli.command)},"data":`);
  return write;
}

/**
 * An error the command reports while it goes on (it prints its data and ends with exit code 2 or 3, not by throwing):
 * the envelope's `errors` lists it. The first one counts.
 */
export function noteError(e: unknown): void {
  cli.error ??= e;
}

/** An error as the envelope lists it: the one shape the MCP tools use too (errorEnvelope in @testpion/core). */
const envelopeError = (e: unknown, exitCode?: number): EnvelopeError => errorEnvelope(e, { exitCode }) as EnvelopeError;

const statusOf = (exitCode: number): Envelope['status'] => (exitCode === 0 ? 'ok' : exitCode === 1 ? 'failed' : 'error');

/** Write the envelope (or the jsonl result line) once the command has ended with `exitCode`, and `error` if it threw. */
export function finishOutput(exitCode: number, error?: unknown): void {
  if (!machine()) return;
  // an error exit code always comes with an error: the one thrown, else the one the command noted, else what the code says
  const err = error ?? cli.error;
  const errors =
    err !== undefined
      ? [envelopeError(err, exitCode)]
      : exitCode > 1
        ? [{ code: exitCode === 2 ? 'ConfigurationError' : 'ExecutionError', message: `${cli.command || 'The command'} ended with exit code ${exitCode}`, retryable: false }]
        : [];
  const metrics = { duration_ms: Date.now() - cli.startedAt, exit_code: exitCode };
  const rest = { status: statusOf(exitCode), errors, warnings: cli.warnings, metrics, ...(cli.dryRun !== undefined ? { dry_run: cli.dryRun } : {}), ...(cli.page ? { page: cli.page } : {}) };
  if (cli.streamed) {
    // the data was streamed: close the document with the rest of the envelope
    const tail = JSON.stringify(rest);
    write(`,${tail.slice(1)}\n`);
    return;
  }
  const data = cli.outputs.length === 0 ? null : cli.outputs.length === 1 ? cli.outputs[0] : cli.outputs;
  const { status, ...more } = rest;
  const env: Envelope = { schema_version: SCHEMA_VERSION, command: cli.command, status, data, ...more };
  if (cli.jsonl) write(`${JSON.stringify({ ...env, type: 'result' })}\n`);
  else write(`${JSON.stringify(env, null, 2)}\n`);
}
