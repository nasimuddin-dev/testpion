import type { checkReadOnlySql, resolveSqlSource, runReadOnlySql } from '../../runner/sql-exec.js';

/**
 * What the SQL metrics (metrics-sql.ts) borrow from the runner: the read-only executor. The metric engine takes nothing from
 * the runner but types, so runner/sql-exec.ts hands its functions over here when it is loaded (the engine always loads it).
 */
export interface SqlHost {
  checkReadOnlySql: typeof checkReadOnlySql;
  resolveSqlSource: typeof resolveSqlSource;
  runReadOnlySql: typeof runReadOnlySql;
}

let host: SqlHost | undefined;

export function provideSqlHost(h: SqlHost): void {
  host = h;
}

export function sqlHost(): SqlHost {
  if (!host) throw new Error('The SQL executor is not loaded (runner/sql-exec.ts)');
  return host;
}
