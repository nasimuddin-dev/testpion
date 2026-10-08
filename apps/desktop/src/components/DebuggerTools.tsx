import { CodeBlock } from './CodeBlock';
import { ChevronDown, Copy, Download, RefreshCw, ShieldCheck, ShieldOff } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { call } from '../api';
import { confirmAction, toastError, useApp } from '../store';
import { Badge, Button, Empty, Menu, Modal, Select } from './ui';
import { finishSave, type SaveResult } from '../lib/files';
import { tryDecodeJwt } from '@testpion/shared';
import { copyText } from '../lib/clipboard';
import { plural } from '../lib/format';

/**
 * The HTTP Debugger's tools (planning/http-debugger.md, DBG-4): the root certificate that decrypts HTTPS, the decode
 * panel (URL, Base64, hex, JWT, timestamps), the frames of a WebSocket and the events of a stream.
 */

const toast = (m: string) => useApp.getState().toast(m, 'success');

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
      toastError(e);
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
              onClick={() => void call<SaveResult>('debug.certificate', { action: 'export' }).then((r) => finishSave(r, 'certificate'), toastError)}
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
                  <Button size="sm" variant="ghost" icon={<Copy size={12} />} onClick={() => void copyText(line, 'the line')} title="Copy" />
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

const jsonOf = (s: string) => JSON.stringify(JSON.parse(s), null, 2);
const jwtOf = (s: string) => {
  const jwt = tryDecodeJwt(s.trim().replace(/^Bearer\s+/i, ''));
  if (!jwt) throw new Error('not a JWT');
  return JSON.stringify({ header: jwt.header, payload: jwt.payload, expires: jwt.expiresAt ?? 'never' }, null, 2);
};
const htmlDecode = (s: string) => {
  const t = document.createElement('textarea');
  t.innerHTML = s;
  return t.value;
};
const htmlEncode = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The conversions of the Convert panel: decoders read a value, encoders write one. */
const DECODERS: Array<{ id: string; label: string; run(s: string): string }> = [
  { id: 'url', label: 'URL Decode', run: (s) => decodeURIComponent(s.replace(/\+/g, ' ')) },
  { id: 'base64', label: 'Base64 Decode', run: b64decode },
  { id: 'hex', label: 'Hex Decode', run: fromHex },
  { id: 'html', label: 'HTML Decode', run: htmlDecode },
  { id: 'jwt', label: 'JWT Decode', run: jwtOf },
  { id: 'timestamp', label: 'Timestamp', run: timeOf },
  { id: 'json', label: 'JSON Format', run: jsonOf },
];
const ENCODERS: Array<{ id: string; label: string; run(s: string): string }> = [
  { id: 'url', label: 'URL Encode', run: encodeURIComponent },
  { id: 'base64', label: 'Base64 Encode', run: b64encode },
  { id: 'hex', label: 'Hex Encode', run: hexOf },
  { id: 'html', label: 'HTML Encode', run: htmlEncode },
  { id: 'json-min', label: 'JSON Minify', run: (s) => JSON.stringify(JSON.parse(s)) },
];

/**
 * Convert (the Debugger's dock): text in, one Decode ▾ and one Encode ▾ (a click runs the shown conversion, the arrow
 * picks another), the result below; then every other reading of the text that makes sense.
 */
