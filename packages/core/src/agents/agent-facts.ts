/**
 * What an AI coding agent needs to know to work with a TestPion workspace, in one place: the commands and their exit
 * codes, the environment variables, the MCP server setup (`testpion agent-info` prints it as JSON) and the facts of a
 * live workspace (its collections, environments by name, tests, flows, evaluations) that AGENTS.md describes.
 *
 * Never a value: environments are listed by name (and whether they are production), never their variables; a secret
 * value is not even read. Names come from files anyone can edit, so they are made safe for Markdown where they are
 * written (see agent-files.ts).
 */
import { existsSync, readdirSync } from 'node:fs';
import type { CollectionNode } from '../model/types.js';
import type { WorkspaceStore, TestFileNode } from '../storage/workspace.js';
import { exposedFlows } from '../runner/exposed-flows.js';
import { listSavedEvaluations } from '../runner/saved-evaluations.js';
import { listWorkspaceDatasets } from '../runner/datasets.js';
import { MINIMAL_TOOLS } from '../mcp-server/tools/search-tools.js';

/** The process exit codes of every `testpion` command. */
export const EXIT_CODES: Record<'0' | '1' | '2' | '3', string> = {
  0: 'success',
  1: 'a test failed (or a comparison found regressions)',
  2: 'configuration error (a wrong argument, a missing file or workspace)',
  3: 'execution error (the run itself could not complete)',
};

/** The environment variables the CLI and the MCP server read. */
export const AGENT_ENVIRONMENT: Record<string, string> = {
  TESTPION_HOME: 'the app folder (settings, secrets, the workspaces list)',
  'TESTPION_SECRET_<NAME>': 'a secret for {{$secret.<name>}} (dots become underscores: provider.openai.apiKey → TESTPION_SECRET_PROVIDER_OPENAI_APIKEY)',
  NO_COLOR: 'plain output',
};

/**
 * The commands an agent runs, with `w` the workspace argument (` -w "<root>"` from agent-info, ` -w .` in AGENTS.md,
 * which is committed with the workspace and so names no path of this computer).
 */
export function agentCommands(w: string): Record<string, string> {
  return {
    test: `testpion test <paths…>${w} -e <environment> -r json -o <dir>`,
    run: `testpion run${w} --suite <name> -e <environment> -r json -o <dir>`,
    runCollection: `testpion run-collection "<collection>"${w} -e <environment> -r json -o <dir>`,
    send: `testpion send <request or URL>${w} -e <environment> --json`,
    flow: `testpion flow <tests/file.yaml>${w} --json (the steps, what each waits for, the latest run) · testpion flow edit <file>${w} --op '<json>'`,
    evaluation: `testpion eval run "<saved evaluation>"${w} · testpion eval compare <run> --baseline <run>${w} --json`,
    lint: `testpion lint-tests${w} --json`,
    generate: `testpion tests-from-spec specs/<api>.yaml${w} --json · testpion integration-suite <spec | collection>${w} --json`,
    mcpServer: `testpion mcp-server${w} [--profile minimal] [--read-only]`,
    agentsInit: `testpion agents init${w} [--targets agents,claude,cursor] --json`,
    doctor: 'testpion doctor --json',
    open: `testpion open <ref>${w} [--json]: the app opens the item a "ref" names (the ItemRef in --json output and MCP results: {kind, …ids})`,
  };
}

/** How an agent connects over MCP, for a server command such as `testpion mcp-server -w .`. */
export function agentMcp(command: string) {
  return {
    command,
    claudeCode: `claude mcp add testpion -- ${command}`,
    profiles: { full: 'every tool (the default)', minimal: `${MINIMAL_TOOLS.size} tools of the common jobs; search_tools finds the rest` },
    start: 'what_needs_attention, then testpion_guide (the check types and the test file format)',
  };
}

export interface AgentWorkspaceFacts {
  name: string;
  collections: Array<{ name: string; requests: number }>;
  /** Names only, never a variable. */
  environments: Array<{ name: string; production: boolean }>;
  /** Test files under tests/ (paths inside it), suites included. */
  tests: string[];
  suites: string[];
  /** Flows exposed as MCP tools (an expose: block). */
  flows: Array<{ tool: string; file: string }>;
  evaluations: string[];
  datasets: string[];
  specs: string[];
  /** Folders of the workspace that exist (collections, environments, tests …). */
  folders: string[];
}

const requestCount = (nodes: CollectionNode[]): number => nodes.reduce((n, x) => n + (x.kind === 'folder' ? requestCount(x.items ?? []) : 1), 0);

function testFiles(nodes: TestFileNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.kind === 'dir') testFiles(n.children ?? [], out);
    else if (/\.(ya?ml|json)$/i.test(n.name)) out.push(n.path);
  }
  return out;
}

/** A listing that must not stop the rest (a broken file, a folder that is not there): empty on error. */
function safe<T>(f: () => T[]): T[] {
  try {
    return f();
  } catch {
    return [];
  }
}

const byName = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' });

/** The facts of a live workspace an AGENTS.md describes, sorted so the same workspace always gives the same text. */
export function agentWorkspaceFacts(store: WorkspaceStore): AgentWorkspaceFacts {
  const tests = safe(() => testFiles(store.testTree())).sort(byName);
  const specsDir = store.path('specs');
  return {
    name: store.workspace.name,
    collections: safe(() => store.listCollections().filter((c) => !c.problem))
      .map((c) => ({ name: c.name, requests: requestCount(c.items ?? []) }))
      .sort((a, b) => byName(a.name, b.name)),
    environments: safe(() => store.listEnvironments().filter((e) => !e.problem)).map((e) => ({ name: e.name, production: !!e.isProduction })),
    tests: tests.filter((t) => !/\.suite\.(ya?ml|json)$/i.test(t)),
    suites: tests.filter((t) => /\.suite\.(ya?ml|json)$/i.test(t)),
    flows: safe(() => exposedFlows(store).filter((f) => !f.problem && f.tool))
      .map((f) => ({ tool: f.tool, file: f.file }))
      .sort((a, b) => byName(a.tool, b.tool)),
    evaluations: safe(() => listSavedEvaluations(store).map((e) => e.name)).sort(byName),
    datasets: safe(() => listWorkspaceDatasets(store).map((d) => d.path)).sort(byName),
    specs: safe(() => (existsSync(specsDir) ? readdirSync(specsDir).filter((f) => /\.(ya?ml|json)$/i.test(f)) : [])).sort(byName),
    folders: ['collections', 'environments', 'tests', 'specs', 'datasets', 'mocks', 'library'].filter((d) => existsSync(store.path(d))),
  };
}
