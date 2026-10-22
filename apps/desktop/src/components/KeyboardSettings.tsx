import { Download, Keyboard, RotateCcw, Search, Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
import { isMac } from '../api';
import { downloadContent, pickTextFile } from '../lib/files';
import { KEY_NAMES, saveBindings, useBindings } from '../lib/keybindings';
import { bindingProblem, COMMANDS, comboKeys, comboLabel, comboOf, effectiveBindings, exportBindings, importBindings, shortcutGroups, type Combo } from '../lib/shortcuts';
import { railItem, useRail } from '../lib/use-rail';
import { toastError, useApp, attempt } from '../store';
import { Button, cx, IconButton, Input, Kbd } from './ui';

const DEFAULTS = effectiveBindings();
const LABEL = new Map(COMMANDS.map((c) => [c.id, c.label]));

/** The keys of a combination as key caps; "not set" for a command turned off. */
function Keys({ combo }: { combo: Combo }) {
  const keys = comboKeys(combo, KEY_NAMES);
  if (!keys.length) return <span className="text-xs text-muted italic">not set</span>;
  return (
    <span className="inline-flex items-center gap-1">
      {keys.map((k, i) => (
        <Kbd key={i}>{k}</Kbd>
      ))}
    </span>
  );
}

/**
 * Settings ▸ Keyboard: every shortcut (lib/shortcuts.ts, the one list), with a search; the app-wide ones can be rebound
 * (click, press the keys), each reset or all at once, exported and imported as JSON. Saved for this computer.
 */
export function KeyboardSettings() {
  const bindings = useBindings();
  const overrides = useApp((s) => s.settings?.keybindings);
  const views = useRail().visible.map((id) => railItem(id)?.label ?? id);
  const groups = useMemo(() => shortcutGroups({ ...KEY_NAMES, mac: isMac, views, bindings: overrides }), [overrides, views.join()]);
  const [q, setQ] = useState('');
  const [recording, setRecording] = useState<string>();
  const [problem, setProblem] = useState<{ id: string; message: string; conflict?: string; combo: Combo }>();
  const changed = COMMANDS.filter((c) => bindings[c.id] !== DEFAULTS[c.id]).length;

  const save = (next: Record<string, Combo>) => void saveBindings(next).catch(toastError);
  const record = (id: string, e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) return (setRecording(undefined), setProblem(undefined));
    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      setRecording(undefined);
      setProblem(undefined);
      return save({ ...bindings, [id]: '' });
    }
    const combo = comboOf(e.nativeEvent, isMac);
    if (!combo) return; // a modifier alone: keep listening
    setRecording(undefined);
    const p = bindingProblem(id, combo, bindings, isMac, (c) => comboLabel(c, KEY_NAMES));
    if (p) return setProblem({ id, ...p, combo });
    setProblem(undefined);
    save({ ...bindings, [id]: combo });
  };
  /** Give a combination another command has to this one: the other gets this one's old keys (or none, if they clash). */
  const swap = () => {
    if (!problem?.conflict) return;
    const mine = bindings[problem.id] ?? '';
    const next = { ...bindings, [problem.id]: problem.combo, [problem.conflict]: '' };
    next[problem.conflict] = mine && !bindingProblem(problem.conflict, mine, next, isMac) ? mine : '';
    setProblem(undefined);
    save(next);
  };
  const resetAll = () => (setProblem(undefined), save({ ...DEFAULTS }));

  const needle = q.trim().toLowerCase();
  const matches = (text: string, keys: string[][], ids?: string[]) =>
    !needle || text.toLowerCase().includes(needle) || keys.some((k) => k.join('+').toLowerCase().includes(needle)) || !!ids?.some((id) => LABEL.get(id)?.toLowerCase().includes(needle));
  const shown = groups.map((g) => ({ ...g, items: g.items.filter((it) => matches(it.text, it.keys, it.ids)) })).filter((g) => g.items.length);

  return (
    <div className="flex flex-col gap-4" data-keyboard-settings>
      <p className="text-sm text-muted">
        Click a shortcut's keys and press the new ones (<Kbd>Esc</Kbd> cancels, <Kbd>Backspace</Kbd> turns it off). The app-wide shortcuts can be changed; the others are listed for reference. Saved
        for this computer; the tooltips, menus, the command palette and the shortcuts list (<Kbd>?</Kbd>) show your keys.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="relative flex-1 min-w-48 max-w-96">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
          <Input className="w-full pl-8" placeholder="Search shortcuts by what they do or their keys" aria-label="Search shortcuts" value={q} onChange={(e) => setQ(e.target.value)} />
        </span>
        <Button size="sm" icon={<Download size={13} />} onClick={() => downloadContent('testpion-keybindings.json', exportBindings(overrides), { type: 'application/json' })}>
          Export…
        </Button>
        <Button
          size="sm"
          icon={<Upload size={13} />}
          onClick={async () => {
            const f = await pickTextFile('.json,application/json');
            if (!f) return;
            await attempt(async () => {
              const r = importBindings(f.text, isMac);
              await saveBindings(effectiveBindings(r.bindings));
              useApp.getState().toast(`Key bindings imported${r.skipped.length ? `; skipped ${r.skipped.join('; ')}` : ''}`, r.skipped.length ? 'warning' : 'success');
            });
          }}
        >
          Import…
        </Button>
        <Button size="sm" icon={<RotateCcw size={13} />} disabled={!changed} reason="Every shortcut has its default keys" onClick={resetAll} title="Every shortcut back to its default keys">
          Reset all{changed ? ` (${changed})` : ''}
        </Button>
      </div>
      {problem && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm" data-binding-problem>
          <span className="flex-1 min-w-0">
            <b>{LABEL.get(problem.id)}</b>: {problem.message}.
          </span>
          {problem.conflict && (
            <Button size="sm" variant="primary" onClick={swap}>
              Use it here
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setProblem(undefined)}>
            Cancel
          </Button>
        </div>
      )}
      {shown.map((g) => (
        <section key={g.title}>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted mb-1.5">{g.title}</h3>
          <div className="rounded-lg border border-line divide-y divide-line">
            {g.items.map((it, i) => (
              <div key={`${g.title}-${i}`} className="flex items-center gap-3 px-3 py-1.5 text-sm" data-shortcut-row={it.ids?.join(',') ?? ''}>
                <span className="flex-1 min-w-0">{it.text}</span>
                {it.ids ? (
                  <span className="flex items-center gap-1.5 shrink-0">
                    {it.ids.map((id) => (
                      <span key={id} className="flex items-center gap-0.5">
                        <button
                          aria-label={`Change the keys of ${LABEL.get(id)}`}
                          title={recording === id ? 'Press the new keys (Esc cancels, Backspace turns it off)' : `${LABEL.get(id)}: click to change`}
                          data-binding={id}
                          className={cx(
                            'min-w-24 h-7 px-2 rounded-md border text-left',
                            recording === id ? 'border-accent ring-2 ring-accent/30 bg-accent-soft' : 'border-line hover:border-line-strong hover:bg-hover',
                          )}
                          onClick={() => (setRecording(recording === id ? undefined : id), setProblem(undefined))}
                          onBlur={() => recording === id && setRecording(undefined)}
                          onKeyDown={(e) => recording === id && record(id, e)}
                        >
                          {recording === id ? (
                            <span className="text-xs text-accent inline-flex items-center gap-1">
                              <Keyboard size={12} /> Press keys…
                            </span>
                          ) : (
                            <Keys combo={bindings[id] ?? ''} />
                          )}
                        </button>
                        <IconButton
                          label={`Reset ${LABEL.get(id)} to ${comboKeys(DEFAULTS[id]!, KEY_NAMES).join('+')}`}
                          className={cx('h-7 w-7', bindings[id] === DEFAULTS[id] && 'invisible')}
                          onClick={() => save({ ...bindings, [id]: DEFAULTS[id]! })}
                        >
                          <RotateCcw size={12} />
                        </IconButton>
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 shrink-0 text-muted" title="Fixed: this shortcut belongs to an editor or a list">
                    {it.keys.map((k, j) => (
                      <span key={j} className="inline-flex items-center gap-1">
                        {j > 0 && <span className="text-xs">/</span>}
                        {k.map((x, n) => (
                          <Kbd key={n}>{x}</Kbd>
                        ))}
                      </span>
                    ))}
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
      {!shown.length && <p className="text-sm text-muted">No shortcut matches “{q}”.</p>}
    </div>
  );
}
