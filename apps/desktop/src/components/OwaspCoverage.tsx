import { useEffect, useState } from 'react';
import { call } from '../api';
import { plural } from '../lib/format';
import { ChartCard } from './charts';

/** A row of `owasp` in a run's breakdown (`runs.breakdown`). */
export interface OwaspRow {
  id: string;
  name: string;
  tests: number;
  failed: number;
}

/**
 * The OWASP Top 10 for LLM applications: which categories this run tested and where a test failed. A category with no
 * test says so: a run that did not test it has not shown it is safe.
 */
export function OwaspCard({ rows }: { rows: OwaspRow[] }) {
  const covered = rows.filter((r) => r.tests).length;
  return (
    <ChartCard title="OWASP Top 10 for LLM applications" aside={`${covered} of ${rows.length} tested`}>
      <div className="flex flex-col" data-run-owasp>
        {rows.map((r) => (
          <div key={r.id} className="flex items-center gap-2 py-1 text-xs min-w-0" data-run-owasp-row={r.id} data-state={!r.tests ? 'untested' : r.failed ? 'failed' : 'passed'}>
            <span className="w-12 shrink-0 tabular-nums text-muted">{r.id.replace(/:\d+$/, '')}</span>
            <span className={`truncate flex-1 min-w-0 ${r.tests ? 'text-fg' : 'text-muted'}`} title={r.name}>
              {r.name}
            </span>
            <span className={`tabular-nums shrink-0 ${!r.tests ? 'text-muted' : r.failed ? 'text-bad' : 'text-ok'}`}>
              {!r.tests ? 'not tested' : r.failed ? `${r.failed} of ${plural(r.tests, 'test')} failed` : `${plural(r.tests, 'test')} passed`}
            </span>
          </div>
        ))}
      </div>
    </ChartCard>
  );
}

/** The card for a run, when one of its tests covered a category (a run of plain API tests shows nothing). */
export function RunOwasp({ runId }: { runId: string }) {
  const [rows, setRows] = useState<OwaspRow[]>();
  useEffect(() => {
    setRows(undefined);
    void call<{ owasp?: OwaspRow[] }>('runs.breakdown', { runId }).then(
      (b) => setRows(b.owasp),
      () => setRows(undefined),
    );
  }, [runId]);
  return rows ? <OwaspCard rows={rows} /> : null;
}
