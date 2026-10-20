import type { ReactNode } from 'react';
import type { HttpRequestSpec } from '../types';
import { Input, Select, Textarea, Toggle } from './ui';

/** One row of the request settings: name and explanation on the left, the control on the right (Postman's layout). */
export function SettingRow({ title, children, control, isDefault }: { title: string; children?: ReactNode; control: ReactNode; isDefault?: boolean }) {
  return (
    <div className="flex items-start gap-6 py-3 border-b border-line/60">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium flex items-center gap-2">
          {title}
          {isDefault === false && <span className="text-[0.7rem] px-1.5 rounded-full bg-accent-soft text-accent">changed</span>}
        </div>
        {children && <div className="text-xs text-muted mt-0.5 leading-snug">{children}</div>}
      </div>
      <div className="shrink-0 w-64 flex justify-end">{control}</div>
    </div>
  );
}

const TLS_VERSIONS = ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'] as const;

/**
 * Request settings, like Postman's Settings tab: HTTP version, TLS, redirects, URL encoding, cookies, retries, proxy, mTLS.
 * One component for a request, a folder and a collection: what a folder or collection sets is the default of the requests
 * inside (their own win), so the same rows, the same words.
 */
export function RequestSettings({ settings: st, onChange }: { settings: NonNullable<HttpRequestSpec['settings']>; onChange(s: NonNullable<HttpRequestSpec['settings']>): void }) {
  const set = (patch: Partial<typeof st>) => onChange({ ...st, ...patch });
  const num = (v: string) => (v === '' ? undefined : Number(v));
  const section = (label: string) => <div className="pt-5 pb-1 text-[11px] font-semibold tracking-wider uppercase text-muted">{label}</div>;
  const toggle = (checked: boolean, on: (v: boolean) => void) => <Toggle checked={checked} onChange={on} label={checked ? 'On' : 'Off'} />;
  return (
    <div className="h-full overflow-auto">
      <div className="px-4 pb-6 max-w-4xl">
        {section('Connection')}
        <SettingRow title="HTTP version" isDefault={!st.http1Only} control={
          <Select className="w-40" value={st.http1Only ? 'http1' : 'auto'} onChange={(e) => set({ http1Only: e.target.value === 'http1' || undefined })} aria-label="HTTP version">
            <option value="auto">Auto</option>
            <option value="http1">HTTP/1.1</option>
          </Select>
        }>
          Auto offers HTTP/2 over https and uses it when the server supports it; HTTP/1.1 never does.
        </SettingRow>
        <SettingRow title="Timeout (ms)" isDefault={st.timeoutMs === undefined} control={<Input className="w-40" type="number" min={0} value={st.timeoutMs ?? ''} placeholder="Default (Settings)" onChange={(e) => set({ timeoutMs: num(e.target.value) })} />}>
          How long to wait for the response before giving up.
        </SettingRow>
        <SettingRow title="Retries" isDefault={!st.retries} control={<Input className="w-40" type="number" min={0} max={5} value={st.retries ?? ''} placeholder="0" onChange={(e) => set({ retries: e.target.value ? Math.min(5, Math.max(0, Number(e.target.value))) : undefined })} />}>
          Try again on network errors, timeouts, 429 and 5xx (POST and PATCH only when the connection failed).
        </SettingRow>
        <SettingRow title="First retry after (ms)" isDefault={st.retryDelayMs === undefined} control={<Input className="w-40" type="number" min={0} value={st.retryDelayMs ?? ''} placeholder="500" onChange={(e) => set({ retryDelayMs: num(e.target.value) })} />}>
          Doubles each time, at most 10 s; a Retry-After header wins.
        </SettingRow>
        <SettingRow title="Proxy" isDefault={!st.proxy} control={<Input className="w-64 mono" value={st.proxy ?? ''} placeholder="Default (Settings)" onChange={(e) => set({ proxy: e.target.value || undefined })} />}>
          Send this request through a proxy, e.g. http://proxy:8080 (overrides the app's proxy settings).
        </SettingRow>

        {section('SSL / TLS')}
        <SettingRow title="Enable SSL certificate verification" isDefault={!st.insecure} control={toggle(!st.insecure, (v) => set({ insecure: v ? undefined : true }))}>
          Verify the server's certificate. Turning it off accepts any certificate: for development servers only.
        </SettingRow>
        <SettingRow title="TLS versions" isDefault={!st.tlsMinVersion && !st.tlsMaxVersion} control={
          <div className="flex items-center gap-1.5">
            <Select className="w-28" value={st.tlsMinVersion ?? ''} aria-label="Oldest TLS version" onChange={(e) => set({ tlsMinVersion: (e.target.value || undefined) as typeof st.tlsMinVersion })}>
              <option value="">Default</option>
              {TLS_VERSIONS.map((v) => <option key={v} value={v}>{v}</option>)}
            </Select>
            <span className="text-xs text-muted">to</span>
            <Select className="w-28" value={st.tlsMaxVersion ?? ''} aria-label="Newest TLS version" onChange={(e) => set({ tlsMaxVersion: (e.target.value || undefined) as typeof st.tlsMaxVersion })}>
              <option value="">Default</option>
              {TLS_VERSIONS.map((v) => <option key={v} value={v}>{v}</option>)}
            </Select>
          </div>
        }>
          Oldest and newest protocol versions allowed in the handshake; versions outside the range are disabled.
        </SettingRow>
        <SettingRow title="Cipher suites" isDefault={!st.ciphers?.trim()} control={
          <Textarea autoGrow={false} className="field w-64 h-20 mono text-xs" placeholder="Default (Node.js / OpenSSL)" value={st.ciphers ?? ''} onChange={(e) => set({ ciphers: e.target.value || undefined })} aria-label="Cipher suites" />
        }>
          OpenSSL cipher names in order of preference, separated by colons, e.g. <span className="mono">ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384</span>.
        </SettingRow>

        {section('Redirects')}
        <SettingRow title="Automatically follow redirects" isDefault={st.followRedirects !== false} control={toggle(st.followRedirects !== false, (v) => set({ followRedirects: v ? undefined : false }))}>
          Follow HTTP 3xx responses. Off shows the redirect response itself.
        </SettingRow>
        <SettingRow title="Maximum number of redirects" isDefault={st.maxRedirects === undefined} control={<Input className="w-40" type="number" min={0} value={st.maxRedirects ?? ''} placeholder="20" onChange={(e) => set({ maxRedirects: num(e.target.value) })} />} />
        <SettingRow title="Follow original HTTP method" isDefault={!st.followOriginalMethod} control={toggle(!!st.followOriginalMethod, (v) => set({ followOriginalMethod: v || undefined }))}>
          Redirect (301, 302) with the original method and body instead of switching to GET. A 303 always becomes GET.
        </SettingRow>
        <SettingRow title="Follow Authorization header" isDefault={!st.followAuthorizationHeader} control={toggle(!!st.followAuthorizationHeader, (v) => set({ followAuthorizationHeader: v || undefined }))}>
          Keep the Authorization header when a redirect goes to a different host. Off by default, so credentials don't leak to another server.
        </SettingRow>
        <SettingRow title="Remove referer header on redirect" isDefault={!st.removeRefererOnRedirect} control={toggle(!!st.removeRefererOnRedirect, (v) => set({ removeRefererOnRedirect: v || undefined }))}>
          Drop the Referer header from redirected requests.
        </SettingRow>

        {section('URL and cookies')}
        <SettingRow title="Encode URL automatically" isDefault={st.encodeUrl !== false} control={toggle(st.encodeUrl !== false, (v) => set({ encodeUrl: v ? undefined : false }))}>
          Percent-encode query parameters and path variables. Off sends them as typed (characters that can't be sent at all, like spaces, are still encoded).
        </SettingRow>
        <SettingRow title="Disable cookie jar" isDefault={!st.disableCookieJar} control={toggle(!!st.disableCookieJar, (v) => set({ disableCookieJar: v || undefined }))}>
          Don't send cookies from the cookie jar and don't store the cookies this request receives. Cookies on the Cookies tab are still sent.
        </SettingRow>

        {section('Client certificate (mTLS)')}
        <SettingRow title="Certificate (PEM)" isDefault={!st.clientCert?.certPath} control={<Input className="w-64 mono" value={st.clientCert?.certPath ?? ''} placeholder="path/to/client.crt" onChange={(e) => set({ clientCert: e.target.value || st.clientCert?.keyPath ? { certPath: e.target.value, keyPath: st.clientCert?.keyPath ?? '', caPath: st.clientCert?.caPath } : undefined })} />} />
        <SettingRow title="Key (PEM)" isDefault={!st.clientCert?.keyPath} control={<Input className="w-64 mono" value={st.clientCert?.keyPath ?? ''} placeholder="path/to/client.key" onChange={(e) => set({ clientCert: { certPath: st.clientCert?.certPath ?? '', keyPath: e.target.value, caPath: st.clientCert?.caPath } })} />} />
        <SettingRow title="CA certificate (optional)" isDefault={!st.clientCert?.caPath} control={<Input className="w-64 mono" value={st.clientCert?.caPath ?? ''} placeholder="path/to/ca.crt" onChange={(e) => set({ clientCert: { certPath: st.clientCert?.certPath ?? '', keyPath: st.clientCert?.keyPath ?? '', caPath: e.target.value || undefined } })} />} />
        <p className="text-xs text-muted pt-4">
          Responses are always parsed strictly (invalid HTTP headers are rejected). Settings are saved with the request, so collection runs, monitors and <span className="mono">testpion run-collection</span> use them too.
        </p>
      </div>
    </div>
  );
}
