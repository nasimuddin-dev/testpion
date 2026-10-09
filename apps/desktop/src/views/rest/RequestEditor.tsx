/** The request editor: params, auth, headers, body, cookies, scripts, tests, examples, docs and settings. */
import { editorLanguageOfText } from '../../data-languages';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useApp } from '../../store';
import type { BodyConfig, HttpRequestSpec, KeyValue, SavedExample } from '../../types';
import { ExamplesPanel } from '../../components/ExamplesPanel';
import { Markdown } from '../../components/Markdown';
import { ScriptsPanel } from '../../components/ScriptsPanel';

import { AssertionEditor } from '../../components/AssertionEditor';
import { AuthEditor } from '../../components/AuthEditor';
import { CodeEditor } from '../../components/CodeEditor';
import { call } from '../../api';
import { COMMON_HEADERS, HEADER_VALUES, KeyValueEditor } from '../../components/KeyValueEditor';
import { LinkButton, Field, Input, Select, Tabs, Toggle, Textarea } from '../../components/ui';
import { RestTab } from './types';
import { switchBodyType, type BodyStash } from '../../lib/body';

export function RequestEditor({
  tab,
  update,
  setReq,
  setParams,
  setExamples,
}: {
  tab: RestTab;
  update(p: Partial<RestTab>): void;
  setReq(p: Partial<HttpRequestSpec>): void;
  setParams(p: KeyValue[]): void;
  setExamples(e: SavedExample[]): void;
}) {
  const [sub, setSub] = useState<'params' | 'auth' | 'headers' | 'body' | 'cookies' | 'scripts' | 'tests' | 'examples' | 'docs' | 'settings'>('params');
  const r = tab.request;
  const count = (a?: Array<{ enabled?: boolean }>) => a?.filter((x) => x.enabled !== false).length || undefined;
  return (
    <div className="h-full flex flex-col min-h-0">
      <Tabs
        value={sub}
        onChange={setSub}
        tabs={[
          { id: 'params', label: 'Params', badge: count(r.params) },
          { id: 'auth', label: 'Authorization' },
          { id: 'headers', label: 'Headers', badge: count(r.headers) },
          { id: 'body', label: 'Body', badge: r.body && r.body.type !== 'none' ? r.body.type : undefined },
          { id: 'cookies', label: 'Cookies', badge: count(r.cookies) },
          { id: 'scripts', label: 'Scripts', badge: (tab.preRequestScript ? 1 : 0) + (tab.testScript ? 1 : 0) || undefined },
          { id: 'tests', label: 'Tests', badge: tab.assertions.length || undefined },
          { id: 'examples', label: 'Examples', badge: tab.examples?.length || undefined },
          { id: 'docs', label: 'Docs', badge: tab.description?.trim() ? '•' : undefined },
          { id: 'settings', label: 'Settings' },
        ]}
      />
      <div className="flex-1 min-h-0 overflow-auto">
        {sub === 'params' && (
          <div className="p-2">
            <div className="text-xs font-semibold text-muted px-1 pb-1">Query Params</div>
            <KeyValueEditor rows={r.params ?? []} onChange={setParams} keyPlaceholder="Key" bulkEdit />
            {!!r.pathVariables?.length && (
              <>
                <div className="text-xs font-semibold text-muted px-1 pt-4 pb-1">Path Variables</div>
                <KeyValueEditor rows={r.pathVariables} onChange={(pathVariables) => setReq({ pathVariables: pathVariables.filter((v) => r.pathVariables!.some((x) => x.key === v.key)) })} keyPlaceholder="Key" fixedKeys />
              </>
            )}
            <p className="text-xs text-muted px-2 pt-3">
              The query string in the URL bar and this table stay in sync. Use <span className="mono">/:name</span> in the path for path variables. Values may use {'{{variables}}'}.
            </p>
          </div>
        )}
        {sub === 'auth' && <AuthEditor auth={r.auth} onChange={(auth) => setReq({ auth })} />}
        {sub === 'headers' && (
          <div className="p-2">
            <KeyValueEditor rows={r.headers ?? []} onChange={(headers) => setReq({ headers })} keyPlaceholder="Header" suggestions={COMMON_HEADERS} valueSuggestions={HEADER_VALUES} />
          </div>
        )}
        {sub === 'body' && <BodyEditor stashKey={tab.id} body={r.body ?? { type: 'none' }} onChange={(body) => setReq({ body })} method={r.method} url={r.url} />}
        {sub === 'cookies' && (
          <div className="p-2">
            <KeyValueEditor rows={r.cookies ?? []} onChange={(cookies) => setReq({ cookies })} keyPlaceholder="Cookie" />
            <p className="text-xs text-muted px-1 pt-2">
              Matching cookies from the workspace cookie jar are added automatically; cookies here win when the name is the same. Use the cookie button next to Send to see or edit the jar.
            </p>
          </div>
        )}
        {sub === 'scripts' && <ScriptsPanel pre={tab.preRequestScript ?? ''} post={tab.testScript ?? ''} onPre={(v) => update({ preRequestScript: v })} onPost={(v) => update({ testScript: v })} />}
        {sub === 'docs' && <DocsEditor value={tab.description ?? ''} onChange={(description) => update({ description })} />}
        {sub === 'examples' && <ExamplesPanel key={tab.id} collectionId={tab.collectionId} requestId={tab.requestId} examples={tab.examples ?? []} onChange={setExamples} />}
        {sub === 'tests' && <AssertionEditor checks={tab.assertions} onChange={(assertions) => update({ assertions })} groups={['Response', 'Body']} />}
        {sub === 'settings' && <RequestSettings settings={r.settings ?? {}} onChange={(settings) => setReq({ settings })} />}
      </div>
    </div>
  );
}

