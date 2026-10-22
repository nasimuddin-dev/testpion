/**
 * The web permissions the app's page may use. Electron grants every permission request of the page when no handler is set
 * (camera, microphone, location …); the page is the app's own and needs three: notifications (monitor and run alerts), pasting
 * into the terminal (clipboard read) and copying (sanitised clipboard write). Everything else is refused, and so is every
 * request from another page (the visualizer's isolated origin, an embedded frame).
 */
const ALLOWED = new Set(['notifications', 'clipboard-read', 'clipboard-sanitized-write']);

/** Whether the page at `url` (the requesting origin) may use `permission`; `devServer` is the Vite origin of a development run. */
export function permissionAllowed(permission: string, url: string | undefined, devServer?: string): boolean {
  if (!ALLOWED.has(permission) || !url) return false;
  if (url.startsWith('file://')) return true;
  return !!devServer && new URL(devServer).origin === safeOrigin(url);
}

function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
