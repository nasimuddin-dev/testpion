/**
 * Guards for the servers TestPion runs on loopback (the recorder, the mock server, flow webhooks, the web bridge). A web page
 * the person visits can reach them: by naming a host that resolves to 127.0.0.1 (DNS rebinding: the browser then sends the
 * page's own Host header), or by a cross-site request with its Origin. Both are answered here.
 */

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const hostnameOf = (hostHeader: string): string => {
  const h = hostHeader.trim().toLowerCase();
  // [::1]:8080 | 127.0.0.1:8080 | localhost
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.replace(/:\d+$/, '');
};

/** Whether a Host header names this computer's loopback (localhost, 127.x, ::1): a rebinding page has its own name there. */
export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  const name = hostnameOf(host);
  return LOOPBACK_NAMES.has(name) || name.endsWith('.localhost') || /^127(\.\d{1,3}){3}$/.test(name);
}

/** Whether an Origin header is a page served from this computer (a front end in development on localhost). */
export function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    return isLoopbackHostHeader(new URL(origin).host);
  } catch {
    return false;
  }
}
