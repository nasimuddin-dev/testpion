/**
 * The command line's structure after every module registered its commands: related commands live under one word, and the
 * help lists them in groups.
 *
 * - `lint` is three commands (a collection, test files, OpenAPI documents), `mock` three (a collection's examples, an MCP
 *   server, a GraphQL schema) and `openapi` five (diff, ops, drift, coverage, fuzz). Each used to be a top-level word
 *   with a hyphen; the old spelling still works (LEGACY below), so scripts, CI files and docs written for it keep running.
 * - `lint <collection>` and `mock <collection>` still work as before: the group's default is the collection form.
 */
import type { Command } from 'commander';

interface Move {
  from: string;
  group: string;
  as: string;
  isDefault?: boolean;
}

const MOVES: Move[] = [
  { from: 'lint', group: 'lint', as: 'collection', isDefault: true },
  { from: 'lint-tests', group: 'lint', as: 'tests' },
  { from: 'openapi-lint', group: 'lint', as: 'openapi' },
  { from: 'mock', group: 'mock', as: 'collection', isDefault: true },
  { from: 'mock-mcp', group: 'mock', as: 'mcp' },
  { from: 'mock-graphql', group: 'mock', as: 'graphql' },
  { from: 'openapi-diff', group: 'openapi', as: 'diff' },
  { from: 'openapi-ops', group: 'openapi', as: 'ops' },
  { from: 'openapi-drift', group: 'openapi', as: 'drift' },
  { from: 'coverage', group: 'openapi', as: 'coverage' },
  { from: 'fuzz', group: 'openapi', as: 'fuzz' },
  // into groups that already exist: the run history kept on disk is part of the history, what a workspace was allowed is part of the workspace
  { from: 'runs', group: 'history', as: 'runs' },
  { from: 'trust', group: 'workspace', as: 'trust' },
];

const GROUP_TEXT: Record<string, string> = {
  lint: 'review things before they cause trouble: a collection (the default: `lint <collection>`), test files (`lint tests`), OpenAPI documents (`lint openapi`)',
  mock: "serve a fake API on localhost until Ctrl+C: a collection's saved examples (the default: `mock <collection>`), a fake MCP server (`mock mcp`), typed data for a GraphQL schema (`mock graphql`)",
  openapi: 'OpenAPI / Swagger tools: diff two versions, list operations, drift against real traffic, coverage by your runs, fuzz (`lint openapi` checks a document)',
};

/** The old top-level spelling of a command and what it is now (so nothing written for it breaks). */
export const LEGACY: Record<string, string> = Object.fromEntries(MOVES.filter((m) => m.from !== m.group).map((m) => [m.from, `${m.group} ${m.as}`]));

/** `openapi-lint` is `lint openapi`; `openapi lint` (the natural guess) is the same. */
export function rewriteLegacy(argv: string[]): string[] {
  const word = argv[2];
  if (word === undefined) return argv;
  const to = LEGACY[word];
  if (to) return [...argv.slice(0, 2), ...to.split(' '), ...argv.slice(3)];
  if (word === 'openapi' && argv[3] === 'lint') return [...argv.slice(0, 2), 'lint', 'openapi', ...argv.slice(4)];
  return argv;
}

/** Which part of the help each top-level command is listed under. */
const HELP_GROUPS: Record<string, string[]> = {
  'Run and test:': ['test', 'run', 'run-collection', 'load', 'send', 'report', 'eval', 'rag', 'record', 'monitor', 'flow', 'flows', 'serve', 'wait-for', 'ci', 'security', 'generate', 'tests-from-spec', 'integration-suite', 'generate-data'],
  'Servers and protocols:': ['mock', 'mcp', 'mcp-server', 'graphql-subscribe', 'graphql-op', 'debug', 'ws', 'mqtt', 'kafka', 'grpc'],
  'Check and review:': ['lint', 'openapi', 'vars', 'variable-flow', 'secrets', 'certificates', 'attention', 'tidy', 'replace', 'doctor', 'jwt'],
  'Workspace and data:': ['workspace', 'env', 'import', 'import-report', 'import-undo', 'export', 'export-environment', 'docs', 'bundle', 'scripts', 'collections', 'requests', 'datasets', 'storage', 'trash', 'item', 'open', 'search', 'kinds', 'output', 'settings', 'auth'],
  'History and reports:': ['history', 'load-history', 'workspace-report', 'diff'],
  'Git:': ['git'],
  'For AI agents:': ['ai', 'agent-info', 'agents', 'agents-md', 'feedback'],
};

/** Move the related commands under their group, and put every top-level command in a help group. */
export function regroup(program: Command): void {
  // take the commands out first (a group may have the name of one of them)
  const taken = new Map<string, Command>();
  for (const m of MOVES) {
    const c = program.commands.find((x) => x.name() === m.from);
    if (!c) continue;
    (program.commands as Command[]).splice(program.commands.indexOf(c), 1);
    taken.set(m.from, c);
  }
  const groups = new Map<string, Command>();
  for (const m of MOVES) {
    const c = taken.get(m.from);
    if (!c) continue;
    // a group that is a command of its own already (`history`, `workspace`) takes the moved command as one more subcommand
    let g = groups.get(m.group) ?? program.commands.find((x) => x.name() === m.group);
    if (!g) {
      g = program.command(m.group).description(GROUP_TEXT[m.group] ?? m.group);
    }
    groups.set(m.group, g);
    c.name(m.as);
    c.parent = g;
    (g.commands as Command[]).push(c);
    if (m.isDefault) (g as unknown as { _defaultCommandName?: string })._defaultCommandName = m.as;
  }
  for (const [title, names] of Object.entries(HELP_GROUPS)) for (const n of names) program.commands.find((c) => c.name() === n)?.helpGroup(title);
}
