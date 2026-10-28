import { useApp } from '../store';

/**
 * WF-12: the HTTP Debugger's capture mode for one API (Capture ▸ Capture traffic for one API…, the RecordDialog): one
 * concept, capture, whichever way the traffic comes in. Every way to open it (the Debugger's Capture menu, the status
 * bar's Tools, the palette, the Collections header) goes to the Debugger first.
 */
export function openReverseProxyCapture(): void {
  const s = useApp.getState();
  s.setView('debugger');
  s.set({ recordOpen: true });
}
