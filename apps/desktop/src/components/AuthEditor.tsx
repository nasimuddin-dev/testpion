import type { AuthConfig } from '../types';
import { Button, Field, Input, Select, Textarea } from './ui';
import { call } from '../api';
import { useApp } from '../store';
import { KeyValueEditor } from './KeyValueEditor';

const TYPES: Array<{ id: AuthConfig['type']; label: string }> = [
  { id: 'inherit', label: 'Inherit from collection' },
  { id: 'none', label: 'No auth' },
  { id: 'bearer', label: 'Bearer token' },
  { id: 'basic', label: 'Basic auth' },
  { id: 'apiKey', label: 'API key' },
  { id: 'oauth2', label: 'OAuth 2.0' },
  { id: 'oauth1', label: 'OAuth 1.0' },
  { id: 'awsv4', label: 'AWS Signature' },
  { id: 'digest', label: 'Digest auth' },
  { id: 'jwt', label: 'JWT (HMAC signed)' },
  { id: 'headers', label: 'Custom headers' },
];

function defaults(type: AuthConfig['type']): AuthConfig {
  switch (type) {
    case 'bearer':
      return { type, token: '{{accessToken}}' };
    case 'basic':
      return { type, username: '', password: '' };
    case 'apiKey':
      return { type, key: 'X-Api-Key', value: '{{apiKey}}', in: 'header' };
    case 'oauth2':
      return { type, grantType: 'client_credentials', tokenUrl: '', clientId: '{{clientId}}', clientSecret: '{{clientSecret}}', usePkce: true };
    case 'jwt':
      return { type, secret: '{{jwtSecret}}', algorithm: 'HS256', payload: '{\n  "sub": "user-123"\n}', expiresInSec: 3600 };
    case 'headers':
      return { type, headers: [] };
    case 'digest':
      return { type, username: '', password: '{{password}}' };
    case 'oauth1':
      return { type, consumerKey: '{{consumerKey}}', consumerSecret: '{{consumerSecret}}', token: '{{accessToken}}', tokenSecret: '{{tokenSecret}}', signatureMethod: 'HMAC-SHA1' };
    case 'awsv4':
      return { type, accessKey: '{{awsAccessKey}}', secretKey: '{{awsSecretKey}}', region: 'us-east-1', service: 'execute-api' };
    default:
      return { type } as AuthConfig;
  }
}

