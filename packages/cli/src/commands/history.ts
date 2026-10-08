import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import {
  WorkspaceManager,
  formatDuration,
  compareHistory,
  responseTimeStats,
  type WorkspaceStore,
  redactDiff,
  Redactor,
  type CollectionNode,
  historyToHar,
  mcpToolUsage,
  llmUsage,
  testHistory,
  summarizeTestHistory,
  flakyTests,
  scoreTrend,
  reviewResult,
  runReviewReport,
} from '@testpion/core';
import { EXIT, green, red, yellow, dim, bold, CliError, printJson, withWorkspace, requireCollection } from '../shared.js';

/** `testpion history …`: the response history of requests sent in the app, test and score history, comparing two responses. */
export function registerHistoryCommands(program: Command): void {
  const histCmd = program.command('history').description('response history of requests sent in the app, and comparing two responses');
  histCmd
    .command('export-har')
    .description('write HTTP and GraphQL history as a HAR file (browser devtools and other tools open it; secrets masked)')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('-q, --query <text>', 'only entries matching this text (name, URL, method, status)')
    .option('-n, --limit <n>', 'how many, newest first', '500')
    .option('-o, --out <file>', 'write here (default: print it)')
    .action((o) =>
      withWorkspace(o.workspace, (store) => {
        const items = store.meta.listHistory({ query: o.query, limit: Math.min(Number(o.limit) || 500, 2000) }).items;
        const har = historyToHar(store, items, new Redactor(new WorkspaceManager().loadSettings().redactFields));
        const text = JSON.stringify(har, null, 2) + '\n';
        if (o.out) {
          writeFileSync(resolve(o.out), text);
          console.log(green(`Wrote ${(har.log as { entries: unknown[] }).entries.length} entries to ${resolve(o.out)}`));
        } else process.stdout.write(text);
      }),
    );
  histCmd
    .command('list')
    .description('recent responses, newest first (optionally of one saved request)')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('--collection <nameOrId>', 'collection of --request')
    .option('--request <nameOrId>', 'only responses of this saved request')
    .option('--failed', 'only responses that failed (4xx/5xx, transport errors, non-OK gRPC codes)')
    .option('-n, --limit <n>', 'how many', '20')
    .option('--json', 'print as JSON')
    .action((o) => {
      return withWorkspace(o.workspace, (store) => {
        const requestId = o.request ? savedRequestId(store, o.request, o.collection) : undefined;
        const items = store.meta.listHistory({ requestId, kind: requestId ? 'http' : undefined, failed: o.failed || undefined, limit: Math.min(Number(o.limit) || 20, 500) }).items;
        const rows = items.map((h) => ({ id: h.id, timestamp: h.timestamp, kind: h.kind, name: h.name, method: h.method, status: h.status, durationMs: h.durationMs, size: h.size }));
        if (o.json) printJson(rows);
        else for (const r of rows) console.log(`${dim(r.id)}  ${r.timestamp}  ${String(r.status ?? '').padEnd(4)} ${r.method ?? r.kind} ${r.name}  ${dim(formatDuration(r.durationMs ?? 0))}`);
      });
    });
  histCmd
    .command('stats')
    .description("response-time summary of a saved request's recent responses: median, p95, slowest, failed")
    .requiredOption('-w, --workspace <nameOrPath>')
    .requiredOption('--request <nameOrId>', 'saved request')
    .option('--collection <nameOrId>', 'collection of --request')
    .option('-n, --limit <n>', 'how many recent responses', '50')
    .option('--json', 'print as JSON')
    .action((o) => {
      return withWorkspace(o.workspace, (store) => {
        const requestId = savedRequestId(store, o.request, o.collection);
        const s = responseTimeStats(store.meta.listHistory({ requestId, kind: 'http', limit: Math.min(Number(o.limit) || 50, 500) }).items);
        if (o.json) printJson(s);
        else if (!s.count) console.log('No responses yet. Send the request from the app first.');
        else {
          const f = (v?: number) => formatDuration(v ?? 0);
          console.log(`${s.count} responses: median ${f(s.p50Ms)}, p95 ${f(s.p95Ms)}, fastest ${f(s.minMs)}, slowest ${f(s.maxMs)}, mean ${f(s.meanMs)}`);
          console.log(s.failed ? red(`${s.failed} failed`) : green('none failed'));
        }
      });
    });
  histCmd
    .command('activity')
    .description('workspace activity per day: requests sent, failed requests, median response time, test runs and failed tests')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('-d, --days <n>', 'how many days, up to 90', '14')
    .option('--json', 'print as JSON')
    .action((o) => {
      return withWorkspace(o.workspace, (store) => {
        const a = store.meta.activity({ days: Number(o.days) || 14, tzOffsetMin: new Date().getTimezoneOffset() });
        if (o.json) printJson(a);
        else {
          for (const d of a.days)
            console.log(
              `${d.day}  ${String(d.requests).padStart(4)} requests${d.failedRequests ? red(` (${d.failedRequests} failed)`) : ''}${d.medianMs !== undefined ? dim(`  median ${formatDuration(d.medianMs)}`) : ''}  ${d.runs ? `${d.runs} runs, ${d.tests} tests${d.failedTests ? red(` (${d.failedTests} failed)`) : ''}` : ''}`,
            );
          const kinds = Object.entries(a.byKind)
            .map(([k, n]) => `${k} ${n}`)
            .join(', ');
          if (kinds) console.log(dim(`By kind: ${kinds}`));
        }
      });
    });
  histCmd
    .command('review')
    .description("a person's verdicts on a run's results: list them, or rate one good or bad with a note (the app's 👍 / 👎)")
    .argument('<runId>', 'the run (from the app or `testpion history list`)')
    .argument('[resultId]', 'the result to rate')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('--good', 'rate it good')
    .option('--bad', 'rate it bad')
    .option('--clear', 'remove the rating and note')
    .option('--note <text>', 'why')
    .option('--json', 'print as JSON')
    .action(async (runId: string, resultId: string | undefined, o: { workspace: string; good?: boolean; bad?: boolean; clear?: boolean; note?: string; json?: boolean }) => {
      return withWorkspace(o.workspace, async (store) => {
        if (resultId) {
          if (o.good && o.bad) throw new CliError('Choose --good or --bad, not both', EXIT.CONFIG_ERROR);
          const review = reviewResult(store, runId, resultId, o.clear ? null : { rating: o.good ? 'good' : o.bad ? 'bad' : undefined, note: o.note, by: process.env.USER ?? process.env.USERNAME });
          if (o.json) return printJson({ resultId, review: review ?? null });
          return console.log(review ? `${review.rating === 'bad' ? red('bad') : review.rating === 'good' ? green('good') : dim('no rating')}${review.note ? `  ${review.note}` : ''}` : dim('Review cleared.'));
        }
        const report = await runReviewReport(store, runId);
        if (o.json) return printJson(report);
        for (const r of report.results) console.log(`${r.rating === 'bad' ? red('bad ') : r.rating === 'good' ? green('good') : dim('note')}  ${r.name} ${dim(`(${r.status}, ${r.id})`)}${r.note ? `\n      ${r.note}` : ''}`);
        console.log(dim(`${report.good} good, ${report.bad} bad, ${report.unreviewed} not rated of ${report.good + report.bad + report.unreviewed}`));
      });
    });
  histCmd
    .command('scores')
    .description("each evaluator's mean score run by run (evaluations, AI and RAG tests), oldest first")
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('-q, --query <text>', 'only runs whose name contains this')
    .option('-n, --limit <n>', 'how many runs', '20')
    .option('--json', 'print as JSON')
    .action((o: { workspace: string; query?: string; limit: string; json?: boolean }) => {
      return withWorkspace(o.workspace, (store) => {
        const points = scoreTrend(store, { name: o.query, limit: Number(o.limit) || 20 });
        if (o.json) return printJson(points);
        if (!points.length) return console.log(dim('No runs with scores.'));
        const evaluators = [...new Set(points.flatMap((p) => Object.keys(p.scores)))].sort();
        const w = Math.max(...evaluators.map((e) => e.length));
        // one row per evaluator: its score in each run, oldest to newest
        for (const e of evaluators)
          console.log(
            `${e.padEnd(w)}  ${points.map((p) => (p.scores[e] === undefined ? dim('  -  ') : p.scores[e]! >= 0.7 ? green(p.scores[e]!.toFixed(2)) : yellow(p.scores[e]!.toFixed(2)))).join(' ')}`,
          );
        console.log(dim(`${points.length} runs, oldest left: ${points[0]!.startedAt.slice(0, 16)} → ${points[points.length - 1]!.startedAt.slice(0, 16)}`));
      });
    });
  histCmd
    .command('flaky')
    .description('tests whose result keeps changing across the latest runs, or that passed only after a retry (exit 1 when there are any)')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('-n, --runs <n>', 'how many of the latest runs', '30')
    .option('--json', 'print as JSON')
    .action(async (o: { workspace: string; runs: string; json?: boolean }) => {
      return withWorkspace(o.workspace, async (store) => {
        const rows = await flakyTests(store, { runs: Number(o.runs) || 30 });
        if (o.json) printJson(rows);
        else if (!rows.length) console.log(green('No flaky tests in the latest runs.'));
        else
          for (const t of rows)
            console.log(
              `${t.recent.map((s) => (s === 'passed' ? green('█') : red('█'))).join('')}  ${bold(t.name)}  ${dim(`${t.passed}/${t.runs} passed · flipped ${t.flips}×${t.retried ? ` · ${t.retried} retried` : ''} · last ${t.lastStatus}`)}`,
            );
        process.exitCode = rows.length ? EXIT.TEST_FAILURE : EXIT.SUCCESS;
      });
    });
  histCmd
    .command('test')
    .description('one test (or saved request) across the latest runs, newest first: status, latency and the checks that failed, with how often the result flipped (flaky)')
    .argument('<name>', 'test name as in run results (or its id with --id)')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('--id', 'the argument is the test / request id')
    .option('-n, --limit <n>', 'how many runs', '20')
    .option('--json', 'print as JSON')
    .action(async (name: string, o: { workspace: string; id?: boolean; limit: string; json?: boolean }) => {
      return withWorkspace(o.workspace, async (store) => {
        const points = await testHistory(store, o.id ? { id: name } : { name }, { limit: Number(o.limit) || 20 });
        const sum = summarizeTestHistory(points);
        if (o.json) return printJson({ summary: sum, runs: points });
        if (!points.length) return console.log(dim(`"${name}" is in none of the latest runs.`));
        console.log(
          `${bold(name)}  ${sum.failed ? red(`${sum.failed} of ${sum.runs} failed`) : green(`passed ${sum.passed} of ${sum.runs}`)}${sum.flips > 1 ? yellow(`  flipped ${sum.flips} times (flaky?)`) : ''}${sum.medianMs !== undefined ? dim(`  median ${formatDuration(sum.medianMs)}`) : ''}`,
        );
        console.log(
          '  ' +
            [...points]
              .reverse()
              .map((p) => (p.status === 'passed' ? green('█') : p.status === 'skipped' ? dim('·') : red('█')))
              .join('') +
            dim('  oldest → newest'),
        );
        for (const p of points)
          console.log(
            `  ${p.startedAt.slice(0, 16).replace('T', ' ')}  ${p.status === 'passed' ? green('passed') : p.status === 'skipped' ? dim('skipped') : red(p.status)}  ${dim(`${p.latencyMs !== undefined ? formatDuration(p.latencyMs) : ''} · ${p.runName}${p.environment ? ` · ${p.environment}` : ''}`)}${p.failures.length ? red(`  ${p.failures.join('; ')}`) : ''}`,
          );
      });
    });
  histCmd
    .command('mcp-tools')
    .description('MCP tool calls made in the app, per tool: calls, failures, median and p95 time, last used')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('-s, --server <name>', 'only this MCP server')
    .option('--json', 'print as JSON')
    .action((o: { workspace: string; server?: string; json?: boolean }) => {
      return withWorkspace(o.workspace, (store) => {
        const rows = mcpToolUsage(store).filter((u) => !o.server || u.server.toLowerCase() === o.server.toLowerCase() || u.serverId === o.server);
        if (o.json) return printJson(rows);
        if (!rows.length) return console.log(dim('No MCP tool calls in the history.'));
        const w = Math.min(48, Math.max(...rows.map((r) => `${r.server} · ${r.tool}`.length)));
        for (const r of rows)
          console.log(
            `${`${r.server} · ${r.tool}`.slice(0, w).padEnd(w)}  ${String(r.calls).padStart(5)} calls  ${r.failed ? red(`${r.failed} failed`.padEnd(10)) : dim('0 failed'.padEnd(10))}  ${dim(`median ${r.medianMs ?? '-'} ms · p95 ${r.p95Ms ?? '-'} ms`)}`,
          );
      });
    });
  histCmd
    .command('llm')
    .description('prompts run in the AI Lab, per provider and model: prompts, input / output tokens, estimated cost, median time')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('--json', 'print as JSON')
    .action((o: { workspace: string; json?: boolean }) => {
      return withWorkspace(o.workspace, (store) => {
        const rows = llmUsage(store);
        if (o.json) return printJson(rows);
        if (!rows.length) return console.log(dim('No prompts in the history.'));
        const w = Math.min(48, Math.max(...rows.map((r) => `${r.provider} · ${r.model}`.length)));
        for (const r of rows)
          console.log(
            `${`${r.provider} · ${r.model}`.slice(0, w).padEnd(w)}  ${String(r.calls).padStart(5)} prompts  ${`${r.inputTokens} in / ${r.outputTokens} out`.padEnd(22)}  ${dim(`${r.costUsd !== undefined ? `$${r.costUsd.toFixed(4)}` : 'no price'} · median ${r.medianMs ?? '-'} ms`)}`,
          );
      });
    });
  histCmd
    .command('diff')
    .description('compare two responses from the history (older first): status, timing, headers and a field-by-field body diff')
    .argument('<before>', 'history id of the older response')
    .argument('<after>', 'history id of the newer response')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('--json', 'print the diff as JSON')
    .action((before: string, after: string, o) => {
      return withWorkspace(o.workspace, (store) => {
        // values of sensitive fields and headers are masked (agents read this output too)
        const r = redactDiff(compareHistory(store, before, after), new Redactor(new WorkspaceManager().loadSettings().redactFields));
        if (o.json) printJson(r);
        else {
          console.log(`${r.diff.different ? yellow('Changed') : green('Same')}: ${r.diff.summary}`);
          for (const c of r.diff.body.changes)
            console.log(
              `  ${c.kind === 'added' ? green('+') : c.kind === 'removed' ? red('-') : yellow('~')} ${c.path}  ${c.kind === 'added' ? JSON.stringify(c.after) : c.kind === 'removed' ? JSON.stringify(c.before) : `${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`}`,
            );
          for (const l of r.diff.body.lines ?? []) if (l.op !== ' ') console.log(`  ${l.op === '+' ? green('+') : red('-')} ${l.text}`);
          for (const h of r.diff.headers.filter((x) => !x.volatile)) console.log(`  header ${h.name}: ${h.before ?? '(none)'} -> ${h.after ?? '(none)'}`);
        }
        process.exitCode = 0;
      });
    });
}

/** Id of a saved request by name or id (optionally within one collection). */
function savedRequestId(store: WorkspaceStore, request: string, collection?: string): string {
  const want = String(request).toLowerCase();
  const cols = collection ? [requireCollection(store, String(collection), { loadable: true })] : store.listCollections().filter((c) => !c.problem);
  const flat = (nodes: CollectionNode[]): CollectionNode[] => nodes.flatMap((n) => (n.kind === 'folder' ? flat(n.items) : [n]));
  const hit = cols.flatMap((c) => flat(c.items)).find((n) => n.id.toLowerCase() === want || n.name.toLowerCase() === want);
  if (!hit) throw new CliError(`No saved request "${request}"`, EXIT.CONFIG_ERROR);
  return hit.id;
}
