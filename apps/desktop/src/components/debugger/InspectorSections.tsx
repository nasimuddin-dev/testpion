import type { ReactNode } from 'react';
import { cacheDuration, cachingOf, tlsFindings, type CacheVerdict } from '@testpion/shared';
import { Badge } from '../ui';
import type { Exchange } from './model';

/** The Summary tab's TLS and Caching sections (FG-10): rows for its property table, in plain words. Empty when there is nothing to say. */
type Row = [string, ReactNode];

const day = (iso?: string) => (iso ? iso.slice(0, 10) : undefined);

/** The TLS connection to the server: what was agreed, the certificate, and what looks wrong with either. */
export function tlsRows(e: Exchange): Row[] {
  const c = e.connection;
  if (!c) return [];
  const leaf = c.chain?.[0];
  const findings = tlsFindings(c, e.host.replace(/:\d+$/, ''));
  return [
    ['TLS version', c.version],
    ['Cipher', c.cipher],
    ['Negotiated protocol', c.alpn],
    ['Certificate trusted', c.authorized === undefined ? undefined : c.authorized ? 'yes' : `no${c.authError ? `: ${c.authError}` : ''}`],
    ['Certificate subject', leaf?.subject],
    ['Issued by', leaf?.issuer],
    ['Valid', leaf?.validFrom || leaf?.validTo ? `${day(leaf.validFrom) ?? '?'} to ${day(leaf.validTo) ?? '?'}` : undefined],
    ['Names', leaf?.san?.length ? leaf.san.join(', ') : undefined],
    ['Chain', c.chain && c.chain.length > 1 ? c.chain.map((x) => /CN=([^,]+)/.exec(x.subject)?.[1] ?? x.subject).join(' > ') : undefined],
    ['Fingerprint (SHA-256)', leaf?.fingerprint256],
    ...findings.map((f): Row => ['Finding', <span key={f.text} className={f.level === 'bad' ? 'text-bad' : f.level === 'warn' ? 'text-warn' : 'text-ok'} data-tls-finding={f.level}>{f.text}</span>]),
  ];
}

const VERDICT: Record<CacheVerdict, { label: string; tone: 'ok' | 'warn' | 'bad' | 'default' }> = {
  'fresh-cacheable': { label: 'A browser keeps it', tone: 'ok' },
  revalidate: { label: 'A browser asks again each time', tone: 'warn' },
  'not-cacheable': { label: 'Not cached', tone: 'bad' },
  unknown: { label: 'No verdict', tone: 'default' },
};

/** Would a browser cache this response, for how long, and how is it checked again. */
export function cachingRows(e: Exchange): Row[] {
  if (e.kind !== 'http' || !e.responseHeaders || e.status === undefined) return [];
  const r = cachingOf({ method: e.method, status: e.status, requestHeaders: e.requestHeaders, responseHeaders: e.responseHeaders });
  const v = VERDICT[r.verdict];
  return [
    ['Verdict', <Badge key="v" tone={v.tone}>{v.label}</Badge>],
    ['In words', r.summary],
    ['Fresh for', r.freshSeconds !== undefined ? `${cacheDuration(r.freshSeconds)}${r.heuristic ? ' (guessed)' : ''}` : undefined],
    ['Age', r.ageSeconds !== undefined ? cacheDuration(r.ageSeconds) : undefined],
    ['Cache-Control', r.directives.length ? r.directives.join(', ') : undefined],
    ...r.validators.map((x): Row => [x.header, x.value]),
    ...r.notes.map((n, i): Row => [i === 0 ? 'Also' : `Also ${i + 1}`, n]),
  ];
}
