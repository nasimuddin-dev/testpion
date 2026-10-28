import { ChevronDown, ChevronRight, FlaskConical, Plus, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { normalizeMetricName } from '@testpion/shared';
import { useRpc } from '../../lib/use-rpc';
import { plural } from '../../lib/format';
import { useApp } from '../../store';
import type { CheckConfig } from '../../types';
import { AssertionEditor } from '../AssertionEditor';
import { Badge, Button, Callout, cx, FilterInput, IconButton, Input, SectionTitle, Segmented, Select, Spinner, Toggle } from '../ui';
import { MetricEditor, metricFilesChanged } from './CustomMetrics';
import { metricResolver, type MetricCatalogue, type MetricRow } from './metric-resolver';

type Row = MetricRow;
type Catalogue = MetricCatalogue;

const KIND_BADGE: Record<string, { label: string; tone: 'ok' | 'judge' | 'accent' | 'default'; title: string }> = {
  deterministic: { label: 'no model', tone: 'ok', title: 'Computed from numbers and text: free, instant, the same every time' },
  judged: { label: 'AI reviewer', tone: 'judge', title: 'Asks an AI reviewer model, which receives the question, answer and documents of each sample' },
  embedding: { label: 'embeddings', tone: 'accent', title: 'Uses an embedding model' },
  sql: { label: 'SQL', tone: 'default', title: 'Runs SQL' },
};

const INPUT_NAME: Record<string, string> = {
  question: 'a question',
  answer: 'the answer',
  contexts: 'retrieved contexts',
  reference: 'a "reference" column',
  referenceIds: 'a "reference_ids" column',
  referenceContexts: 'a "reference_contexts" column',
  canaries: 'a "canaries" column',
  toolCalls: 'the tool calls',
  referenceToolCalls: 'a "reference_tool_calls" column',
  answerable: 'an "answerable" column',
  source: 'a "source" column',
  rubric: 'a "rubric" column',
  goodAnswers: 'a "good_answers" column',
  latency: 'the latency',
  scores: 'retrieval scores',
  relevance: 'a "relevance" column',
  images: 'pictures (an image chunk, or an "images" column)',
  turns: 'a conversation (a "turns" column)',
  referenceTopics: 'a "reference_topics" column',
  expectedOutcome: 'an "expected_outcome" column',
  shouldRefuse: 'a "should_refuse" column',
  otherAnswer: 'a "baseline_answer" column',
};

/** The decision-tree control of a metric: always, only when, or only unless another metric of the sample has a result like this ("faithfulness < 0.8"). */
function RouteControl({ check, onChange }: { check: CheckConfig; onChange(p: Record<string, unknown>): void }) {
  const mode = check.when !== undefined ? 'when' : check.unless !== undefined ? 'unless' : 'always';
  const text = String(check.when ?? check.unless ?? '');
  return (
    <label className="flex items-center gap-1" title="A decision tree: run this metric only when (or only unless) another metric of the same sample gave a result like “faithfulness < 0.8”. A metric that is not run costs nothing and is n/a in the matrix." data-rag-route>
      <Select className="h-6 min-h-6 py-0 text-xs" value={mode} aria-label="When to run this metric" onChange={(ev) => onChange(ev.target.value === 'always' ? { when: undefined, unless: undefined } : ev.target.value === 'when' ? { when: text || 'faithfulness < 0.8', unless: undefined } : { unless: text || 'faithfulness < 0.8', when: undefined })}>
        <option value="always">always run</option>
        <option value="when">run only when</option>
        <option value="unless">run only unless</option>
      </Select>
      {mode !== 'always' && <Input className="h-6 min-h-6 w-44 text-xs mono" value={text} placeholder="faithfulness < 0.8" aria-label="Condition on another metric" onChange={(ev) => onChange({ [mode]: ev.target.value })} data-rag-route-condition />}
    </label>
  );
}

/** A second instance of a metric with options: the next k (5 more), or the next mode not used yet, named so its column is its own. */
function variantOf(r: Row, used: CheckConfig[]): Record<string, unknown> {
  const k = r.options?.k;
  if (k) {
    const next = Math.max(...used.map((u) => Number(u.k ?? k.default ?? 10))) + 5;
    return { k: next, name: r.id.replace('@k', `@${next}`) };
  }
  const mode = r.options?.mode;
  if (mode?.values) {
    const taken = new Set(used.map((u) => String(u.mode ?? mode.default)));
    const next = mode.values.find((v) => !taken.has(v)) ?? mode.values[0]!;
    return { mode: next, name: next === mode.default ? undefined : `${r.id} (${next})` };
  }
  return {};
}

/** An option typed as text: valid JSON ([…] or {…}) is kept as the value it describes (a rubric, a tree, a list), anything else as text (a list is “a; b”). */
function textOption(text: string): unknown {
  if (text === '') return undefined;
  const t = text.trim();
  if (/^[[{]/.test(t) && /[\]}]$/.test(t)) {
    try {
      return JSON.parse(t);
    } catch {
      /* still being typed */
    }
  }
  return text;
}

const optionValue = (e: CheckConfig, key: string, dflt: unknown) => (e[key] === undefined ? dflt : e[key]);

/**
 * The metric picker: every RAG metric grouped by type, found by search (an id, an alias or a Ragas name), chosen one by
 * one or by preset, each with what it reads (the inputs the dataset lacks are said), its pass mark and options, a formula
 * with a worked example, and Try. It edits the `evaluators` list of the evaluation: entries that are not metrics of the
 * catalogue are left alone. One shared component for the evaluation, the monitor and the CI dialogs.
 */
export function MetricPicker({
  evaluators,
  onChange,
  columns,
  hasTarget,
  onTry,
  footer,
}: {
  evaluators: CheckConfig[];
  onChange(next: CheckConfig[]): void;
  /** The dataset's columns (what a metric lacks is said). */
  columns: string[];
  hasTarget: boolean;
  onTry?(check: CheckConfig): void;
  footer?: ReactNode;
}) {
  const cat = useRpc<Catalogue>('rag.metrics', { columns, hasTarget }, { keep: true, reloadOn: ['data.changed'], reloadIf: metricFilesChanged });
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'free' | 'judged' | 'selected'>('all');
  const [open, setOpen] = useState<string>();
  const [editing, setEditing] = useState<{ id?: string }>();
  const resolve = useMemo(() => metricResolver(cat?.metrics ?? []), [cat]);
  const byRow = useMemo(() => {
    const m = new Map<string, number[]>();
    evaluators.forEach((e, i) => {
      const r = resolve(e.type);
      if (r) m.set(r.id, [...(m.get(r.id) ?? []), i]);
    });
    return m;
  }, [evaluators, resolve]);
  if (!cat)
    return (
      <div className="p-6 grid place-items-center">
        <Spinner />
      </div>
    );

  const q = normalizeMetricName(query);
  const visible = (r: Row) => {
    if (filter === 'free' && r.kind !== 'deterministic') return false;
    if (filter === 'judged' && r.kind === 'deterministic') return false;
    if (filter === 'selected' && !byRow.has(r.id)) return false;
    if (!q) return true;
    return [r.id, r.name, r.what, ...r.aliases, ...(r.ragas?.names ?? [])].some((s) => normalizeMetricName(s).includes(q));
  };
  const patch = (i: number, p: Record<string, unknown>) => onChange(evaluators.map((e, k) => (k === i ? { ...e, ...p } : e)));
  const remove = (idx: number[]) => onChange(evaluators.filter((_, k) => !idx.includes(k)));
  const add = (r: Row, extra: Record<string, unknown> = {}) => onChange([...evaluators, { type: r.id, ...extra }]);
  const total = [...byRow.values()].reduce((a, b) => a + b.length, 0);
  // a preset or Clear replaces the metrics picked, with the pass marks and options edited on them: the message has Undo
  const replaceWith = (next: CheckConfig[], message: string) => {
    const before = evaluators;
    onChange(next);
    if (total > 0) useApp.getState().toast(message, 'info', undefined, { undo: () => onChange(before), restored: 'Your metrics are back, with their options' });
  };
  const applyPreset = (checks: CheckConfig[], name: string) => replaceWith([...evaluators.filter((e) => !resolve(e.type)), ...checks], `Preset ${name} replaced the ${plural(total, 'metric')} you picked`);

  return (
    <div className="flex flex-col gap-2 p-3" data-rag-picker>
      <div className="flex items-center gap-1.5 flex-wrap" data-rag-presets>
        <span className="text-xs text-muted">Presets</span>
        {cat.presets.map((p) => (
          <Button key={p.id} size="sm" title={p.description} onClick={() => applyPreset(p.checks, p.name)} data-rag-preset={p.id}>
            {p.name}
          </Button>
        ))}
        {total > 0 && (
          <Button size="sm" variant="ghost" onClick={() => replaceWith(evaluators.filter((e) => !resolve(e.type)), `Took ${plural(total, 'metric')} off the list`)} title="Take every metric off the list">
            Clear
          </Button>
        )}
        <Button size="sm" className="ml-auto" icon={<Plus size={12} />} onClick={() => setEditing({})} title="Write your own metric: a criterion, a checklist, rules, a formula, a script" data-rag-new-metric>
          New custom metric
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <FilterInput className="flex-1" value={query} onChange={setQuery} placeholder="Search metrics: faithfulness, LLMContextRecall, nv_context_relevance, recall@k …" label="Search metrics" data-rag-picker-search="" />
        <Segmented
          label="Show"
          size="xs"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'free', label: 'No model', title: 'Metrics that run without any model' },
            { value: 'judged', label: 'AI reviewer', title: 'Metrics that ask an AI reviewer or an embedding model' },
            { value: 'selected', label: `Selected ${total}` },
          ]}
        />
      </div>
      {cat.groups.map((g) => {
        const rows = cat.metrics.filter((r) => r.group === g.id && visible(r));
        if (!rows.length) return null;
        const chosen = rows.filter((r) => byRow.has(r.id)).length;
        return (
          <section key={g.id} data-rag-group={g.id}>
            <SectionTitle size="sm" as="h3" className="py-1">
              {g.label} <span className="font-normal normal-case">· {rows.length}{chosen ? ` · ${chosen} selected` : ''}</span>
            </SectionTitle>
            <div className="rounded-lg border border-line divide-y divide-line/70">
              {rows.map((r) => {
                const idx = byRow.get(r.id) ?? [];
                const on = idx.length > 0;
                const kind = KIND_BADGE[r.kind]!;
                const missing = (r.missing ?? []).map((m) => INPUT_NAME[m] ?? m);
                const isOpen = open === r.id;
                return (
                  <div key={r.id} data-rag-metric={r.id} className={cx(on && 'bg-accent/5')}>
                    <div className="flex items-center gap-2 px-2 py-1.5">
                      <input type="checkbox" checked={on} aria-label={`Use ${r.name}`} onChange={() => (on ? remove(idx) : add(r))} data-rag-metric-check />
                      <button className="text-muted hover:text-text" aria-label={isOpen ? 'Hide details' : 'Show details'} onClick={() => setOpen(isOpen ? undefined : r.id)}>
                        {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-medium text-sm">{r.name}</span>
                          <span className="mono text-xs text-muted">{r.id}</span>
                          <Badge tone={kind.tone} title={kind.title}>
                            {kind.label}
                          </Badge>
                          {r.direction === 'lower' && <Badge title="A lower score is better">lower is better</Badge>}
                          <span className="text-xs text-muted">{r.calls === '0' ? '' : `AI reviewer calls: ${r.calls}`}</span>
                          {r.custom && (
                            <button className="text-xs text-accent hover:underline" onClick={() => setEditing({ id: r.id.replace(/^custom\//, '') })} data-rag-edit-metric={r.id}>
                              Edit
                            </button>
                          )}
                        </div>
                        {r.what && (
                          <div className="text-xs text-muted leading-snug" data-rag-metric-what>
                            {r.what}
                          </div>
                        )}
                        {missing.length > 0 && (
                          <div className="text-xs text-warn" data-rag-missing>
                            needs {missing.join(', ')}: the dataset does not have {missing.length > 1 ? 'them' : 'it'}
                          </div>
                        )}
                      </div>
                      {onTry && (
                        <Button size="sm" icon={<FlaskConical size={12} />} onClick={() => onTry(on ? evaluators[idx[0]!]! : { type: r.id })} title="Run this metric on one sample, and see what an AI reviewer would receive" data-rag-try>
                          Try
                        </Button>
                      )}
                    </div>
                    {on &&
                      idx.map((i) => {
                        const e = evaluators[i]!;
                        return (
                          <div key={i} className="flex items-center gap-2 flex-wrap pl-12 pr-2 pb-1.5 text-xs" data-rag-instance>
                            <label className="flex items-center gap-1">
                              pass at {r.direction === 'lower' ? '≤' : '≥'}
                              <Input type="number" step="0.05" className="h-6 min-h-6 w-16 text-xs" value={typeof e.threshold === 'number' ? e.threshold : ''} placeholder={r.threshold !== undefined ? String(r.threshold) : 'mark'} onChange={(ev) => patch(i, { threshold: ev.target.value === '' ? undefined : Number(ev.target.value) })} aria-label={`${r.name} pass mark`} />
                            </label>
                            {Object.entries(r.options ?? {}).map(([key, o]) =>
                              o.values ? (
                                <label key={key} className="flex items-center gap-1" title={o.description}>
                                  {key}
                                  <Select className="h-6 min-h-6 py-0 text-xs" value={String(optionValue(e, key, o.default))} onChange={(ev) => patch(i, { [key]: ev.target.value, ...(key === 'mode' ? { name: ev.target.value === o.default ? undefined : `${r.id} (${ev.target.value})` } : {}) })} aria-label={`${r.name} ${key}`}>
                                    {o.values.map((v) => (
                                      <option key={v} value={v}>
                                        {v}
                                      </option>
                                    ))}
                                  </Select>
                                </label>
                              ) : o.type === 'number' ? (
                                <label key={key} className="flex items-center gap-1" title={o.description}>
                                  {key}
                                  <Input type="number" className="h-6 min-h-6 w-14 text-xs" value={String(optionValue(e, key, o.default))} onChange={(ev) => patch(i, { [key]: Number(ev.target.value), name: r.id.replace('@k', `@${ev.target.value}`) })} aria-label={`${r.name} ${key}`} />
                                </label>
                              ) : o.type === 'boolean' ? (
                                <Toggle key={key} checked={optionValue(e, key, o.default) === true} onChange={(v) => patch(i, { [key]: v })} title={o.description} label={key} />
                              ) : (
                                <label key={key} className="flex items-center gap-1" title={o.description} data-rag-option={key}>
                                  {key}
                                  {o.required && <span className="text-bad" aria-hidden="true">*</span>}
                                  <Input className={cx('h-6 min-h-6 w-48 text-xs', o.required && !String(e[key] ?? '').trim() && 'border-warn')} value={e[key] === undefined ? '' : typeof e[key] === 'string' ? (e[key] as string) : JSON.stringify(e[key])} placeholder={o.description.length > 60 ? `${o.description.slice(0, 58)}…` : o.description} onChange={(ev) => patch(i, { [key]: textOption(ev.target.value) })} aria-label={`${r.name} ${key}${o.required ? ' (required)' : ''}`} />
                                </label>
                              ),
                            )}
                            <RouteControl check={e} onChange={(p) => patch(i, p)} />
                            {r.options && (
                              <IconButton label={`Add another ${r.name}`} onClick={() => add(r, variantOf(r, evaluators.filter((_, k) => idx.includes(k))))}>
                                <Plus />
                              </IconButton>
                            )}
                            {idx.length > 1 && (
                              <IconButton label="Remove this one" onClick={() => remove([i])}>
                                <X />
                              </IconButton>
                            )}
                          </div>
                        );
                      })}
                    {isOpen && (
                      <div className="px-12 pb-2 text-xs grid gap-1" data-rag-metric-details>
                        <div>{r.what}</div>
                        <div>
                          <b>How. </b>
                          {r.how}
                        </div>
                        <div>
                          <b>Example. </b>
                          {r.example}
                        </div>
                        <div className="text-muted">
                          Reads: {r.requires.map((m) => INPUT_NAME[m] ?? m).join(', ') || 'nothing from the dataset'}
                          {r.optional?.length ? ` (also: ${r.optional.map((m) => INPUT_NAME[m] ?? m).join(', ')})` : ''}
                        </div>
                        {(r.aliases.length > 0 || r.ragas) && <div className="text-muted">Also called: {[...r.aliases, ...(r.ragas?.names ?? [])].join(', ')}</div>}
                        {r.ragas?.differs && <div className="text-muted">Ragas: {r.ragas.differs}</div>}
                        {r.sources.length > 0 && <div className="text-muted">Sources: {r.sources.join(' · ')}</div>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
      {!cat.groups.some((g) => cat.metrics.some((r) => r.group === g.id && visible(r))) && <Callout tone="accent">No metric matches “{query}”. Try an id, a Ragas name or part of what it measures.</Callout>}
      {evaluators.some((e) => !resolve(e.type)) && (
        <details className="text-xs" data-rag-other-checks>
          <summary className="cursor-pointer text-muted select-none">Other checks of this evaluation ({evaluators.filter((e) => !resolve(e.type)).length}): not RAG metrics</summary>
          <AssertionEditor
            checks={evaluators.filter((e) => !resolve(e.type))}
            onChange={(others) => onChange([...evaluators.filter((e) => resolve(e.type)), ...others])}
            groups={['Body', 'AI', 'RAG', 'Safety', 'Response']}
          />
        </details>
      )}
      {editing && <MetricEditor id={editing.id} onClose={() => setEditing(undefined)} />}
      {footer && (
        <div className="sticky bottom-0 -mx-3 px-3 py-2 border-t border-line bg-bg text-xs" data-rag-picker-footer>
          {footer}
        </div>
      )}
    </div>
  );
}
