import { Check, Plus, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { SELECT_FIELDS, SELECT_OPS, compileWhere, parseWhere, whereText, type SelectClause } from '@testpion/shared';
import { plural } from '../../lib/format';
import { Button, Field, IconButton, Input, Modal, Select } from '../ui';
import type { Exchange } from './model';

const NUMERIC_ONLY = new Set(['>', '>=', '<', '<=']);
const hint = (field: string) => (field === 'size' ? '200kb, 1.5mb' : field === 'time' ? '500ms, 2s' : field === 'status' ? '404, 4xx, error' : field === 'method' ? 'POST' : field === 'host' ? 'api.example.com' : '');

/**
 * Edit ▸ Select matching: pick the rows that satisfy conditions on the grid's columns (Fiddler's Select by), then use them
 * (Delete, Save to collection, Create flow, Resend). The same grammar as `testpion debug exchanges --where` and the command bar.
 */
export function SelectDialog({ rows, initial, onSelect, onClose }: { rows: Exchange[]; initial?: string; onSelect(ids: string[]): void; onClose(): void }) {
  const [clauses, setClauses] = useState<SelectClause[]>(() => {
    const p = initial ? parseWhere(initial) : undefined;
    return p?.ok ? p.clauses : [{ field: 'status', op: '>=', value: '400' }];
  });
  const set = (i: number, patch: Partial<SelectClause>) => setClauses((c) => c.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const text = whereText(clauses);
  const parsed = useMemo(() => (clauses.every((c) => c.value.trim()) ? parseWhere(text) : undefined), [clauses, text]);
  const matches = useMemo(() => {
    if (!parsed?.ok) return undefined;
    const test = compileWhere(parsed.clauses);
    const ids: string[] = [];
    for (const r of rows) if (test(r)) ids.push(r.id);
    return ids;
  }, [parsed, rows]);
  const problem = !clauses.every((c) => c.value.trim()) ? 'Fill in every value' : parsed && !parsed.ok ? parsed.error : !matches?.length ? 'No row matches yet' : undefined;
  const go = () => {
    if (!matches?.length) return;
    onSelect(matches);
    onClose();
  };
  return (
    <Modal
      title="Select matching rows"
      onClose={onClose}
      width={640}
      onSubmit={go}
      footer={
        <>
          <Button icon={<X size={13} />} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={<Check size={13} />} disabled={!matches?.length} reason={problem} onClick={go}>
            {matches?.length ? `Select ${plural(matches.length, 'row')}` : 'Select'}
          </Button>
        </>
      }
    >
      <div className="grid gap-3" data-select-dialog>
        <p className="text-xs text-muted">Every condition must hold. The selected rows can then be deleted, saved to a collection, made into a flow or sent again.</p>
        {clauses.map((c, i) => (
          <div key={i} className="grid grid-cols-[150px_150px_1fr_auto] gap-2 items-end" data-select-clause={i}>
            <Field label={i === 0 ? 'Column' : 'and column'}>
              <Select value={c.field} aria-label="Column" onChange={(e) => set(i, { field: e.target.value as SelectClause['field'] })}>
                {SELECT_FIELDS.map((f) => (
                  <option key={f.field} value={f.field}>
                    {f.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Is">
              <Select value={c.op} aria-label="Comparison" onChange={(e) => set(i, { op: e.target.value as SelectClause['op'] })}>
                {SELECT_OPS.filter((o) => !NUMERIC_ONLY.has(o.op) || SELECT_FIELDS.find((f) => f.field === c.field)?.numeric).map((o) => (
                  <option key={o.op} value={o.op}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Value" hint={hint(c.field)}>
              <Input className="mono" value={c.value} aria-label="Value" onChange={(e) => set(i, { value: e.target.value })} />
            </Field>
            <IconButton label="Remove this condition" disabled={clauses.length === 1} reason="A selection needs at least one condition" onClick={() => setClauses((cs) => cs.filter((_, j) => j !== i))}>
              <X />
            </IconButton>
          </div>
        ))}
        <div>
          <Button size="sm" icon={<Plus size={12} />} disabled={clauses.length >= 12} reason="At most 12 conditions" onClick={() => setClauses((c) => [...c, { field: 'host', op: '~', value: '' }])}>
            Add a condition
          </Button>
        </div>
        <div className="text-xs text-muted" data-select-summary>
          <span className="mono text-fg">{text}</span>
          <div>{parsed && !parsed.ok ? <span className="text-bad">{parsed.error}</span> : matches ? `${plural(matches.length, 'row')} of ${rows.length} match` : ''}</div>
        </div>
      </div>
    </Modal>
  );
}
