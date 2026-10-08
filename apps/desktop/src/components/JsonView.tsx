import { detectLanguage, highlight as syntaxTokens, type CodeLanguage } from '../lib/highlight';
import { Camera, ChevronDown, ChevronRight, ChevronUp, CircleCheck, Copy, Equal, ListChecks, ListOrdered, Search, Shapes, Variable, WrapText } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { JSONPath } from 'jsonpath-plus';
import { cx, IconButton, Input, Menu, VirtualList, type MenuItem } from './ui';
import { copyText } from '../lib/clipboard';
import { plural } from '../lib/format';

const ROW = 20;

interface TreeRow {
  depth: number;
  key?: string;
  path: string;
  /** JavaScript accessor from the document root, e.g. `.items[0]["content-type"]` (for scripts). */
  access?: string;
  value: unknown;
  expandable: boolean;
  count?: number;
  closing?: string;
}

/** A response field to keep in a variable: the test script sets it after every send. */
export interface TreeVariable {
  name: string;
  access: string;
  value: unknown;
}

function summary(v: unknown): string {
  if (Array.isArray(v)) return `[${v.length}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).length}}`;
  return '';
}

/**
 * Virtualised JSON tree: only rows for expanded nodes are materialised and only visible rows are
 * rendered, so multi-megabyte payloads stay responsive.
 */
/** A check a response field can become (the request's Tests tab). */
export interface TreeAssertion {
  type: string;
  path: string;
  expected?: unknown;
  min?: number;
  /** Snapshot checks: compare the shape or the values. */
  mode?: 'shape' | 'values';
}

/** A variable name for a key: `access_token` stays, `user-id` → `userId`, an index → `item0`. */
const variableName = (key: string) => (/^\d+$/.test(key) ? `item${key}` : key.replace(/[^A-Za-z0-9_]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : '')) || 'value');

const typeName = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const short = (v: unknown) => {
  const s = JSON.stringify(v);
  return s.length > 28 ? `${s.slice(0, 27)}…` : s;
};

/** What a field can be checked for: equal to its current value, present, of its type, its length. */
function assertionItems(r: { path: string; value: unknown; expandable: boolean }, onAssert: (a: TreeAssertion) => void): MenuItem[] {
  const items: MenuItem[] = [];
  if (!r.expandable) items.push({ label: `Equals ${short(r.value)}`, icon: <Equal size={14} />, onSelect: () => onAssert({ type: 'equals', path: r.path, expected: r.value }) });
  items.push({ label: 'Exists', icon: <CircleCheck size={14} />, onSelect: () => onAssert({ type: 'exists', path: r.path }) });
  items.push({
    label: `Is ${typeName(r.value) === 'object' ? 'an object' : typeName(r.value) === 'array' ? 'an array' : `a ${typeName(r.value)}`}`,
    icon: <Shapes size={14} />,
    onSelect: () => onAssert({ type: 'type', path: r.path, expected: typeName(r.value) }),
  });
  if (Array.isArray(r.value)) {
    items.push({
      label: `Has ${plural(r.value.length, 'item')}`,
      icon: <ListOrdered size={14} />,
      onSelect: () => onAssert({ type: 'length', path: r.path, expected: (r.value as unknown[]).length }),
    });
    items.push({ label: 'Is not empty', icon: <ListChecks size={14} />, onSelect: () => onAssert({ type: 'length', path: r.path, min: 1 }) });
  }
  if (r.expandable) items.push({ label: 'Keeps this shape (snapshot)', icon: <Camera size={14} />, onSelect: () => onAssert({ type: 'snapshot', path: r.path, expected: r.value, mode: 'shape' }) });
  return items;
}

/** The tree's own path of a child: `[i]` in an array, `.key` in an object (what expanding and walking both use). */
const childPath = (parent: string, value: unknown, key: string) => (Array.isArray(value) ? `${parent}[${key}]` : `${parent}.${key}`);

