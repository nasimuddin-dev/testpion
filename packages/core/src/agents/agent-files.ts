/**
 * `testpion agents init`: the files AI coding agents read first when they open a folder — AGENTS.md (Codex, Cursor,
 * Copilot, Claude Code via CLAUDE.md, Gemini …), an optional one-line CLAUDE.md pointer and an optional Cursor rule —
 * written into the workspace root from the live workspace.
 *
 * TestPion owns only the part between its markers; everything the user wrote around it is kept byte for byte (line
 * endings, a BOM, the text before and after). Running it again replaces only that part, and writes nothing when the
 * text would not change. A file whose markers are broken (one missing, two blocks) is left alone and reported, unless
 * `force`. One mechanism for the CLI, the MCP tool and the app (agents.init).
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { ApsError } from '../errors.js';
import { atomicWrite } from '../storage/fsutil.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { agentGuide } from '../mcp-server/agent-kit.js';
import { checkTypes } from '../eval/checks.js';
import { agentCommands, agentMcp, agentWorkspaceFacts, EXIT_CODES, type AgentWorkspaceFacts } from './agent-facts.js';

export const AGENT_BEGIN = '<!-- testpion:begin -->';
export const AGENT_END = '<!-- testpion:end -->';
/** The begin marker of 0.45 and earlier (`<!-- testpion:start (written by TestPion; …) -->`): still found and replaced. */
const LEGACY_BEGIN = /^<!-- testpion:start\b[^>]*-->$/;

/** The files an agent reads, by target. */
export const AGENT_TARGETS = { agents: 'AGENTS.md', claude: 'CLAUDE.md', cursor: '.cursor/rules/testpion.mdc' } as const;
export type AgentTarget = keyof typeof AGENT_TARGETS;

/** `agents,claude` / ['agents', 'cursor'] → the targets, checked; AGENTS.md is always one of them (the others point to it). */
export function parseAgentTargets(v: string | string[] | undefined): AgentTarget[] {
  const raw = (Array.isArray(v) ? v : v === undefined ? [] : [v])
    .flatMap((x) => String(x).split(/[\s,]+/))
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  const bad = raw.filter((x) => !(x in AGENT_TARGETS));
  if (bad.length) throw new ApsError('ValidationError', `Unknown target${bad.length > 1 ? 's' : ''} ${bad.map((b) => `"${b}"`).join(', ')}: use ${Object.keys(AGENT_TARGETS).join(', ')}`);
  const set = new Set<AgentTarget>(['agents', ...(raw as AgentTarget[])]);
  return (Object.keys(AGENT_TARGETS) as AgentTarget[]).filter((t) => set.has(t));
}

/* ------------------------------------------------------------------ rendering */

/**
 * A name from the workspace as Markdown text: one line, no HTML (a name holding "<!-- testpion:end -->" must not end
 * the block), no table or code breaks, at most 120 characters.
 */
export function mdName(s: string): string {
  const one = String(s ?? '')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = one.length > 120 ? `${one.slice(0, 119)}…` : one;
  return cut.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '\\|').replace(/`/g, "'") || '(unnamed)';
}

/** At most `max` items as a Markdown list, then "… and N more". */
function list(items: string[], max: number, empty: string): string {
  if (!items.length) return `${empty}\n`;
  const shown = items.slice(0, max).map((x) => `- ${x}`);
  if (items.length > max) shown.push(`- … and ${items.length - max} more`);
  return `${shown.join('\n')}\n`;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** A table cell of commands: each (·-separated) in its own code span, a | escaped so it does not end the cell. */
const cell = (commands: string) =>
  commands
    .split(' · ')
    .map((c) => `\`${c.replace(/\|/g, '\\|')}\``)
    .join('<br>');

/** The server command written into committed files: relative to the workspace, so no path of this computer. */
const MCP_COMMAND = 'testpion mcp-server -w .';

