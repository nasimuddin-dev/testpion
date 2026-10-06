import { KeyRound } from 'lucide-react';
import { describeExpiry, type DecodedJwt } from '@testpion/shared';
import { JsonTree } from './JsonView';
import { Badge } from './ui';

const CLAIM_TIMES = ['iat', 'nbf', 'exp'] as const;

/** The JWTs found in a response: header and claims decoded (not verified), with when each expires. */
export function JwtView({ tokens }: { tokens: DecodedJwt[] }) {
  return (
    <div className="h-full overflow-auto p-3 flex flex-col gap-3">
      <p className="text-xs text-muted">Decoded locally, not verified: the signature is not checked (no keys are involved). Add a <b>JWT</b> check to a request's tests to assert claims and expiry.</p>
      {tokens.map((t, i) => {
        const left = t.expiresInSec;
        return (
          <section key={i} className="rounded-lg border border-line">
            <header className="flex items-center gap-2 px-3 py-2 border-b border-line text-sm">
              <KeyRound size={14} className="text-muted" />
              <span className="font-medium">Token {tokens.length > 1 ? i + 1 : ''}</span>
              <Badge>{String(t.header.alg ?? '?')}</Badge>
              {left !== undefined ? <Badge tone={left <= 0 ? 'bad' : left < 300 ? 'warn' : 'ok'}>{describeExpiry(left)}</Badge> : <Badge>no expiry</Badge>}
              {typeof t.payload.sub === 'string' && <span className="text-xs text-muted truncate">sub {t.payload.sub}</span>}
            </header>
            <div className="grid gap-2 p-3 text-xs" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,2fr)' }}>
              <div className="min-w-0">
                <div className="text-muted font-semibold mb-1">Header</div>
                <JsonTree data={t.header} />
              </div>
              <div className="min-w-0">
                <div className="text-muted font-semibold mb-1">Claims</div>
                <JsonTree data={t.payload} />
                <div className="mt-2 flex flex-col gap-0.5 text-muted">
                  {CLAIM_TIMES.filter((k) => typeof t.payload[k] === 'number').map((k) => (
                    <span key={k}>
                      <span className="mono">{k}</span> {new Date((t.payload[k] as number) * 1000).toLocaleString()}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}
