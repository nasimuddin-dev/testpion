import { useEffect, useState } from 'react';
import { call } from '../api';
import { useApp } from '../store';
import { openRef } from '../lib/open-ref';
import { formatMs, plural, timeAgo } from '../lib/format';
import { axisMs, ChartCard, PointLine, Swatch } from './charts';
import { StatusIcon } from './Results';
import { Sparkles } from 'lucide-react';
import { Button, Empty, Spinner } from './ui';

/** From `runs.testHistory` (testHistory in core). */
interface Point {
  runId: string;
  runName: string;
  startedAt: string;
  environment?: string;
  status: string;
  latencyMs?: number;
  attempts?: number;
  failures: string[];
}

const bad = (s: string) => s === 'failed' || s === 'error';
const color = (p: Point) => (p.status === 'passed' ? 'var(--ok)' : bad(p.status) ? 'var(--bad)' : 'var(--warn)');

/** One test across the latest runs: pass / fail over time, latency, and each run (click to open it). */
export function TestHistory({ id, name, runId }: { id: string; name: string; runId: string }) {
  const [points, setPoints] = useState<Point[]>();
  useEffect(() => {
    setPoints(undefined);
    void call<Point[]>('runs.testHistory', { id, limit: 30 }).then(setPoints, () => setPoints([]));
  }, [id, runId]);
  if (!points)
    return (
      <div className="h-full grid place-items-center">
        <Spinner />
      </div>
    );
  if (points.length < 2) return <Empty title="No earlier runs of this test">Run it again and each result is listed here, with how its time and outcome changed.</Empty>;
  const ordered = [...points].reverse();
  const counted = ordered.filter((p) => p.status !== 'skipped');
  let flips = 0;
  for (let i = 1; i < counted.length; i++) if ((counted[i]!.status === 'passed') !== (counted[i - 1]!.status === 'passed')) flips++;
  const passed = counted.filter((p) => p.status === 'passed').length;
  const timed = ordered.filter((p) => p.latencyMs !== undefined);
  const sorted = timed.map((p) => p.latencyMs!).sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : 0;
  const open = (rid: string) => rid !== runId && void openRef({ kind: 'run', runId: rid });
  return (
    <div className="p-3 flex flex-col gap-3">
      <div className="text-sm">
        <b className={passed === counted.length ? 'text-ok' : 'text-bad'}>
          passed {passed} of {plural(counted.length, 'run')}
        </b>
        {flips > 1 && <span className="text-warn"> · the result flipped {flips} times: flaky?</span>}
        <span className="text-muted"> · {name}</span>
      </div>
      {(flips > 0 || passed < counted.length) && (
        <div>
          <Button
            size="sm"
            icon={<Sparkles size={12} />}
            title="Ask the AI assistant whether this test is flaky or broken, and why (statuses, times and failed check names are sent)"
            onClick={() =>
              useApp.getState().set({
                assistant: {
                  task: 'explain-test-history',
                  title: `History of "${name}"`,
                  context: {
                    test: name,
                    summary: { runs: counted.length, passed, failed: counted.length - passed, flips, medianMs: median },
                    runs: points.map((p) => ({ when: p.startedAt, status: p.status, latencyMs: p.latencyMs, attempts: p.attempts, environment: p.environment, failedChecks: p.failures })),
                  },
                },
              })
            }
          >
            Explain with AI
          </Button>
        </div>
      )}
      {timed.length > 1 && (
        <ChartCard
          title="Time per run"
          aside={
            <span>
              median <b className="text-fg">{formatMs(median)}</b>
            </span>
          }
          legend={
            <>
              <Swatch color="var(--ok)" label="Passed" />
              <Swatch color="var(--bad)" label="Failed" />
              <span className="ml-auto">oldest left</span>
            </>
          }
        >
          <PointLine
            items={timed}
            value={(p) => p.latencyMs!}
            color={color}
            keyOf={(p) => p.runId}
            axis={axisMs}
            reference={median}
            ends={(p) => timeAgo(p.startedAt)}
            tip={(p) => (
              <>
                <div className="font-medium text-fg">
                  {p.status} · {formatMs(p.latencyMs)}
                </div>
                <div className="text-muted">
                  {p.runName} · {timeAgo(p.startedAt)}
                </div>
                {p.failures.length > 0 && <div className="text-bad">{p.failures.join('; ')}</div>}
              </>
            )}
            label={`Time of ${name} in the last ${timed.length} runs, median ${formatMs(median)}`}
          />
        </ChartCard>
      )}
      <div className="rounded-lg border border-line divide-y divide-line/60">
        {points.map((p) => (
          <button
            key={p.runId}
            className="w-full flex items-start gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-hover disabled:hover:bg-transparent"
            disabled={p.runId === runId}
            title={p.runId === runId ? 'This run' : 'Open this run'}
            onClick={() => open(p.runId)}
          >
            <span className="pt-0.5">
              <StatusIcon status={p.status} />
            </span>
            <span className="flex-1 min-w-0">
              <span className="text-fg">{p.runName}</span>
              <span className="text-muted">
                {' '}
                · {timeAgo(p.startedAt)}
                {p.environment ? ` · ${p.environment}` : ''}
                {p.runId === runId ? ' · this run' : ''}
              </span>
              {p.failures.length > 0 && <span className="block text-bad truncate">{p.failures.join('; ')}</span>}
            </span>
            {p.attempts && <span className="text-warn shrink-0">{p.attempts} attempts</span>}
            <span className="tabular-nums shrink-0 w-16 text-right text-fg">{formatMs(p.latencyMs)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
