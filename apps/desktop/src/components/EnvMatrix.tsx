import { Lock, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { asError, call } from '../api';
import { plural } from '../lib/format';
import { Empty, Modal, Spinner, Toggle, cx } from './ui';
import { EnvOutputBar } from './EnvOutputBar';
import { tableOutputSpec } from './output/table-specs';

/** From `env.matrix` (environmentMatrix in core): statuses only, never values. */
interface Matrix {
  environments: string[];
  rows: Array<{ key: string; cells: Array<{ state: 'set' | 'empty' | 'missing' | 'disabled'; secret?: boolean }>; incompleteIn: string[]; differs: boolean }>;
  incomplete: number;
}

const CELL = {
  set: { text: 'set', className: 'text-ok' },
  empty: { text: 'empty', className: 'text-warn bg-warn/10' },
  missing: { text: 'missing', className: 'text-bad bg-bad/10' },
  disabled: { text: 'off', className: 'text-muted bg-hover/60' },
} as const;

/** Every variable across every environment: what is missing, empty or turned off where (values are never shown). */
export function EnvMatrix({ onClose }: { onClose(): void }) {
  const [m, setM] = useState<Matrix>();
  const [error, setError] = useState<string>();
  const [onlyIncomplete, setOnlyIncomplete] = useState(true);
  const load = () => {
    setError(undefined);
    setM(undefined);
    void call<Matrix>('env.matrix').then(
      (r) => {
        setM(r);
        if (!r.incomplete) setOnlyIncomplete(false);
      },
      (e) => setError(asError(e).message),
    );
  };
  useEffect(load, []);
  const rows = m ? (onlyIncomplete ? m.rows.filter((r) => r.incompleteIn.length) : m.rows) : [];
  // the rows as shown (statuses, never values)
  const spec = useMemo(
    () =>
      tableOutputSpec({
        id: 'env.matrix',
        what: 'environment matrix',
        name: 'environment-matrix',
        title: 'Variables across environments',
        columns: ['variable', ...(m?.environments ?? []), 'differs'],
        rows: rows.map((r) => [r.key, ...r.cells.map((c) => `${c.state}${c.secret ? ' (secret)' : ''}`), r.differs ? 'yes' : '']),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rows follow m and the filter
    [m, onlyIncomplete],
  );
  return (
    <Modal title="Variables across environments" onClose={onClose} width={Math.min(1100, 360 + (m?.environments.length ?? 2) * 120)}>
      {error ? (
        <Empty title="Couldn't build the matrix" actions={[{ label: 'Retry', icon: <RotateCcw size={13} />, onClick: load }]}>
          {error}
        </Empty>
      ) : !m ? (
        <div className="h-40 grid place-items-center">
          <Spinner />
        </div>
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex items-center gap-3 flex-wrap">
            <span className={m.incomplete ? 'text-warn' : 'text-ok'}>
              {m.incomplete ? `${plural(m.incomplete, 'variable')} missing, empty or off somewhere` : 'Every variable is set in every environment'} · {plural(m.rows.length, 'variable')}
            </span>
            {m.incomplete > 0 && <Toggle checked={onlyIncomplete} onChange={setOnlyIncomplete} label="Only incomplete" />}
            <EnvOutputBar spec={spec} />
          </div>
          <div className="overflow-auto max-h-[60vh] rounded-lg border border-line">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-panel">
                <tr className="text-left text-muted">
                  <th className="font-normal px-3 py-1.5">Variable</th>
                  {m.environments.map((e) => (
                    <th key={e} className="font-normal px-2 py-1.5 text-center truncate max-w-32" title={e}>
                      {e}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className="border-t border-line/60">
                    <td className="px-3 py-1 mono">
                      {r.key}
                      {r.differs && (
                        <span className="ml-2 text-[0.65rem] text-muted font-sans" title="The plain values differ between environments (expected for hosts and ids)">
                          differs
                        </span>
                      )}
                    </td>
                    {r.cells.map((c, i) => (
                      <td key={i} className="px-2 py-1 text-center">
                        <span
                          className={cx('inline-flex items-center gap-1 px-1.5 rounded', CELL[c.state].className)}
                          title={`${r.key} in ${m.environments[i]}: ${c.state}${c.secret ? ' (secret)' : ''}`}
                        >
                          {c.secret && <Lock size={10} aria-label="secret" />}
                          {CELL[c.state].text}
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && <div className="p-3 text-muted">Nothing to show.</div>}
          </div>
          <p className="text-xs text-muted">
            Values are never shown here; secrets count as set when the secret store has a value. Agents get the same with the <code>environment_matrix</code> MCP tool; <code>testpion env matrix</code>{' '}
            prints it.
          </p>
        </div>
      )}
    </Modal>
  );
}
