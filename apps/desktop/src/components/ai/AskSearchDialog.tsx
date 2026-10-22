import { Plus, Search, Sparkles, Square, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SearchAnswer, SearchCondition, SearchFieldDef, SearchQuery, SearchRow } from '@testpion/core';
import { asError, call } from '../../api';
import { aiSetupAction } from '../../lib/ai-errors';
import { formatMs, formatCost, timeAgo } from '../../lib/format';
import { openRef } from '../../lib/open-ref';
import type { AskSearchRequest } from '../../store';
import { Badge, Button, Callout, IconButton, Input, Modal, Select, Spinner, useDebounced } from '../ui';
import { AiEstimateLine, estimateOf, type EstimateState } from './AiEstimateLine';

/** What `search.fields` tells the editor: the fields, the sources and the operator labels. */
interface Catalog {
  fields: SearchFieldDef[];
  sources: Array<{ id: string; label: string }>;
  ops: Record<string, string>;
}

/** A condition while it is edited: the value as the text of its input (a list is comma-separated). */
interface Row {
  field: string;
  op: string;
  text: string;
}

const textOf = (c: SearchCondition): string => (Array.isArray(c.value) ? c.value.join(', ') : String(c.value));
const rowsOf = (q: SearchQuery): Row[] => q.where.map((c) => ({ field: c.field, op: c.op, text: textOf(c) }));

/** The condition an edited row means, or undefined while its value is not (yet) valid for the field. */
function conditionOf(r: Row, def: SearchFieldDef | undefined): SearchCondition | undefined {
  if (!def) return undefined;
  const t = r.text.trim();
  if (def.type === 'bool') return { field: def.id, op: r.op as never, value: t !== 'false' };
  if (!t) return undefined;
  const one = (s: string) => (def.type === 'number' ? Number(s) : s);
  if (r.op === 'in') {
    const list = t
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(one);
    return list.length && list.every((v) => (typeof v === 'number' ? Number.isFinite(v) : true)) ? { field: def.id, op: 'in', value: list as Array<string | number> } : undefined;
  }
  const v = one(t);
  return typeof v === 'number' && !Number.isFinite(v) ? undefined : { field: def.id, op: r.op as never, value: v };
}

const SORTS: Array<[string, string, SearchQuery['sort']]> = [
  ['new', 'Newest first', { by: 'time', dir: 'desc' }],
  ['old', 'Oldest first', { by: 'time', dir: 'asc' }],
  ['slow', 'Slowest first', { by: 'duration', dir: 'desc' }],
  ['fast', 'Fastest first', { by: 'duration', dir: 'asc' }],
];
const sortId = (s: SearchQuery['sort']) => SORTS.find(([, , x]) => x.by === s.by && x.dir === s.dir)![0];

