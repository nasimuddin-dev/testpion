import { contextBridge, ipcRenderer } from 'electron';

type Listener = (payload: unknown) => void;

// main.ts passes whether it draws the title bar as an argument (a synchronous call would wait for the main process,
// which is busy constructing the backend while the page loads)
const titleBarArg = process.argv?.find((a) => a.startsWith('--tp-titlebar='));
const listeners = new Map<string, Set<Listener>>();

ipcRenderer.on('aps:event', (_e, channel: string, payload: unknown) => {
  for (const l of listeners.get(channel) ?? []) l(payload);
});

/** The only API exposed to the renderer: a narrow RPC + event bridge (no Node access). */
contextBridge.exposeInMainWorld('aps', {
  kind: 'electron',
  platform: process.platform,
  invoke: async (method: string, params?: unknown) => {
    const r = await ipcRenderer.invoke('aps:rpc', method, params);
    if (!r.ok) throw Object.assign(new Error(r.error?.message ?? 'Error'), r.error);
    return r.data;
  },
  // the envelope itself: an error thrown across the context bridge keeps only its message, so the page throws
  // (with the kind, suggestions and details) on its side
  rpc: (method: string, params?: unknown) => ipcRenderer.invoke('aps:rpc', method, params),
  on: (channel: string, cb: Listener) => {
    const set = listeners.get(channel) ?? listeners.set(channel, new Set()).get(channel)!;
    set.add(cb);
    return () => set.delete(cb);
  },
  startup: () => ipcRenderer.invoke('aps:startup'),
  /** The app draws the title bar (Windows, Linux): the top bar leaves room for the window buttons and has a ☰ menu. */
  titleBar: titleBarArg ? titleBarArg.endsWith('=1') : ipcRenderer.sendSync('aps:titlebar') === true,
  titleBarColors: (color: string, symbolColor: string, height?: number) => ipcRenderer.send('aps:titlebar-colors', { color, symbolColor, height }),
  appMenu: (x: number, y: number) => ipcRenderer.send('aps:app-menu', { x, y }),
});
