import { CheckCircle2 } from 'lucide-react';
import { useMemo } from 'react';
import { jsonPretty, markdownTable, objectsToCsv, outputFileName } from '@testpion/shared';
import { plural } from '../lib/format';
import { useProblems, type Problem } from '../lib/problems';
import { ProblemList } from './ProblemList';
import { OutputActions } from './output/OutputFrame';
import { OutputHint } from './output/OutputToolbar';
import type { OutputSpec } from './output/output-core';
import { Empty } from './ui';

const COLUMNS = ['severity', 'type', 'kind', 'group', 'message', 'at'] as const;
/** A problem as a row of the exported list (its ref as JSON, for what it names). */
const row = (p: Problem) => ({ severity: p.severity, type: p.type, kind: p.kind, group: p.group, message: p.message, at: p.at ?? '', ref: p.ref });

/** WF-03: the bottom panel's Problems tab: every problem of the workspace, grouped, F8 / Shift+F8 to step through. */
export function ProblemsPanel() {
  const problems = useProblems();
  const failures = problems.filter((p) => p.type === 'failure').length;
  const errors = problems.filter((p) => p.type === 'error').length;
  const spec = useMemo<OutputSpec>(
    () => ({
      id: 'problems',
      what: 'problems',
      name: outputFileName({ name: 'problems', ext: '' }),
      formats: [
        { format: 'md', default: true, build: () => `# Problems\n\n${markdownTable([...COLUMNS], problems.map((p) => COLUMNS.map((c) => row(p)[c])))}` },
        { format: 'json', build: () => jsonPretty(problems.map(row)) },
        { format: 'csv', build: () => objectsToCsv(problems.map(row), { columns: [...COLUMNS, 'ref'] }) },
      ],
      empty: problems.length ? undefined : 'No problems',
    }),
    [problems],
  );
  return (
    <>
      <div className="flex items-center gap-3 px-3 h-7 border-b border-line text-xs text-muted shrink-0">
        <span>
          {plural(failures, 'failure')} · {plural(errors, 'error')} · {plural(problems.length - failures - errors, 'warning')}
        </span>
        {/* the keys behind the ⓘ (the same hint as every output bar's): as text they were the first thing clipped in a narrow pane */}
        <OutputActions spec={spec}>
          <OutputHint hint="F8 / Shift+F8: next / previous problem" />
        </OutputActions>
      </div>
      <div className="flex-1 overflow-auto px-1 py-1" data-output="problems">
        {problems.length ? (
          <ProblemList problems={problems} grouped />
        ) : (
          <Empty icon={<CheckCircle2 size={22} />} title="No problems">
            Monitors, runs, requests, certificates and workspace files are all fine.
          </Empty>
        )}
      </div>
    </>
  );
}
