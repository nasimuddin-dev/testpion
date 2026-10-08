import { useCallback, useEffect, useState } from 'react';
import { call, on } from '../../api';
import { toastError } from '../../store';
import { loadRules, type HeldBreakpoint, type RulesState } from '../DebuggerRules';

export interface Status {
  running: boolean;
  url?: string;
  port?: number;
  exchanges: number;
  systemProxy: boolean;
  autosave: boolean;
  decrypt: boolean;
  noDecrypt: string[];
}

/**
 * The session's state that the backend drives: the proxy's status (read again after a burst of traffic), the rules
 * of the active profile and the exchanges held at a breakpoint (kept in step by the backend's events). The view adds
 * what it owns: the list, the selection, the dialogs.
 */
export function useDebuggerSession() {
  const [status, setStatus] = useState<Status>();
  const [rules, setRules] = useState<RulesState>();
  const [held, setHeld] = useState<HeldBreakpoint[]>([]);
  const [openBreakpoint, setOpenBreakpoint] = useState<HeldBreakpoint>();
  const loadStatus = useCallback(() => call<Status>('debug.status').then(setStatus, toastError), []);
  useEffect(() => {
    void loadStatus();
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = on('debug.exchange', () => {
      clearTimeout(t);
      t = setTimeout(() => void loadStatus(), 500);
    });
    return () => (off(), clearTimeout(t));
  }, [loadStatus]);
  // the rules (DBG-3): the active profile's count for the bar, and exchanges held at a breakpoint
  useEffect(() => {
    void loadRules().then((r) => r && setRules(r));
    void call<HeldBreakpoint[]>('debug.breakpoints').then(setHeld, () => undefined);
    const offRules = on('debug.rules', () => void loadRules().then((r) => r && setRules(r)));
    const offBp = on<{ id: string; released?: boolean; phase?: 'request' | 'response'; exchange?: HeldBreakpoint['exchange'] }>('debug.breakpoint', (b) => {
      if (b.released) {
        setHeld((h) => h.filter((x) => x.id !== b.id));
        setOpenBreakpoint((o) => (o?.id === b.id ? undefined : o));
      } else if (b.exchange) {
        const bp: HeldBreakpoint = { id: b.id, phase: b.phase ?? 'request', since: new Date().toISOString(), exchange: b.exchange };
        setHeld((h) => [...h, bp]);
        setOpenBreakpoint((o) => o ?? bp);
      }
    });
    return () => (offRules(), offBp());
  }, []);
  return { status, setStatus, rules, setRules, held, setHeld, openBreakpoint, setOpenBreakpoint, loadStatus };
}
