import { isMac } from '../api';
import { isRequestView, useApp } from '../store';
import { getBindings } from './keybindings';
import { stepProblem } from './problems';
import { railTarget } from './rail';
import { reopenClosedTab } from './closed-tabs';
import { runAgain } from './run-again';
import { comboOf, commandFor, isTextCombo } from './shortcuts';
import { focusTerminal, newTerminal } from './terminal';
import { getRail, goToRail } from './use-rail';
import { hasUndo, undoLatest } from './undo';
import { downloadFocusedOutput } from '../components/output/output-core';

/** What each app-wide command does (lib/shortcuts.ts names them); `false`: nothing to do here, the key goes on. */
const RUN: Record<string, () => void | false> = {
  'quick-open': () => useApp.getState().set({ paletteOpen: true, paletteQuery: '', searchOpen: false }),
  palette: () => useApp.getState().set({ paletteOpen: true, paletteQuery: '>', searchOpen: false }),
  // switch environment (Insomnia's binding): Quick Open at #
  'switch-environment': () => useApp.getState().set({ paletteOpen: true, paletteQuery: '#', searchOpen: false }),
  search: () => useApp.getState().set({ searchOpen: true, paletteOpen: false }),
  // WF-08: the latest run, as it ran
  'rerun-last': () => void runAgain('last'),
  // WF-10: whichever strip it was in
  'reopen-tab': () => void reopenClosedTab(),
  // the down arrow of the output nearest to the focus (a response, a run, the console)
  'download-output': () => downloadFocusedOutput(),
  back: () => useApp.getState().goBack(),
  forward: () => useApp.getState().goForward(),
  'toggle-explorer': () => {
    const st = useApp.getState();
    // the Tests view shows the explorer too, when asked (requests are dragged from it onto a flow's canvas)
    if (st.view === 'tests') st.set({ explorerInTests: !st.explorerInTests });
    else if (isRequestView(st.view)) st.toggleExplorer();
    else (st.setView(st.lastRequestView), st.toggleExplorer(true));
  },
  // WF-03
  'next-problem': () => void stepProblem(1),
  'previous-problem': () => void stepProblem(-1),
  settings: () => useApp.getState().setView('settings'),
  // the AI assistant, with what is on screen (again: close it)
  assistant: () => {
    const st = useApp.getState();
    st.set({ assistant: st.assistant?.task === 'free' ? undefined : { task: 'free', title: 'Ask the assistant', context: {} } });
  },
  // Postman's shortcut for the console
  'toggle-console': () => {
    const st = useApp.getState();
    st.set(st.logsOpen && st.bottomTab === 'console' ? { logsOpen: false } : { logsOpen: true, bottomTab: 'console' });
  },
  // as in VS Code: Ctrl+` shows / hides the Terminal, Ctrl+Shift+` opens a new one (only where shells run)
  terminal: () => {
    const st = useApp.getState();
    if (!st.info?.capabilities?.shell) return false;
    if (st.logsOpen && st.bottomTab === 'terminal') st.set({ logsOpen: false });
    else focusTerminal();
  },
  'new-terminal': () => (useApp.getState().info?.capabilities?.shell ? newTerminal() : false),
  shortcuts: () => useApp.getState().set({ shortcutsOpen: true }),
};

/** Keys typed into a field are text, not shortcuts. */
export const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || !!t.closest('.monaco-editor'));

/**
 * The app's global key handler: the person's bindings (Settings ▸ Keyboard) and Ctrl/Cmd+Alt+1…9 for the views shown on
 * the rail. A key alone that types (`?`) counts only outside text fields.
 */
export function handleGlobalKey(e: KeyboardEvent): void {
  const combo = comboOf(e, isMac);
  if (!combo) return;
  const rail = /^Mod\+Alt\+([1-9])$/.exec(combo);
  if (rail) {
    const target = railTarget(getRail().visible, Number(rail[1]));
    if (target) goToRail(target);
    return;
  }
  // Ctrl/Cmd+Z outside text fields: the latest delete's Undo while its message is up (lib/undo.ts). Decided after every
  // other listener had the key (the flow canvas has its own undo), so whatever used it keeps it.
  if (combo === 'Mod+Z' && hasUndo() && !isTyping(e.target) && !document.querySelector('[role=dialog], [role=menu]')) {
    setTimeout(() => !e.defaultPrevented && undoLatest(), 0);
    return;
  }
  const id = commandFor(combo, getBindings());
  if (!id || (isTextCombo(combo) && isTyping(e.target))) return;
  if (RUN[id]?.() !== false) e.preventDefault();
}
