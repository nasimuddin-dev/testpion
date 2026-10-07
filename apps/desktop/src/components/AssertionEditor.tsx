import { Plus, Trash2 } from 'lucide-react';
import type { CheckConfig } from '../types';
import { Button, cx, IconButton } from './ui';

interface CheckDef {
  type: string;
  label: string;
  group: string;
  fields: Array<'path' | 'expected' | 'max' | 'min' | 'threshold' | 'header' | 'tool' | 'schema' | 'criteria' | 'judge' | 'method' | 'values' | 'spec' | 'operationId' | 'snapshot'>;
  hint?: string;
}

export const CHECK_DEFS: CheckDef[] = [
  { type: 'status', label: 'Status code', group: 'Response', fields: ['expected'], hint: '200, 2xx, [200,201], success, error' },
  { type: 'latency', label: 'Latency ≤ (ms)', group: 'Response', fields: ['max'] },
  { type: 'header', label: 'Header', group: 'Response', fields: ['header', 'expected'] },
  { type: 'jwt', label: 'JWT valid', group: 'Response', fields: ['path', 'header', 'min'], hint: 'the token at path, in a header (e.g. authorization) or the first one in the body: decodes and is not expired (min: seconds it must still be valid); claims to compare in test files' },
  { type: 'certificate', label: 'Certificate valid for (days)', group: 'Response', fields: ['min'], hint: 'HTTPS: fails when the server certificate expires in fewer days than min (default 14), or has expired' },
  { type: 'security-headers', label: 'Security headers', group: 'Response', fields: ['values'], hint: 'HSTS, nosniff, clickjacking, CORS with credentials, server version; list items to skip: hsts, nosniff, frame, cors, server-version' },
  { type: 'exists', label: 'Exists', group: 'Body', fields: ['path'] },
  { type: 'not-exists', label: 'Does not exist', group: 'Body', fields: ['path'] },
  { type: 'equals', label: 'Equals', group: 'Body', fields: ['path', 'expected'] },
  { type: 'not-equals', label: 'Not equals', group: 'Body', fields: ['path', 'expected'] },
  { type: 'contains', label: 'Contains', group: 'Body', fields: ['path', 'expected'] },
  { type: 'not-contains', label: 'Does not contain', group: 'Body', fields: ['path', 'expected'] },
  { type: 'regex', label: 'Matches regex', group: 'Body', fields: ['path', 'expected'] },
  { type: 'type', label: 'Type is', group: 'Body', fields: ['path', 'expected'], hint: 'string, number, integer, boolean, object, array, null' },
  { type: 'length', label: 'Length', group: 'Body', fields: ['path', 'expected'] },
  { type: 'threshold', label: 'Number within', group: 'Body', fields: ['path', 'min', 'max'] },
  { type: 'json-schema', label: 'JSON Schema', group: 'Body', fields: ['path', 'schema'] },
  { type: 'is-json', label: 'Is valid JSON', group: 'Body', fields: [] },
  { type: 'snapshot', label: 'Matches snapshot', group: 'Body', fields: ['path', 'snapshot'], hint: 'shape: the same fields and types, values may change; values: the same values too' },
  { type: 'openapi', label: 'Matches OpenAPI contract', group: 'Response', fields: ['spec', 'operationId'], hint: 'status, content type and body checked against the operation in the OpenAPI document' },
  { type: 'graphql-no-errors', label: 'No GraphQL errors', group: 'GraphQL', fields: [] },
  { type: 'graphql-errors', label: 'GraphQL error contains', group: 'GraphQL', fields: ['expected'] },
  { type: 'exact-match', label: 'Exact match', group: 'AI', fields: ['path', 'expected'] },
  { type: 'tokens', label: 'Tokens ≤', group: 'AI', fields: ['max'] },
  { type: 'first-token', label: 'Time to first token ≤ (ms)', group: 'AI', fields: ['max'] },
  { type: 'cost', label: 'Cost ≤ (USD)', group: 'AI', fields: ['max'] },
  { type: 'similarity', label: 'Similarity ≥', group: 'AI', fields: ['expected', 'threshold', 'method'], hint: 'method: lexical | f1 | embedding' },
  { type: 'llm-judge', label: 'LLM-as-judge', group: 'AI', fields: ['criteria', 'judge', 'threshold'] },
  { type: 'refusal', label: 'Refuses', group: 'Safety', fields: [] },
  { type: 'not-refusal', label: 'Does not refuse', group: 'Safety', fields: [] },
  { type: 'no-leak', label: 'No sensitive data leak', group: 'Safety', fields: ['values'] },
  { type: 'tool-called', label: 'Tool called', group: 'Agent', fields: ['tool'] },
  { type: 'tool-not-called', label: 'Tool not called', group: 'Agent', fields: ['tool'] },
  { type: 'max-tool-calls', label: 'Max tool calls', group: 'Agent', fields: ['max'] },
  { type: 'tool-args-valid', label: 'Tool args match schema', group: 'Agent', fields: [] },
  { type: 'context-precision', label: 'Context precision', group: 'RAG', fields: ['threshold', 'judge'], hint: 'the useful documents ranked first; with a judge, each document gets a verdict' },
  { type: 'context-recall', label: 'Context recall', group: 'RAG', fields: ['expected', 'threshold', 'judge'], hint: "the reference answer's statements found in the retrieved context" },
  { type: 'context-entity-recall', label: 'Context entity recall', group: 'RAG', fields: ['expected', 'threshold'], hint: "the reference's names, numbers and dates found in the retrieved context (no model)" },
  { type: 'groundedness', label: 'Groundedness (faithfulness)', group: 'RAG', fields: ['threshold', 'judge'], hint: "the answer's claims supported by the retrieved context; with a judge, claim by claim" },
  { type: 'answer-correctness', label: 'Answer correctness', group: 'RAG', fields: ['expected', 'threshold', 'judge'], hint: "the answer's facts against the reference answer (F1); with a judge, claim by claim" },
  { type: 'answer-relevance', label: 'Answer relevance', group: 'RAG', fields: ['threshold', 'judge'] },
  { type: 'citation', label: 'Citations valid', group: 'RAG', fields: [] },
];

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
        const def = CHECK_DEFS.find((d) => d.type === c.type) ?? { type: c.type, label: c.type, group: '', fields: ['path', 'expected'] as CheckDef['fields'] };
        return (
          <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-panel px-2 py-1.5">
            <select className="field h-7 min-h-7 py-0" value={c.type} onChange={(e) => set(i, { type: e.target.value })} aria-label="Check type">
              {Object.entries(byGroup).map(([g, ds]) => (
                <optgroup key={g} label={g}>
                  {ds.map((d) => (
                    <option key={d.type} value={d.type}>
                      {d.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
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
              <select className="field h-7 min-h-7 py-0" value={String(c.method ?? 'lexical')} onChange={(e) => set(i, { method: e.target.value })}>
                <option value="lexical">lexical</option>
                <option value="f1">token F1</option>
                <option value="embedding">embedding</option>
              </select>
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
              <input className="field h-7 min-h-7 flex-1 min-w-48" placeholder="Criteria, e.g. The answer is polite and correct" value={String(c.criteria ?? '')} onChange={(e) => set(i, { criteria: e.target.value })} />
            )}
            {def.fields.includes('judge') && (
              <input
                className="field h-7 min-h-7 mono w-48"
                placeholder="judge provider/model"
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
                <select className="field h-7 min-h-7 py-0" value={c.mode === 'values' ? 'values' : 'shape'} onChange={(e) => set(i, { mode: e.target.value })} title={def.hint} aria-label="Snapshot comparison">
                  <option value="shape">same shape</option>
                  <option value="values">same values</option>
                </select>
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
              <Trash2 size={13} />
            </IconButton>
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
