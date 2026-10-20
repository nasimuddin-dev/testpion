import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { useMemo } from 'react';
import { AiAction } from './ai/AiAction';
import { ApiReportBar } from './ApiReportBar';
import { lintReport } from './output/api-report-specs';
import { Badge, Empty } from './ui';
import { plural } from '../lib/format';

export interface ApiLintProblem {
  rule: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  where: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface ApiLintResult {
  problems: ApiLintProblem[];
  counts: { error: number; warning: number; info: number };
  operations: number;
}

const ICON = {
  error: <CircleAlert size={13} className="text-bad shrink-0" />,
  warning: <TriangleAlert size={13} className="text-warn shrink-0" />,
  info: <Info size={13} className="text-muted shrink-0" />,
};
const TONE = { error: 'bad', warning: 'warn', info: 'default' } as const;

/** The lint problems of an API definition: one row per problem (opens its place in the document), and AI advice on fixing them. */
export function ApiLintPanel({ spec, text, result, onOpen }: { spec: string; text: string; result?: ApiLintResult; onOpen(p: ApiLintProblem): void }) {
  const report = useMemo(() => (result ? lintReport(spec, result) : undefined), [spec, result]);
  if (!result) return <Empty title="Checking the document…" />;
  const { counts, problems } = result;
  if (!problems.length)
    return (
      <Empty icon={<CircleCheck size={26} />} title="No problems">
        Every $ref resolves, path parameters are declared, operationIds are unique, security schemes exist and examples match their schemas ({plural(result.operations, 'operation')} checked).
      </Empty>
    );
  return (
    <div className="h-full flex flex-col min-h-0" data-api-lint>
      <div className="flex items-center gap-3 px-3 py-2 border-b border-line text-sm shrink-0">
        <span className="flex items-center gap-1">
          {ICON.error} {plural(counts.error, 'error')}
        </span>
        <span className="flex items-center gap-1">
          {ICON.warning} {plural(counts.warning, 'warning')}
        </span>
        <span className="flex items-center gap-1">
          {ICON.info} {plural(counts.info, 'note')}
        </span>
        <span className="text-muted">· {plural(result.operations, 'operation')}</span>
        <ApiReportBar kind="lint" report={report}>
        <AiAction variant="ghost" label="How to fix (AI)" request={() => ({
          task: 'fix-openapi-lint',
          title: `Fixes · ${spec.replace(/^specs\//, '')}`,
          context: { document: spec, problems: problems.slice(0, 80).map(({ rule, severity, line, where, message }) => ({ rule, severity, line, where, message })), text: text.slice(0, 40_000) },
        })} />
        </ApiReportBar>
      </div>
      <ul className="flex-1 overflow-auto p-1">
        {problems.map((p, i) => (
          <li key={i}>
            <button className="w-full text-left flex items-start gap-2 px-2 py-1.5 rounded hover:bg-panel" onClick={() => onOpen(p)} title="Show it in the document" data-lint-rule={p.rule}>
              <span className="pt-0.5">{ICON[p.severity]}</span>
              <span className="flex flex-col min-w-0 flex-1">
                <span className="text-sm">{p.message}</span>
                <span className="text-xs text-muted truncate">
                  {p.where} · line {p.line}
                </span>
              </span>
              <Badge tone={TONE[p.severity]}>{p.rule}</Badge>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