/** The TestPion part of AGENTS.md, between the markers (LF line endings; the writer adapts them to the file). */
export function renderAgentsMd(f: AgentWorkspaceFacts, o: { checkTypes?: string[] } = {}): string {
  const cmd = agentCommands(' -w .');
  const mcp = agentMcp(MCP_COMMAND);
  const production = f.environments.filter((e) => e.production).map((e) => `\`${mdName(e.name)}\``);
  const guide = agentGuide({ workspace: mdName(f.name), checkTypes: o.checkTypes ?? checkTypes() })
    .replace(/^# TestPion for AI agents\n+/, '')
    .replace(/^Workspace: .*\n+/, '')
    .replace(/^## /gm, '### ');
  const folders: Array<[string, string]> = [
    ['collections/', `saved requests, one JSON file per collection${f.collections.length ? ` (${plural(f.collections.length, 'collection')})` : ''}`],
    ['environments/', `variables per environment${f.environments.length ? ` (${f.environments.map((e) => mdName(e.name)).join(', ')})` : ''}; secret values are not in these files`],
    ['tests/', `YAML test files and flows, suites are \`*.suite.yaml\`${f.tests.length + f.suites.length ? ` (${plural(f.tests.length, 'file')}, ${plural(f.suites.length, 'suite')})` : ''}`],
    ['specs/', 'API definitions (OpenAPI, AsyncAPI)'],
    ['datasets/', 'data files (CSV, JSON, JSONL, Markdown, SQLite) for data-driven runs and evaluations'],
    ['mocks/', 'mock servers (REST, MCP, GraphQL)'],
    ['library/', 'saved evaluations, load tests and other items of the app'],
    ['runs/, traces/, reports/, .local/', "results and this computer's state: never committed (.gitignore)"],
  ];
  return `${AGENT_BEGIN}
<!-- Written by TestPion (testpion agents init, or Settings ▸ AI agents in the app). Edit outside the testpion markers: this part is replaced when it is written again. -->
# TestPion workspace: ${mdName(f.name)}

This folder is a [TestPion](https://testpion.dev) workspace: API requests, environments, tests, flows and evaluations as plain files. Prefer the TestPion CLI or its MCP tools to editing the JSON files by hand: they keep ids, references and secrets right.

## What is here

| Folder | What it holds |
|---|---|
${folders.map(([d, w]) => `| \`${d}\` | ${w} |`).join('\n')}

### Collections

${list(
  f.collections.map((c) => `${mdName(c.name)} (${plural(c.requests, 'request')})`),
  30,
  'None yet.',
)}
### Environments

${list(
  f.environments.map((e) => `${mdName(e.name)}${e.production ? ' — **production**' : ''}`),
  30,
  'None yet.',
)}
### Tests and flows

${list([...f.suites.map((s) => `\`tests/${mdName(s)}\` (suite)`), ...f.tests.map((t) => `\`tests/${mdName(t)}\``)], 40, 'None yet: see "Add a test" below.')}${
    f.flows.length
      ? `\nFlows exposed as MCP tools (call them by name):\n\n${list(
          f.flows.map((x) => `\`${mdName(x.tool)}\` — \`tests/${mdName(x.file)}\``),
          30,
          '',
        )}`
      : ''
  }${f.evaluations.length ? `\n### Saved evaluations\n\n${list(f.evaluations.map(mdName), 30, '')}` : ''}${
    f.datasets.length
      ? `\n### Datasets\n\n${list(
          f.datasets.map((d) => `\`${mdName(d)}\``),
          30,
          '',
        )}`
      : ''
  }${
    f.specs.length
      ? `\n### API definitions\n\n${list(
          f.specs.map((s) => `\`specs/${mdName(s)}\``),
          30,
          '',
        )}`
      : ''
  }
## Run things (CLI)

Run from this folder (\`-w .\`); add \`--json\` (or \`-r json -o <dir>\` for runs) to read the results as JSON: one envelope \`{ status, data, errors, warnings }\` (the result is \`.data\`; \`errors[].hint\` says what to do). \`--jsonl\` streams a run a line per result; \`--dry-run\` shows what a command that writes would change.

| Job | Command |
|---|---|
| Run test files or a folder | ${cell(cmd.test)} |
| Run a suite | ${cell(cmd.run)} |
| Run a collection | ${cell(cmd.runCollection)} |
| Send one request | ${cell(cmd.send)} |
| See or edit a flow | ${cell(cmd.flow)} |
| Evaluations | ${cell(cmd.evaluation)} |
| Check test files | ${cell(cmd.lint)} |
| Generate tests | ${cell(cmd.generate)} |

Exit codes: ${Object.entries(EXIT_CODES)
    .map(([k, v]) => `\`${k}\` ${v}`)
    .join(' · ')}. Logs go to stderr, results to stdout.

