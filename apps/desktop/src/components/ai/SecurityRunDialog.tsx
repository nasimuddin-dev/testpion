import { Play, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import type { SecurityRunReport, SecurityStepVerdict } from '@testpion/core';
import { asError, call } from '../../api';
import { OutputActions } from '../output/OutputFrame';
import { securityOutputSpec } from '../output/ai-specs';
import { useApp } from '../../store';
import { Badge, Button, Callout, Modal, Spinner } from '../ui';

type Report = SecurityRunReport & { markdown: string };

const TONE = { finding: 'bad', inconclusive: 'warn', pass: 'ok' } as const;
const WORD = { finding: 'Finding', inconclusive: 'Inconclusive', pass: 'Pass' } as const;

/** One step's verdict: what it probed, and the checks that failed or why it proved nothing. */
function Verdict({ v }: { v: SecurityStepVerdict }) {
  return (
    <li className="rounded-lg border border-line p-2 grid gap-1" data-security-verdict={v.verdict}>
      <div className="flex items-center gap-2 min-w-0">
        <Badge tone={TONE[v.verdict]}>{WORD[v.verdict]}</Badge>
        {v.owasp && <Badge>{v.owasp}</Badge>}
        <span className="truncate" title={v.name}>
          {v.name}
        </span>
        {v.status !== undefined && <span className="ml-auto text-xs text-muted tabular-nums">status {v.status}</span>}
      </div>
      {v.detail.map((d, i) => (
        <p key={i} className="text-xs text-muted pl-1">
          {d}
        </p>
      ))}
    </li>
  );
}

/**
 * Run a generated security test file (AI-8) in the environment of the window and show the verdicts, findings first. The
 * runner judges: each step's verdict is the result of its checks. A production environment is refused (the window never
 * consents to it). Nothing is run until the person presses Run.
 */
export function SecurityRunDialog({ path, environment, onClose }: { path: string; environment?: string; onClose(): void }) {
  const prod = useApp((s) => !!s.workspace?.environments.find((e) => e.name === environment)?.isProduction);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<Report>();
  const [error, setError] = useState<string>();
  const run = async () => {
    if (!environment) return;
    setBusy(true);
    setError(undefined);
    try {
      setReport(await call<Report>('ai.securityRun', { path, environment }));
    } catch (e) {
      setError(asError(e).message);
    } finally {
      setBusy(false);
    }
  };
  const s = report?.summary;
  return (
    <Modal
      title={
        <span className="flex items-center gap-2">
          <ShieldAlert size={16} /> Security tests · tests/{path}
        </span>
      }
      onClose={onClose}
      width={760}
      footer={
        <>
          {report && (
            <span className="mr-auto">
              <OutputActions spec={securityOutputSpec(report)} />
            </span>
          )}
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" icon={<Play size={13} />} loading={busy} disabled={!environment || prod} onClick={() => void run()} data-security-run>
            {report ? 'Run again' : 'Run now'}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 text-sm" data-security-run-dialog>
        <p>
          The file is written. Running it sends the probes to <b>{environment ?? 'no environment'}</b>, one at a time, paced by the file — requests without credentials, with an invalid token and as another user. The verdicts are the checks of
          each step, computed from the responses.
        </p>
        {prod && <Callout tone="bad">“{environment}” is a production environment: security tests are refused there. Pick a test environment (top bar), then run.</Callout>}
        {!environment && <Callout tone="warn">No environment is selected. Pick the test environment the probes should reach (top bar).</Callout>}
        {busy && (
          <div className="flex items-center gap-2 text-muted" role="status">
            <Spinner /> Running the probes…
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-bad/40 bg-bad/5 p-3" role="alert">
            {error}
          </div>
        )}
        {report && s && (
          <div className="grid gap-2" data-security-report>
            <p>
              {s.steps} steps: <b className={s.findings ? 'text-bad' : ''}>{s.findings} findings</b>, {s.pass} passed, {s.inconclusive} inconclusive.
            </p>
            <ul className="grid gap-1.5 max-h-[360px] overflow-auto">
              {report.verdicts.map((v) => (
                <Verdict key={v.step} v={v} />
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
