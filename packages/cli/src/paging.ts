/**
 * One way every list command of the CLI pages (the same contract as the MCP tools): `--limit` (how many; 200 unless the
 * command says otherwise, at most 1,000), `--cursor` (the `nextCursor` of the page before) or `--offset` (the same as a
 * number). A list that is cut says so: a `more: --cursor X` line in text mode, and with `--json` the envelope's `page`
 * ({ total, limit, truncated, nextCursor }) and a warning; `data` stays the plain list.
 */
import { SURFACE_PAGE, pageArgs, pageOf, type ListPage, type PageBounds } from '@testpion/core';
import type { Command } from 'commander';
import { dim } from './shared.js';
import { machine, noteWarning, notePage } from './output.js';

/** What a command's options hold for paging (text from the shell). */
export interface PagingOptions {
  limit?: string | number;
  cursor?: string;
  offset?: string | number;
}

/** `--cursor` and `--offset` (and `-n, --limit` when the command has none yet). */
export function addPaging(cmd: Command, o: { limit?: boolean } = {}): Command {
  if (o.limit) cmd.option('-n, --limit <n>', `how many (default ${SURFACE_PAGE.limit}, at most ${SURFACE_PAGE.max}); a longer list says "more: --cursor …"`);
  return cmd.option('--cursor <cursor>', 'where the page starts: the nextCursor of the page before').option('--offset <n>', 'where the page starts, as a number (the same as --cursor)');
}

/** The page of a list in memory, asked for by the command's options. */
export function pagedList<T>(all: readonly T[], o: PagingOptions, bounds: PageBounds = SURFACE_PAGE): ListPage<T> {
  return pageOf(all, pageArgs(o), bounds);
}

/** Says a page was cut: the hint line in text mode, the envelope's `page` and a warning with --json. Call it when the command prints the page. */
export function reportPage(p: ListPage<unknown>, o: PagingOptions, what = 'items'): void {
  const shownFrom = pageArgs(o).cursor;
  if (!p.truncated && shownFrom === undefined) return;
  notePage({ total: p.total, limit: p.limit, truncated: p.truncated, ...(p.nextCursor ? { nextCursor: p.nextCursor } : {}) });
  if (!p.truncated) return;
  const line = `${p.items.length} of ${p.total} ${what} shown; more: --cursor ${p.nextCursor}`;
  if (machine()) noteWarning(line);
  else console.log(dim(line));
}