export function JsonTree({ data: full, query, onAssert: assertOnFull, onSaveVariable }: { data: unknown; query?: string; onAssert?(a: TreeAssertion): void; onSaveVariable?(v: TreeVariable): void }) {
  // "Filter with JSONPath": show only what the expression selects
  const [filter, setFilter] = useState('');
  const filtered = useMemo(() => {
    const f = filter.trim();
    if (!f) return undefined;
    try {
      const r = JSONPath({ path: f, json: full as object, wrap: true }) as unknown[];
      return { data: r, error: undefined };
    } catch (e) {
      return { data: undefined, error: (e as Error).message };
    }
  }, [filter, full]);
  const data = useMemo(() => filtered?.data ?? (filtered ? [] : full), [filtered, full]);
  // paths inside a filtered result aren't the response's paths, so checks are only offered unfiltered
  const onAssert = filtered ? undefined : assertOnFull;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['$']));
  useEffect(() => {
    // new data opens its first level; a filter's matches open one level more, so a matched object shows its fields
    const s = new Set(['$']);
    if (data && typeof data === 'object')
      for (const [k, v] of Object.entries(data as object).slice(0, 50)) {
        const p = childPath('$', data, k);
        s.add(p);
        if (filtered && v && typeof v === 'object') for (const k2 of Object.keys(v).slice(0, 50)) s.add(childPath(p, v, k2));
      }
    setExpanded(s);
  }, [data, filtered]);

  const rows = useMemo(() => {
    const out: TreeRow[] = [];
    const walk = (v: unknown, key: string | undefined, path: string, depth: number, access = '') => {
      const expandable = !!v && typeof v === 'object';
      out.push({ depth, key, path, access, value: v, expandable, count: expandable ? Object.keys(v as object).length : undefined });
      if (expandable && expanded.has(path)) {
        const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v as object);
        const limit = 5000;
        entries
          .slice(0, limit)
          .forEach(([k, x]) =>
            walk(x, k, childPath(path, v, k), depth + 1, `${access}${Array.isArray(v) ? `[${k}]` : /^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`}`),
          );
        if (entries.length > limit) out.push({ depth: depth + 1, path: `${path}#more`, value: `… ${entries.length - limit} more items (use Raw view / Save response)`, expandable: false });
        out.push({ depth, path: `${path}#close`, value: undefined, expandable: false, closing: Array.isArray(v) ? ']' : '}' });
      }
    };
    walk(data, undefined, '$', 0);
    return out;
  }, [data, expanded]);

  const q = query?.toLowerCase();
  const toggle = (p: string) => {
    const s = new Set(expanded);
    if (s.has(p)) s.delete(p);
    else s.add(p);
    setExpanded(s);
  };
  const expandAll = () => {
    const s = new Set<string>();
    let n = 0;
    const walk = (v: unknown, p: string) => {
      if (!v || typeof v !== 'object' || n > 20000) return;
      s.add(p);
      n++;
      for (const [k, x] of Object.entries(v)) walk(x, childPath(p, v, k));
    };
    walk(data, '$');
    setExpanded(s);
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="@container flex items-center gap-2 px-2 py-1 text-xs text-muted shrink-0 whitespace-nowrap">
        <button className="hover:text-fg" onClick={expandAll}>
          Expand all
        </button>
        <button className="hover:text-fg" onClick={() => setExpanded(new Set(['$']))}>
          Collapse all
        </button>
        <input
          className="field h-6 text-xs mono flex-1 min-w-24 max-w-72 ml-2"
          placeholder="Filter with JSONPath, e.g. $.items[*].name"
          aria-label="Filter with JSONPath"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          spellCheck={false}
        />
        {filtered && (
          <span className={filtered.error ? 'text-bad' : ''}>{filtered.error ? 'Not a valid JSONPath' : `${(filtered.data ?? []).length} match${(filtered.data ?? []).length === 1 ? '' : 'es'}`}</span>
        )}
        <span className="ml-auto hidden @2xl:inline truncate">
          {filtered
            ? 'Showing the matches as a list'
            : onAssert
              ? onSaveVariable
                ? 'Click a key to copy its JSONPath, save it to a variable or check it'
                : 'Click a key to copy its JSONPath or turn it into an assertion'
              : 'Click a key to copy its JSONPath'}
        </span>
      </div>
      <VirtualList
        className="flex-1 mono text-[0.9em]"
        items={rows}
        rowHeight={ROW}
        render={(r) => {
          if (r.closing)
            return (
              <div style={{ paddingLeft: r.depth * 14 + 18 }} className="text-muted leading-5">
                {r.closing}
              </div>
            );
          const isHit = q && ((r.key ?? '').toLowerCase().includes(q) || (!r.expandable && String(r.value).toLowerCase().includes(q)));
          return (
            <div className={cx('flex items-center leading-5 whitespace-nowrap hover:bg-hover', isHit && 'search-hit')} style={{ paddingLeft: r.depth * 14 + 4 }}>
              <span className="w-3.5 inline-flex">
                {r.expandable && (
                  <button aria-label={expanded.has(r.path) ? 'Collapse' : 'Expand'} onClick={() => toggle(r.path)} className="text-muted">
                    {expanded.has(r.path) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  </button>
                )}
              </span>
              {r.key !== undefined &&
                (onAssert ? (
                  <Menu
                    align="start"
                    width={230}
                    trigger={
                      <button title={`${r.path}: copy the path or add an assertion`} className="syn-key hover:underline">
                        {/^\d+$/.test(r.key) ? r.key : `"${r.key}"`}
                      </button>
                    }
                    items={[
                      { label: 'Copy JSONPath', icon: <Copy size={14} />, onSelect: () => void copyText(r.path, 'the JSONPath') },
                      ...(onSaveVariable
                        ? [{ label: 'Save to variable…', icon: <Variable size={14} />, onSelect: () => onSaveVariable({ name: variableName(r.key!), access: r.access ?? '', value: r.value }) }]
                        : []),
                      ...assertionItems(r, onAssert).map((it, i) => (i === 0 ? { ...it, separator: true } : it)),
                    ]}
                  />
                ) : (
                  <button title={`Copy ${r.path}`} onClick={() => void copyText(r.path, 'the JSONPath')} className="syn-key hover:underline">
                    {/^\d+$/.test(r.key) ? r.key : `"${r.key}"`}
                  </button>
                ))}
              {r.key !== undefined && <span className="text-muted mr-1">:</span>}
              {r.expandable ? (
                <span className="text-muted cursor-pointer" onClick={() => toggle(r.path)}>
                  {Array.isArray(r.value) ? '[' : '{'}
                  {!expanded.has(r.path) && (
                    <span>
                      {' '}
                      {summary(r.value)} {Array.isArray(r.value) ? ']' : '}'}
                    </span>
                  )}
                </span>
              ) : (
                <Scalar v={r.value} />
              )}
            </div>
          );
        }}
      />
    </div>
  );
}