/** The editable query: the chips of what was understood. Changing one and pressing Search runs it again, with no model. */
function QueryChips({
  catalog,
  sources,
  rows,
  scope,
  onSources,
  onRows,
  onSearch,
  sort,
  limit,
  onSort,
  onLimit,
  problem,
}: {
  catalog: Catalog;
  sources: string[];
  rows: Row[];
  scope?: readonly string[];
  onSources(s: string[]): void;
  onRows(r: Row[]): void;
  onSearch(): void;
  sort: SearchQuery['sort'];
  limit: number;
  onSort(s: SearchQuery['sort']): void;
  onLimit(n: number): void;
  problem?: string;
}) {
  const def = (id: string) => catalog.fields.find((f) => f.id === id);
  // a field is offered when at least one chosen source has it
  const offered = catalog.fields.filter((f) => f.sources.some((s) => sources.includes(s)));
  const set = (i: number, patch: Partial<Row>) => onRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="grid gap-2" data-ask-chips aria-label="What was understood, editable">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted mr-1">Look in</span>
        {catalog.sources
          .filter((s) => !scope?.length || scope.includes(s.id))
          .map((s) => {
            const on = sources.includes(s.id);
            return (
              <Button
                key={s.id}
                size="sm"
                variant={on ? 'soft' : 'ghost'}
                icon={null}
                aria-pressed={on}
                data-ask-source={s.id}
                onClick={() => onSources(on ? sources.filter((x) => x !== s.id) : [...sources, s.id])}
              >
                {s.label}
              </Button>
            );
          })}
      </div>
      {rows.map((r, i) => {
        const d = def(r.field);
        return (
          <div key={i} className="flex flex-wrap items-center gap-1.5 rounded-lg border border-line bg-panel/50 p-1.5" data-ask-chip={`${r.field}:${r.op}`}>
            <Select
              aria-label="Field"
              value={r.field}
              className="w-36"
              onChange={(e) => {
                const nd = def(e.target.value)!;
                set(i, { field: nd.id, op: nd.ops.includes(r.op as never) ? r.op : nd.ops[0]!, text: nd.type === 'bool' ? 'true' : r.text });
              }}
            >
              {(d && !offered.includes(d) ? [...offered, d] : offered).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </Select>
            <Select aria-label="Operator" value={r.op} className="w-36" onChange={(e) => set(i, { op: e.target.value })}>
              {(d?.ops ?? []).map((o) => (
                <option key={o} value={o}>
                  {catalog.ops[o] ?? o}
                </option>
              ))}
            </Select>
            {d?.type === 'bool' ? (
              <Select aria-label="Value" value={r.text === 'false' ? 'false' : 'true'} className="w-24" onChange={(e) => set(i, { text: e.target.value })}>
                <option value="true">yes</option>
                <option value="false">no</option>
              </Select>
            ) : (
              <Input
                aria-label="Value"
                className="flex-1 min-w-[8rem]"
                value={r.text}
                placeholder={
                  d?.type === 'time' ? (r.op === 'within' ? '7d, 24h, 90m' : '2026-10-12') : d?.type === 'number' ? (d.unit ? `number (${d.unit})` : 'number') : r.op === 'in' ? 'a, b, c' : 'text'
                }
                inputMode={d?.type === 'number' ? 'numeric' : undefined}
                onChange={(e) => set(i, { text: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && onSearch()}
              />
            )}
            {d?.unit && <span className="text-xs text-muted">{d.unit}</span>}
            <IconButton label="Remove this filter" onClick={() => onRows(rows.filter((_, j) => j !== i))}>
              <X size={14} />
            </IconButton>
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" icon={<Plus size={12} />} data-ask-add onClick={() => onRows([...rows, { field: 'text', op: 'contains', text: '' }])}>
          Add filter
        </Button>
        <Select aria-label="Order" value={sortId(sort)} className="w-36" onChange={(e) => onSort(SORTS.find(([id]) => id === e.target.value)![2])}>
          {SORTS.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </Select>
        <Select aria-label="At most" value={limit} className="w-32" onChange={(e) => onLimit(Number(e.target.value))}>
          {[10, 25, 50, 100, 200].map((n) => (
            <option key={n} value={n}>
              at most {n}
            </option>
          ))}
        </Select>
        <Button size="sm" variant="primary" icon={<Search size={12} />} disabled={!sources.length} reason="Tick what to search in" data-ask-run onClick={onSearch} className="ml-auto">
          Search
        </Button>
      </div>
      {problem && (
        <p className="text-xs text-bad" role="alert" data-ask-problem>
          {problem}
        </p>
      )}
    </div>
  );
}

const SOURCE_TONE: Record<string, 'default' | 'accent' | 'warn' | 'judge'> = { history: 'accent', runs: 'default', results: 'warn', traces: 'judge' };

function Hit({ row, labels, onOpen }: { row: SearchRow; labels: Record<string, string>; onOpen(): void }) {
  return (
    <button type="button" className="w-full text-left px-3 py-2 flex items-center gap-3 hover:bg-hover rounded-md" data-ask-hit={row.id} onClick={onOpen}>
      <Badge tone={SOURCE_TONE[row.source] ?? 'default'}>{labels[row.source] ?? row.source}</Badge>
      <span className="min-w-0 flex-1">
        <span className={`block text-sm truncate ${row.failed ? 'text-bad' : ''}`}>{row.title}</span>
        {row.subtitle && <span className="block text-xs text-muted truncate">{row.subtitle}</span>}
      </span>
      <span className="text-xs text-muted shrink-0 text-right">
        <span className="block">{timeAgo(row.at)}</span>
        {row.durationMs !== undefined && <span className="block tabular-nums">{formatMs(row.durationMs)}</span>}
      </span>
    </button>
  );
}

/**
 * "Ask…" (AI-12): a question in your own words over History, runs, test results and traces. The model only translates it
 * into a query (it sees the question and the field names, never the data); TestPion runs the query, shows it in words and
 * as chips you can edit, then lists the hits. Without a model, or when it fails, the words are searched as typed — the
 * box always answers. One dialog for the search box, the palette and the History / Runs / Traces filter bars (`scope`).
 */
export function AskSearchDialog({ request, onClose }: { request: AskSearchRequest; onClose(): void }) {
  const [question, setQuestion] = useState(request.question ?? '');
  const [catalog, setCatalog] = useState<Catalog>();
  const [answer, setAnswer] = useState<SearchAnswer>();
  const [sources, setSources] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [sort, setSort] = useState<SearchQuery['sort']>(SORTS[0]![2]);
  const [limit, setLimit] = useState(25);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const live = useRef<string>(undefined);
  // what asking would cost, shown before the first send and under the box every time (a dry run: nothing leaves the computer)
  const [estimate, setEstimate] = useState<EstimateState>();
  const asked = useDebounced(question.trim(), 400);
  useEffect(() => {
    if (!asked) return setEstimate(undefined);
    let on = true;
    call<SearchAnswer>('search.ask', { question: asked, scope: request.scope, dryRun: true }).then(
      (a) => on && setEstimate(a.preview ? estimateOf(a.preview) : undefined),
      (e) => on && setEstimate({ ok: false, text: `${asError(e).message} Asking will search for the words as typed.` }),
    );
    return () => {
      on = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked]);
  useEffect(() => {
    void call<Catalog>('search.fields').then(setCatalog, (e) => setError(asError(e).message));
  }, []);

  const adopt = (a: SearchAnswer) => {
    setAnswer(a);
    setSources(a.query.sources);
    setRows(rowsOf(a.query));
    setSort(a.query.sort);
    setLimit(a.query.limit);
    setProblem(undefined);
  };
  const ask = async (noAi = false) => {
    const q = question.trim();
    if (!q || busy) return;
    const id = `ask-${Date.now().toString(36)}`;
    live.current = id;
    setBusy(id);
    setError(undefined);
    try {
      const a = await call<SearchAnswer>('search.ask', { question: q, scope: request.scope, noAi: noAi || undefined, requestId: id });
      if (live.current === id) adopt(a);
    } catch (e) {
      const err = asError(e);
      if (live.current === id && !(err.kind === 'CancelledError' || /abort|cancel/i.test(err.message))) setError(err.message);
    } finally {
      if (live.current === id) setBusy(undefined);
    }
  };
  const stop = () => {
    if (busy) void call('ai.cancel', { id: busy }).catch(() => undefined);
    live.current = undefined;
    setBusy(undefined);
  };
  // the edited chips run again with no model: the same engine, the same checks
  const search = async () => {
    const where: SearchCondition[] = [];
    for (const r of rows) {
      const c = conditionOf(
        r,
        catalog?.fields.find((f) => f.id === r.field),
      );
      if (!c) return setProblem(`Give "${catalog?.fields.find((f) => f.id === r.field)?.label ?? r.field}" a valid value, or remove the filter.`);
      where.push(c);
    }
    setBusy('run');
    setProblem(undefined);
    try {
      const a = await call<SearchAnswer>('search.query', { query: { sources, where, sort, limit }, scope: request.scope });
      adopt({ ...a, question: answer?.question ?? question, mode: 'query', assumptions: [] });
    } catch (e) {
      setProblem(asError(e).message.replace(/^Invalid search query: /, ''));
    } finally {
      setBusy(undefined);
    }
  };
  // opened with a question (from the search box or the palette) it waits for Ask, with the estimate in view: asking spends tokens

  const labels = useMemo(() => Object.fromEntries((catalog?.sources ?? []).map((s) => [s.id, s.label])), [catalog]);
  const setup = answer?.fallback ? aiSetupAction(new Error(answer.fallback)) : undefined;
  const o = answer?.outcome;
  const open = (r: SearchRow) => {
    onClose();
    void openRef(r.ref);
  };
  return (
    <Modal
      title={
        <span className="flex items-center gap-2">
          <Sparkles size={16} /> Ask about history, runs and traces
        </span>
      }
      onClose={() => (stop(), onClose())}
      width={760}
      footer={<Button onClick={() => (stop(), onClose())}>Close</Button>}
    >
      <div className="grid gap-3 text-sm" data-ask-dialog>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void ask();
          }}
        >
          <Input
            autoFocus
            className="flex-1"
            aria-label="Your question"
            data-ask-input
            placeholder="failed payment calls last week over 2 s"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
          {busy && busy !== 'run' ? (
            <Button type="button" icon={<Square size={12} />} onClick={stop}>
              Stop
            </Button>
          ) : (
            <Button type="submit" variant="primary" icon={<Sparkles size={13} />} disabled={!question.trim() || !!busy} reason="Ask a question first" data-ask-submit>
              Ask
            </Button>
          )}
        </form>
        <AiEstimateLine estimate={question.trim() ? estimate : undefined} waiting={!!question.trim() && asked === question.trim()} className="text-xs text-muted min-h-4 -mt-1" data-ask-estimate="" />
        <p className="text-xs text-muted -mt-1">
          The model turns your question into a search; it sees the question and the field names, never your data. TestPion runs the search itself.
          {request.scope?.length ? ` Asking within ${request.scope.map((s) => labels[s] ?? s).join(' and ')}.` : ''}
        </p>
        {busy && (
          <div className="flex items-center gap-2 text-muted" role="status">
            <Spinner /> {busy === 'run' ? 'Searching…' : 'Understanding your question…'}
          </div>
        )}
        {error && (
          <Callout tone="bad" role="alert">
            {error}
          </Callout>
        )}
        {answer && (
          <>
            {answer.fallback && (
              <Callout
                tone="warn"
                data-ask-fallback
                action={
                  setup && (
                    <Button size="sm" onClick={() => (setup.onClick(), onClose())}>
                      {setup.label}
                    </Button>
                  )
                }
              >
                {answer.fallback}
              </Callout>
            )}
            <section aria-label="How the question was understood" className="grid gap-1.5">
              <div className="flex items-center gap-2">
                <span className="font-medium">{answer.mode === 'ai' ? 'Understood as' : answer.mode === 'text' ? 'Searching for the words' : 'Searching'}</span>
                {answer.mode === 'ai' && answer.model && (
                  <Badge tone="accent" title="The model that translated the question; it never saw your data">
                    {answer.model}
                  </Badge>
                )}
                {answer.mode === 'text' && <Badge>plain text</Badge>}
                {answer.mode === 'query' && <Badge>edited</Badge>}
                {answer.costUsd !== undefined && <span className="text-xs text-muted">{formatCost(answer.costUsd)}</span>}
              </div>
              <p data-ask-explain>{answer.explain}</p>
              {answer.assumptions.length > 0 && (
                <ul className="text-xs text-muted list-disc pl-5" data-ask-assumptions>
                  {answer.assumptions.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              )}
            </section>
            {catalog && (
              <QueryChips
                catalog={catalog}
                sources={sources}
                rows={rows}
                scope={request.scope}
                onSources={setSources}
                onRows={setRows}
                onSearch={() => void search()}
                sort={sort}
                limit={limit}
                onSort={setSort}
                onLimit={setLimit}
                problem={problem}
              />
            )}
            {o && (
              <section aria-label="Results" className="grid gap-1" data-ask-results>
                <div className="text-xs text-muted">
                  {o.rows.length < o.matched ? `${o.rows.length} of ${o.matched} matches` : `${o.matched} ${o.matched === 1 ? 'match' : 'matches'}`} · {o.ms} ms
                </div>
                {o.notes.map((n) => (
                  <p key={n} className="text-xs text-warn">
                    {n}
                  </p>
                ))}
                <div className="max-h-[38vh] overflow-auto -mx-1" role="list">
                  {o.rows.map((r) => (
                    <Hit key={`${r.source}:${r.id}`} row={r} labels={labels} onOpen={() => open(r)} />
                  ))}
                  {!o.rows.length && <div className="px-3 py-4 text-muted">Nothing matches. Loosen a filter above and search again.</div>}
                </div>
              </section>
            )}
            {answer.mode !== 'text' && (
              <div>
                <Button size="sm" variant="ghost" icon={null} onClick={() => void ask(true)} disabled={!!busy} reason="Still searching" title="Do not use the model: look for the words as typed">
                  Search the words only
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
