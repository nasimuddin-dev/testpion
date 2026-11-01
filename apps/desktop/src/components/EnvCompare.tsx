import { ArrowLeft, ArrowLeftRight, ArrowRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { asError, call } from '../api';
import { confirmAction, toastError } from '../store';
import type { Environment } from '../types';
import { Badge, cx, IconButton, Modal, Select, Toggle } from './ui';
import { EnvOutputBar } from './EnvOutputBar';
import { tableOutputSpec } from './output/table-specs';

interface EnvDiffRow {
  key: string;
  status: 'same' | 'different' | 'only-left' | 'only-right';
  left?: string;
  right?: string;
  secret?: boolean;
  secretLeft?: boolean;
  secretRight?: boolean;
  disabledLeft?: boolean;
  disabledRight?: boolean;
  secretSetLeft?: boolean;
  secretSetRight?: boolean;
}
interface EnvDiff {
  left: string;
  right: string;
  rows: EnvDiffRow[];
  summary: { same: number; different: number; onlyLeft: number; onlyRight: number };
}

const LABEL: Record<EnvDiffRow['status'], { text: string; tone: 'default' | 'warn' | 'bad' | 'ok' }> = {
  same: { text: 'Same', tone: 'default' },
  different: { text: 'Different', tone: 'warn' },
  'only-left': { text: 'Missing on the right', tone: 'bad' },
  'only-right': { text: 'Missing on the left', tone: 'bad' },
};

/** Two environments side by side, differences first (secret values are never shown, only whether they are set). */
export function EnvCompare({ environments, initialLeft, onClose }: { environments: Environment[]; initialLeft: string; onClose(): void }) {
  const [left, setLeft] = useState(initialLeft);
  const [right, setRight] = useState(() => environments.find((e) => e.id !== initialLeft)?.id ?? initialLeft);
  const [diff, setDiff] = useState<EnvDiff>();
  const [error, setError] = useState<string>();
  const [showSame, setShowSame] = useState(false);
  const load = () =>
    call<EnvDiff>('env.diff', { left, right }).then(
      (d) => (setDiff(d), setError(undefined)),
      (e) => setError(asError(e).message),
    );
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the pair
  }, [left, right]);
  const name = (id: string) => environments.find((e) => e.id === id)?.name ?? id;
  /** Copy a row's variable to the other side (its value, enabled and secret as on the source), after asking: the old value is gone. */
  const copy = async (r: EnvDiffRow, to: 'left' | 'right') => {
    const from = to === 'left' ? right : left;
    const target = to === 'left' ? left : right;
    const has = to === 'left' ? r.status !== 'only-right' : r.status !== 'only-left';
    const ok = await confirmAction({
      title: `Copy ${r.key} to ${name(target)}?`,
      message: has ? `Its value in ${name(target)} is replaced by the one in ${name(from)}; the old value is gone.` : `${r.key} is added to ${name(target)} with the value it has in ${name(from)}.`,
      detail: r.secret || (to === 'left' ? r.secretRight : r.secretLeft) ? 'A secret is copied secret store to secret store and never shown.' : undefined,
      confirmLabel: 'Copy',
    });
    if (!ok) return;
    try {
      await call('vars.copyToEnvironment', { from, to: target, key: r.key });
      await load();
    } catch (e) {
      toastError(e);
    }
  };

  const rows = (diff?.rows ?? []).filter((r) => showSame || r.status !== 'same');
  const cell = (r: EnvDiffRow, side: 'left' | 'right') => {
    const present = side === 'left' ? r.status !== 'only-right' : r.status !== 'only-left';
    if (!present) return <span className="text-bad italic">not defined</span>;
    const disabled = side === 'left' ? r.disabledLeft : r.disabledRight;
    const set = side === 'left' ? r.secretSetLeft : r.secretSetRight;
    const isSecret = side === 'left' ? r.secretLeft : r.secretRight;
    return (
      <span className={cx('mono break-all', disabled && 'line-through text-muted')}>
        {isSecret ? <span className="text-muted">{set === false ? 'secret · not set' : 'secret · set'}</span> : (side === 'left' ? r.left : r.right) || <span className="text-muted italic">empty</span>}
        {disabled && <span className="ml-2 not-italic text-xs">(disabled)</span>}
      </span>
    );
  };
  // the values as shown: secrets only as set / not set
  const text = (r: EnvDiffRow, side: 'left' | 'right') => {
    if (side === 'left' ? r.status === 'only-right' : r.status === 'only-left') return 'not defined';
    const secret = side === 'left' ? r.secretLeft : r.secretRight;
    const set = side === 'left' ? r.secretSetLeft : r.secretSetRight;
    const value = side === 'left' ? r.left : r.right;
    return `${secret ? (set === false ? 'secret · not set' : 'secret · set') : value || 'empty'}${(side === 'left' ? r.disabledLeft : r.disabledRight) ? ' (disabled)' : ''}`;
  };
  const spec = useMemo(
    () =>
      tableOutputSpec({
        id: 'env.matrix',
        what: 'environment comparison',
        name: `compare-${diff?.left ?? 'left'}-${diff?.right ?? 'right'}`,
        title: `${diff?.left ?? ''} compared with ${diff?.right ?? ''}`,
        columns: ['variable', diff?.left ?? 'left', diff?.right ?? 'right', 'status'],
        rows: rows.map((r) => [r.key, text(r, 'left'), text(r, 'right'), LABEL[r.status].text]),
        empty: diff ? undefined : 'Reading the environments…',
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rows follow diff and the filter
    [diff, showSame],
  );
  const picker = (value: string, set: (v: string) => void, label: string) => (
    <Select aria-label={label} value={value} onChange={(e) => set(e.target.value)} className="flex-1">
      {environments.map((e) => (
        <option key={e.id} value={e.id} disabled={!!e.problem} title={e.problem}>
          {e.name}
          {e.problem ? '  (cannot be read)' : ''}
        </option>
      ))}
    </Select>
  );
  return (
    <Modal title="Compare environments" onClose={onClose} width={900}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          {picker(left, setLeft, 'Left environment')}
          <IconButton label="Swap" onClick={() => (setLeft(right), setRight(left))}>
            <ArrowLeftRight />
          </IconButton>
          {picker(right, setRight, 'Right environment')}
        </div>
        {error && <div className="text-sm text-bad">{error}</div>}
        {diff && (
          <div className="flex items-center gap-2 text-sm flex-wrap">
            <Badge tone={diff.summary.different ? 'warn' : 'default'}>{diff.summary.different} different</Badge>
            <Badge tone={diff.summary.onlyLeft ? 'bad' : 'default'}>{diff.summary.onlyLeft} only in {diff.left}</Badge>
            <Badge tone={diff.summary.onlyRight ? 'bad' : 'default'}>{diff.summary.onlyRight} only in {diff.right}</Badge>
            <Badge>{diff.summary.same} same</Badge>
            <EnvOutputBar spec={spec}>
              <Toggle checked={showSame} onChange={setShowSame} label="Show variables that are the same" />
            </EnvOutputBar>
          </div>
        )}
        <div className="max-h-[55vh] overflow-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-panel text-xs text-muted text-left">
              <tr>
                <th className="font-normal px-3 py-2 w-48">Variable</th>
                <th className="font-normal px-3 py-2">{diff?.left}</th>
                <th className="font-normal px-3 py-2">{diff?.right}</th>
                <th className="font-normal px-3 py-2 w-44" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-t border-line/60 align-top">
                  <td className="px-3 py-1.5 mono font-medium break-all">{r.key}</td>
                  <td className="px-3 py-1.5">{cell(r, 'left')}</td>
                  <td className="px-3 py-1.5">{cell(r, 'right')}</td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">
                    <Badge tone={LABEL[r.status].tone}>{LABEL[r.status].text}</Badge>
                    {r.status !== 'same' && (
                      <span className="inline-flex gap-0.5 ml-2 align-middle">
                        {r.status !== 'only-right' && (
                          <IconButton size="sm" label={`Copy ${r.key} to ${name(right)}`} onClick={() => void copy(r, 'right')} data-env-copy="right">
                            <ArrowRight />
                          </IconButton>
                        )}
                        {r.status !== 'only-left' && (
                          <IconButton size="sm" label={`Copy ${r.key} to ${name(left)}`} onClick={() => void copy(r, 'left')} data-env-copy="left">
                            <ArrowLeft />
                          </IconButton>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {diff && !rows.length && (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-muted">
                    {left === right ? 'Pick two different environments.' : 'No differences: every variable is the same.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted">Values of secrets and sensitive-looking variables (tokens, passwords, keys) are masked. Secrets are compared by their stored values without showing them.</p>
      </div>
    </Modal>
  );
}
