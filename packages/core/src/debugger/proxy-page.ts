import { Agent as HttpAgent } from 'node:http';
import { guardedLookup } from './upstream-guard.js';

/** Text inside an HTML element or a double-quoted attribute. */
export const escapeHtml = (v: string): string => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The headers of the proxy's own page: nothing but its inline style runs or loads, and it cannot be framed or sniffed. */
export const PROXY_PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
} as const;

/**
 * The page a browser gets when it opens the proxy itself: how to use it, and the root certificate to download. `hostHeader`
 * is whatever the client sent as Host (it is the client's text, so it is escaped here), `hasRoot` whether HTTPS is decrypted.
 */
export function proxyPageHtml(hostHeader: string, hasRoot: boolean): string {
  const here = hostHeader.replace(/^http:\/\//, '');
  const host = escapeHtml(here.replace(/:\d+$/, ''));
  const port = escapeHtml(here.split(':').pop() ?? '');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TestPion HTTP Debugger</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#1b1f2a}code{background:#eef1f6;padding:0 .3em;border-radius:4px}a.b{display:inline-block;margin:.5rem 0;padding:.6rem 1rem;background:#4f6bff;color:#fff;border-radius:8px;text-decoration:none}</style>
<h1>TestPion HTTP Debugger</h1>
<p>This device can send its traffic through TestPion: set its Wi-Fi proxy to <b>manual</b>, server <code>${host}</code>, port <code>${port}</code>.</p>
${hasRoot ? `<p>To see HTTPS too, install and trust TestPion's root certificate on this device:</p><p><a class="b" href="/testpion-root.crt">Download the root certificate</a></p><p>Android: Settings ▸ Security ▸ Encryption & credentials ▸ Install a certificate ▸ CA certificate. iOS: open the downloaded profile in Settings ▸ General ▸ VPN & Device Management, then Settings ▸ General ▸ About ▸ Certificate Trust Settings ▸ turn it on. Remove it when you are done.</p>` : '<p>HTTPS decryption is off in TestPion, so HTTPS shows as tunnels by host.</p>'}`;
}

/**
 * The keep-alive pool for plain-HTTP upstream requests made for devices on the network: its own agent, whose connections resolve
 * through guardedLookup. This computer's own clients use Node's global agent; a socket pooled for one class is never reused for
 * the other, so a device on the network cannot ride a connection that was opened without the check.
 */
export const remoteHttpAgent = () => new HttpAgent({ keepAlive: true, lookup: guardedLookup });