## MCP server (best for agents)

\`${mcp.command}\` serves this workspace as MCP tools, resources and prompts. Claude Code: \`${mcp.claudeCode}\`. Other clients (Cursor, VS Code, Codex, Claude Desktop):

\`\`\`json
{ "mcpServers": { "testpion": { "command": "testpion", "args": ["mcp-server", "-w", "."] } } }
\`\`\`

\`--read-only\` offers only the tools that look; \`--profile minimal\` lists ${mcp.profiles.minimal}. Start with ${mcp.start}. In the TestPion app, Settings ▸ AI agents has the setup per client and tests the connection.

## Add a request, a test, a flow

- **Request**: MCP \`parse_request_snippet\` then \`save_request\` (a cURL / fetch command; secrets become {{variables}}), or \`update_request\` to change one. Don't write collection JSON by hand.
- **Test**: a YAML file under \`tests/\` (the format is below); check it with \`testpion lint-tests -w . --json\`, run it with \`testpion test tests/<file>.yaml -w .\`. MCP: \`write_test_file\` (checks it before saving), \`set_request_checks\` for checks on a saved request.
- **Flow**: a test file whose steps wait for each other (\`dependsOn\`) and pass values (\`extract\`). \`testpion flow edit\` or the MCP tools \`flow_add_step\`, \`flow_connect\`, \`flow_update_step\` edit it; an \`expose:\` block makes it an MCP tool of its own.
- **Evaluation**: a dataset under \`datasets/\` and a saved evaluation (the app's Evaluations view); \`testpion eval run\`, then \`testpion eval compare <run> --baseline <run>\` exits 1 on regressions.

## Environments and secrets

- **Never commit a secret, and never write one into a file here.** A secret variable is \`secret: true\` with an empty value in \`environments/*.json\`; its value lives in the app's secret store on this computer (the OS credential store) or, for the CLI and CI, in an environment variable \`TESTPION_SECRET_<NAME>\` (dots become underscores: \`{{$secret.provider.openai.apiKey}}\` reads \`TESTPION_SECRET_PROVIDER_OPENAI_APIKEY\`).
- Refer to values as \`{{name}}\`, \`{{$secret.name}}\` or \`{{$env.NAME}}\`, never as literal tokens or keys. MCP tools return variable names, not secret values.
- \`runs/\`, \`traces/\`, \`reports/\` and \`.local/\` hold results and this computer's state: keep them out of commits.

## Production

${
  production.length ? `${production.join(', ')} ${production.length === 1 ? 'is' : 'are'} marked as production.` : 'An environment can be marked as production (none is now).'
} Data-changing requests (POST, PUT, PATCH, DELETE, mutations …) to a production environment are refused unless the command gets \`--allow-production\` (CLI), or the MCP server runs with \`--allow-production\` and the tool call passes \`allowProduction: true\`. Reads still run. Never add either without the user asking for it.

## Reference

${guide.trimEnd()}
${AGENT_END}
`;
}

/** CLAUDE.md: one line inside the markers; Claude Code reads AGENTS.md through the @ import. */
export function renderClaudePointer(): string {
  return `${AGENT_BEGIN}\nSee @AGENTS.md for how to work with this TestPion workspace (CLI, MCP server, tests, secrets and production rules).\n${AGENT_END}\n`;
}

const CURSOR_FRONTMATTER = '---\ndescription: How to work with this TestPion workspace (CLI, MCP server, tests, secrets)\nalwaysApply: true\n---\n\n';

