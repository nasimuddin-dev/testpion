/**
 * The test-file format, as a model needs it, made from the one source the lint and the editor use (test-schema.ts
 * `testKeys`, the check registry's `checkTypes` / `checkDocs`): never hand-written, so it cannot drift from what the
 * runner accepts. A task that writes test or flow YAML gets the whole reference (step keys, the checks with what each
 * reads, one complete example); a task that writes checks gets the checks alone. Kept small: the budget is tested.
 *
 * `explainCheckProblem` is the matching repair hint: when the lint says a check has no type or an unknown one (a model
 * that put response fields into `assertions:`), the repair turn shows the right entry shape and the allowed types.
 */
import { checkAliases, checkDocs, checkTypes } from '../eval/checks.js';
import { testKeys } from '../runner/test-schema.js';
import type { CheckConfig } from '../model/types.js';
import { scriptApiIfLoaded, scriptReference } from './script-reference.js';

/** The step keys a flow step uses most whose shape the example does not show (name, method and assertions it does; the rest are in the editor's completion). */
const STEP_KEYS = ['id', 'type', 'dependsOn', 'url', 'headers', 'auth', 'body', 'extract', 'if', 'when'];

/** A value written as a YAML flow map: `{ type: status, expected: 201 }`. */
export function flowMap(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map(flowMap).join(', ')}]`;
  if (typeof v === 'object')
    return `{ ${Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${k}: ${flowMap(x)}`)
      .join(', ')} }`;
  if (typeof v === 'string') return /^[\w$.@/-]+$/.test(v) && !/^(true|false|null|\d.*)$/i.test(v) ? v : JSON.stringify(v);
  return String(v);
}

/** A description's first sentence (a colon does not end it: what follows is often the shape), at most about 100 characters, cut at a word. */
const firstSentence = (s: string) => {
  const t = (/^(.*?\.)(\s|$)/.exec(s)?.[1] ?? s).replace(/\s+/g, ' ');
  return t.length > 100 ? `${t.slice(0, 100).replace(/\s+\S*$/, '')} …` : t;
};

/** The checks: one line each for those that read a response (fields and an example), then the other types by name. */
export function checksReference(): string {
  const documented = checkDocs();
  const named = new Set(documented.map((d) => d.type));
  // other names of a type (http-status, response-time …) work too; the reference names each type once
  const aliases = checkAliases();
  const other = checkTypes().filter((t) => !named.has(t) && !aliases[t]);
  return [
    'Checks (assertions:): a list, each entry one map with a type:',
    ...documented.map((d) => `- ${flowMap(d.example)} — ${d.fields}`),
    `Other types (AI, gRPC, GraphQL, MCP): ${other.join(', ')}.`,
    'A response field is not a check: write { type: equals, path: $.field, expected: value }.',
  ].join('\n');
}

/** One complete, valid flow (it is linted in the tests): create → extract the id → read it back with it. */
export const FLOW_EXAMPLE = `name: Pets CRUD
tests:
  - id: create-pet
    type: http
    method: POST
    url: "{{baseUrl}}/pets"
    body: { type: json, content: '{"name": "Rex", "species": "dog"}' }
    extract:
      petId: $.id
    assertions:
      - { type: status, expected: 201 }
      - { type: exists, path: $.id }
  - id: get-pet
    type: http
    method: GET
    url: "{{baseUrl}}/pets/{{petId}}"
    dependsOn: [create-pet]
    assertions:
      - { type: status, expected: 200 }
      - { type: equals, path: $.name, expected: Rex }
`;

/** The whole reference for tasks that write test / flow YAML. */
export function flowFormatReference(): string {
  const http = testKeys('test', 'http');
  const keys = STEP_KEYS.map((k) => http.find((d) => d.key === k)).filter((d): d is NonNullable<typeof d> => !!d);
  return [
    'TestPion test file format (YAML): name:, optional defaults: (keys every step starts with, e.g. auth), and tests: (the steps). Step keys:',
    // the type: its values say it all
    ...keys.map((k) => `- ${k.key}: ${k.key === 'type' && k.values ? k.values.join(' | ') : firstSentence(k.description)}`),
    checksReference(),
    'A complete example:',
    FLOW_EXAMPLE.trimEnd(),
  ].join('\n');
}

export type FormatKind = 'flow' | 'checks' | 'script';

/**
 * The reference a task's instruction gets: the whole test-file format, the checks alone, the tp.* script API (read from
 * the sandbox: `loadScriptApi()` must have run, as `runAiTask` does), or several of them.
 */
export function formatReference(kind: FormatKind | FormatKind[]): string {
  const kinds = Array.isArray(kind) ? kind : [kind];
  return kinds
    .map((k) => {
      if (k === 'flow') return flowFormatReference();
      if (k === 'checks') return kinds.includes('flow') ? '' : checksReference();
      const api = scriptApiIfLoaded();
      return api ? scriptReference(api) : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

/** A lint problem about a check with the right entry shape and the allowed types (see the module comment); others are returned as they are. */
export function explainCheckProblem(message: string): string {
  if (!/A check needs a type|Unknown check type/i.test(message)) return message;
  const docs = checkDocs();
  const shape = docs
    .filter((d) => ['status', 'equals', 'exists', 'type'].includes(d.type))
    .map((d) => `- ${flowMap(d.example)}`)
    .join(' ');
  // the lint lists every type after the colon; the documented ones are what a response check uses
  const head = message.replace(/("[^"]*"): .*$/, '$1');
  return `${head} — likely cause: each entry of assertions: is one check map with a type, e.g. ${shape}; response fields (name: Dog) are not checks — write { type: equals, path: $.name, expected: Dog }. Types for a response: ${docs.map((d) => d.type).join(', ')}.`;
}

/** An example check of a type (for hints), when the type is documented. */
export const checkExample = (type: string): CheckConfig | undefined => checkDocs().find((d) => d.type === type)?.example;
