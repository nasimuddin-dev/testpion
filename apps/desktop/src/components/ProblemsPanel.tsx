import { CheckCircle2 } from 'lucide-react';
import { useProblems } from '../lib/problems';
import { ProblemList } from './ProblemList';
import { Empty } from './ui';

/** WF-03: the bottom panel's Problems tab: every problem of the workspace, grouped, F8 / Shift+F8 to step through. */
export function ProblemsPanel() {
  const problems = useProblems();
  const failures = problems.filter((p) => p.type === 'failure').length;
  const errors = problems.filter((p) => p.type === 'error').length;
  return (
    <>
      <div className="flex items-center gap-3 px-3 h-7 border-b border-line text-xs text-muted shrink-0">
        <span>
          {failures} failure{failures === 1 ? '' : 's'} · {errors} error{errors === 1 ? '' : 's'} · {problems.length - failures - errors} warning{problems.length - failures - errors === 1 ? '' : 's'}
        </span>
        <span className="ml-auto">F8 / Shift+F8: next / previous</span>
      </div>
      <div className="flex-1 overflow-auto px-1 py-1">
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