/** Auth configuration; values support {{variables}} so credentials can live in secret environment variables. */
export function AuthEditor({ auth, onChange, allowInherit = true }: { auth?: AuthConfig; onChange(a: AuthConfig): void; allowInherit?: boolean }) {
  const a = auth ?? { type: allowInherit ? 'inherit' : 'none' };
  const set = (patch: Record<string, unknown>) => onChange({ ...a, ...patch } as AuthConfig);
  return (
    <div className="p-3 flex flex-col gap-3 max-w-2xl">
      <Field label="Type">
        <Select value={a.type} onChange={(e) => onChange(defaults(e.target.value as AuthConfig['type']))}>
          {TYPES.filter((t) => allowInherit || t.id !== 'inherit').map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </Select>
      </Field>
      {a.type === 'inherit' && <p className="text-sm text-muted">Uses the auth configured on the parent folder or collection.</p>}
      {a.type === 'bearer' && (
        <>
          <Field label="Token" hint="Tip: reference a secret environment variable, e.g. {{accessToken}}">
            <Input className="mono" value={a.token} onChange={(e) => set({ token: e.target.value })} />
          </Field>
          <Field label="Prefix">
            <Input value={a.prefix ?? 'Bearer'} onChange={(e) => set({ prefix: e.target.value })} />
          </Field>
        </>
      )}
      {a.type === 'basic' && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Username">
            <Input value={a.username} onChange={(e) => set({ username: e.target.value })} />
          </Field>
          <Field label="Password">
            <Input type="password" value={a.password} onChange={(e) => set({ password: e.target.value })} />
          </Field>
        </div>
      )}
      {a.type === 'apiKey' && (
        <div className="grid grid-cols-3 gap-3">
          <Field label="Key">
            <Input value={a.key} onChange={(e) => set({ key: e.target.value })} />
          </Field>
          <Field label="Value">
            <Input className="mono" value={a.value} onChange={(e) => set({ value: e.target.value })} />
          </Field>
          <Field label="Add to">
            <Select value={a.in} onChange={(e) => set({ in: e.target.value })}>
              <option value="header">Header</option>
              <option value="query">Query params</option>
            </Select>
          </Field>
        </div>
      )}
      {a.type === 'jwt' && (
        <>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Secret">
              <Input type="password" value={a.secret} onChange={(e) => set({ secret: e.target.value })} />
            </Field>
            <Field label="Algorithm">
              <Select value={a.algorithm ?? 'HS256'} onChange={(e) => set({ algorithm: e.target.value })}>
                <option>HS256</option>
                <option>HS384</option>
                <option>HS512</option>
              </Select>
            </Field>
            <Field label="Expires in (s)">
              <Input type="number" value={a.expiresInSec ?? ''} onChange={(e) => set({ expiresInSec: e.target.value ? Number(e.target.value) : undefined })} />
            </Field>
          </div>
          <Field label="Payload (JSON)">
            <Textarea className="field mono min-h-24" value={a.payload} onChange={(e) => set({ payload: e.target.value })} />
          </Field>
        </>
      )}
      {a.type === 'oauth2' && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Grant type">
              <Select value={a.grantType} onChange={(e) => set({ grantType: e.target.value })}>
                <option value="client_credentials">Client credentials</option>
                <option value="password">Password</option>
                <option value="authorization_code">Authorization code (+PKCE)</option>
              </Select>
            </Field>
            <Field label="Token URL">
              <Input className="mono" value={a.tokenUrl} onChange={(e) => set({ tokenUrl: e.target.value })} />
            </Field>
            {a.grantType === 'authorization_code' && (
              <>
                <Field label="Authorization URL" hint="Opens your browser; the redirect is captured on 127.0.0.1.">
                  <Input className="mono" value={a.authUrl ?? ''} onChange={(e) => set({ authUrl: e.target.value })} />
                </Field>
                <Field label="Callback URL" hint="The redirect URL registered with the provider. Empty: any free port, /callback.">
                  <Input className="mono" placeholder="http://localhost:8080/callback" value={a.redirectUri ?? ''} onChange={(e) => set({ redirectUri: e.target.value || undefined })} />
                </Field>
              </>
            )}
            <Field label="Client ID">
              <Input className="mono" value={a.clientId} onChange={(e) => set({ clientId: e.target.value })} />
            </Field>
            <Field label="Client secret">
              <Input className="mono" type="password" value={a.clientSecret ?? ''} onChange={(e) => set({ clientSecret: e.target.value })} />
            </Field>
            <Field label="Scope">
              <Input value={a.scope ?? ''} onChange={(e) => set({ scope: e.target.value })} />
            </Field>
            <Field label="Audience">
              <Input value={a.audience ?? ''} onChange={(e) => set({ audience: e.target.value })} />
            </Field>
            <Field label="Client authentication">
              <Select value={a.clientAuth ?? 'body'} onChange={(e) => set({ clientAuth: e.target.value === 'header' ? 'header' : undefined })}>
                <option value="body">Send client credentials in the body</option>
                <option value="header">Send as Basic Auth header</option>
              </Select>
            </Field>
            {a.grantType === 'password' && (
              <>
                <Field label="Username">
                  <Input value={a.username ?? ''} onChange={(e) => set({ username: e.target.value })} />
                </Field>
                <Field label="Password">
                  <Input type="password" value={a.password ?? ''} onChange={(e) => set({ password: e.target.value })} />
                </Field>
              </>
            )}
          </div>
          {a.grantType === 'authorization_code' && (
            <label className="text-sm flex items-center gap-2">
              <input type="checkbox" checked={a.usePkce !== false} onChange={(e) => set({ usePkce: e.target.checked })} /> Use PKCE (S256)
            </label>
          )}
          <div className="flex items-center gap-3">
            <p className="text-xs text-muted flex-1">Tokens are cached in memory until they expire (then refreshed with the refresh token, when the provider gave one) and are redacted from history, traces and reports.</p>
            <Button
              size="sm"
              onClick={() =>
                void call<number>('auth.clearTokens').then((n) => useApp.getState().toast(n ? `Forgot ${n} cached token${n > 1 ? 's' : ''}: the next request gets a new one` : 'No cached tokens', 'info'))
              }
            >
              Forget tokens
            </Button>
          </div>
        </>
      )}
      {a.type === 'digest' && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Username">
              <Input value={a.username} onChange={(e) => set({ username: e.target.value })} />
            </Field>
            <Field label="Password">
              <Input type="password" value={a.password} onChange={(e) => set({ password: e.target.value })} />
            </Field>
          </div>
          <p className="text-xs text-muted">The first request receives the server's challenge (401); TestPion answers it and sends the request again. MD5, SHA-256 and their -sess variants.</p>
        </>
      )}
      {a.type === 'oauth1' && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Consumer key">
              <Input className="mono" value={a.consumerKey} onChange={(e) => set({ consumerKey: e.target.value })} />
            </Field>
            <Field label="Consumer secret">
              <Input className="mono" type="password" value={a.consumerSecret} onChange={(e) => set({ consumerSecret: e.target.value })} />
            </Field>
            <Field label="Access token">
              <Input className="mono" value={a.token ?? ''} onChange={(e) => set({ token: e.target.value || undefined })} />
            </Field>
            <Field label="Token secret">
              <Input className="mono" type="password" value={a.tokenSecret ?? ''} onChange={(e) => set({ tokenSecret: e.target.value || undefined })} />
            </Field>
            <Field label="Signature method">
              <Select value={a.signatureMethod ?? 'HMAC-SHA1'} onChange={(e) => set({ signatureMethod: e.target.value })}>
                <option>HMAC-SHA1</option>
                <option>HMAC-SHA256</option>
                <option>PLAINTEXT</option>
              </Select>
            </Field>
            <Field label="Add parameters to">
              <Select value={a.addTo ?? 'header'} onChange={(e) => set({ addTo: e.target.value })}>
                <option value="header">Authorization header</option>
                <option value="query">Query string</option>
              </Select>
            </Field>
            <Field label="Realm (optional)">
              <Input value={a.realm ?? ''} onChange={(e) => set({ realm: e.target.value || undefined })} />
            </Field>
          </div>
          <p className="text-xs text-muted">Each request is signed when it is sent (method, URL and form fields), with a new nonce and timestamp. Keep secrets in secret variables.</p>
        </>
      )}
      {a.type === 'awsv4' && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Access key">
              <Input className="mono" value={a.accessKey} onChange={(e) => set({ accessKey: e.target.value })} />
            </Field>
            <Field label="Secret key" hint="Reference a secret variable, e.g. {{awsSecretKey}}">
              <Input className="mono" type="password" value={a.secretKey} onChange={(e) => set({ secretKey: e.target.value })} />
            </Field>
            <Field label="AWS region">
              <Input className="mono" value={a.region} placeholder="us-east-1" onChange={(e) => set({ region: e.target.value })} />
            </Field>
            <Field label="Service name">
              <Input className="mono" value={a.service} placeholder="execute-api, s3, lambda …" onChange={(e) => set({ service: e.target.value })} />
            </Field>
          </div>
          <Field label="Session token" hint="Only for temporary credentials (STS, SSO).">
            <Input className="mono" type="password" value={a.sessionToken ?? ''} onChange={(e) => set({ sessionToken: e.target.value || undefined })} />
          </Field>
          <p className="text-xs text-muted">Signed when the request is sent (method, URL, headers and body), so it stays valid after scripts change the request.</p>
        </>
      )}
      {a.type === 'headers' && <KeyValueEditor rows={a.headers} onChange={(headers) => set({ headers })} keyPlaceholder="Header" />}
    </div>
  );
}