/** The Cursor rule: the essentials, and AGENTS.md for the rest. */
export function renderCursorRule(f: AgentWorkspaceFacts): string {
  const cmd = agentCommands(' -w .');
  return `${AGENT_BEGIN}
This folder is the TestPion workspace "${mdName(f.name)}". Read AGENTS.md (in this folder) before changing anything here.

- Run tests with \`${cmd.test}\`, a collection with \`${cmd.runCollection}\`; exit code 1 means a test failed.
- Use the MCP server \`${MCP_COMMAND}\` (or the CLI) rather than editing collections/*.json by hand.
- Never write a secret into a file: secrets are \`{{variables}}\` whose values live in the app's secret store or \`TESTPION_SECRET_<NAME>\`.
- Never pass \`--allow-production\` unless the user asks for it.
${AGENT_END}
`;
}

/* ------------------------------------------------------------------ the marked block */

export type AgentFileStatus = 'created' | 'updated' | 'unchanged' | 'skipped';

/** The line ending a text mostly uses (a new file: LF). */
function eolOf(text: string): '\r\n' | '\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

interface Line {
  start: number;
  end: number;
  text: string;
}

function* lines(text: string): Generator<Line> {
  let start = 0;
  while (start < text.length) {
    const nl = text.indexOf('\n', start);
    const end = nl < 0 ? text.length : nl + 1;
    yield {
      start,
      end,
      text: text
        .slice(start, end)
        .replace(/\r?\n$/, '')
        .trim(),
    };
    start = end;
  }
}

/**
 * `existing` with TestPion's block (`block`, LF endings) put in: in place of the one there, or at the end. The block
 * takes the file's line endings. Markers count only on a line of their own (a marker quoted in the user's prose is
 * text). `force` repairs broken markers: the text from the first begin to the last end is replaced, or, without a
 * matching pair, the stray marker lines go and the block is added at the end (the user's text stays).
 */
export function upsertMarkedBlock(
  existing: string | undefined,
  block: string,
  o: { force?: boolean; isUnchanged?(before: string): boolean } = {},
): { text: string; status: AgentFileStatus; reason?: string } {
  if (existing === undefined || !existing.replace(/^\uFEFF/, '').trim()) {
    const text = existing?.startsWith('\uFEFF') ? `\uFEFF${block}` : block;
    return { text, status: existing === undefined ? 'created' : 'updated' };
  }
  const eol = eolOf(existing);
  const body = eol === '\n' ? block : block.replace(/\n/g, '\r\n');
  const begins: Line[] = [];
  const ends: Line[] = [];
  for (const l of lines(existing)) {
    if (l.text === AGENT_BEGIN || LEGACY_BEGIN.test(l.text)) begins.push(l);
    else if (l.text === AGENT_END) ends.push(l);
  }
  let text: string;
  const ok = begins.length === 1 && ends.length === 1 && ends[0]!.start > begins[0]!.start;
  if (!begins.length && !ends.length) {
    if (o.isUnchanged?.(existing)) return { text: existing, status: 'unchanged', reason: 'it already points to AGENTS.md' };
    // after what the user wrote, a blank line between
    text = `${existing.replace(/\s+$/, '')}${eol}${eol}${body}`;
  } else if (ok) {
    text = existing.slice(0, begins[0]!.start) + body + existing.slice(ends[0]!.end);
  } else if (!o.force) {
    const why = !begins.length
      ? 'a testpion:end marker without its begin'
      : !ends.length
        ? 'a testpion:begin marker without its end'
        : begins.length > 1 || ends.length > 1
          ? 'more than one testpion block'
          : 'the testpion markers in the wrong order';
    return { text: existing, status: 'skipped', reason: `${why}: fix the markers or use --force` };
  } else {
    const first = begins[0];
    const last = ends.at(-1);
    if (first && last && last.start > first.start) text = existing.slice(0, first.start) + body + existing.slice(last.end);
    else {
      const stray = [...begins, ...ends].sort((a, b) => b.start - a.start);
      let t = existing;
      for (const l of stray) t = t.slice(0, l.start) + t.slice(l.end);
      text = `${t.replace(/\s+$/, '')}${t.trim() ? `${eol}${eol}` : ''}${body}`;
    }
  }
  return text === existing ? { text, status: 'unchanged' } : { text, status: 'updated' };
}

/* ------------------------------------------------------------------ writing */

