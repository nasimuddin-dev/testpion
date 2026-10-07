import { str, type Tool } from './tool.js';

/**
 * The tools an agent reaches without the full list: the `minimal` profile (the common jobs) and search_tools, which
 * finds any tool by what the agent wants to do. Hosts that load every listed tool into the context list the profile;
 * every tool can still be called.
 */

/** The `minimal` profile: the tools of the common jobs (find, send, run, check, import, generate, watch). */
export const MINIMAL_TOOLS = new Set([
  'what_needs_attention',
  'testpion_guide',
  'search_tools',
  'list_collections',
  'list_requests',
  'get_request',
  'send_request',
  'save_request',
  'parse_request_snippet',
  'set_request_checks',
  'run_collection',
  'list_tests',
  'run_tests',
  'write_test_file',
  'lint_tests',
  'run_breakdown',
  'compare_runs',
  'list_environments',
  'import_definition',
  'generate_tests',
  'generate_flows',
  'api_coverage',
  'list_monitors',
  'monitor_results',
  'run_evaluation',
  'llm_usage',
]);

/** A tool found by what the agent wants to do: the matching tools with a line each and their required arguments. */
export function searchTool(tools: Tool[], titleOf: (name: string, write: boolean) => string): Tool {
  const firstSentence = (s: string) => s.split(/(?<=\.)\s/)[0]!.slice(0, 200);
  return {
    name: 'search_tools',
    description:
      'Find a TestPion tool by what you want to do ("run tests", "mock", "capture traffic", "compare two runs", "secrets"): the matching tools with a line each and their required arguments. Any tool it names can be called, listed or not. Use it before guessing a tool name.',
    inputSchema: { type: 'object', properties: { query: str('What you want to do, in a few words') }, required: ['query'] },
    run: (a) => {
      const words = String(a.query ?? '')
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((w) => w.length > 1);
      const scored = tools
        .filter((t) => t.name !== 'search_tools')
        .map((t) => {
          const name = t.name.toLowerCase();
          const text = t.description.toLowerCase();
          const score = words.reduce((n, w) => n + (name.includes(w) ? 3 : 0) + (text.includes(w) ? 1 : 0), 0);
          return { t, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 12);
      return {
        tools: scored.map(({ t }) => ({ name: t.name, title: titleOf(t.name, !!t.write), description: firstSentence(t.description), required: t.inputSchema.required ?? [], changes: !!t.write })),
        hint: scored.length
          ? 'Call a tool by its name; testpion_guide explains variables, checks and the test file format.'
          : 'Nothing matched: try other words, or read testpion_guide for what the server does.',
      };
    },
  };
}
