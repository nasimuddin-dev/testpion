import { ArrowLeftRight, Play } from 'lucide-react';
import { useState } from 'react';
import { asError, call } from '../../api';
import { useApp } from '../../store';
import { CompareView, type Compared } from '../../components/ResponseHistory';
import { Badge, Button, Empty, IconButton, Modal, Select, Spinner, statusTone } from '../../components/ui';
import { formatMs } from '../../lib/format';
import type { RestTab } from './types';
import { toEngineRequest } from '../../lib/url';

interface Side {
  environment: string;
  status?: number | string;
  durationMs?: number;
  error?: string;
}
interface Result {
  left: Side;
  right: Side;
  diff: Compared['diff'];
}

/**
 * Send the open request with two environments and compare the responses, to catch differences between
 * e.g. Staging and Production. Both are real requests (scripts and checks run as usual).
 */
export function EnvCompareDialog({ tab, onClose }: { tab: RestTab; onClose(): void }) {
  const envs = useApp((s) => s.workspace?.environments ?? []);
  const current = useApp((s) => s.environment);
  const [left, setLeft] = useState(current ?? envs[0]?.name ?? '');
  const [right, setRight] = useState(envs.find((e) => e.name !== (current ?? envs[0]?.name))?.name ?? '');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState<string>();
  const production = envs.filter((e) => e.isProduction && (e.name === left || e.name === right)).map((e) => e.name);

  const run = async () => {
    setRunning(true);
    setError(undefined);
    try {
      setResult(
        await call<Result>('http.compareEnvironments', {
          request: toEngineRequest(tab.request),
          name: tab.name,
          collectionId: tab.collectionId,
          requestId: tab.requestId,
          preRequestScript: tab.preRequestScript,
          testScript: tab.testScript,
          assertions: tab.assertions,
          left,
          right,
        }),
      );
    } catch (e) {
      setError(asError(e).message);
    } finally {
      setRunning(false);
    }
  };
  const side = (s: Side) => (
    <span className="inline-flex items-center gap-2 text-sm">
      <span className="font-medium">{s.environment}</span>
      {s.error ? <Badge tone="bad">error</Badge> : <Badge tone={statusTone(s.status)}>{s.status}</Badge>}
      {s.durationMs !== undefined && <span className="text-muted tabular-nums">{formatMs(s.durationMs)}</span>}
    </span>
  );
  const picker = (value: string, set: (v: string) => void, label: string) => (
    <Select aria-label={label} className="flex-1" value={value} onChange={(e) => (set(e.target.value), setResult(undefined))}>
      {envs.map((e) => (
        <option key={e.id} value={e.name} disabled={!!e.problem} title={e.problem}>
          {e.name}
          {e.problem ? '  (cannot be read)' : ''}
          {e.isProduction ? ' (production)' : ''}
        </option>
      ))}
    </Select>
  );
  return (
    <Modal title={`Compare "${tab.name}" across environments`} onClose={onClose} width={960}>
      {envs.length < 2 ? (
        <Empty title="You need two environments">Create a second environment (Envs) to compare a request between them.</Empty>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            {picker(left, setLeft, 'First environment')}
            <IconButton label="Swap" onClick={() => (setLeft(right), setRight(left), setResult(undefined))}>
              <ArrowLeftRight size={14} />
            </IconButton>
            {picker(right, setRight, 'Second environment')}
            <Button variant="primary" icon={<Play size={13} />} loading={running} disabled={!left || !right || left === right} onClick={() => void run()}>
              Send to both
            </Button>
          </div>
          {production.length > 0 && <p className="text-xs text-warn">This sends a real request to {production.join(' and ')} (marked as production).</p>}
          {error && <p className="text-sm text-bad">{error}</p>}
          {running && (
            <div className="h-40 grid place-items-center">
              <Spinner size={20} />
            </div>
          )}
          {result && !running && (
            <>
              <div className="flex items-center gap-4 flex-wrap">
                {side(result.left)}
                <span className="text-muted">vs</span>
                {side(result.right)}
              </div>
              {(result.left.error || result.right.error) && <p className="text-sm text-bad">{result.left.error ?? result.right.error}</p>}
              <div className="h-[55vh] rounded-lg border border-line overflow-hidden">
                <CompareView
                  labels={[result.left.environment, result.right.environment]}
                  c={{ before: { id: 'left', timestamp: new Date().toISOString(), status: result.left.status }, after: { id: 'right', timestamp: new Date().toISOString(), status: result.right.status }, diff: result.diff, bodyMissing: false }}
                />
              </div>
            </>
          )}
          {!result && !running && <p className="text-sm text-muted">Both environments get the same request, with their own variables, auth and scripts. The comparison shows status, time, headers and every changed JSON field.</p>}
        </div>
      )}
    </Modal>
  );
}
