import { ChevronDown, CirclePause, OctagonPause, Play } from 'lucide-react';
import { call } from '../../api';
import { toastError, useApp } from '../../store';
import { Button, Menu, type MenuItem } from '../ui';
import type { Rule, RulesState } from '../DebuggerRules';

/** The managed rule's modes, as `debug.autoBreakpoint` takes them and the menu says them (the same words as core's AUTO_BREAKPOINT_LABEL). */
export type AutoBreakpoint = 'off' | 'request' | 'response' | 'post' | 'errors';
const MODES: Array<{ mode: Exclude<AutoBreakpoint, 'off'>; label: string; title: string }> = [
  { mode: 'request', label: 'Every request', title: 'Hold each request before it is sent, so it can be edited' },
  { mode: 'response', label: 'Every response', title: 'Hold each response before the program gets it' },
  { mode: 'post', label: 'Only POST', title: 'Hold the requests that use POST' },
  { mode: 'errors', label: 'Only errors', title: 'Hold the responses with a status of 400 or more' },
];
const LABEL_OF: Record<AutoBreakpoint, string> = { off: 'Off', request: 'Every request', response: 'Every response', post: 'Only POST', errors: 'Only errors' };

/** A new breakpoint rule for the rule editor ("Custom…"). */
export const customBreakpointRule = (): Partial<Rule> => ({ kind: 'breakpoint', name: 'Breakpoint', enabled: true, match: {}, breakpoint: 'request' });

/**
 * The filter strip's Breakpoints split button (FG-5): the button toggles Off and Every request, the arrow chooses what to
 * hold. It keeps one managed rule, "Auto breakpoint", in the active profile; it shows in the Rules panel like any other.
 */
export function BreakpointSplit({ rules, onRules, onCustom }: { rules?: RulesState; onRules(r: RulesState): void; onCustom(): void }) {
  const mode: AutoBreakpoint = rules?.autoBreakpoint ?? 'off';
  const set = (m: AutoBreakpoint) =>
    void call<RulesState>('debug.autoBreakpoint', { mode: m }).then((r) => {
      onRules(r);
      useApp.getState().toast(m === 'off' ? 'Breakpoints are off' : `Breakpoint on: ${LABEL_OF[m].toLowerCase()} are held until you resume them`);
    }, toastError);
  const items: MenuItem[] = [
    { label: `${mode === 'off' ? '✓ ' : '  '}Off`, title: 'Remove the auto breakpoint rule', onSelect: () => set('off') },
    ...MODES.map<MenuItem>((m) => ({ label: `${mode === m.mode ? '✓ ' : '  '}${m.label}`, title: m.title, onSelect: () => set(m.mode) })),
    { label: `${rules?.customBreakpoint ? '✓ ' : '  '}Custom…`, separator: true, title: 'Write your own breakpoint rule: by domain, URL, method or status', onSelect: onCustom },
  ];
  return (
    <span className="inline-flex" data-breakpoint-split>
      <Button
        size="sm"
        variant={mode === 'off' ? 'default' : 'soft'}
        className="rounded-r-none"
        icon={<OctagonPause size={12} />}
        title={mode === 'off' ? 'Hold every request so it can be edited (Off again with a second click)' : 'Turn the automatic breakpoint off'}
        onClick={() => set(mode === 'off' ? 'request' : 'off')}
        data-breakpoint-main
      >
        Breakpoints: {LABEL_OF[mode]}
      </Button>
      <Menu
        width={220}
        items={items}
        trigger={
          <Button size="sm" variant={mode === 'off' ? 'default' : 'soft'} className="rounded-l-none -ml-px px-1.5" aria-label="Choose what to hold" title="Choose what to hold" data-breakpoint-menu>
            <ChevronDown size={12} />
          </Button>
        }
      />
    </span>
  );
}

/** Pause or resume listing (FG-13): the proxy keeps forwarding either way. */
export function PauseButton({ paused, onChange }: { paused: boolean; onChange(paused: boolean): void }) {
  return (
    <Button
      icon={paused ? <Play size={13} /> : <CirclePause size={13} />}
      title={paused ? 'List new traffic again' : 'Stop listing new traffic. The proxy keeps forwarding it, so programs are not affected.'}
      onClick={() => void call('debug.pause', { on: !paused }).then(() => onChange(!paused), toastError)}
      data-pause-listing
    >
      {paused ? 'Resume' : 'Pause'}
    </Button>
  );
}
