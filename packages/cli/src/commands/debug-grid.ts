/**
 * The HTTP Debugger's grid tools from the terminal, on a HAR file, so a script or an agent can do what the grid does:
 *   debugger exchanges <har>   list the entries; --where selects (Select matching), --column adds headers, --group-by groups (FG-3, FG-12, FG-17)
 *   debugger replay <har> …    send entries again many times, some at once (FG-2)
 *   debugger snippet <har> <e> an entry as cURL / PowerShell / fetch / HTTPie … (Q7)
 *   debugger programs          the running programs with connections, for a Capture only rule (FG-16)
 */
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import {
  CODE_LANGUAGES,
  Redactor,
  cleanReplayOptions,
  compileWhere,
  executeHttp,
  exchangesFromHar,
  generateCode,
  isReplayLocalHost,
  listRunningPrograms,
  parseWhere,
  replayMany,
  requestOfExchange,
  type DebuggerExchange,
  type HttpRequestSpec,
} from '@testpion/core';
import { formatBytes } from '@testpion/shared';
import { EXIT, CliError, dim, green, printJson, red, JSON_RESULT_OPTION } from '../shared.js';

function readEntries(file: string): DebuggerExchange[] {
  let har: unknown;
  try {
    har = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new CliError(`${file}: ${(e as Error).message}`, EXIT.CONFIG_ERROR);
  }
  return exchangesFromHar(har);
}

/** An entry by its exchange id, or #3 for the third. */
function pickEntry(all: DebuggerExchange[], ref: string): DebuggerExchange {
  const n = /^#(\d+)$/.exec(ref);
  const e = n ? all[Number(n[1]) - 1] : all.find((x) => x.id === ref);
  if (!e) throw new CliError(`No entry ${ref} in the file (give the exchange id, or #3 for the third entry)`, EXIT.CONFIG_ERROR);
  return e;
}

const mask = (e: DebuggerExchange, red_: Redactor) => ({ ...e, url: red_.redactUrl(e.url) });