function Scalar({ v }: { v: unknown }) {
  if (v === null) return <span className="syn-keyword">null</span>;
  if (typeof v === 'string') {
    const s = v.length > 500 ? v.slice(0, 500) + '…' : v;
    return (
      <span className="syn-string" title={v.length > 500 ? `${v.length} chars` : undefined}>
        "{s}"
      </span>
    );
  }
  if (typeof v === 'number') return <span className="syn-number">{v}</span>;
  if (typeof v === 'boolean') return <span className="syn-keyword">{String(v)}</span>;
  return <span>{String(v)}</span>;
}

/**
 * Virtualised raw text viewer with search. Very long lines are split into fixed-width
 * segments so a single 50 MB line never becomes one DOM node.
 */
export function RawView({ text, language }: { text: string; language?: string }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [wrapAt, setWrapAt] = useState(true);
  // rows have a fixed height (virtualised), so long lines are wrapped at the width of the view
  const box = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(160);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const probe = document.createElement('span');
      probe.textContent = 'x'.repeat(50);
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
      el.appendChild(probe);
      const charW = probe.getBoundingClientRect().width / 50 || 7.5;
      probe.remove();
      // the line-number gutter and the scrollbar take about 4rem
      setCols(Math.max(40, Math.floor((el.clientWidth - 64) / charW)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const lines = useMemo(() => {
    const raw = text.split('\n');
    if (!wrapAt) return raw;
    const out: string[] = [];
    for (const l of raw) {
      if (l.length <= cols) out.push(l);
      else for (let i = 0; i < l.length; i += cols) out.push(l.slice(i, i + cols));
    }
    return out;
  }, [text, wrapAt, cols]);
  const matches = useMemo(() => {
    if (!query) return [] as number[];
    const q = query.toLowerCase();
    const m: number[] = [];
    for (let i = 0; i < lines.length && m.length < 10000; i++) if (lines[i]!.toLowerCase().includes(q)) m.push(i);
    return m;
  }, [lines, query]);
  useEffect(() => setActive(0), [query]);
  const activeLine = matches[active];
  // syntax colours line by line (only the visible rows are drawn); a search shows its matches instead
  const syntax = useMemo<CodeLanguage>(() => {
    const l = (language ?? '').toLowerCase();
    return /json/.test(l) ? 'json' : /xml|html/.test(l) ? 'xml' : /ya?ml/.test(l) ? 'yaml' : detectLanguage(text.slice(0, 4000));
  }, [language, text]);
  const highlight = (l: string, isActive: boolean) => {
    if (!query) return l ? syntaxTokens(l, syntax === 'http' ? 'plain' : syntax).map((t, i) => (t.kind ? <span key={i} className={`syn-${t.kind}`}>{t.text}</span> : t.text)) : ' ';
    const parts: React.ReactNode[] = [];
    const lower = l.toLowerCase();
    const q = query.toLowerCase();
    let i = 0;
    let k = 0;
    for (;;) {
      const j = lower.indexOf(q, i);
      if (j < 0) break;
      parts.push(l.slice(i, j));
      parts.push(
        <mark key={k++} className={isActive ? 'search-hit-active' : 'search-hit'}>
          {l.slice(j, j + q.length)}
        </mark>,
      );
      i = j + q.length;
    }
    parts.push(l.slice(i));
    return parts;
  };
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-1 px-2 py-1 shrink-0 border-b border-line">
        <Search size={13} className="text-muted" />
        <Input
          className="h-6 min-h-6 text-xs w-56"
          placeholder="Search response"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && matches.length) setActive((a) => (e.shiftKey ? (a - 1 + matches.length) % matches.length : (a + 1) % matches.length));
          }}
        />
        {query && <span className="text-xs text-muted tabular-nums">{matches.length ? `${active + 1}/${matches.length}${matches.length >= 10000 ? '+' : ''}` : 'no matches'}</span>}
        <IconButton label="Previous match" onClick={() => matches.length && setActive((a) => (a - 1 + matches.length) % matches.length)}>
          <ChevronUp size={14} />
        </IconButton>
        <IconButton label="Next match" onClick={() => matches.length && setActive((a) => (a + 1) % matches.length)}>
          <ChevronDown size={14} />
        </IconButton>
        <div className="ml-auto flex items-center gap-1">
          <IconButton label="Wrap long lines" active={wrapAt} onClick={() => setWrapAt(!wrapAt)}>
            <WrapText size={14} />
          </IconButton>
          <IconButton label="Copy" onClick={() => void copyText(text)}>
            <Copy size={14} />
          </IconButton>
        </div>
      </div>
      <div ref={box} className="flex-1 min-h-0 flex flex-col mono text-[0.9em] relative">
        <VirtualList
          className="flex-1"
          items={lines}
          rowHeight={ROW}
          scrollToIndex={activeLine}
          render={(l, i) => (
            <div className="flex leading-5 whitespace-pre">
              <span className="w-12 shrink-0 text-right pr-3 text-muted select-none opacity-60">{i + 1}</span>
              <span>{highlight(l, i === activeLine)}</span>
            </div>
          )}
        />
      </div>
    </div>
  );
}
