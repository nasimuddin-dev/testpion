import { openQuickLook } from './EnvQuickLook';
import { Copy, KeyRound, Layers, Save, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { call } from '../api';
import { toastError, useApp } from '../store';
import { dynamicVariables } from '../editor-intel';
import { inspectVariables, type VarInfo } from '../lib/vars-cache';
import { collectionOf, useVarPopover, VARS_CHANGED } from '../lib/var-popover';
import { Button, cx, useDebounced } from './ui';
import { copyText } from '../lib/clipboard';


/**
 * Single-line input that highlights {{variables}} (resolved = blue, unresolved = red), shows where
 * each value comes from on hover, autocompletes variable names after typing `{{`, and shows a
 * variable's value (to copy, edit or add to the environment) when it's clicked.
 * Uses an overlay so the native input keeps full editing behaviour.
 */
export function VarInput({
  value,
  onChange,
  placeholder,
  className,
  onEnter,
  collectionId,
  ariaLabel,
  onPasteText,
  cell,
  list,
}: {
  value: string;
  onChange(v: string): void;
  placeholder?: string;
  className?: string;
  onEnter?(): void;
  collectionId?: string;
  ariaLabel?: string;
  /** Return true to consume the pasted text (e.g. to import a cURL command). */
  onPasteText?(text: string): boolean;
  /** Borderless, for table cells (headers, params, form fields). */
  cell?: boolean;
  /** id of a <datalist> with value suggestions. */
  list?: string;
}) {
  const env = useApp((s) => s.environment);
  const [vars, setVars] = useState<Record<string, VarInfo>>({});
  const [all, setAll] = useState<VarInfo[]>([]);
  const [suggest, setSuggest] = useState<{ prefix: string; start: number; index: number } | null>(null);
  const debounced = useDebounced(value, 300);
  const overlay = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // the variable popover (one for the whole app) is open on one of this field's variables
  const pop = useVarPopover((s) => !!s.open && s.open.owner === box.current && !!box.current);
  const setPop = (p: { name: string; x: number; y: number } | null) =>
    p ? useVarPopover.getState().show({ ...p, collectionId: collectionId ?? collectionOf(box.current), owner: box.current ?? undefined }) : pop && useVarPopover.getState().hide();
  const [refresh, setRefresh] = useState(0);
  // a value saved from the popover: look again
  useEffect(() => {
    const again = () => setRefresh((n) => n + 1);
    window.addEventListener(VARS_CHANGED, again);
    return () => window.removeEventListener(VARS_CHANGED, again);
  }, []);

  useEffect(() => {
    if (!/\{\{/.test(debounced)) return setVars({});
    void inspectVariables({ environment: env, collectionId, template: debounced }).then((list) => setVars(Object.fromEntries(list.map((v) => [v.name, v]))));
  }, [debounced, env, collectionId, refresh]);

  /** A click inside a {{variable}} opens its popover. */
  const openAtCaret = () => {
    const el = input.current;
    if (!el || el.selectionStart !== el.selectionEnd) return;
    const caret = el.selectionStart ?? 0;
    for (const m of value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
      const start = m.index ?? 0;
      if (caret > start && caret < start + m[0].length) {
        const token = overlay.current?.querySelector<HTMLElement>(`[data-var="${start}"]`);
        // shown on top of everything (fixed), under the clicked variable, so no pane can clip it
        const r = (token ?? box.current ?? el).getBoundingClientRect();
        setSuggest(null);
        return setPop({ name: m[1]!.trim(), x: r.left, y: (box.current ?? el).getBoundingClientRect().bottom });
      }
    }
    setPop(null);
  };

  const loadAll = () =>
    void Promise.all([inspectVariables({ environment: env, collectionId }), dynamicVariables()]).then(([list, dynamic]) =>
      setAll([...list.filter((v) => v.name !== 'workspaceDir'), ...dynamic]),
    );

  /** Show suggestions when the caret is inside an unfinished `{{name`. */
  const updateSuggest = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const m = /\{\{\s*([\w.$-]*)$/.exec(before);
    if (!m) return setSuggest(null);
    if (!all.length) loadAll();
    setSuggest({ prefix: m[1]!, start: caret - m[1]!.length, index: 0 });
  };
  const matches = suggest ? all.filter((v) => v.name.toLowerCase().includes(suggest.prefix.toLowerCase())).slice(0, 8) : [];
  const pick = (v: VarInfo) => {
    if (!suggest || !input.current) return;
    const caret = input.current.selectionStart ?? value.length;
    const after = value.slice(caret).replace(/^[\w.$-]*\}{0,2}/, '');
    const next = value.slice(0, suggest.start) + v.name + '}}' + after;
    onChange(next);
    setSuggest(null);
    const pos = suggest.start + v.name.length + 2;
    requestAnimationFrame(() => input.current?.setSelectionRange(pos, pos));
  };

  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    parts.push(value.slice(last, m.index));
    const name = m[1]!.trim();
    const base = name.split('.')[0]!;
    const resolved = name.startsWith('$') || vars[base]?.scope !== undefined;
    parts.push(
      <span key={m.index} data-var={m.index} className={resolved ? 'var-token' : 'var-missing'}>
        {m[0]}
      </span>,
    );
    last = (m.index ?? 0) + m[0].length;
  }
  parts.push(value.slice(last));
  const tooltip = Object.values(vars)
    .map((v) => (v.scope ? `${v.name} = ${v.secret ? '••••••' : v.value} (${v.scope})` : `${v.name}: not defined in the current environment`))
    .join('\n');

  return (
    <div
      ref={box}
      data-var-input
      className={cx(cell ? 'relative flex items-center min-h-[26px] rounded focus-within:bg-field focus-within:shadow-[inset_0_0_0_1.5px_var(--accent)]' : 'relative field p-0 flex items-center', className)}
      title={suggest || pop ? undefined : tooltip ? `${tooltip}\n(click a variable to see or edit it)` : undefined}
    >
      <div ref={overlay} aria-hidden className={cx('absolute inset-0 flex items-center whitespace-pre overflow-hidden mono pointer-events-none', cell ? 'px-1.5' : 'px-2')}>
        <span>{parts}</span>
      </div>
      <input
        ref={input}
        aria-label={ariaLabel}
        aria-autocomplete="list"
        className={cx('relative w-full h-full bg-transparent outline-none mono', cell ? 'px-1.5 py-[3px]' : 'px-2')}
        list={list}
        style={{ color: 'transparent', caretColor: 'var(--caret)' }}
        placeholder={placeholder}
        value={value}
        spellCheck={false}
        onChange={(e) => {
          onChange(e.target.value);
          updateSuggest(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onPaste={(e) => {
          const text = e.clipboardData.getData('text');
          if (onPasteText?.(text)) e.preventDefault();
        }}
        onBlur={() => setTimeout(() => setSuggest(null), 150)}
        onClick={openAtCaret}
        onScroll={(e) => overlay.current && (overlay.current.scrollLeft = e.currentTarget.scrollLeft)}
        onKeyUp={(e) => overlay.current && (overlay.current.scrollLeft = e.currentTarget.scrollLeft)}
        onKeyDown={(e) => {
          if (suggest && matches.length) {
            if (e.key === 'ArrowDown') return (e.preventDefault(), setSuggest({ ...suggest, index: (suggest.index + 1) % matches.length }));
            if (e.key === 'ArrowUp') return (e.preventDefault(), setSuggest({ ...suggest, index: (suggest.index - 1 + matches.length) % matches.length }));
            if (e.key === 'Enter' || e.key === 'Tab') return (e.preventDefault(), pick(matches[suggest.index]!));
            if (e.key === 'Escape') return setSuggest(null);
          }
          if (e.key === 'Escape' && pop) return setPop(null);
          if (e.key === 'Enter') onEnter?.();
        }}
      />
      {suggest && matches.length > 0 && (
        <div role="listbox" className="absolute left-0 top-full mt-1 z-40 w-96 max-w-full rounded-md border border-line bg-bg shadow-xl py-1 text-sm">
          {matches.map((v, i) => (
            <button
              key={v.name}
              role="option"
              aria-selected={i === suggest.index}
              onMouseDown={(e) => (e.preventDefault(), pick(v))}
              className={cx('w-full text-left px-3 py-1.5 flex items-center gap-2', i === suggest.index && 'bg-accent/10')}
            >
              <span className="mono">{v.name}</span>
              <span className="ml-auto text-xs text-muted truncate max-w-48">{v.secret ? '••••••' : v.value}</span>
              <span className="text-[0.7rem] text-muted border border-line rounded px-1">{v.scope}</span>
            </button>
          ))}
          {/* outside a collection (MCP servers, settings …) collection variables don't apply: say so, and where they are */}
          {!(collectionId ?? collectionOf(box.current)) && (
            <div className="px-3 pt-1.5 pb-1 mt-1 border-t border-line text-xs text-muted" data-suggest-note>
              From the active environment, the workspace and the globals. Collection variables only apply to that collection's requests:{' '}
              <button
                className="text-accent hover:underline"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setSuggest(null);
                  useApp.getState().openIntent('environments', { tab: 'collection' });
                }}
              >
                copy them to an environment
              </button>{' '}
              to use them here.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** What a {{variable}} holds and where it comes from; set it in the active environment, or add it there. */
export function VarPopover({ name, info, environment, collectionId, x, y, onClose, onSaved }: { name: string; info?: VarInfo; environment?: string; collectionId?: string; x: number; y: number; onClose(): void; onSaved(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const dynamic = name.startsWith('$');
  const defined = info?.scope !== undefined;
  // a value from the environment (or a missing one) is edited there; other scopes are shown as they are
  const editable = !dynamic && (!defined || info?.scope === 'environment');
  const [draft, setDraft] = useState(info?.secret ? '' : info?.value ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [onClose]);
  const save = async () => {
    if (!environment) return;
    setBusy(true);
    try {
      const r = await call<{ environment: string }>('vars.setInEnvironment', { environment, name, value: draft });
      useApp.getState().toast(`${defined ? 'Updated' : 'Added'} {{${name}}} in ${r.environment}`, 'success');
      onSaved();
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const changed = info?.secret ? draft !== '' : draft !== (info?.value ?? '');
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={`Variable ${name}`}
      className="fixed z-[80] w-[22rem] max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-popover shadow-lg p-3 flex flex-col gap-2 text-sm font-sans animate-in fade-in-0 zoom-in-95 duration-150"
      style={{ left: Math.max(8, Math.min(x, window.innerWidth - 368)), top: Math.min(y + 6, window.innerHeight - 260) }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className={cx('mono font-semibold truncate', defined || dynamic ? 'text-accent' : 'text-bad')}>{`{{${name}}}`}</span>
        <span className={cx('ml-auto shrink-0 text-[0.7rem] rounded px-1.5 border', defined || dynamic ? 'border-line text-muted' : 'border-bad/40 text-bad')}>{dynamic ? 'dynamic' : defined ? info!.scope : 'not defined'}</span>
        <button aria-label="Close" className="shrink-0 text-muted hover:text-fg" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      {dynamic ? (
        <p className="text-xs text-muted">A dynamic variable: it gives a new value each time a request uses it.</p>
      ) : editable ? (
        <>
          <label className="text-xs text-muted">{defined ? 'Value in the active environment' : 'Not defined in the active environment. Add it:'}</label>
          <input
            autoFocus
            className="field mono text-sm"
            type={info?.secret ? 'password' : 'text'}
            placeholder={info?.secret ? 'Secret: type a new value to replace it' : 'value'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && changed && void save()}
          />
        </>
      ) : (
        <>
          <div className="field mono text-sm break-all max-h-28 overflow-auto">{info?.secret ? '••••••' : info?.value || <span className="text-muted">(empty)</span>}</div>
          <p className="text-xs text-muted">Set in the {info?.scope} variables{info?.scope === 'collection' ? ' (collection settings)' : ''}; it takes precedence over the environment.</p>
        </>
      )}
      {/* the buttons wrap when they do not fit; Save keeps the right end of its row */}
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 pt-1">
        {!dynamic && defined && !info?.secret && (
          <Button size="sm" icon={<Copy size={12} />} onClick={() => void copyText(info?.value ?? '')}>
            Copy
          </Button>
        )}
        {/* where this variable is set: its collection's settings, the workspace or global variables, or the environments */}
        {(() => {
          const open = (view: 'environments' | 'collections', payload: Record<string, unknown>) => (onClose(), useApp.getState().openIntent(view, payload));
          const where =
            info?.scope === 'collection' && collectionId
              ? { label: 'Collection variables', go: () => open('collections', { collectionId, tab: 'variables' }) }
              : info?.scope === 'workspace'
              ? { label: 'Workspace variables', go: () => open('environments', { tab: 'workspace' }) }
              : info?.scope === 'global'
              ? { label: 'Globals', go: () => open('environments', { tab: 'globals' }) }
              : { label: 'Environments', go: () => open('environments', {}) };
          return (
            <Button size="sm" variant="ghost" icon={<KeyRound size={12} />} onClick={where.go}>
              {where.label}
            </Button>
          );
        })()}
        <Button
          size="sm"
          variant="ghost"
          icon={<Layers size={12} />}
          title="Every scope that sets this variable (collection, environment, workspace, globals) and which one this request uses"
          onClick={() => {
            onClose();
            // the overview opens on this variable: where it is set, or that it is set nowhere
            openQuickLook(name);
          }}
        >
          Where it's set
        </Button>
        {editable && (
          <Button size="sm" variant="primary" className="ml-auto" icon={<Save size={12} />} loading={busy} disabled={!changed || !environment} title={environment ? undefined : 'Choose an environment in the top bar first'} onClick={() => void save()}>
            {defined ? 'Save' : 'Add'}
          </Button>
        )}
      </div>
    </div>,
    document.body,
  );
}
