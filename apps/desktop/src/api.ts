/**
 * Renderer ↔ backend bridge. In Electron this is the preload IPC bridge; in browser development
 * mode it is an HTTP/SSE bridge proxied by Vite. The UI never executes network calls itself.
 */
export interface NormalizedError {
  kind: string;
  message: string;
  what: string;
  why: string;
  suggestions: string[];
  details?: Record<string, unknown>;
}

interface Bridge {
  kind: 'electron' | 'web';
  platform: string;
  invoke(method: string, params?: unknown): Promise<any>;
  on(channel: string, cb: (payload: any) => void): () => void;
  /** Electron on Windows / Linux: the app draws the title bar (window buttons over the top bar's right end). */
  titleBar?: boolean;
  /** Screenshot and e2e runs (electron/main.ts capture mode). */
  capture?: boolean;
  titleBarColors?(color: string, symbolColor: string, height?: number): void;
  /** Open the application menu (File, Edit, View …) at a point of the window. */
  appMenu?(x: number, y: number): void;
}

declare global {
  interface Window {
    aps?: Bridge;
  }
}

function webBridge(): Bridge {
  const cfg = String(import.meta.env.VITE_TESTPION_BRIDGE ?? '');
  const token = cfg.split('|')[1] ?? '';
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  let es: EventSource | undefined;
  const connect = () => {
    es = new EventSource(`/__aps/events?token=${token}`);
    es.onmessage = (m) => {
      const { channel, payload } = JSON.parse(m.data);
      for (const l of listeners.get(channel) ?? []) l(payload);
    };
  };
  return {
    kind: 'web',
    platform: navigator.platform.toLowerCase().includes('mac') ? 'darwin' : navigator.platform.toLowerCase().includes('win') ? 'win32' : 'linux',
    async invoke(method, params) {
      const res = await fetch(`/__aps/rpc?token=${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) });
      const r = await res.json();
      if (!r.ok) throw Object.assign(new Error(r.error?.message ?? 'Error'), r.error);
      return r.data;
    },
    on(channel, cb) {
      if (!es) connect();
      const set = listeners.get(channel) ?? listeners.set(channel, new Set()).get(channel)!;
      set.add(cb);
      return () => set.delete(cb);
    },
  };
}

const electronBridge = (aps: Bridge & { rpc?(method: string, params?: unknown): Promise<{ ok: boolean; data?: unknown; error?: NormalizedError }> }): Bridge =>
  aps.rpc
    ? {
        ...aps,
        async invoke(method, params) {
          const r = await aps.rpc!(method, params);
          // thrown here, on the page's side of the context bridge, the error keeps its kind, suggestions and details
          if (!r.ok) throw Object.assign(new Error(r.error?.message ?? 'Error'), r.error);
          return r.data;
        },
      }
    : aps;

export const bridge: Bridge = window.aps ? electronBridge(window.aps) : webBridge();

/** URL of an isolated tp.visualizer page (its own origin and security policy; see the backend). */
export function visualizationUrl(id: string): string {
  return bridge.kind === 'electron' ? `tpviz://${id}/` : `/__aps/viz/${id}`;
}

// browser development mode only: expose the bridge for debugging from the devtools console
if (bridge.kind === 'web' && import.meta.env.DEV) (window as unknown as { __aps: Bridge }).__aps = bridge;

/**
 * What a call the backend refused can do instead of failing: given the error, the method and the parameters, the
 * parameters to call again with (the production guard's confirmation adds allowProduction), or undefined to fail.
 * One for the whole window (lib/production-guard.ts registers it), so every view's sends and runs get the same answer.
 */
type Recovery = (e: unknown, method: string, params: unknown) => Promise<unknown | undefined> | undefined;
let recovery: Recovery | undefined;
export function setCallRecovery(fn: Recovery | undefined): void {
  recovery = fn;
}

/**
 * A whole-document save refused with a ConflictError (the file changed outside this window since it was read): the handler asks the
 * person and answers the parameters to save again with (Keep mine), a result to hand the caller instead (Take theirs, Open both), or
 * undefined to fail (Cancel). One for the whole window (lib/save-conflict.ts).
 */
type ConflictHandler = (info: { method: string; params: unknown; error: NormalizedError }) => Promise<{ params: unknown } | { result: unknown } | undefined>;
let conflictHandler: ConflictHandler | undefined;
export function setConflictHandler(fn: ConflictHandler | undefined): void {
  conflictHandler = fn;
}

export async function call<T = any>(method: string, params?: unknown): Promise<T> {
  try {
    return await bridge.invoke(method, params);
  } catch (e) {
    if ((e as { kind?: string })?.kind === 'ConflictError' && conflictHandler) {
      const answer = await conflictHandler({ method, params, error: asError(e) });
      if (!answer) throw e;
      return 'result' in answer ? (answer.result as T) : bridge.invoke(method, answer.params);
    }
    const again = recovery && (await recovery(e, method, params));
    if (again === undefined) throw e;
    return bridge.invoke(method, again);
  }
}

export function on<T = any>(channel: string, cb: (payload: T) => void): () => void {
  return bridge.on(channel, cb);
}

export function asError(e: unknown): NormalizedError {
  const x = e as Partial<NormalizedError> & { message?: string };
  return {
    kind: x?.kind ?? 'Error',
    message: x?.message ?? String(e),
    what: x?.what ?? x?.message ?? String(e),
    why: x?.why ?? '',
    suggestions: x?.suggestions ?? [],
    details: x?.details,
  };
}

export const isMac = bridge.platform === 'darwin';
export const modKey = isMac ? '⌘' : 'Ctrl';