export function registerDebugGridCommands(program: Command): void {
  program
    .command('debug-exchanges')
    .description('list the entries of a HAR file: select them with --where (status>=400 and host~api), add header columns, group them by domain, application or connection')
    .argument('<har>', 'the HAR file (a saved Debugger session, or any HAR)')
    .option('--where <condition>', 'status>=400 and host~api and size>200kb. Fields: status method host url type size time app ip user pid note mark kind. Operators: = != > >= < <= ~ !~ ^= $=')
    .option('--column <side:header...>', 'add a header as a column: response:cache-control, request:x-request-id', (v: string, prev: string[] = []) => [...prev, v])
    .option('--group-by <what>', 'domain | application | connection: count the entries per group instead of listing them')
    .option('--limit <n>', 'at most this many entries (default 200)', '200')
    .option(...JSON_RESULT_OPTION)
    .action((file: string, o: { where?: string; column?: string[]; groupBy?: string; limit: string; json?: boolean }) => {
      const all = readEntries(file);
      let test: ReturnType<typeof compileWhere> | undefined;
      if (o.where) {
        const w = parseWhere(o.where);
        if (!w.ok) throw new CliError(w.error, EXIT.CONFIG_ERROR);
        test = compileWhere(w.clauses);
      }
      const redactor = new Redactor();
      const picked = all.map((e, i) => ({ e, n: i + 1 })).filter(({ e }) => !test || test(e));
      if (o.groupBy) {
        if (!['domain', 'application', 'connection'].includes(o.groupBy)) throw new CliError('--group-by is domain, application or connection', EXIT.CONFIG_ERROR);
        const groups = new Map<string, { group: string; count: number; bytes: number; failed: number }>();
        for (const { e } of picked) {
          const key = o.groupBy === 'domain' ? e.host : o.groupBy === 'application' ? (e.application ?? '(unknown)') : (e.connectionId ?? `:${e.clientPort}`);
          const g = groups.get(key) ?? { group: key, count: 0, bytes: 0, failed: 0 };
          g.count++;
          g.bytes += e.responseBodyBytes;
          if (e.error || (e.status ?? 0) >= 400) g.failed++;
          groups.set(key, g);
        }
        const out = { file, total: all.length, matched: picked.length, groupBy: o.groupBy, groups: [...groups.values()] };
        if (o.json) return printJson(out);
        for (const g of out.groups) console.log(`${g.group.padEnd(40)} ${String(g.count).padStart(5)} requests  ${formatBytes(g.bytes).padStart(9)}${g.failed ? red(`  ${g.failed} failed`) : ''}`);
        return;
      }
      const cols = (o.column ?? []).map((c) => {
        const m = /^(request|response):(.+)$/i.exec(c.trim());
        if (!m) throw new CliError(`--column ${c}: write request:name or response:name`, EXIT.CONFIG_ERROR);
        return { key: c.trim().toLowerCase(), side: m[1]!.toLowerCase() as 'request' | 'response', name: m[2]!.trim().toLowerCase() };
      });
      const limit = Math.max(1, Math.min(5000, Number(o.limit) || 200));
      const rows = picked.slice(0, limit).map(({ e, n }) => ({
        n,
        id: e.id,
        method: e.method,
        url: redactor.redactUrl(e.url),
        status: e.status ?? (e.error ? 'ERR' : null),
        type: e.contentType?.split(';')[0] ?? null,
        bytes: e.responseBodyBytes,
        ms: e.durationMs ?? null,
        application: e.application ?? null,
        ...(cols.length ? { columns: Object.fromEntries(cols.map((c) => [c.key, redactor.isSensitiveKey(c.name) ? '***' : ((c.side === 'request' ? e.requestHeaders : e.responseHeaders)?.[c.name] ?? null)])) } : {}),
      }));
      const out = { file, total: all.length, matched: picked.length, shown: rows.length, ...(o.where ? { where: o.where } : {}), exchanges: rows };
      if (o.json) return printJson(out);
      for (const r of rows) console.log(`${String(r.n).padStart(4)}  ${r.method.padEnd(6)} ${String(r.status ?? '').padEnd(4)} ${r.url}${r.columns ? dim('  ' + JSON.stringify(r.columns)) : ''}`);
      console.log(dim(`${picked.length} of ${all.length} entries${picked.length > rows.length ? ` (first ${rows.length})` : ''}`));
    });

  program
    .command('debug-replay')
    .description('send entries of a HAR file again: --times sends in all (1 to 200), --concurrency at once; prints the statuses and the fastest, middle and slowest time')
    .argument('<har>', 'the HAR file')
    .argument('<entries...>', 'exchange ids, or #3 for the third entry; several are sent in this order and round again')
    .option('--times <n>', 'how many sends in all (default: one per entry)')
    .option('--concurrency <n>', 'how many at once (1 to 20)', '1')
    .option('--delay <ms>', 'wait between the start of one send and the next in a lane', '0')
    .option('--stop-on-failure', 'stop starting sends after the first error or status of 400 and up')
    .option('--yes', 'allow several sends to a host that is not on this computer')
    .option('--dry-run', 'send nothing: say what would be sent')
    .option(...JSON_RESULT_OPTION)
    .action(async (file: string, refs: string[], o: { times?: string; concurrency: string; delay: string; stopOnFailure?: boolean; yes?: boolean; dryRun?: boolean; json?: boolean }) => {
      const all = readEntries(file);
      const picked = refs.map((r) => pickEntry(all, r)).filter((e) => e.kind !== 'tunnel');
      if (!picked.length) throw new CliError('Give requests to send (an HTTPS tunnel is not a request)', EXIT.CONFIG_ERROR);
      const opts = cleanReplayOptions({ count: o.times === undefined ? picked.length : Number(o.times), concurrency: Number(o.concurrency), delayMs: Number(o.delay), stopOnFailure: !!o.stopOnFailure });
      const remote = [...new Set(picked.filter((e) => !isReplayLocalHost(e.host)).map((e) => e.host))];
      const redactor = new Redactor();
      const targets = picked.map((e) => ({ id: e.id, method: e.method, url: redactor.redactUrl(e.url) }));
      if (o.dryRun) {
        const out = { dryRun: true, options: opts, targets, remote };
        if (o.json) return printJson(out);
        return console.log(`Would send ${opts.count} requests (${opts.concurrency} at once) to ${targets.map((t) => t.url).join(', ')}${remote.length ? ` - not on this computer: ${remote.join(', ')}` : ''}`);
      }
      if (opts.count > 1 && remote.length && !o.yes) throw new CliError(`This sends ${opts.count} requests to ${remote.join(', ')}, which is not on this computer. Add --yes if the server is yours or you have permission.`, EXIT.CONFIG_ERROR);
      const summary = await replayMany(opts, async (i) => {
        const e = picked[i % picked.length]!;
        const started = Date.now();
        try {
          const { response } = await executeHttp(requestOfExchange(e) as HttpRequestSpec, { redactor, maxPreviewBytes: 1024 });
          return { status: response.status, ms: response.durationMs ?? Date.now() - started };
        } catch (err) {
          return { error: (err as Error).message, ms: Date.now() - started };
        }
      });
      const out = { options: opts, targets, remote, ...summary };
      if (o.json) {
        printJson(out);
      } else {
        console.log(`${green(`${summary.sent} of ${summary.planned} sent`)}  ${Object.entries(summary.statuses).map(([k, n]) => `${k} x ${n}`).join('  ')}${summary.skipped ? `  ${summary.skipped} not started` : ''}`);
        if (summary.minMs !== undefined) console.log(dim(`fastest ${summary.minMs} ms, middle ${summary.p50Ms} ms, slowest ${summary.maxMs} ms`));
      }
      if (summary.failed) process.exitCode = EXIT.TEST_FAILURE;
    });

  program
    .command('debug-snippet')
    .description('an entry of a HAR file as code: cURL, PowerShell, fetch, HTTPie, Python … (secrets in the URL and headers are masked)')
    .argument('<har>', 'the HAR file')
    .argument('<entry>', 'the exchange id, or #3 for the third entry')
    .option('--lang <language>', `curl (default), powershell, fetch, httpie, ${CODE_LANGUAGES.map((l) => l.id).filter((l) => !['curl', 'powershell', 'fetch', 'httpie'].includes(l)).join(', ')}`, 'curl')
    .option(...JSON_RESULT_OPTION)
    .action((file: string, entry: string, o: { lang: string; json?: boolean }) => {
      const e = pickEntry(readEntries(file), entry);
      if (!CODE_LANGUAGES.some((l) => l.id === o.lang)) throw new CliError(`Unknown language "${o.lang}": ${CODE_LANGUAGES.map((l) => l.id).join(', ')}`, EXIT.CONFIG_ERROR);
      const redactor = new Redactor();
      const headers = Object.entries(redactor.redactHeaders(e.requestHeaders)).filter(([k]) => !/^(host|content-length|connection|proxy-.*)$/i.test(k)) as Array<[string, string]>;
      const text = generateCode({ method: e.method, url: mask(e, redactor).url, headers, body: e.requestBody && redactor.redactString(e.requestBody) }, o.lang);
      if (o.json) return printJson({ language: o.lang, text });
      console.log(text);
    });

  program
    .command('debug-programs')
    .description('the programs running now that hold network connections (the names a Capture only rule on the Application column uses), busiest first')
    .option('--filter <text>', 'only programs whose name contains this')
    .option(...JSON_RESULT_OPTION)
    .action(async (o: { filter?: string; json?: boolean }) => {
      const programs = (await listRunningPrograms()).filter((p) => !o.filter || p.name.toLowerCase().includes(o.filter.toLowerCase()));
      if (o.json) return printJson({ programs });
      for (const p of programs) console.log(`${p.name.padEnd(32)} ${String(p.connections).padStart(4)} connections  ${dim(`pid ${p.pids.slice(0, 5).join(', ')}`)}`);
      if (!programs.length) console.log('No program with connections found');
    });
}