export interface AgentFileResult {
  target: AgentTarget;
  /** Path inside the workspace, with forward slashes. */
  path: string;
  status: AgentFileStatus;
  reason?: string;
}

export interface AgentsInitResult {
  workspace: string;
  /** The workspace folder (absolute; the files' paths are relative to it). */
  root: string;
  dryRun: boolean;
  files: AgentFileResult[];
}

/** The real file a workspace path writes to: itself, or what a link inside the workspace points to; never outside it. */
function realTarget(root: string, abs: string): { path: string } | { reason: string } {
  const base = realpathSync(root);
  const inside = (p: string) => {
    const rel = relative(base, p);
    return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
  };
  if (!existsSync(abs)) {
    // a folder on the way may be a link (.cursor → elsewhere): the file is written where the nearest existing folder really is
    let dir = dirname(abs);
    while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
    const realDir = realpathSync(dir);
    if (realDir !== base && !inside(realDir)) return { reason: 'its folder is a link to a folder outside the workspace' };
    // a dangling link would be replaced by a file: say so instead
    try {
      if (lstatSync(abs).isSymbolicLink()) return { reason: 'it is a link to a file that does not exist' };
    } catch {
      /* not there at all */
    }
    return { path: abs };
  }
  const st = lstatSync(abs);
  const real = realpathSync(abs);
  if (!inside(real)) return { reason: st.isSymbolicLink() ? 'it is a link to a file outside the workspace' : 'its folder is a link to a folder outside the workspace' };
  if (!st.isSymbolicLink()) return st.isFile() ? { path: abs } : { reason: 'it is not a file' };
  return lstatSync(real).isFile() ? { path: real } : { reason: 'it is a link to something that is not a file' };
}

/**
 * Write (or refresh) the agent files of a workspace: AGENTS.md always, CLAUDE.md and the Cursor rule when asked.
 * Each file on its own: one that cannot be written is reported (`skipped` with the reason), the others still are.
 * `dryRun` reports what would happen without writing.
 */
export function initAgentFiles(store: WorkspaceStore, o: { targets?: AgentTarget[]; force?: boolean; dryRun?: boolean } = {}): AgentsInitResult {
  const targets = parseAgentTargets(o.targets);
  const root = resolve(store.root);
  const facts = agentWorkspaceFacts(store);
  const written = new Map<string, AgentTarget>();
  const files: AgentFileResult[] = [];
  for (const target of targets) {
    const path = AGENT_TARGETS[target];
    const abs = join(root, ...path.split('/'));
    const res = (status: AgentFileStatus, reason?: string) => files.push({ target, path, status, ...(reason ? { reason } : {}) });
    try {
      const real = realTarget(root, abs);
      if ('reason' in real) {
        res('skipped', real.reason);
        continue;
      }
      const key = process.platform === 'win32' ? real.path.toLowerCase() : real.path;
      const same = written.get(key);
      // CLAUDE.md as a link to AGENTS.md (a common setup): AGENTS.md is already it
      if (same) {
        res('unchanged', `it is a link to ${AGENT_TARGETS[same]}`);
        continue;
      }
      written.set(key, target);
      const before = existsSync(real.path) ? readFileSync(real.path, 'utf8') : undefined;
      const block = target === 'agents' ? renderAgentsMd(facts) : target === 'claude' ? renderClaudePointer() : renderCursorRule(facts);
      const fresh = target === 'cursor' && (before === undefined || !before.trim()) ? CURSOR_FRONTMATTER + block : block;
      const r = upsertMarkedBlock(before, fresh, {
        force: o.force,
        // a CLAUDE.md of the user's that already imports or names AGENTS.md needs no second pointer
        isUnchanged: target === 'claude' ? (t) => /(^|[\s@(/[`"'])AGENTS\.md\b/m.test(t) : undefined,
      });
      if ((r.status === 'created' || r.status === 'updated') && !o.dryRun) atomicWrite(real.path, r.text);
      res(r.status, r.reason);
    } catch (e) {
      res('skipped', e instanceof Error ? e.message : String(e));
    }
  }
  return { workspace: store.workspace.name, root, dryRun: !!o.dryRun, files };
}
