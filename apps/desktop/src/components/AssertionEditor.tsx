import { Plus, Trash2 } from 'lucide-react';
import type { CheckConfig } from '../types';
import { Button, cx, IconButton, Select } from './ui';
import { CHECK_DEFS, CHECK_GROUP_LABEL, type CheckDef } from '../lib/check-defs';

function parseExpected(s: string): unknown {
  const t = s.trim();
  if (t === '') return '';
  try {
    return JSON.parse(t);
  } catch {
    return s;
  }
}

function showExpected(v: unknown): string {
  if (v === undefined) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

export function AssertionEditor({ checks, onChange, groups }: { checks: CheckConfig[]; onChange(c: CheckConfig[]): void; groups?: string[] }) {
  const defs = CHECK_DEFS.filter((d) => !groups || groups.includes(d.group));
  const set = (i: number, patch: Partial<CheckConfig>) => onChange(checks.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const byGroup = defs.reduce<Record<string, CheckDef[]>>((a, d) => ((a[d.group] ??= []).push(d), a), {});
  return (
    <div className="p-3 flex flex-col gap-2 text-sm">
      {checks.map((c, i) => {
        const def: CheckDef = CHECK_DEFS.find((d) => d.type === c.type) ?? { type: c.type, label: c.type, group: '', fields: ['path', 'expected'], what: '' };
        return (
          <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-panel px-2 py-1.5">
            <Select className="h-7 min-h-7 py-0" value={c.type} onChange={(e) => set(i, { type: e.target.value })} aria-label="Check type">
              {Object.entries(byGroup).map(([g, ds]) => (
                <optgroup key={g} label={CHECK_GROUP_LABEL[g] ?? g}>
                  {ds.map((d) => (
                    <option key={d.type} value={d.type}>
                      {d.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
            {def.fields.includes('path') && <input className="field h-7 min-h-7 mono w-44" placeholder="$.path (optional)" value={c.path ?? ''} onChange={(e) => set(i, { path: e.target.value || undefined })} />}
            {def.fields.includes('header') && <input className="field h-7 min-h-7 mono w-40" placeholder="header name" value={String(c.header ?? '')} onChange={(e) => set(i, { header: e.target.value })} />}
            {def.fields.includes('tool') && <input className="field h-7 min-h-7 mono w-40" placeholder="tool name" value={String(c.tool ?? '')} onChange={(e) => set(i, { tool: e.target.value })} />}
            {def.fields.includes('expected') && (
              <input className="field h-7 min-h-7 mono flex-1 min-w-32" placeholder={def.hint ?? 'expected (JSON or text)'} value={showExpected(c.expected)} onChange={(e) => set(i, { expected: parseExpected(e.target.value) })} />
            )}
            {def.fields.includes('min') && <input className="field h-7 min-h-7 w-20" type="number" placeholder="min" value={String(c.min ?? '')} onChange={(e) => set(i, { min: e.target.value === '' ? undefined : Number(e.target.value) })} />}
            {def.fields.includes('max') && <input className="field h-7 min-h-7 w-24" type="number" placeholder="max" value={String(c.max ?? '')} onChange={(e) => set(i, { max: e.target.value === '' ? undefined : Number(e.target.value) })} />}
            {def.fields.includes('threshold') && (
              <input className="field h-7 min-h-7 w-24" type="number" step="0.05" placeholder="threshold" value={String(c.threshold ?? '')} onChange={(e) => set(i, { threshold: e.target.value === '' ? undefined : Number(e.target.value) })} />
            )}
            {def.fields.includes('method') && (
              <Select className="h-7 min-h-7 py-0" value={String(c.method ?? 'lexical')} onChange={(e) => set(i, { method: e.target.value })}>
                <option value="lexical">wording</option>
                <option value="f1">shared words</option>
                <option value="embedding">meaning</option>
              </Select>
            )}
            {def.fields.includes('values') && (
              <input
                className="field h-7 min-h-7 mono flex-1 min-w-32"
                placeholder="canary values, comma separated (built-in detectors always on)"
                value={((c.values as string[]) ?? []).join(', ')}
                onChange={(e) => set(i, { values: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
              />
            )}
            {def.fields.includes('criteria') && (
              <input className="field h-7 min-h-7 flex-1 min-w-48" placeholder="Grading rule, e.g. The answer is polite and correct" value={String(c.criteria ?? '')} onChange={(e) => set(i, { criteria: e.target.value })} />
            )}
            {def.fields.includes('judge') && (
              <input
                className="field h-7 min-h-7 mono w-48"
                placeholder="AI reviewer provider/model"
                value={c.judge ? `${(c.judge as { provider: string }).provider}/${(c.judge as { name?: string }).name ?? ''}` : ''}
                onChange={(e) => {
                  const [provider, ...rest] = e.target.value.split('/');
                  set(i, { judge: { provider, name: rest.join('/') || undefined, temperature: 0 } });
                }}
              />
            )}
            {def.fields.includes('spec') && (
              <input
                className="field h-7 min-h-7 mono flex-1 min-w-48"
                placeholder="OpenAPI file in the workspace, e.g. openapi.yaml"
                title={def.hint}
                value={typeof c.spec === 'string' ? c.spec : ''}
                onChange={(e) => set(i, { spec: e.target.value })}
              />
            )}
            {def.fields.includes('operationId') && (
              <input
                className="field h-7 min-h-7 mono w-44"
                placeholder="operationId (optional)"
                title="By default the operation is found from the request's method and URL"
                value={String(c.operationId ?? '')}
                onChange={(e) => set(i, { operationId: e.target.value || undefined })}
              />
            )}
            {def.fields.includes('snapshot') && (
              <>
                <Select className="h-7 min-h-7 py-0" value={c.mode === 'values' ? 'values' : 'shape'} onChange={(e) => set(i, { mode: e.target.value })} title={def.hint} aria-label="Snapshot comparison">
                  <option value="shape">same shape</option>
                  <option value="values">same values</option>
                </Select>
                <input
                  className="field h-7 min-h-7 mono flex-1 min-w-40"
                  placeholder="ignore, e.g. $.id, $..updatedAt, $.items[*].price"
                  title="Paths not compared: [*] any index, * any key, $.. any depth"
                  value={((c.ignore as string[]) ?? []).join(', ')}
                  onChange={(e) => set(i, { ignore: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
                />
                <span className="text-xs text-muted" title={c.expected === undefined ? '' : JSON.stringify(c.expected, null, 2).slice(0, 2000)}>
                  {c.expected === undefined ? 'no snapshot yet' : `snapshot ${(JSON.stringify(c.expected).length / 1024).toFixed(1)} KB`}
                </span>
              </>
            )}
            {def.fields.includes('schema') && (
              <input
                className="field h-7 min-h-7 mono flex-1 min-w-48"
                placeholder='{"type":"object","required":["id"]} (blank = infer from expected)'
                value={c.schema ? JSON.stringify(c.schema) : ''}
                onChange={(e) => {
                  try {
                    set(i, { schema: e.target.value ? JSON.parse(e.target.value) : undefined });
                  } catch {
                    /* keep typing */
                  }
                }}
              />
            )}
            <IconButton label="Remove check" className={cx('ml-auto')} onClick={() => onChange(checks.filter((_, j) => j !== i))}>
              <Trash2 />
            </IconButton>
            {def.what && (
              <div className="basis-full text-xs text-muted leading-snug" data-check-what={c.type}>
                {def.what}
              </div>
            )}
          </div>
        );
      })}
      <div>
        <Button size="sm" icon={<Plus size={12} />} onClick={() => onChange([...checks, { type: defs[0]?.type ?? 'status', ...(defs[0]?.type === 'status' ? { expected: 200 } : {}) }])}>
          Add check
        </Button>
      </div>
    </div>
  );
}
