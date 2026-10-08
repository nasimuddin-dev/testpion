import { Command } from 'commander';
import { ENGINE_VERSION, MINIMAL_TOOLS } from '@testpion/core';
import { withWorkspace } from '../shared.js';

/**
 * `testpion agent-info`: what an AI agent needs to drive TestPion from this machine, as one JSON object — the version,
 * the workspace it would get, the commands and their exit codes, the environment variables, the MCP server setup and
 * where the docs for agents are. Agents read it instead of guessing from --help.
 */
export function registerAgentInfoCommand(program: Command): void {
  program
    .command('agent-info')
    .description('what an AI agent needs to use TestPion here, as JSON: the workspace, the commands and exit codes, environment variables, the MCP server setup, the docs for agents')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .action(async (o: { workspace?: string }) => {
      let workspace: Record<string, unknown> | null = null;
      try {
        workspace = await withWorkspace(o.workspace, (store) => ({
          name: store.workspace.name,
          root: store.root,
          collections: store.listCollections().map((c) => c.name),
          environments: store.listEnvironments().map((e) => e.name),
          folders: { tests: 'tests/ (YAML test files and *.suite.yaml)', specs: 'specs/ (OpenAPI, AsyncAPI)', datasets: 'datasets/', mocks: 'mocks/', collections: 'collections/' },
        }));
      } catch {
        workspace = null;
      }
      const w = workspace ? ` -w "${String(workspace.root)}"` : '';
      console.log(
        JSON.stringify(
          {
            schemaVersion: 1,
            testpion: ENGINE_VERSION,
            workspace,
            commands: {
              test: `testpion test <paths…>${w} -e <environment> -r json -o <dir>`,
              run: `testpion run${w} --suite <name> -e <environment> -r json -o <dir>`,
              send: `testpion send <request or URL>${w} -e <environment> --json`,
              lint: `testpion lint-tests${w} --json`,
              generate: `testpion tests-from-spec specs/<api>.yaml${w} --json · testpion integration-suite <spec | collection>${w} --json`,
              mcpServer: `testpion mcp-server${w} [--profile minimal] [--read-only]`,
              doctor: 'testpion doctor --json',
            },
            exitCodes: { 0: 'success', 1: 'a test failed', 2: 'configuration error (a wrong argument, a missing file)', 3: 'execution error' },
            output: { json: '--json on most commands prints one JSON object; -r json on runs writes results.jsonl, summary.json and report.json into -o', logs: 'stderr; results go to stdout' },
            environment: {
              TESTPION_HOME: 'the app folder (settings, secrets, workspaces list)',
              'TESTPION_SECRET_<NAME>': 'a secret for {{$secret.<name>}} (dots become underscores: provider.openai.apiKey → TESTPION_SECRET_PROVIDER_OPENAI_APIKEY)',
              NO_COLOR: 'plain output',
            },
            mcp: {
              command: `testpion mcp-server${w}`,
              claudeCode: `claude mcp add testpion -- testpion mcp-server${w}`,
              profiles: { full: 'every tool (the default)', minimal: `${MINIMAL_TOOLS.size} tools of the common jobs; search_tools finds the rest` },
              start: 'what_needs_attention, then testpion_guide (the check types and the test file format)',
            },
            docs: { agents: 'https://testpion.dev/ai-testing/mcp-server', llms: 'https://testpion.dev/llms.txt', agentsMd: `testpion agents-md${w} writes AGENTS.md into the workspace` },
            secrets: 'Secret values never appear in tool results, exports or generated files: they are {{variables}}; set them in the environment or the app.',
          },
          null,
          2,
        ),
      );
    });
}
