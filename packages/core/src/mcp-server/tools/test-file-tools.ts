import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApsError } from '../../errors.js';
import { TOOL_DETAILS } from '../tool-contract.js';
import { checkTypes } from '../../eval/checks.js';
import type { CheckConfig, CollectionNode } from '../../model/types.js';
import { isSuiteFile, loadSuite, loadTestsFromFile } from '../../runner/loader.js';
import { collectionVariableFlow, definedVariableNames, unusedVariables } from '../../runner/variable-flow.js';
import { checkedTestFilePath } from '../../storage/test-path.js';
import { shortId } from '../../util/ids.js';
import { agentGuide } from '../agent-kit.js';
import { str } from '../tool.js';
import type { Tool } from '../tool.js';
import type { ModuleToolDeps } from './deps.js';

/** Writing tests: unused and flowing variables, the guide, checks on a request, test files. */
export function testFileTools(d: ModuleToolDeps): Tool[] {
  const { store, settings, findCollection, findRequest, readOnly } = d;
  return [
    {
      name: 'unused_variables',
      description:
        'Variables defined in environments and the workspace that nothing in the workspace reads ({{name}} in requests, saved items, MCP servers, test files or other variables, or a script get). Use it to clean up; variable_usages double-checks one name before deleting it.',
      inputSchema: { type: 'object', properties: {} },
      run: () => unusedVariables(store),
    },
    {
      name: 'variable_flow',
      description:
        'How variables flow through a collection run: for each variable, the requests (or collection / folder scripts) that set it with tp.environment.set etc., and the requests that use it ({{name}} or a script get), in run order. Flags used-before-set (a request uses it before any script sets it and no environment defines it), never-set and unused. Use it to debug request chaining.',
      inputSchema: { type: 'object', properties: { collection: str('Collection name or id') }, required: ['collection'] },
      run: (a) => {
        const c = findCollection(a.collection);
        return collectionVariableFlow(c, definedVariableNames(store, settings));
      },
    },
    {
      name: 'testpion_guide',
      description:
        'How to use this TestPion workspace: which tool to use for what, how variables resolve, every check type this engine knows (with examples) and the YAML test file format. Read it before writing checks or test files.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => agentGuide({ workspace: store.workspace.name, checkTypes: checkTypes(), readOnly: readOnly, toolDetails: TOOL_DETAILS }),
    },
    {
      name: 'set_request_checks',
      write: true,
      description:
        'Set the checks (assertions) of a saved REST or GraphQL request: they run whenever it is sent, in the app, in run_collection and in CI. `mode: "append"` (default) adds them, `"replace"` replaces the existing ones. Each check is { type, name?, path?, expected?, … } (see testpion_guide for the types); unknown types are refused. Returns the request\'s checks.',
      inputSchema: {
        type: 'object',
        properties: {
          collection: str('Collection name or id'),
          request: str('Request name or id'),
          checks: { type: 'array', items: { type: 'object', properties: { type: { type: 'string' } }, required: ['type'] }, description: 'Checks, e.g. [{ "type": "status", "expected": 200 }, { "type": "exists", "path": "$.id" }]' },
          mode: { type: 'string', enum: ['append', 'replace'], description: 'append (default) or replace' },
        },
        required: ['collection', 'request', 'checks'],
      },
      run: (a) => {
        const c = findCollection(a.collection);
        const { node } = findRequest(c, a.request);
        if ((node as { kind: string }).kind !== 'http' && (node as { kind: string }).kind !== 'graphql') throw new ApsError('ValidationError', `"${node.name}" is not a REST or GraphQL request`);
        const checks = Array.isArray(a.checks) ? (a.checks as CheckConfig[]) : [];
        const known = new Set(checkTypes());
        const unknown = checks.filter((k) => !k || typeof k.type !== 'string' || !known.has(k.type)).map((k) => String(k?.type));
        if (unknown.length) throw new ApsError('ValidationError', `Unknown check type: ${unknown.join(', ')}. Known: ${[...known].join(', ')}`);
        const next = a.mode === 'replace' ? checks : [...(node.assertions ?? []), ...checks];
        const map = (nodes: CollectionNode[]): CollectionNode[] => nodes.map((n) => (n.kind === 'folder' ? { ...n, items: map(n.items) } : n.id === node.id ? ({ ...n, assertions: next } as CollectionNode) : n));
        store.saveCollection({ ...c, items: map(c.items) });
        return { collection: c.name, request: node.name, checks: next };
      },
    },
    {
      name: 'write_test_file',
      write: true,
      description:
        'Write a YAML (or JSON) test file under tests/ for `testpion test`, run_tests and CI. The content is checked first: it must parse as TestPion tests or a suite (*.suite.yaml) and use known check types, otherwise nothing is written and the error says why. An existing file is only replaced with `overwrite: true`. See testpion_guide for the format. Returns the path and the tests it holds.',
      inputSchema: {
        type: 'object',
        properties: {
          path: str('Path inside tests/, e.g. "rest/pets.yaml" or "smoke.suite.yaml"'),
          content: str('The file content (YAML or JSON)'),
          overwrite: { type: 'boolean', description: 'Replace the file when it exists (default false)' },
        },
        required: ['path', 'content'],
      },
      run: async (a) => {
        // the same rules on every OS as an AI proposal's file (storage/test-path.ts): / between folders, inside tests/, .yaml/.yml/.json
        const { rel, abs: dest } = checkedTestFilePath(store.path('tests'), String(a.path ?? ''));
        if (existsSync(dest) && a.overwrite !== true) throw new ApsError('ConfigurationError', `tests/${rel} exists; pass overwrite: true to replace it`);
        // parse a copy first, so a broken file never lands in the workspace
        const tmp = join(tmpdir(), `testpion-check-${shortId('t-')}-${rel.split('/').pop()}`);
        writeFileSync(tmp, String(a.content ?? ''));
        try {
          if (isSuiteFile(tmp)) {
            const suite = await loadSuite(tmp);
            store.writeTestFile(rel, String(a.content));
            return { path: `tests/${rel}`, suite };
          }
          const known = new Set(checkTypes());
          const tests: Array<{ id?: string; name: string; type: string; checks: number }> = [];
          const unknown = new Set<string>();
          for await (const t of loadTestsFromFile(tmp)) {
            const checks = ((t as { assertions?: CheckConfig[] }).assertions ?? []) as CheckConfig[];
            checks.forEach((k) => !known.has(k.type) && unknown.add(String(k.type)));
            tests.push({ id: t.id, name: t.name, type: t.type, checks: checks.length });
            if (tests.length >= 1000) break;
          }
          if (!tests.length) throw new ApsError('ValidationError', 'No tests in the content: give one test (type, url …) or a tests: list (see testpion_guide)');
          if (unknown.size) throw new ApsError('ValidationError', `Unknown check type: ${[...unknown].join(', ')}. Known: ${[...known].join(', ')}`);
          store.writeTestFile(rel, String(a.content));
          return { path: `tests/${rel}`, tests };
        } finally {
          rmSync(tmp, { force: true });
        }
      },
    },
  ];
}
