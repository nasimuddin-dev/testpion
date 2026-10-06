import { Copy, Download, RefreshCw, ShieldCheck, ShieldOff } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { asError, call } from '../api';
import { confirmAction, useApp } from '../store';
import { Badge, Button, Empty, Field, Modal, Select } from './ui';
import { finishSave, type SaveResult } from '../lib/files';
import { tryDecodeJwt } from '@testpion/shared';

/**
 * The HTTP Debugger's tools (planning/http-debugger.md, DBG-4): the root certificate that decrypts HTTPS, the decode
 * panel (URL, Base64, hex, JWT, timestamps), the frames of a WebSocket and the events of a stream.
 */

const fail = (e: unknown) => useApp.getState().toast(asError(e).message, 'error');
const toast = (m: string) => useApp.getState().toast(m, 'success');
const copy = (text: string, what: string) => void navigator.clipboard.writeText(text).then(() => toast(`Copied ${what}`));

interface CertInfo {
  path: string;
  fingerprint: string;
  notAfter: string;
  trusted?: boolean;
  instructions: string[];
  note?: string;
  platform: string;
}

/** The root certificate: what it is, whether this computer trusts it, install / remove / export / regenerate. */
export function CertificateDialog({ onClose }: { onClose(): void }) {
  const [info, setInfo] = useState<CertInfo>();
  const [busy, setBusy] = useState(false);
  const act = async (action?: 'install' | 'remove' | 'regenerate') => {
    setBusy(true);
    try {
      const r = await call<CertInfo>('debug.certificate', { action });
      setInfo(r);
      if (r.note) toast(r.note);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void act();
  }, []);
  return (
    <Modal title="HTTPS decryption: the root certificate" onClose={onClose} width={680}>
      {!info ? (
        <Empty title="Reading the certificate…" />
      ) : (
        <div className="grid gap-3 text-sm">
          <p>
            To show what a program sends over HTTPS, TestPion answers it with a certificate for each host, signed by <b>TestPion HTTP Debugger Root</b>. A program accepts that only when this root is
            in the certificate store it trusts. The root was created on this computer and never leaves it; remove it when you no longer debug HTTPS.
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-muted">On this computer</span>
            {info.trusted === true ? <Badge tone="ok">trusted</Badge> : info.trusted === false ? <Badge tone="warn">not trusted yet</Badge> : <Badge>unknown here</Badge>}
            <span className="text-muted">valid until {new Date(info.notAfter).toLocaleDateString()}</span>
          </div>
          <div className="text-xs">
            <div className="text-muted">SHA-256 fingerprint</div>
            <div className="mono break-all">{info.fingerprint}</div>
            <div className="text-muted mt-1">File</div>
            <div className="mono break-all">{info.path}</div>
          </div>
          <div className="flex gap-2 flex-wrap">
            {info.trusted !== true && (
              <Button variant="primary" icon={<ShieldCheck size={13} />} loading={busy} onClick={() => void act('install')} title="Into the current user's trust store (no administrator rights)">
                Trust on this computer
              </Button>
            )}
            {info.trusted !== false && (
              <Button icon={<ShieldOff size={13} />} loading={busy} onClick={() => void act('remove')}>
                Remove from the trust store
              </Button>
            )}
            <Button
              icon={<Download size={13} />}
              onClick={() => void call<SaveResult>('debug.certificate', { action: 'export' }).then((r) => finishSave(r, 'certificate'), fail)}
              title="For a phone, another computer or Firefox"
            >
              Export…
            </Button>
            <Button
              icon={<RefreshCw size={13} />}
              onClick={async () =>
                (await confirmAction({
                  title: 'Make a new root certificate',
                  message: 'The old one stops working everywhere it was trusted; remove it from those stores.',
                  confirmLabel: 'Make a new one',
                  danger: true,
                })) && void act('regenerate')
              }
            >
              New certificate
            </Button>
          </div>
          <div>
            <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-1">By hand</div>
            <ul className="grid gap-1 text-xs">
              {info.instructions.map((line) => (
                <li key={line} className="flex gap-2 items-start">
                  <span className="mono break-all flex-1">{line}</span>
                  <Button size="sm" variant="ghost" icon={<Copy size={12} />} onClick={() => copy(line, 'the line')} title="Copy" />
                </li>
              ))}
            </ul>
          </div>
          <p className="text-xs text-muted">
            Node.js programs read <span className="mono">NODE_EXTRA_CA_CERTS=&lt;the file&gt;</span>; Python <span className="mono">REQUESTS_CA_BUNDLE</span>; curl{' '}
            <span className="mono">--cacert</span>. Programs that pin their certificates cannot be decrypted: keep their hosts opaque.
          </p>
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ decode */

const tryOr = (f: () => string) => {
  try {
    return f();
  } catch {
    return undefined;
  }
};
const b64decode = (s: string) => {
  const t = s.trim().replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(t) || t.length < 4) throw new Error('not base64');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};
const b64encode = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const hexOf = (s: string) => [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
const fromHex = (s: string) => {
  const t = s.replace(/^0x/i, '').replace(/[\s:,-]/g, '');
  if (!/^([0-9a-f]{2})+$/i.test(t)) throw new Error('not hex');
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(t.match(/../g)!.map((h) => parseInt(h, 16))));
};
const timeOf = (s: string) => {
  const n = Number(s.trim());
  if (!Number.isFinite(n) || n <= 0) throw new Error('not a number');
  const ms = n > 1e14 ? n / 1000 : n > 1e11 ? n : n * 1000;
  const d = new Date(ms);
  if (d.getFullYear() < 1990 || d.getFullYear() > 2200) throw new Error('out of range');
  return `${d.toISOString()} (${d.toLocaleString()})`;
};

/** The Decode panel: one input, every reading of it that makes sense. */
export function DecodeDialog({ initial = '', onClose }: { initial?: string; onClose(): void }) {
  const [text, setText] = useState(initial);
  const rows = useMemo(() => {
    if (!text) return [];
    const jwt = tryDecodeJwt(text.trim().replace(/^Bearer\s+/i, ''));
    const out: Array<[string, string | undefined]> = [
      ['URL decoded', tryOr(() => decodeURIComponent(text.replace(/\+/g, ' ')))],
      ['URL encoded', tryOr(() => encodeURIComponent(text))],
      ['Base64 decoded', tryOr(() => b64decode(text))],
      ['Base64 encoded', tryOr(() => b64encode(text))],
      ['Hex decoded', tryOr(() => fromHex(text))],
      ['Hex', tryOr(() => hexOf(text))],
      ['Timestamp', tryOr(() => timeOf(text))],
      ['JWT', jwt ? JSON.stringify({ header: jwt.header, payload: jwt.payload, expires: jwt.expiresAt ?? 'never' }, null, 2) : undefined],
      ['JSON (formatted)', tryOr(() => JSON.stringify(JSON.parse(text), null, 2))],
    ];
    return out.filter(([, v]) => v !== undefined && v !== text);
  }, [text]);
  return (
    <Modal title="Decode" onClose={onClose} width={760}>
      <div className="grid gap-3">
        <Field label="Text" hint="URL-encoded, Base64 (also base64url), hex, a Unix timestamp (s, ms, µs), a JWT, JSON">
          <textarea className="field mono text-xs w-full" rows={4} value={text} onChange={(e) => setText(e.target.value)} autoFocus aria-label="Text to decode" />
        </Field>
        {rows.length === 0 ? (
          <p className="text-sm text-muted">{text ? 'Nothing decodes this text.' : 'Paste a value from a request or a response.'}</p>
        ) : (
          rows.map(([label, value]) => (
            <div key={label} data-decode={label}>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-muted uppercase tracking-wide">{label}</span>
                <Button size="sm" variant="ghost" icon={<Copy size={12} />} onClick={() => copy(value!, label.toLowerCase())} title="Copy" />
              </div>
              <pre className="text-xs mono whitespace-pre-wrap break-all rounded border border-line p-2 bg-panel max-h-48 overflow-auto">{value}</pre>
            </div>
          ))
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ frames and events */

export interface Frame {
  at: string;
  direction: 'sent' | 'received';
  opcode: string;
  bytes: number;
  text?: string;
  truncated?: boolean;
}
export interface StreamEvent {
  at: string;
  event?: string;
  id?: string;
  data: string;
}

const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour12: false }) + '.' + String(new Date(iso).getMilliseconds()).padStart(3, '0');

/** A WebSocket's frames, both directions, newest last; control frames can be hidden. */
export function FramesView({ frames, open }: { frames: Frame[]; open?: boolean }) {
  const [show, setShow] = useState<'all' | 'data' | 'sent' | 'received'>('data');
  const list = frames.filter((f) => (show === 'all' ? true : show === 'data' ? f.opcode === 'text' || f.opcode === 'binary' || f.opcode === 'continuation' : f.direction === show));
  return (
    <div className="p-3 grid gap-2">
      <div className="flex items-center gap-2 text-xs">
        <Select aria-label="Which frames" value={show} onChange={(e) => setShow(e.target.value as typeof show)}>
          <option value="data">Messages</option>
          <option value="all">All frames (ping, pong, close)</option>
          <option value="sent">Sent</option>
          <option value="received">Received</option>
        </Select>
        <span className="text-muted">
          {list.length} of {frames.length}
          {open ? ' · open' : ''}
        </span>
      </div>
      {!list.length ? (
        <p className="text-sm text-muted">No frames yet.</p>
      ) : (
        <table className="text-xs w-full">
          <tbody>
            {list.map((f, i) => (
              <tr key={i} className="border-t border-line/60 align-top" data-frame={f.direction}>
                <td className="py-1 pr-2 whitespace-nowrap text-muted tabular-nums">{time(f.at)}</td>
                <td className={f.direction === 'sent' ? 'py-1 pr-2 text-accent' : 'py-1 pr-2 text-ok'}>{f.direction === 'sent' ? '↑' : '↓'}</td>
                <td className="py-1 pr-2 text-muted">{f.opcode}</td>
                <td className="py-1 pr-2 mono break-all">
                  {f.text ?? <span className="text-muted">({f.bytes} bytes)</span>}
                  {f.truncated ? ' …' : ''}
                </td>
                <td className="py-1 text-right tabular-nums text-muted whitespace-nowrap">{f.bytes} B</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Server-Sent Events as they came. */
export function EventsView({ events, open }: { events: StreamEvent[]; open?: boolean }) {
  return (
    <div className="p-3 grid gap-2">
      <div className="text-xs text-muted">
        {events.length} event{events.length === 1 ? '' : 's'}
        {open ? ' · the stream is open' : ''}
      </div>
      <table className="text-xs w-full">
        <tbody>
          {events.map((e, i) => (
            <tr key={i} className="border-t border-line/60 align-top" data-event>
              <td className="py-1 pr-2 whitespace-nowrap text-muted tabular-nums">{time(e.at)}</td>
              <td className="py-1 pr-2 whitespace-nowrap">{e.event ?? 'message'}</td>
              <td className="py-1 pr-2 text-muted whitespace-nowrap">{e.id ? `#${e.id}` : ''}</td>
              <td className="py-1 mono break-all whitespace-pre-wrap">{e.data}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Read a picked file as base64 (a SAZ archive is binary). */
export function pickBinaryFile(accept: string): Promise<{ name: string; base64: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      const bytes = new Uint8Array(await f.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      resolve({ name: f.name, base64: btoa(bin) });
    };
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}