export function ConvertTool({ initial = '' }: { initial?: string }) {
  const [text, setText] = useState(initial);
  const [decoder, setDecoder] = useState(DECODERS[0]!);
  const [encoder, setEncoder] = useState(ENCODERS[0]!);
  const [out, setOut] = useState<{ label: string; value?: string }>();
  const run = (c: { label: string; run(s: string): string }) => setOut({ label: c.label, value: tryOr(() => c.run(text)) });
  const readings = useMemo(() => {
    if (!text) return [];
    return DECODERS.map((d) => [d.label, tryOr(() => d.run(text))] as [string, string | undefined]).filter(([, v]) => v !== undefined && v !== text);
  }, [text]);
  const split = (list: typeof DECODERS, current: (typeof DECODERS)[number], pick: (c: (typeof DECODERS)[number]) => void, label: string) => (
    <span className="inline-flex">
      <Button size="sm" className="rounded-r-none" onClick={() => run(current)} title={`${current.label} the text`}>
        {current.label}
      </Button>
      <Menu
        width={180}
        align="start"
        items={list.map((c) => ({ label: c.label, onSelect: () => (pick(c), run(c)) }))}
        trigger={
          <Button size="sm" className="rounded-l-none border-l-0 px-1.5" aria-label={label}>
            <ChevronDown size={12} />
          </Button>
        }
      />
    </span>
  );
  return (
    <div className="flex-1 min-h-0 flex flex-col p-2 gap-2" data-convert>
      <div className="flex gap-2">
        {split(DECODERS, decoder, setDecoder, 'Choose a decoder')}
        {split(ENCODERS, encoder, setEncoder, 'Choose an encoder')}
      </div>
      <textarea
        className="field mono text-xs w-full flex-1 min-h-24"
        value={text}
        onChange={(e) => (setText(e.target.value), setOut(undefined))}
        placeholder="Paste a value: URL-encoded, Base64, hex, HTML, a JWT, a timestamp, JSON"
        aria-label="Text to convert"
      />
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-muted uppercase tracking-wide">{out?.label ?? 'Result'}</span>
        {out?.value !== undefined && <Button size="sm" variant="ghost" icon={<Copy size={12} />} onClick={() => void copyText(out.value!, out.label.toLowerCase())} title="Copy" />}
      </div>
      <textarea className="field mono text-xs w-full flex-1 min-h-24" readOnly value={out ? (out.value ?? `This text does not ${out.label.toLowerCase()}.`) : ''} aria-label="Converted text" data-convert-result />
      {readings.length > 0 && (
        <details className="text-xs" open={!out}>
          <summary className="cursor-pointer text-muted">Other readings ({readings.length})</summary>
          <div className="grid gap-2 mt-1 max-h-64 overflow-auto">
            {readings.map(([label, value]) => (
              <div key={label} data-decode={label}>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold text-muted uppercase tracking-wide">{label}</span>
                  <Button size="sm" variant="ghost" icon={<Copy size={12} />} onClick={() => void copyText(value!, label.toLowerCase())} title="Copy" />
                </div>
                <CodeBlock className="mono whitespace-pre-wrap break-all rounded border border-line p-2 bg-panel max-h-40 overflow-auto" text={value ?? ''} />
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
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
        {plural(events.length, 'event')}
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

/* ------------------------------------------------------------------ gRPC, HTTP/2 connections, a phone on the LAN */

export interface GrpcCall {
  service: string;
  method: string;
  decodedWith: 'proto' | 'raw';
  requests: unknown[];
  responses: unknown[];
  status?: number;
  statusName?: string;
  message?: string;
}

/** A gRPC call: its status, then the messages both ways as JSON. */
export function GrpcView({ call: g, open }: { call: GrpcCall; open?: boolean }) {
  return (
    <div className="p-3 grid gap-3 text-sm">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="mono text-xs">
          {g.service}/{g.method}
        </span>
        {g.statusName ? <Badge tone={g.status === 0 ? 'ok' : 'bad'}>{g.statusName}</Badge> : <Badge>{open ? 'streaming' : 'no status'}</Badge>}
        {g.message && <span className="text-bad text-xs">{g.message}</span>}
      </div>
      <p className="text-xs text-muted" data-grpc-decoded={g.decodedWith}>
        {g.decodedWith === 'proto'
          ? 'Decoded with the .proto files of the workspace.'
          : 'No .proto in the workspace describes this method: fields are shown by number. Add the service as a gRPC request (with its .proto or reflection) to see names.'}
      </p>
      {(
        [
          ['Sent', g.requests],
          ['Received', g.responses],
        ] as Array<[string, unknown[]]>
      ).map(([title, list]) => (
        <section key={title}>
          <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-1">
            {title} · {plural(list.length, 'message')}
          </div>
          {list.map((m, i) => (
            <CodeBlock key={i} className="text-xs mono whitespace-pre-wrap break-all rounded border border-line p-2 bg-panel mb-1" data-grpc-message={title} language="json" text={JSON.stringify(m, null, 2)} />
          ))}
        </section>
      ))}
    </div>
  );
}

export interface ConnectionRow {
  id: string;
  method: string;
  url: string;
  host: string;
  status?: number;
  httpVersion?: string;
  connectionId?: string;
  streamId?: number;
  durationMs?: number;
  application?: string;
  error?: string;
  tls?: boolean;
}

/** The HTTP/2 tree, and every connection: which requests (streams) went over which connection, newest first. */
export function ConnectionsView({ rows, onPick }: { rows: ConnectionRow[]; onPick(id: string): void }) {
  const groups = useMemo(() => {
    const m = new Map<string, ConnectionRow[]>();
    for (const r of rows) {
      const k = r.connectionId ?? r.id;
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return [...m.entries()]
      .map(([id, list]) => ({ id, list, h2: list.some((x) => x.httpVersion === '2'), host: list[0]!.host, application: list.find((x) => x.application)?.application, tls: list.some((x) => x.tls) }))
      .reverse();
  }, [rows]);
  if (!groups.length) return <Empty title="No connections yet">Each program connection appears here with the requests it carried; HTTP/2 shows its streams.</Empty>;
  return (
    <div className="flex-1 min-h-0 overflow-auto p-3 grid gap-2 content-start">
      {groups.map((g) => (
        <section key={g.id} className="rounded-lg border border-line" data-connection={g.h2 ? 'h2' : 'h1'}>
          <header className="flex items-center gap-2 px-3 py-1.5 border-b border-line text-sm">
            <Badge tone={g.h2 ? 'accent' : 'default'}>{g.h2 ? 'HTTP/2' : 'HTTP/1.1'}</Badge>
            {g.tls && <Badge tone="ok">TLS</Badge>}
            <span className="font-medium truncate">{g.host}</span>
            <span className="text-xs text-muted">{g.application ?? ''}</span>
            <span className="ml-auto text-xs text-muted">
              {g.list.length} {g.h2 ? 'stream' : 'request'}
              {g.list.length === 1 ? '' : 's'}
            </span>
          </header>
          <table className="text-xs w-full">
            <tbody>
              {g.list.map((r) => (
                <tr key={r.id} className="border-t border-line/60 cursor-pointer hover:bg-hover" onClick={() => onPick(r.id)}>
                  <td className="py-1 px-3 w-16 text-muted tabular-nums">{r.streamId !== undefined ? `#${r.streamId}` : ''}</td>
                  <td className="py-1 pr-2 w-14 mono font-bold">{r.method}</td>
                  <td className="py-1 pr-2 truncate max-w-xl">{r.url}</td>
                  <td className="py-1 pr-3 text-right tabular-nums">{r.error ? 'ERR' : (r.status ?? '…')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

interface LanInfo {
  running: boolean;
  lan: boolean;
  port?: number;
  decrypt: boolean;
  addresses: Array<{ ip: string; proxy?: string; page?: string; qrSvg?: string }>;
}

/** A phone or another computer: listen on the network, then scan the QR code for the proxy settings and the certificate. */
export function LanDialog({ onClose, onRestartOnLan }: { onClose(): void; onRestartOnLan(): Promise<void> }) {
  const [info, setInfo] = useState<LanInfo>();
  const load = () => void call<LanInfo>('debug.lan').then(setInfo, toastError);
  useEffect(load, []);
  return (
    <Modal title="Capture a phone or another computer" onClose={onClose} width={720}>
      {!info ? (
        <Empty title="Looking for this computer's addresses…" />
      ) : !info.running ? (
        <p className="text-sm">Start capturing first.</p>
      ) : !info.lan ? (
        <div className="grid gap-3 text-sm">
          <p>
            The proxy listens on this computer only. To let a phone or another computer on the same network use it, listen on the network too (anyone on the network can then send through it while it
            runs).
          </p>
          <div>
            <Button variant="primary" onClick={() => void onRestartOnLan().then(load)}>
              Listen on the network
            </Button>
          </div>
        </div>
      ) : !info.addresses.length ? (
        <p className="text-sm">This computer has no address on a local network.</p>
      ) : (
        <div className="grid gap-4 text-sm">
          <p>
            On the device, set the Wi-Fi network's proxy to <b>manual</b> with the server and port below, or scan the code: it opens a page with these settings
            {info.decrypt ? ' and the root certificate to install, for HTTPS' : ''}.
          </p>
          <div className="grid grid-cols-2 gap-4">
            {info.addresses.map((a) => (
              <div key={a.ip} className="rounded-lg border border-line p-3 grid gap-2 justify-items-center" data-lan={a.ip}>
                {a.qrSvg && <div className="w-44 h-44 bg-white rounded p-1 [&_svg]:w-full [&_svg]:h-full" dangerouslySetInnerHTML={{ __html: a.qrSvg }} />}
                <div className="mono text-xs">{a.proxy}</div>
                <Button size="sm" icon={<Copy size={12} />} onClick={() => void copyText(a.proxy ?? '', 'the proxy address')}>
                  Copy
                </Button>
              </div>
            ))}
          </div>
          {!info.decrypt && <p className="text-xs text-muted">HTTPS shows as tunnels by host. Turn on HTTPS ▸ Decrypt HTTPS to read it; the page then offers the root certificate.</p>}
        </div>
      )}
    </Modal>
  );
}
