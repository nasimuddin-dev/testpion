import { AlertTriangle, CheckCircle2, Cookie, Disc, Replace, ShieldCheck, SquareTerminal, Wrench } from 'lucide-react';
import { openReverseProxyCapture } from '../lib/capture';
import { useApp } from '../store';
import { useProblems } from '../lib/problems';
import { focusTerminal, useShellCapable } from '../lib/terminal';
import { modKey } from '../api';
import { Menu, cx, type MenuItem } from './ui';

/** Open or close a tab of the bottom panel (the status bar's buttons toggle it, the same way for each). */
function toggleBottom(tab: 'problems' | 'terminal') {
  const s = useApp.getState();
  if (s.logsOpen && s.bottomTab === tab) return s.set({ logsOpen: false });
  s.set({ logsOpen: true, bottomTab: tab });
  if (tab === 'terminal') focusTerminal();
}

/**
 * The status bar as the tool hub (WF-03, WF-17): the Problems count (a click toggles the Problems tab), the Terminal
 * beside Console and Logs, and a Tools menu (Cookies, Find & replace in a collection, the reverse proxy for one API, Certificates).
 */
export function StatusBarTools() {
  const problems = useProblems();
  const shell = useShellCapable();
  const open = useApp((s) => s.logsOpen);
  const tab = useApp((s) => s.bottomTab);
  const bad = problems.filter((p) => p.type !== 'warning').length;
  const tools: MenuItem[] = [
    { label: 'Cookies…', icon: <Cookie size={14} />, onSelect: () => useApp.getState().set({ cookiesOpen: true }) },
    { label: 'Find & replace in a collection…', icon: <Replace size={14} />, onSelect: () => useApp.getState().openIntent('collections', { replace: true }) },
    { label: 'Reverse proxy for one API…', icon: <Disc size={14} />, onSelect: () => openReverseProxyCapture() },
    { label: 'Certificates', icon: <ShieldCheck size={14} />, onSelect: () => useApp.getState().openIntent('settings', { tab: 'certificates' }) },
  ];
  return (
    <>
      <button
        data-status="problems"
        className={cx('flex items-center gap-1 hover:text-fg', open && tab === 'problems' && 'text-fg', bad > 0 && 'text-bad')}
        title={problems.length ? `Problems: ${problems.length} (F8: the next one)` : 'No problems'}
        onClick={() => toggleBottom('problems')}
      >
        {problems.length ? <AlertTriangle size={12} /> : <CheckCircle2 size={12} />} {problems.length}
      </button>
      {shell && (
        <button
          data-status="terminal"
          className={cx('flex items-center gap-1 hover:text-fg', open && tab === 'terminal' && 'text-fg')}
          title={`Terminal (${modKey}+\`)`}
          onClick={() => toggleBottom('terminal')}
        >
          <SquareTerminal size={12} /> Terminal
        </button>
      )}
      <Menu
        width={260}
        align="end"
        items={tools}
        trigger={
          <button data-status="tools" className="flex items-center gap-1 hover:text-fg" title="Tools: cookies, find & replace, reverse proxy, certificates">
            <Wrench size={12} /> Tools
          </button>
        }
      />
    </>
  );
}
