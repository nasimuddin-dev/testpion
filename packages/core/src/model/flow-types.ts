/**
 * The flow-only parts of the test model: a step's `forEach:` and `until:`, and the flow blocks that send no request
 * (delay, condition, script, sub-flow, log, set variable, assert). Re-exported from types.ts, where `TestCase` and
 * `TestType` stay.
 */
import type { TestBase } from './types.js';

/** `forEach:` of a step: an inline list of rows, or `{ dataset: path }` (CSV, JSON, JSONL, Markdown; relative to the test file). */
export type ForEachSpec = unknown[] | { dataset: string; limit?: number };

/** `until:` of a step: run it again until `if` is true on its response, waiting `everyMs` (times `backoff`, at most `maxEveryMs`), failing after `timeoutMs`. */
export interface UntilSpec {
  if: string;
  everyMs: number;
  timeoutMs: number;
  backoff: number;
  maxEveryMs: number;
}

/** A pause in a flow: waits `ms` milliseconds (never longer than the test's timeout; a cancelled run stops it at once). */
export interface DelayTest extends TestBase {
  type: 'delay';
  ms: number;
}

/** A condition block: evaluates `if:` and passes; the steps that depend on it with `when: true|false` run on its branch. */
export interface ConditionTest extends TestBase {
  type: 'condition';
  if: string;
}

/** A script block: runs `script:` (the tp.* API) with no request; the variables it sets flow to the steps after it. */
export interface ScriptTest extends TestBase {
  type: 'script';
  script: string;
}

/** A sub-flow: runs another test file as one step with `inputs:` as its variables; its `output:` (or extracted values) come back. */
export interface FlowTest extends TestBase {
  type: 'flow';
  /** The test file to run, relative to this file (or to tests/). */
  flowFile: string;
  inputs?: Record<string, unknown>;
}

/** A log block: shows `message:` (a template) in the run's results. */
export interface LogTest extends TestBase {
  type: 'log';
  message: string;
}

/** Where a Set variable block writes: the run only, or the environment, collection or global variables (kept like a script's tp.environment.set). */
export type SetScope = 'run' | 'environment' | 'collection' | 'global';

/** A Set variable block: writes `set:` (name → template, resolved) to `scope`; no request. */
export interface SetTest extends TestBase {
  type: 'set';
  set: Record<string, unknown>;
  scope: SetScope;
}

/** An Assert block: only checks (`assertions:`), on the previous step's response or on the variables; no request. */
export interface AssertTest extends TestBase {
  type: 'assert';
  subject: 'response' | 'variables';
}