/** Pretty-print JSON (keeping {{variables}} intact) or indent XML. */
export function beautify(text: string, type: string): string {
  if (type === 'json') {
    // protect unquoted {{vars}} so the JSON parses, then restore them
    const vars: string[] = [];
    const safe = text.replace(/\{\{[^{}]+\}\}/g, (m) => `"__VAR${vars.push(m) - 1}__"`);
    try {
      return JSON.stringify(JSON.parse(safe), null, 2).replace(/"__VAR(\d+)__"/g, (_, i) => vars[Number(i)]!);
    } catch {
      useApp.getState().toast('The body is not valid JSON', 'error');
      return text;
    }
  }
  let depth = 0;
  return text
    .replace(/>\s*</g, '>\n<')
    .split('\n')
    .map((line) => {
      const l = line.trim();
      if (/^<\//.test(l)) depth = Math.max(0, depth - 1);
      const out = '  '.repeat(depth) + l;
      if (/^<[^!?/][^>]*[^/]>$/.test(l) && !/<\/[^>]+>$/.test(l)) depth++;
      return out;
    })
    .join('\n');
}

/**
 * What each body type held, per request tab, so switching type and back (JSON → None → JSON, or to a form
 * and back) restores it, as in Postman. Kept for the session; only the selected type is saved.
 */
const bodyStash = new Map<string, BodyStash>();
function BodyEditor({ body, onChange, stashKey = 'default', method, url }: { body: BodyConfig; onChange(b: BodyConfig): void; stashKey?: string; method?: string; url?: string }) {
  // the schema of the body from the API definition the request belongs to (specs/): completion and checks in the editor
  const environment = useApp((s) => s.environment);
  const [spec, setSpec] = useState<{ schema: unknown; spec: string; path: string; summary?: string } | null>(null);
  useEffect(() => {
    if (body.type !== 'json' || !url || !method) return setSpec(null);
    let live = true;
    const t = setTimeout(() => {
      void call<{ schema: unknown; spec: string; path: string; summary?: string } | null>('openapi.bodySchema', { method, url, environment })
        .then((r) => live && setSpec(r))
        .catch(() => live && setSpec(null));
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [body.type, method, url, environment]);
  // a body typed as text that is really JSON or XML: offer the right editor (completion, checks, beautify)
  const looksLike = useMemo((): 'json' | 'xml' | 'html' | undefined => {
    if (body.type !== 'text' || !('content' in body) || !body.content.trim()) return undefined;
    const t = body.content.trim();
    if (/^[{[]/.test(t)) {
      try {
        JSON.parse(t);
        return 'json';
      } catch {
        return undefined;
      }
    }
    if (/^<\?xml|^<[a-zA-Z][\w:-]*[\s>]/.test(t)) return /<html|<!doctype html/i.test(t) ? 'html' : 'xml';
    return undefined;
  }, [body]);
  const types: Array<[BodyConfig['type'], string]> = [
    ['none', 'None'],
    ['json', 'JSON'],
    ['xml', 'XML'],
    ['text', 'Text'],
    ['html', 'HTML'],
    ['form-urlencoded', 'Form URL-encoded'],
    ['multipart', 'Multipart form'],
    ['binary', 'Binary file'],
  ];
  const setType = (t: BodyConfig['type']) => {
    if (t === body.type) return;
    let stash = bodyStash.get(stashKey);
    if (!stash) bodyStash.set(stashKey, (stash = { byType: {} }));
    onChange(switchBodyType(body, t, stash));
  };
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex gap-3 px-3 py-1.5 text-sm flex-wrap items-center border-b border-line">
        {(body.type === 'json' || body.type === 'xml') && (
          <LinkButton className="order-last ml-auto text-xs" onClick={() => onChange({ ...body, content: beautify(body.content, body.type) })}>
            Beautify
          </LinkButton>
        )}
        {types.map(([t, label]) => (
          <label key={t} className="flex items-center gap-1 cursor-pointer">
            <input type="radio" name="body-type" checked={body.type === t} onChange={() => setType(t)} />
            {label}
          </label>
        ))}
      </div>
      <div className="flex-1 min-h-0">
        {body.type === 'none' && <div className="p-4 text-sm text-muted">This request has no body.</div>}
        {looksLike && (
          <div className="px-3 py-1 text-xs text-muted border-b border-line flex items-center gap-2">
            This looks like {looksLike.toUpperCase()}.
            <LinkButton  onClick={() => setType(looksLike)}>
              Edit it as {looksLike.toUpperCase()}
            </LinkButton>
          </div>
        )}
        {'content' in body && (
          <div className="h-full flex flex-col min-h-0">
            {spec && body.type === 'json' && (
              <div className="px-3 py-1 text-xs text-muted border-b border-line truncate" title={`The editor completes and checks the body against this operation's schema (${spec.spec})`}>
                Schema from <b>{spec.spec}</b> · {spec.path}
                {spec.summary ? ` · ${spec.summary}` : ''}
              </div>
            )}
            <div className="flex-1 min-h-0">
              <CodeEditor
                language={body.type === 'json' ? 'json' : body.type === 'xml' ? 'xml' : body.type === 'html' ? 'html' : editorLanguageOfText(body.content)}
                value={body.content}
                onChange={(content) => onChange({ ...body, content })}
                path={body.type === 'json' ? `body/${stashKey}.json` : undefined}
                jsonSchema={body.type === 'json' && spec ? spec.schema : undefined}
              />
            </div>
          </div>
        )}
        {(body.type === 'form-urlencoded' || body.type === 'multipart') && (
          <div className="p-2 overflow-auto h-full">
            <KeyValueEditor rows={body.fields} onChange={(fields) => onChange({ ...body, fields })} keyPlaceholder="Field" allowFile={body.type === 'multipart'} />
          </div>
        )}
        {body.type === 'binary' && (
          <div className="p-4 flex flex-col gap-3 max-w-xl">
            <Field label="File path" hint="The file is streamed from disk when the request is sent.">
              <Input className="mono" value={body.filePath} onChange={(e) => onChange({ ...body, filePath: e.target.value })} />
            </Field>
            <Field label="Content-Type">
              <Input value={body.contentType ?? ''} placeholder="application/octet-stream" onChange={(e) => onChange({ ...body, contentType: e.target.value || undefined })} />
            </Field>
          </div>
        )}
      </div>
    </div>
  );
}

/** Request documentation: Markdown source and a live preview side by side. */
function DocsEditor({ value, onChange }: { value: string; onChange(v: string): void }) {
  return (
    <div className="h-full grid grid-cols-2 gap-3 p-2 min-h-0">
      <Textarea autoGrow={false}
        className="field h-full resize-none mono text-sm"
        placeholder={'Document this request in Markdown: what it does, required parameters, error cases…'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Request documentation (Markdown)"
      />
      <div className="overflow-auto border border-line rounded-md p-3">
        {value.trim() ? <Markdown source={value} /> : <p className="text-sm text-muted">The preview appears here. The collection’s Docs tab shows the documentation of every request.</p>}
      </div>
    </div>
  );
}

/** One row of the request settings: name and explanation on the left, the control on the right (Postman's layout). */
function SettingRow({ title, children, control, isDefault }: { title: string; children?: ReactNode; control: ReactNode; isDefault?: boolean }) {
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

/** Per-request settings, like Postman's Settings tab: HTTP version, TLS, redirects, URL encoding, cookies, retries, proxy, mTLS. */
function RequestSettings({ settings: st, onChange }: { settings: NonNullable<HttpRequestSpec['settings']>; onChange(s: NonNullable<HttpRequestSpec['settings']>): void }) {
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
