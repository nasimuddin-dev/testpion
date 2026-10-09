import { cx } from './ui';

/** A value as one line of text: strings as they are, the rest as JSON. */
export const valueText = (v: unknown) => (typeof v === 'string' ? v : v === undefined ? '' : (JSON.stringify(v) ?? String(v)));

/**
 * Variables and their values, one row each, the changed ones highlighted: a run result's variables after its step
 * (the Variables tab of a result) and the flow debugger's variables timeline.
 */
export function VariablesTable({ vars, changed, empty = 'No variables.' }: { vars: Record<string, unknown>; changed?: Set<string>; empty?: string }) {
  const keys = Object.keys(vars);
  if (!keys.length) return <p className="p-3 text-xs text-muted">{empty}</p>;
  return (
    <table className="w-full text-xs" data-variables-table>
      <tbody>
        {keys.map((k) => {
          const on = changed?.has(k);
          return (
            <tr key={k} className={cx('border-b border-line/50 align-top', on && 'bg-accent-soft')} data-var-row={k} data-changed={on || undefined}>
              <td className={cx('mono px-2 py-1 w-1/3 break-all', on ? 'text-accent font-semibold' : 'text-muted')}>{k}</td>
              <td className="mono px-2 py-1 break-all whitespace-pre-wrap" data-var-value>
                {valueText(vars[k])}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
