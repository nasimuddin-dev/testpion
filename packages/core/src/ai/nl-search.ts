/**
 * AI-12 · Natural-language search: the `nl-search` task's prompt, answer schema and verifier. The model only TRANSLATES
 * a question into a search query (search/query-spec.ts); TestPion validates it and runs it itself (search/query-engine.ts),
 * so the model sees the question and the field names, never the data it searches. Imports only the spec (no cycle with
 * the task registry, which reads these).
 */
import { fieldCatalogText, parseSearchQuery, SEARCH_FIELDS, SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX, SEARCH_SOURCES, type SearchQuery } from '../search/query-spec.js';

export const NL_SEARCH_INSTRUCTION =
  'Translate the developer\'s question about their API testing activity into a search query that TestPion runs itself over its History (requests sent), runs, test results (the tests inside runs) and traces. You never see that data: you only write the query. Answer with one JSON object: {"query": {"sources": [...], "where": [{"field", "op", "value"}], "sort": {"by", "dir"}, "limit"}, "assumptions": [...]}.\n' +
  `sources: the narrowest list of ${SEARCH_SOURCES.join(', ')} that answers the question (calls, requests and responses are history; test failures and flaky tests are results; "runs" are whole runs; spans and agent steps are traces); a field that only some sources have limits the search to them. All conditions in "where" must hold (AND). Use only these fields and the operators listed for each:\n${fieldCatalogText()}\n` +
  'Rules. The context has `now` (ISO, UTC) and `scope` (the sources the question was asked in, when it was asked inside History, Runs or Traces: use those sources). Durations are milliseconds ("over 2 s" = duration gt 2000). "Failed", "broken", "erroring" = failed eq true; "succeeded" = failed eq false. "Server errors" / "5xx" = status gte 500 and status lte 599; "4xx" = gte 400 and lte 499; "not found" = status eq 404; "unauthorized" = 401. "Last N hours/days/weeks" = time within (90m, 24h, 7d, 2w); "last week" = within 7d; "today", "yesterday" or a named day = time gte and time lte as ISO dates computed from `now` (a date alone covers the whole day). "Slow" with no number = duration gte 1000, and say so in assumptions. "Flaky" = flaky eq true. Words that name an API area ("payment calls", "login") = url contains the word in History and name contains it in the others; a test or request named in the question = name contains it; an environment = environment eq it. sort: "slowest" = {"by": "duration", "dir": "desc"}, "fastest" = asc; otherwise newest first {"by": "time", "dir": "desc"}. limit: the number the question asks for (at most ' +
  `${SEARCH_LIMIT_MAX}), else ${SEARCH_LIMIT_DEFAULT}. ` +
  'List every guess in "assumptions" (what "slow" or "recently" was taken to mean), one short sentence each. If part of the question cannot be expressed with these fields, keep the rest and add that part\'s key words as a text contains condition, and say so in assumptions. If the question is not a search, answer {"query": {"where": [{"field": "text", "op": "contains", "value": <its key words>}]}, "assumptions": ["not a search question"]}. Never invent fields or operators, never write code or regular expressions. Output only the JSON object.';

const WHERE_ITEM = {
  type: 'object',
  required: ['field', 'op', 'value'],
  properties: {
    field: { type: 'string', enum: SEARCH_FIELDS.map((f) => f.id), description: 'A field of the catalog' },
    op: { type: 'string', enum: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'not_contains', 'in', 'within'], description: 'An operator that field takes' },
    value: { description: 'A string, a number (milliseconds, bytes, a count), a boolean, or a list for "in"' },
  },
};

export const NL_SEARCH_SCHEMA = {
  type: 'object',
  required: ['query'],
  properties: {
    query: {
      type: 'object',
      properties: {
        sources: { type: 'array', items: { type: 'string', enum: [...SEARCH_SOURCES] } },
        where: { type: 'array', items: WHERE_ITEM },
        sort: { type: 'object', properties: { by: { type: 'string', enum: ['time', 'duration'] }, dir: { type: 'string', enum: ['asc', 'desc'] } } },
        limit: { type: 'integer', minimum: 1, maximum: SEARCH_LIMIT_MAX },
      },
    },
    assumptions: { type: 'array', items: { type: 'string' }, description: 'What was guessed' },
  },
};

/** The model's answer made into a query (strictly validated) and its assumptions. */
export function nlSearchAnswer(value: unknown): { query?: SearchQuery; assumptions: string[]; problems: string[] } {
  const v = value && typeof value === 'object' ? (value as { query?: unknown; assumptions?: unknown }) : {};
  const { query, problems } = parseSearchQuery(v.query);
  const assumptions = (Array.isArray(v.assumptions) ? v.assumptions : [])
    .filter((a): a is string => typeof a === 'string' && !!a.trim())
    .map((a) => a.trim().slice(0, 240))
    .slice(0, 8);
  return { query, assumptions, problems };
}

/** The task's verifier: problems go back to the model (the repair loop), each says what is allowed. */
export const validateNlSearch = (value: unknown): string[] => nlSearchAnswer(value).problems;
