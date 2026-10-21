import { aiRunDeps } from '../../ai/tasks/run.js';
import { withEngine } from './server-kit.js';
import { ApsError } from '../../errors.js';
import type { AppSettings } from '../../model/types.js';
import { askSearch, runQuerySpec } from '../../search/ask.js';
import { SEARCH_SOURCES, type SearchSource } from '../../search/query-spec.js';
import type { SecretStore } from '../../storage/secrets.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import { str, type Tool } from '../tool.js';

/** `sources` as an agent passes them: a list or a comma-separated text, only known names. */
function sourcesOf(v: unknown): SearchSource[] | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const names = (Array.isArray(v) ? v : String(v).split(/[,\s]+/)).map(String).filter(Boolean);
  const bad = names.filter((n) => !SEARCH_SOURCES.includes(n as SearchSource));
  if (bad.length) throw new ApsError('ValidationError', `Unknown source ${bad.map((b) => `"${b}"`).join(', ')}`, { suggestions: [`Sources: ${SEARCH_SOURCES.join(', ')}`] });
  return names as SearchSource[];
}

/**
 * AI-12 for agents: `search_ask` searches History, runs, test results and traces from a question in plain words (the
 * configured model only translates it into a validated query; TestPion runs the query, so the answer is deterministic
 * and the data is never sent) or from a query written directly. Read-only: it never changes the workspace.
 */
export function searchAskTools({ store, secrets, settings }: { store: WorkspaceStore; secrets: SecretStore; settings: AppSettings }): Tool[] {
  return [
    {
      name: 'search_ask',
      description:
        'Search History (requests sent), runs, test results and traces with a question in plain words — "failed payment calls last week over 2 s", "flaky tests in staging", "traces where a tool timed out" — or with a query of your own. With `question`, TestPion\'s configured model (the user\'s key or a local model) only TRANSLATES the question into a validated query (known fields and operators, bounded limits); TestPion runs it deterministically, so the model never sees the data it searches. The result has `explain` (how the question was understood, in words), `chips` (the conditions), `assumptions` (what the model guessed), `outcome.rows` (each with a `ref` for open_item / the app) and, when no model is set up or its query was invalid, `mode: "text"` with the `fallback` reason (the words were searched as typed). With `query` (an object: {sources, where: [{field, op, value}], sort, limit}) no model is called. Read-only. Fields: text, time (gte/lte ISO date, within 7d/24h), name, kind, method, url, status, failed, duration (ms), size, environment, collection, file, error, assertion, span, spans, flaky, attempts, failures.',
      inputSchema: {
        type: 'object',
        properties: {
          question: str('The question in plain words'),
          query: {
            type: 'object',
            description:
              'A search query instead of a question: {"sources": ["history"], "where": [{"field": "status", "op": "gte", "value": 500}], "sort": {"by": "time", "dir": "desc"}, "limit": 25}',
          },
          sources: { description: 'Search only these sources: history, runs, results, traces (a list or comma-separated)', anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] },
          privacy: {
            type: 'string',
            enum: ['full', 'metadata', 'names'],
            description: 'What the model may see of the question: full (masked, default), metadata, names. It never sees workspace data',
          },
          noAi: { type: 'boolean', description: 'Do not call a model: search the words of `question` as typed' },
          dryRun: { type: 'boolean', description: 'Send nothing: return what would be sent to the model, with the token and cost estimate' },
        },
      },
      run: async (a) => {
        const scope = sourcesOf(a.sources);
        if (a.query !== undefined && a.question) throw new ApsError('ValidationError', 'Pass `question` or `query`, not both');
        if (a.query !== undefined) {
          return await runQuerySpec(store, a.query, { scope });
        }
        if (!a.question || !String(a.question).trim()) throw new ApsError('ValidationError', 'Pass `question` (plain words) or `query` (a search query)');
        return withEngine({ store, secrets, settings }, {}, async (ctx) => {
          return await askSearch(aiRunDeps({ ctx, settings, store, surface: 'mcp' }), {
            question: String(a.question),
            scope,
            privacy: a.privacy ? String(a.privacy) : undefined,
            noAi: a.noAi === true,
            dryRun: a.dryRun === true,
          });
        });
      },
    },
  ];
}
