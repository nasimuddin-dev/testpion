/**
 * `askSearch`: the one call every host makes for AI-12 (the app's `search.ask`, `testpion search --ask`, MCP
 * `search_ask`). The `nl-search` task translates the question into a query, the query is validated (query-spec.ts) and
 * the engine runs it (query-engine.ts); the answer carries the query in plain words and as chips, so what was understood
 * is visible before it is trusted. Without a model, or when the model fails or answers with an invalid query, the same
 * call is a plain text search (`mode: 'text'`, with why): the box never dead-ends. `runQuerySpec` runs a query a caller
 * wrote (chips edited by hand, `--query-json`) with no model at all.
 */
import { ApsError, normalizeError } from '../errors.js';
import type { TokenUsage } from '../model/types.js';
import { nlSearchAnswer } from '../ai/nl-search.js';
import { runAiTask, type AiPreview, type AiRunDeps } from '../ai/tasks/run.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { runSearchQuery, type SearchOutcome } from './query-engine.js';
import { explainQuery, parseSearchQuery, queryChips, SEARCH_VALUE_MAX, textQuery, type SearchChip, type SearchQuery, type SearchSource } from './query-spec.js';

export interface SearchAnswer {
  /** The question as asked (empty for a query run directly). */
  question: string;
  /** `ai`: a model translated the question; `text`: a plain text search (no model, or it failed); `query`: a query given directly. */
  mode: 'ai' | 'text' | 'query';
  query: SearchQuery;
  /** The query in plain words: how the question was understood. */
  explain: string;
  chips: SearchChip[];
  /** What the model guessed (what "slow" meant …). */
  assumptions: string[];
  /** Why a plain text search was made instead of a translation. */
  fallback?: string;
  outcome?: SearchOutcome;
  model?: string;
  usage?: TokenUsage;
  costUsd?: number;
  repairs?: number;
  /** A dry run: nothing was sent and nothing searched; this is what would be sent. */
  dryRun?: boolean;
  preview?: Omit<AiPreview, 'messages'> & { messages?: AiPreview['messages'] };
}

export interface AskOptions {
  question: string;
  /** Where the question is asked (History → ['history']): the search stays inside. */
  scope?: SearchSource[];
  privacy?: string;
  provider?: string;
  model?: string;
  /** No model: a plain text search. */
  noAi?: boolean;
  dryRun?: boolean;
  /** For tests: the time "now" is. */
  now?: number;
}

function inScope(q: SearchQuery, scope: SearchSource[] | undefined): { query?: SearchQuery; problems: string[] } {
  if (!scope?.length) return { query: q, problems: [] };
  const sources = q.sources.filter((s) => scope.includes(s));
  // the model went outside where the question was asked: it is brought back
  return parseSearchQuery({ ...q, sources: sources.length ? sources : scope });
}

async function answerOf(store: WorkspaceStore, a: Omit<SearchAnswer, 'explain' | 'chips' | 'outcome'>, now?: number): Promise<SearchAnswer> {
  return { ...a, explain: explainQuery(a.query), chips: queryChips(a.query), outcome: await runSearchQuery(store, a.query, { now }) };
}

/** A query that failed validation: every problem says what is allowed, so a caller can correct it. */
export const invalidQuery = (problems: string[]): ApsError =>
  new ApsError('ValidationError', `Invalid search query: ${problems.join('; ')}`, { details: { problems }, suggestions: problems.slice(0, 5) });

/** A query given directly (edited chips, `--query-json`, MCP `search_query`): validated, run, explained. No model. */
export async function runQuerySpec(store: WorkspaceStore, input: unknown, o: { question?: string; now?: number; scope?: SearchSource[] } = {}): Promise<SearchAnswer> {
  const parsed = parseSearchQuery(input);
  const scoped = parsed.query ? inScope(parsed.query, o.scope) : parsed;
  if (!scoped.query) throw invalidQuery(scoped.problems);
  return answerOf(store, { question: o.question ?? '', mode: 'query', query: scoped.query, assumptions: [] }, o.now);
}

/** A plain text search over the question (also what the box does with no model). */
export const runTextSearch = (store: WorkspaceStore, text: string, o: { scope?: SearchSource[]; fallback?: string; now?: number } = {}): Promise<SearchAnswer> => {
  const q = textQuery(text);
  const scoped = inScope(q, o.scope).query ?? q;
  return answerOf(store, { question: text, mode: 'text', query: scoped, assumptions: [], ...(o.fallback ? { fallback: o.fallback } : {}) }, o.now);
};

export async function askSearch(deps: AiRunDeps, o: AskOptions): Promise<SearchAnswer> {
  if (!deps.store) throw new Error('askSearch needs the workspace');
  const store = deps.store;
  const question = o.question.trim().slice(0, 1000);
  if (!question) throw new ApsError('ValidationError', 'Ask a question, or type words to search for');
  const now = o.now ?? Date.now();
  const plain = (fallback: string) => runTextSearch(store, question.slice(0, SEARCH_VALUE_MAX), { scope: o.scope, fallback, now });
  if (o.noAi) return plain('Searched for the words as typed (no AI, as asked).');
  try {
    const r = await runAiTask(deps, {
      task: 'nl-search',
      question,
      // only the clock and where the question is asked go with it: no workspace data
      context: { now: new Date(now).toISOString(), ...(o.scope?.length ? { scope: o.scope } : {}) },
      privacy: o.privacy,
      provider: o.provider,
      model: o.model,
      dryRun: o.dryRun,
    });
    if (r.dryRun) {
      const q = textQuery(question);
      return { question, mode: 'ai', query: q, explain: explainQuery(q), chips: queryChips(q), assumptions: [], dryRun: true, preview: r.preview };
    }
    const a = nlSearchAnswer(r.value);
    const scoped = a.query ? inScope(a.query, o.scope) : { problems: a.problems };
    if (!scoped.query)
      return {
        ...(await plain(
          `The model's query was not valid (${(scoped.problems.length ? scoped.problems : r.problems).slice(0, 2).join('; ') || 'no query in its answer'}): searched for the words as typed.`,
        )),
        usage: r.usage,
        costUsd: r.costUsd,
      };
    return {
      ...(await answerOf(
        store,
        {
          question,
          mode: 'ai',
          query: scoped.query,
          assumptions: a.assumptions,
          model: `${r.provider}/${r.model}`,
          usage: r.usage,
          ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
          repairs: r.repairs,
        },
        now,
      )),
    };
  } catch (e) {
    const n = normalizeError(e);
    // a cancelled call stays cancelled; a missing model, a refusing provider, a cap or a network error is a plain text search
    if (n.kind === 'CancelledError' || deps.signal?.aborted || o.dryRun) throw e;
    return plain(`${n.message} Searched for the words as typed instead.`);
  }
}
