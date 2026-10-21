/**
 * `testpion search --ask "<question>"` and `testpion search --query-json <spec>` (AI-12): the natural-language search of
 * the app's Ask box from a shell. `--ask` has the configured model translate the question into a search query (it sees
 * the question and the field names, never the data), TestPion validates the query and runs it over History, runs, test
 * results and traces, and the answer says how the question was understood; without a model, or when it fails, the words
 * are searched as typed. `--query-json` runs a query directly (no model): the same engine, the same output.
 */
import { existsSync, readFileSync } from 'node:fs';
import { formatUsd, itemRefUrl } from '@testpion/shared';
import { ApsError, aiRunDeps, askSearch, pageArgs, runQuerySpec, SEARCH_SOURCES, SOURCE_LABEL, WorkspaceManager, type SearchAnswer, type SearchSource } from '@testpion/core';
import { cliContext, CliError, dim, EXIT, printJson, withWorkspace, yellow } from '../shared.js';
import { printPreview } from './ai-print.js';
import { reportPage } from '../paging.js';

/** A cut list of matches says so (the envelope's `page`, and the hint line in text mode). */
function reportSearchPage(a: SearchAnswer, o: SearchAskOptions): void {
  const x = a.outcome;
  if (x) reportPage({ items: x.rows, total: x.matched, limit: x.query.limit, truncated: x.truncated, ...(x.nextCursor ? { nextCursor: x.nextCursor } : {}) }, o, 'matches');
}

/** `--limit`, `--cursor` and `--offset` as the page of a query. */
const pageOf = (o: SearchAskOptions) => {
  const p = pageArgs(o);
  return { ...(p.limit !== undefined ? { limit: p.limit } : {}), ...(p.cursor !== undefined ? { cursor: p.cursor } : {}) };
};

export interface SearchAskOptions {
  workspace?: string;
  ask?: string;
  queryJson?: string;
  in?: string;
  ai?: boolean;
  dryRun?: boolean;
  privacy?: string;
  provider?: string;
  model?: string;
  json?: boolean;
  limit?: string;
  cursor?: string;
  offset?: string;
}

/** `--in history,runs` as sources. */
function scopeOf(v: string | undefined): SearchSource[] | undefined {
  if (!v) return undefined;
  const names = v.split(/[,\s]+/).filter(Boolean);
  const bad = names.filter((n) => !SEARCH_SOURCES.includes(n as SearchSource));
  if (bad.length) throw new CliError(`Unknown source ${bad.map((b) => `"${b}"`).join(', ')} for --in. Sources: ${SEARCH_SOURCES.join(', ')}`, EXIT.CONFIG_ERROR);
  return names as SearchSource[];
}

/** A query's JSON: the text itself, `@file`, an existing file, or `-` for stdin. */
function queryInput(v: string): unknown {
  let text = v.trim();
  if (text === '-') text = readFileSync(0, 'utf8');
  else if (text.startsWith('@') || (!text.startsWith('{') && existsSync(text))) text = readFileSync(text.replace(/^@/, ''), 'utf8');
  if (text.length > 20_000) throw new CliError('The query is longer than 20 000 characters', EXIT.CONFIG_ERROR);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CliError(`--query-json is not valid JSON: ${(e as Error).message}`, EXIT.CONFIG_ERROR);
  }
}

function print(a: SearchAnswer): void {
  if (a.fallback) console.log(yellow(a.fallback));
  console.log(`${a.mode === 'ai' ? 'Understood as' : 'Searching'}: ${a.explain}`);
  for (const x of a.assumptions) console.log(dim(`  assumed: ${x}`));
  const o = a.outcome!;
  if (!o.rows.length) console.log(dim('Nothing found.'));
  for (const r of o.rows) console.log(`${r.failed ? '✗' : '·'} ${r.title}${r.subtitle ? dim(`  ${r.subtitle}`) : ''}  ${dim(`[${SOURCE_LABEL[r.source]}, ${r.at}]`)}  ${dim(itemRefUrl(r.ref))}`);
  console.log(
    dim(
      `${o.rows.length} of ${o.matched} match${o.matched === 1 ? '' : 'es'} · ${o.ms} ms${a.model ? ` · ${a.model}${a.usage ? ` · ${a.usage.inputTokens + a.usage.outputTokens} tokens` : ''}${a.costUsd !== undefined ? ` · ${formatUsd(a.costUsd)}` : ''}` : ''}`,
    ),
  );
  for (const n of o.notes) console.log(yellow(n));
  console.log(dim('Adjust it with testpion search --query-json \'{"where":[…]}\' (fields: see the Search docs).'));
}

export async function runSearchAsk(words: string[], o: SearchAskOptions): Promise<void> {
  const scope = scopeOf(o.in);
  if (o.ask !== undefined && o.queryJson !== undefined) throw new CliError('Use --ask (a question) or --query-json (a query), not both', EXIT.CONFIG_ERROR);
  await withWorkspace(o.workspace, async (store) => {
    if (o.queryJson !== undefined) {
      let a: SearchAnswer;
      try {
        a = await runQuerySpec(store, queryInput(o.queryJson), { scope, page: pageOf(o) });
      } catch (e) {
        // the problems say what is allowed: a configuration error, not a crash
        const problems = e instanceof ApsError && e.kind === 'ValidationError' ? (e.details?.problems as string[] | undefined) : undefined;
        if (problems?.length) throw new CliError(`Invalid search query:\n${problems.map((x) => `  - ${x}`).join('\n')}`, EXIT.CONFIG_ERROR);
        throw e;
      }
      if (o.json) printJson(a);
      else print(a);
      return reportSearchPage(a, o);
    }
    const question = [o.ask ?? '', ...words].join(' ').trim();
    const settings = new WorkspaceManager().loadSettings();
    const ctx = cliContext(store);
    try {
      const a = await askSearch(aiRunDeps({ ctx, settings, store, surface: process.env.CI ? 'ci' : 'cli', env: process.env }), {
        question,
        scope,
        page: pageOf(o),
        noAi: o.ai === false,
        dryRun: o.dryRun,
        privacy: o.privacy,
        provider: o.provider,
        model: o.model,
      });
      if (a.dryRun) return o.json ? printJson(a) : printPreview({ preview: a.preview } as never);
      if (o.json) printJson(a);
      else print(a);
      return reportSearchPage(a, o);
    } finally {
      await ctx.dispose();
    }
  });
}
