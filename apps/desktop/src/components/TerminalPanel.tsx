import '@xterm/xterm/css/xterm.css';
import { Terminal, type ILink, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Eraser, Plus, SquareTerminal, Trash2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { outputFileName } from '@testpion/shared';
import { bridge, call, on } from '../api';
import { toastError, useApp } from '../store';
import { copyQuietly, writeClipboard } from '../lib/clipboard';
import { useTerminals, type TerminalSessionInfo } from '../lib/terminal';
import { AckCounter } from '../lib/terminal-flow';
import { terminalLinks } from '../lib/terminal-links';
import { openRef } from '../lib/open-ref';
import { afterScopeChange, scopedKey } from '../lib/ws-scope';
import { Empty, IconButton, Select } from './ui';
import { DocTabStrip } from './DocTabStrip';
import { OutputActions } from './output/OutputFrame';
import type { OutputSpec } from './output/output-core';

/**
 * The bottom panel's Terminal: shells of this computer (PowerShell, cmd, Git Bash, zsh, bash …) in the workspace folder,
 * with `testpion` on the PATH. The shells live in the backend (backend/terminal.ts); this module draws them with xterm.
 * It loads with the tab, the first time the tab opens, and its terminals stay alive (and keep their output) when the
 * tab or the whole panel is closed: each one's xterm is moved into the panel while it is shown.
 */
interface Live {
  info: TerminalSessionInfo;
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  opened: boolean;
  /** What xterm has parsed, acknowledged to the backend (flow control, lib/terminal-flow.ts). */
  acks: AckCounter;
  /** Characters received in all (diagnostics: window.__tpTerminals()). */
  received: number;
  /** Replaying kept output (after a reload): what xterm answers to queries in it (ESC[c …) must not reach the shell. */
  replaying: boolean;
  /** Resolves at the shell's first output (its prompt): a command typed before that could be lost. */
  ready: Promise<void>;
  markReady(): void;
}

interface ShellChoice {
  id: string;
  label: string;
  path: string;
}

const live = new Map<string, Live>();
/** Output that came for a terminal the window does not know yet (its terminal.create answer is on its way). */
const early = new Map<string, string>();
let restoring = true;
let shellsInfo: Promise<{ available: boolean; shells: ShellChoice[] }> | undefined;
const shellList = () => (shellsInfo ??= call<{ available: boolean; shells: ShellChoice[] }>('terminal.shells').catch(() => ({ available: false, shells: [] })));
/** The shell of new terminals, remembered per workspace (lib/ws-scope.ts). */
const SHELL_KEY = 'aps.terminal.shell';
const readShell = () => {
  const key = scopedKey(SHELL_KEY);
  try {
    return (key && localStorage.getItem(key)) || '';
  } catch {
    return '';
  }
};

const setSessions = () => {
  const sessions = [...live.values()].map((l) => l.info);
  const active = useTerminals.getState().active;
  useTerminals.setState({ sessions, active: active && live.has(active) ? active : sessions.at(-1)?.id });
};

/* ---------------------------------------------------------------- theme: the app's tokens */

let probe: CanvasRenderingContext2D | null | undefined;
/** A CSS colour (oklch, a var) as #rrggbb: xterm only reads hex and rgb(). */
function hex(css: string, fallback: string): string {
  probe ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!probe || !css) return fallback;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = fallback;
  probe.fillStyle = css;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => v!.toString(16).padStart(2, '0')).join('')}`;
}
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const dark = () => document.documentElement.getAttribute('data-theme') === 'dark';

/** The ANSI colours (VS Code's defaults), on the panel's background and with the app's text, accent and caret. */
function theme(): ITheme {
  const d = dark();
  const ansi = d
    ? {
        black: '#000000',
        red: '#cd3131',
        green: '#0dbc79',
        yellow: '#e5e510',
        blue: '#2472c8',
        magenta: '#bc3fbc',
        cyan: '#11a8cd',
        white: '#e5e5e5',
        brightBlack: '#666666',
        brightRed: '#f14c4c',
        brightGreen: '#23d18b',
        brightYellow: '#f5f543',
        brightBlue: '#3b8eea',
        brightMagenta: '#d670d6',
        brightCyan: '#29b8db',
        brightWhite: '#e5e5e5',
      }
    : {
        black: '#000000',
        red: '#cd3131',
        green: '#107c10',
        yellow: '#949800',
        blue: '#0451a5',
        magenta: '#bc05bc',
        cyan: '#0598bc',
        white: '#555555',
        brightBlack: '#666666',
        brightRed: '#cd3131',
        brightGreen: '#14ce14',
        brightYellow: '#b5ba00',
        brightBlue: '#0451a5',
        brightMagenta: '#bc05bc',
        brightCyan: '#0598bc',
        brightWhite: '#a5a5a5',
      };
  const bg = hex(token('--panel'), d ? '#161a2e' : '#f8f9fc');
  return {
    ...ansi,
    background: bg,
    foreground: hex(token('--fg'), d ? '#eef0fa' : '#1c2033'),
    cursor: hex(token('--caret'), '#2f7bff'),
    cursorAccent: bg,
    selectionBackground: hex(`color-mix(in oklch, ${token('--accent') || '#2f7bff'} 35%, transparent)`, d ? '#264f78' : '#add6ff'),
    scrollbarSliderBackground: hex(token('--line-strong'), '#888888') + '80',
  };
}

/* ---------------------------------------------------------------- links: URLs and workspace files */

const isWin = bridge.platform === 'win32';

/** `tests/smoke.yaml:12`, `specs\api.yaml`, a path inside the workspace folder: opens what it is (openRef, lib/terminal-links.ts). */
function fileLinks(term: Terminal) {
  return {
    provideLinks(y: number, cb: (links: ILink[] | undefined) => void) {
      const line = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? '';
      const links = terminalLinks(line, useApp.getState().workspace?.path).map((l) => ({
        range: { start: { x: l.start + 1, y }, end: { x: l.start + l.length, y } },
        text: l.text,
        activate: () => void openRef(l.ref),
      }));
      cb(links.length ? links : undefined);
    },
  };
}

/* ---------------------------------------------------------------- one terminal */

function fontFamily() {
  return token('--font-mono') || "'JetBrains Mono Variable', Consolas, monospace";
}

function make(info: TerminalSessionInfo): Live {
  const host = document.createElement('div');
  host.className = 'h-full w-full';
  host.dataset.terminalId = info.id;
  const term = new Terminal({
    fontFamily: fontFamily(),
    fontSize: 13,
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 5000,
    theme: theme(),
    macOptionIsMeta: true,
    allowProposedApi: false,
    ...(isWin ? { windowsPty: { backend: 'conpty' as const } } : {}),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((_e, uri) => void call('app.openExternal', { url: uri }).catch(toastError)));
  term.registerLinkProvider(fileLinks(term));
  let markReady!: () => void;
  const ready = new Promise<void>((r) => (markReady = r));
  const l: Live = {
    info,
    term,
    fit,
    host,
    opened: false,
    acks: new AckCounter((parsed, epoch) => call('terminal.ack', { id: info.id, parsed, epoch })),
    received: 0,
    replaying: false,
    ready,
    markReady,
  };
  const id = () => l.info.id;
  term.onData((data) => {
    if (l.info.exitCode === undefined && !l.replaying) void call('terminal.write', { id: id(), data }).catch(() => undefined);
  });
  term.onResize(({ cols, rows }) => {
    if (l.info.exitCode === undefined && live.has(id())) void call('terminal.resize', { id: id(), cols, rows }).catch(() => undefined);
  });
  // copy on selection (as in most terminals); Ctrl+Shift+C / V copy and paste; Ctrl+C goes to the shell
  term.onSelectionChange(() => {
    const t = term.getSelection();
    // copied as it is made: best effort, no message (an explicit copy says when the clipboard refused)
    if (t) void writeClipboard(t).catch(() => undefined);
  });
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey) return true;
    if (e.code === 'KeyC') {
      const t = term.getSelection();
      if (t) void copyQuietly(t);
      return false;
    }
    if (e.code === 'KeyV') {
      void paste(term);
      return false;
    }
    return true;
  });
  return l;
}

/** Draw output sent in `epoch`; the backend hears once xterm has parsed it (flow control, lib/terminal-flow.ts). */
function draw(l: Live, data: string, epoch: number) {
  l.received += data.length;
  l.term.write(data, () => live.get(l.info.id) === l && l.acks.parsedChunk(data.length, epoch));
  l.markReady();
}

/**
 * Show the output the backend kept in place of what the terminal shows (a restore after a reload, or a replay after the
 * window stopped drawing for a while), and count from there. What xterm answers to queries in it never reaches the shell.
 */
function show(l: Live, output: string, sent: number, epoch: number) {
  l.acks.reset(sent, epoch);
  l.replaying = true;
  // in order: after what was written before, the screen and scrollback start over
  l.term.write('', () => l.term.reset());
  l.term.write(output, () => (l.replaying = false));
  l.markReady();
}

const paste = (term: Terminal) =>
  navigator.clipboard.readText().then(
    (t) => t && term.paste(t),
    () => useApp.getState().toast('Could not read the clipboard', 'error'),
  );

function register(info: TerminalSessionInfo & { epoch?: number }, output?: string): Live {
  const l = make(info);
  live.set(info.id, l);
  // a restored terminal counts from what terminal.list gave; a new one from its first output (which may be here already)
  if (output !== undefined) show(l, output, info.sent ?? 0, info.epoch ?? 0);
  const pending = early.get(info.id);
  early.delete(info.id);
  if (pending) draw(l, pending, 0);
  if (info.exitCode !== undefined) exitedNote(l, info.exitCode);
  setSessions();
  return l;
}

function exitedNote(l: Live, code: number) {
  l.term.write(`\r\n\x1b[2m[The shell exited with code ${code}. Close this terminal, or open a new one with +.]\x1b[0m\r\n`);
}

function dispose(id: string) {
  const l = live.get(id);
  if (!l) return;
  live.delete(id);
  l.acks.dispose();
  l.term.dispose();
  l.host.remove();
  setSessions();
}

/** The buffer's last `rows` rows (scrollback included) as text, one line per logical line (a wrapped line joined back). */
function bufferText(term: Terminal, rows = 1000): string {
  const b = term.buffer.active;
  const lines: string[] = [];
  for (let y = Math.max(0, b.length - rows); y < b.length; y++) {
    const line = b.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return lines.join('\n');
}

/**
 * What each terminal received and drew (for diagnosing a terminal that looks stuck; read-only); `withText`: its buffer's
 * text too (what a screen reader or a check reads; the rows on screen split a long line where the width wraps it).
 */
(window as unknown as { __tpTerminals?: (withText?: boolean) => unknown }).__tpTerminals = (withText = false) =>
  [...live.values()].map((l) => ({ id: l.info.id, received: l.received, parsed: l.acks.parsed, epoch: l.acks.epoch, opened: l.opened, ...(withText ? { text: bufferText(l.term) } : {}) }));

/* ---------------------------------------------------------------- the backend's events, from when this module loads */

on<{ id: string; data: string; epoch?: number }>('terminal.data', ({ id, data, epoch = 0 }) => {
  const l = live.get(id);
  if (l) return draw(l, data, epoch);
  // a terminal being created (its answer comes next); while restoring, the list's output already has it
  if (restoring) return;
  const had = early.get(id) ?? '';
  // bounded by flow control: the backend stops at FLOW_HIGH unacknowledged characters
  if (had.length < 4 * 1024 * 1024) early.set(id, had + data);
});
// the window had stopped drawing (hidden, busy) and the shell ran on: it gets the kept output back
on<{ id: string; output: string; sent: number; epoch: number }>('terminal.replay', ({ id, output, sent, epoch }) => {
  const l = live.get(id);
  if (l) show(l, output, sent, epoch);
});
// the window drew nothing for a while (hidden, busy) and the shell runs on: once xterm has parsed what it has, say so,
// and the kept output comes back (terminal.replay)
on<{ id: string }>('terminal.detached', ({ id }) => {
  const l = live.get(id);
  if (l) l.term.write('', () => l.acks.flush(true));
});
on<{ id: string; code: number }>('terminal.exit', ({ id, code }) => {
  const l = live.get(id);
  if (!l) return;
  l.info = { ...l.info, exitCode: code };
  exitedNote(l, code);
  setSessions();
});
on<{ ids: string[]; reason: string }>('terminal.closed', ({ ids, reason }) => {
  const known = ids.filter((id) => live.has(id));
  for (const id of known) dispose(id);
  if (known.length && reason === 'workspace') useApp.getState().toast('The terminals were closed: they ran in the previous workspace', 'info');
});
// terminals belong to the workspace they were opened in: another workspace starts with none (the backend ends the old
// ones too; ending them here as well means no shell outlives its workspace whatever arrives first)
afterScopeChange(() => {
  const ids = [...live.keys()];
  for (const id of ids) {
    void call('terminal.kill', { id }).catch(() => undefined);
    dispose(id);
  }
  useTerminals.setState({ active: undefined });
  if (ids.length) useApp.getState().toast('The terminals were closed: they ran in the previous workspace', 'info');
});

// a window that reloads gets its terminals back, with their last output
const restored = call<Array<TerminalSessionInfo & { output?: string; epoch?: number }>>('terminal.list', { withOutput: true })
  .then((list) => {
    for (const s of list) if (!live.has(s.id)) register(s, s.output ?? '');
    // the most recent terminal is the one shown
    if (list.length) useTerminals.setState({ active: list.at(-1)!.id });
  })
  .catch(() => undefined)
  .finally(() => (restoring = false));

// theme changes (Settings, the OS) repaint every terminal
new MutationObserver(() => {
  const t = theme();
  for (const l of live.values()) l.term.options.theme = t;
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });

/* ---------------------------------------------------------------- the panel */

export default function TerminalPanel() {
  const sessions = useTerminals((s) => s.sessions);
  const active = useTerminals((s) => s.active);
  const queue = useTerminals((s) => s.queue);
  const visible = useApp((s) => s.logsOpen && s.bottomTab === 'terminal');
  const box = useRef<HTMLDivElement>(null);
  const [shells, setShells] = useState<{ available: boolean; shells: ShellChoice[] }>();
  const wsId = useApp((s) => s.workspace?.id);
  const [shell, setShell] = useState(readShell);
  // another workspace: its own choice
  useEffect(() => setShell(readShell()), [wsId]);
  const busy = useRef(false);

  useEffect(() => {
    void shellList().then(setShells);
  }, []);
  const chosen = shells?.shells.find((s) => s.id === shell)?.id ?? shells?.shells[0]?.id;

  /** Fit the shown terminal to the panel (and so resize its pty). */
  const fitActive = () => {
    const l = active ? live.get(active) : undefined;
    if (!l?.opened || !box.current?.offsetParent) return;
    try {
      l.fit.fit();
    } catch {
      /* not laid out yet */
    }
  };

  const create = async (shellId = chosen): Promise<Live | undefined> => {
    if (!box.current) return undefined;
    // the size the new terminal will have: measured with a terminal of the same font
    const probeTerm = make({ id: '', shell: '', label: '', pid: 0, cwd: '' });
    probeTerm.host.style.cssText = 'position:absolute;inset:4px 0 0 8px;visibility:hidden';
    box.current.append(probeTerm.host);
    probeTerm.term.open(probeTerm.host);
    const dims = probeTerm.fit.proposeDimensions();
    probeTerm.term.dispose();
    probeTerm.host.remove();
    try {
      const info = await call<TerminalSessionInfo>('terminal.create', { shell: shellId, cols: dims?.cols && dims.cols > 1 ? dims.cols : 80, rows: dims?.rows && dims.rows > 1 ? dims.rows : 24 });
      const l = register(info);
      useTerminals.setState({ active: info.id });
      return l;
    } catch (e) {
      toastError(e);
      return undefined;
    }
  };

  // the requests of the window (Run in terminal, Terminal: New / Focus), in order; the first visit opens a terminal
  // (showing the panel), not a later change of the queue: another workspace empties it and starts with no terminal
  const visited = useRef(false);
  useEffect(() => {
    if (!shells?.available || busy.current || !box.current) return;
    const todo = useTerminals.getState().queue;
    busy.current = true;
    void (async () => {
      try {
        await restored;
        if (todo.length) useTerminals.setState((s) => ({ queue: s.queue.slice(todo.length) }));
        const first = !visited.current;
        visited.current = true;
        if (first && !live.size && !todo.some((r) => r.kind === 'new')) await create();
        for (const r of todo) {
          if (r.kind === 'new') await create();
          else {
            const cur = useTerminals.getState().active;
            let l = cur ? live.get(cur) : undefined;
            if (!l || l.info.exitCode !== undefined) l = await create();
            if (!l) break;
            useTerminals.setState({ active: l.info.id });
            if (r.kind === 'run') {
              await Promise.race([l.ready, new Promise((res) => setTimeout(res, 5000))]);
              await call('terminal.write', { id: l.info.id, data: r.command + (r.execute ? '\r' : '') }).catch(toastError);
            }
          }
        }
      } finally {
        busy.current = false;
        // asked for more meanwhile
        if (useTerminals.getState().queue.length) useTerminals.setState((s) => ({ queue: [...s.queue] }));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, shells]);

  // the active terminal is moved into the panel (the others stay alive, out of the page)
  useLayoutEffect(() => {
    const l = active ? live.get(active) : undefined;
    const el = box.current;
    if (!el || !l) return;
    if (l.host.parentElement !== el) el.replaceChildren(l.host);
    if (!l.opened) {
      l.term.open(l.host);
      l.opened = true;
    }
    fitActive();
    if (visible) l.term.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sessions.length, visible]);

  // the panel's size changes (window, split): the terminal follows, at most once a frame
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(fitActive);
    });
    ro.observe(el);
    return () => (ro.disconnect(), cancelAnimationFrame(raf));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const kill = (id: string) => {
    void call('terminal.kill', { id }).catch(() => undefined);
    dispose(id);
  };
  const activeLive = active ? live.get(active) : undefined;
  const activeLabel = activeLive?.info.label;
  // the shown terminal's transcript: its buffer as text (xterm has already interpreted the escape sequences)
  const spec = useMemo<OutputSpec>(
    () => ({
      id: 'terminal',
      what: 'terminal transcript',
      name: outputFileName({ name: `terminal-${activeLabel ?? 'shell'}`, ext: '' }),
      formats: [
        {
          format: 'text',
          build: () => {
            const l = active ? live.get(active) : undefined;
            return l ? bufferText(l.term, l.term.buffer.active.length).replace(/\s+$/, '') + '\n' : '';
          },
        },
      ],
      empty: active && activeLabel !== undefined ? undefined : 'No terminal is open',
    }),
    [active, activeLabel],
  );

  if (shells && !shells.available)
    return (
      <div className="flex-1 overflow-auto">
        <Empty icon={<SquareTerminal size={20} />} title="The terminal is part of the desktop app">
          It runs shells on your computer, so it is not available here. Run <span className="mono">testpion</span> commands from your own terminal (
          <span className="mono">npm install -g testpion</span>).
        </Empty>
      </div>
    );

  return (
    <>
      {/* the terminals are document tabs (the one strip of every view's open items): ✕ or middle-click kills one */}
      <div className="contents" data-terminal-strip="">
        <DocTabStrip
          label="Terminals"
          tabs={sessions.map((s, i) => ({
            id: s.id,
            title: `${s.label}${sessions.filter((x) => x.label === s.label).length > 1 ? ` ${sessions.filter((x, j) => x.label === s.label && j <= i).length}` : ''}${s.exitCode !== undefined ? ' (exited)' : ''}`,
            tooltip: `${s.label} · ${s.cwd}${s.exitCode !== undefined ? ` · exited (${s.exitCode})` : ''}`,
            badge: <SquareTerminal size={12} className="shrink-0 text-muted" aria-hidden />,
          }))}
          activeId={active}
          onSelect={(t) => useTerminals.setState({ active: t.id })}
          onClose={(ids) => ids.forEach(kill)}
          countMenu={false}
          afterTabs={
            <div className="flex items-center gap-1 self-center px-1 shrink-0">
          <IconButton size="md" label="New terminal" onClick={() => void create()} disabled={!shells?.available} reason="No shell was found: install PowerShell or bash">
            <Plus />
          </IconButton>
          <Select
            aria-label="Shell of new terminals"
            className="field-sm text-xs w-auto"
            value={chosen ?? ''}
            onChange={(e) => {
              setShell(e.target.value);
              const key = scopedKey(SHELL_KEY);
              try {
                if (key) localStorage.setItem(key, e.target.value);
              } catch {
                /* private storage */
              }
            }}
          >
            {(shells?.shells ?? []).map((s) => (
              <option key={s.id} value={s.id} title={s.path}>
                {s.label}
              </option>
            ))}
          </Select>
            </div>
          }
          actions={
        <OutputActions spec={spec}>
          <IconButton label="Clear terminal" disabled={!activeLive} reason="No terminal is open" onClick={() => (activeLive?.term.clear(), activeLive?.term.focus())}>
            <Eraser />
          </IconButton>
          <IconButton label="Kill terminal" disabled={!activeLive} reason="No terminal is open" onClick={() => active && kill(active)}>
            <Trash2 />
          </IconButton>
        </OutputActions>
          }
        />
      </div>
      <div
        ref={box}
        className="relative flex-1 min-h-0 pl-2 pt-1 bg-panel overflow-hidden"
        data-terminal-box=""
        data-output="terminal"
        onContextMenu={(e) => {
          // right-click: copy the selection, else paste (as Windows Terminal and VS Code on Windows)
          const t = activeLive?.term;
          if (!t) return;
          e.preventDefault();
          const sel = t.getSelection();
          if (sel)
            void copyQuietly(sel).then((ok) => ok && t.clearSelection());
          else void paste(t);
        }}
        onKeyDown={(e) => {
          // keys typed in a terminal belong to the shell (Ctrl+K, Ctrl+R …), not to the app's shortcuts; Ctrl+Shift and Alt ones still reach the app
          if (!e.shiftKey && !e.altKey) e.stopPropagation();
        }}
      />
    </>
  );
}
