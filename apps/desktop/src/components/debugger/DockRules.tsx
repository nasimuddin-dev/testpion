import { Check, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { call } from '../../api';
import { toastError, useApp } from '../../store';
import { Button, cx, Empty, Field, Input, Menu, Segmented, Select, type MenuItem } from '../ui';
import type { Rule, RuleColumn, RuleCondition, RuleKind, RuleOperator, RulesState } from '../DebuggerRules';

const toast = (m: string) => useApp.getState().toast(m, 'success');

/** The hits keep counting while traffic flows: the rule panels read them again every two seconds. */
export function useLiveRules(onChange: (s: RulesState) => void) {
  useEffect(() => {
    const t = setInterval(() => void call<RulesState>('debug.rules').then(onChange, () => undefined), 2000);
    return () => clearInterval(t);
  }, [onChange]);
}

/**
 * One list of rules of some kinds, the same in every rule panel: a filter, a box that turns a rule on or off, its
 * name (what it does on hover), how many requests it acted on; double-click or the pencil edits, the bin removes.
 */
export function RuleList({
  state,
  kinds,
  onChange,
  onEdit,
  add,
  empty,
}: {
  state?: RulesState;
  kinds: RuleKind[];
  onChange(s: RulesState): void;
  onEdit(r: Rule): void;
  /** The + button: one action, or a menu of them. */
  add: { label: string; onClick?(): void; items?: MenuItem[] };
  empty: string;
}) {
  const [find, setFind] = useState('');
  const f = find.trim().toLowerCase();
  const rules = (state?.rules ?? []).filter((r) => kinds.includes(r.kind) && (!f || r.name.toLowerCase().includes(f) || (r.summary ?? '').toLowerCase().includes(f)));
  const hits = state?.hits ?? {};
  const act = (p: Promise<RulesState>) => void p.then(onChange, toastError);
  const addButton = (
    <Button size="sm" icon={<Plus size={12} />} onClick={add.onClick} title={add.label}>
      Add
    </Button>
  );
  return (
    <div className="flex-1 min-h-0 flex flex-col" data-rule-list={kinds.join(',')}>
      <div className="flex items-center gap-1 p-2 border-b border-line">
        <Input className="flex-1 h-7 text-xs" placeholder="Filter rules" aria-label="Filter rules" value={find} onChange={(e) => setFind(e.target.value)} />
        <Button size="sm" variant="ghost" icon={<RotateCcw size={12} />} title="Count the hits from zero" aria-label="Reset hits" onClick={() => act(call<RulesState>('debug.resetRuleHits'))} />
        {add.items ? <Menu width={220} items={add.items} trigger={addButton} /> : addButton}
      </div>
      <div className="flex items-center h-7 text-[11px] text-muted bg-panel border-b border-line px-2 shrink-0">
        <span className="w-6" />
        <span className="flex-1">Name</span>
        <span className="w-14 text-right">Hits</span>
        <span className="w-12" />
      </div>
      {!rules.length ? (
        <Empty title={f ? 'No rule matches' : 'No rules yet'}>{f ? 'Change the filter.' : empty}</Empty>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto">
          {rules.map((r) => (
            <div
              key={r.id}
              role="row"
              data-rule={r.id}
              className={cx('group flex items-center h-7 px-2 text-xs border-b border-line/40 hover:bg-hover', !r.enabled && 'text-muted')}
              onDoubleClick={() => onEdit(r)}
              title={r.summary}
            >
              <input
                type="checkbox"
                className="w-6"
                checked={r.enabled}
                aria-label={`${r.enabled ? 'Turn off' : 'Turn on'} ${r.name}`}
                onChange={(e) => act(call<RulesState>('debug.setRuleEnabled', { id: r.id, enabled: e.target.checked }))}
              />
              <span className="flex-1 truncate">{r.name}</span>
              <span className="w-14 text-right tabular-nums">{hits[r.id] ?? 0}</span>
              <span className="w-12 flex justify-end gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                <button type="button" className="p-0.5 text-muted hover:text-fg" aria-label={`Edit ${r.name}`} onClick={() => onEdit(r)}>
                  <Pencil size={12} />
                </button>
                <button type="button" className="p-0.5 text-muted hover:text-bad" aria-label={`Remove ${r.name}`} onClick={() => act(call<RulesState>('debug.deleteRule', { id: r.id }))}>
                  <Trash2 size={12} />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Filter: rules that leave requests out (Filter Out), or let only some in (Capture Only). Every one is the user's. */
export function FilterPanel({ state, onChange, onNewRule, onEdit }: { state?: RulesState; onChange(s: RulesState): void; onNewRule(r: Partial<Rule>): void; onEdit(r: Rule): void }) {
  const [side, setSide] = useState<'ignore' | 'only'>('ignore');
  useLiveRules(onChange);
  const onCount = (state?.rules ?? []).filter((r) => r.kind === 'only' && r.enabled).length;
  return (
    <>
      <div className="p-2 border-b border-line">
        <Segmented
          label="Filter kind"
          value={side}
          onChange={setSide}
          options={[
            { value: 'ignore', label: 'Filter Out' },
            { value: 'only', label: 'Capture Only' },
          ]}
        />
        <p className="text-[11px] text-muted mt-1.5">
          {side === 'ignore'
            ? 'Requests a Filter Out rule matches are passed through but not listed.'
            : onCount
              ? `${onCount} Capture Only rule${onCount > 1 ? 's are' : ' is'} on: only what one of them matches is listed.`
              : 'When a Capture Only rule is on, only the requests one of them matches are listed.'}
        </p>
      </div>
      <RuleList
        state={state}
        kinds={[side]}
        onChange={onChange}
        onEdit={onEdit}
        add={{ label: side === 'ignore' ? 'New Filter Out rule' : 'New Capture Only rule', onClick: () => onNewRule({ kind: side, enabled: true, match: {} }) }}
        empty={
          side === 'ignore'
            ? 'Right-click a request ▸ Filter out to add one from its program, URL, domain or method.'
            : 'Right-click a request ▸ Capture only to add one from its program, URL, domain or method.'
        }
      />
    </>
  );
}

export function HighlightPanel({ state, onChange, onEdit }: { state?: RulesState; onChange(s: RulesState): void; onEdit(r?: Rule): void }) {
  useLiveRules(onChange);
  return (
    <RuleList
      state={state}
      kinds={['highlight']}
      onChange={onChange}
      onEdit={onEdit}
      add={{ label: 'New highlight rule', onClick: () => onEdit(undefined) }}
      empty="Highlight requests by status, URL, time, size or program."
    />
  );
}

export function AutoReplyPanel({ state, onChange, onNewRule, onEdit }: { state?: RulesState; onChange(s: RulesState): void; onNewRule(r: Partial<Rule>): void; onEdit(r: Rule): void }) {
  useLiveRules(onChange);
  return (
    <RuleList
      state={state}
      kinds={['reply']}
      onChange={onChange}
      onEdit={onEdit}
      add={{ label: 'New auto-reply rule', onClick: () => onNewRule({ kind: 'reply', enabled: true, match: {}, reply: { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' } }) }}
      empty="Answer requests without the server: right-click a request ▸ Auto-reply ▸ Reply with this response."
    />
  );
}

export function ModifyPanel({ state, onChange, onNewRule, onEdit }: { state?: RulesState; onChange(s: RulesState): void; onNewRule(r: Partial<Rule>): void; onEdit(r: Rule): void }) {
  useLiveRules(onChange);
  return (
    <RuleList
      state={state}
      kinds={['modify', 'redirect']}
      onChange={onChange}
      onEdit={onEdit}
      add={{
        label: 'New rule',
        items: [
          { label: 'Modify headers', onSelect: () => onNewRule({ kind: 'modify', enabled: true, match: {}, requestHeaders: [{ op: 'set', name: 'X-Debug', value: 'testpion' }] }) },
          { label: 'Redirect connections', onSelect: () => onNewRule({ kind: 'redirect', enabled: true, match: {}, redirect: { host: 'localhost:3000', scheme: 'http' } }) },
        ],
      }}
      empty="Change request and response headers or bodies, add a delay, or send a host's requests to another host."
    />
  );
}

const COLUMNS: Array<[RuleColumn, string]> = [
  ['status', 'Status'],
  ['url', 'URL'],
  ['method', 'Method'],
  ['host', 'Domain'],
  ['application', 'Application'],
  ['user', 'User'],
  ['type', 'Type'],
  ['version', 'Version'],
  ['ip', 'IP Address'],
  ['duration', 'Duration (ms)'],
  ['size', 'Size (bytes)'],
];
const OPERATORS: Array<[RuleOperator, string]> = [
  ['equals', 'Equals'],
  ['not-equals', 'Does not equal'],
  ['contains', 'Contains'],
  ['starts-with', 'Starts with'],
  ['ends-with', 'Ends with'],
  ['between', 'Is between'],
  ['greater-than', 'Is greater than'],
  ['less-than', 'Is less than'],
  ['matches', 'Matches (regex)'],
];

/** The Highlight Rule editor: a name, one condition on a column, and how the matching rows look in each theme. */
export function HighlightRuleEditor({ rule, onSaved, onCancel }: { rule?: Rule; onSaved(s: RulesState): void; onCancel(): void }) {
  const [name, setName] = useState(rule?.name ?? '400x Client Errors');
  const [cond, setCond] = useState<RuleCondition>(rule?.match.where ?? { column: 'status', op: 'between', value: '400', value2: '499' });
  const [style, setStyle] = useState(rule?.style ?? { dark: '#22c55e', light: '#b91c1c', bold: true, row: false });
  const set = (p: Partial<RuleCondition>) => setCond({ ...cond, ...p });
  const save = () =>
    void call<RulesState>('debug.saveRule', {
      rule: {
        ...(rule ?? {}),
        kind: 'highlight',
        name: name.trim() || 'Highlight',
        enabled: rule?.enabled ?? true,
        match: { ...(rule?.match ?? {}), where: cond },
        color: rule?.color ?? 'blue',
        style,
      },
    })
      // a new highlight goes first: the first rule that matches colours the row, and this is the one just made
      .then((s) => (rule ? s : call<RulesState>('debug.moveRule', { id: (s as RulesState & { rule?: Rule }).rule?.id ?? '', to: 0 })))
      .then((s) => (onSaved(s), toast(`Saved ${name}`)), toastError);
  return (
    <div className="flex-1 min-h-0 overflow-auto p-3 grid gap-3 content-start text-sm" data-highlight-editor>
      <div className="flex items-end gap-2">
        <Field label="Rule name" className="flex-1">
          <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Rule name" />
        </Field>
        <Button variant="primary" icon={<Check size={13} />} onClick={save}>
          Save
        </Button>
      </div>
      <Field label="Column">
        <Select aria-label="Column" value={cond.column} onChange={(e) => set({ column: e.target.value as RuleColumn })}>
          {COLUMNS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Expression">
        <Select aria-label="Expression" value={cond.op} onChange={(e) => set({ op: e.target.value as RuleOperator })}>
          {OPERATORS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Value">
        <div className="flex items-center gap-2">
          <Input className="flex-1" aria-label="Value" value={cond.value} onChange={(e) => set({ value: e.target.value })} />
          {cond.op === 'between' && (
            <>
              <span className="text-muted">–</span>
              <Input className="flex-1" aria-label="Upper value" value={cond.value2 ?? ''} onChange={(e) => set({ value2: e.target.value })} />
            </>
          )}
        </div>
      </Field>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={!!cond.regex} onChange={(e) => set({ regex: e.target.checked })} /> Use regex
      </label>
      <div className="border-t border-line pt-3 grid gap-2">
        <label className="flex items-center gap-2 text-xs">
          <span className="w-28">Dark theme</span>
          <input type="color" aria-label="Dark theme colour" value={style.dark ?? '#22c55e'} onChange={(e) => setStyle({ ...style, dark: e.target.value })} />
        </label>
        <label className="flex items-center gap-2 text-xs">
          <span className="w-28">Light theme</span>
          <input type="color" aria-label="Light theme colour" value={style.light ?? '#b91c1c'} onChange={(e) => setStyle({ ...style, light: e.target.value })} />
        </label>
        <label className="flex items-center gap-2 text-xs">
          <span className="w-28">Make bold</span>
          <input type="checkbox" checked={!!style.bold} onChange={(e) => setStyle({ ...style, bold: e.target.checked })} />
        </label>
        <label className="flex items-center gap-2 text-xs">
          <span className="w-28">Entire row</span>
          <input type="checkbox" checked={!!style.row} onChange={(e) => setStyle({ ...style, row: e.target.checked })} />
        </label>
      </div>
      <p className="text-[11px] text-muted">
        The colour applies to the Status column, or to the whole row&apos;s text with Entire row. Conditions on Status, Type, Duration and Size are checked when the response is in.
      </p>
      {rule && (
        <Button size="sm" variant="ghost" onClick={onCancel}>
          New rule instead
        </Button>
      )}
    </div>
  );
}
