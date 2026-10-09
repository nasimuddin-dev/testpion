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

export function call<T = any>(method: string, params?: unknown): Promise<T> {
  return bridge.invoke(method, params);
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
