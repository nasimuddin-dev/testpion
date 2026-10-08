import { ArrowDownToLine, ArrowUpFromLine, ChevronDown, ChevronRight, FlaskConical } from 'lucide-react';
import { useState } from 'react';
import { call } from '../api';
import { confirmAction, toastError, useApp } from '../store';
import { Badge, Button, Empty } from './ui';

interface Message {
  name: string;
  summary?: string;
  contentType?: string;
  payload?: string;
  example?: unknown;
}

interface Channel {
  id: string;
  address: string;
  description?: string;
  actions: Array<'send' | 'receive'>;
  servers: string[];
  messages: Message[];
}

export interface AsyncOutline {
  title: string;
  version?: string;
  description?: string;
  asyncapi: string;
  servers: Array<{ name: string; url: string; protocol: string }>;
  channels: Channel[];
}

/** What the application does on a channel, said from the reader's side. */
const ACTION = {
  send: { label: 'the API publishes', icon: <ArrowUpFromLine size={11} />, hint: 'The application sends messages here: subscribe to read them.' },
  receive: { label: 'the API consumes', icon: <ArrowDownToLine size={11} />, hint: 'The application reads messages from here: publish to send it one.' },
};

function ChannelRow({ c }: { c: Channel }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-t border-line/60" data-channel={c.address}>
      <button className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-panel" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown size={13} className="shrink-0 text-muted" /> : <ChevronRight size={13} className="shrink-0 text-muted" />}
        <span className="mono text-sm truncate">{c.address}</span>
        <span className="flex gap-1 ml-auto shrink-0">
          {c.actions.map((a) => (
            <span key={a} title={ACTION[a].hint}>
              <Badge tone={a === 'send' ? 'accent' : 'default'}>
                <span className="inline-flex items-center gap-1">
                  {ACTION[a].icon}
                  {ACTION[a].label}
                </span>
              </Badge>
            </span>
          ))}
        </span>
      </button>
      {open && (
        <div className="px-8 pb-3 grid gap-3 text-sm">
          {c.description && <p className="text-muted whitespace-pre-wrap">{c.description}</p>}
          {c.servers.length > 0 && <div className="text-xs text-muted">Servers: {c.servers.join(', ')}</div>}
          {c.messages.map((m) => (
            <div key={m.name} className="grid gap-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">{m.name}</span>
                {m.contentType && <span className="text-xs text-muted mono">{m.contentType}</span>}
                {m.summary && <span className="text-xs text-muted truncate">{m.summary}</span>}
              </div>
              {m.payload && <pre className="mono text-xs bg-panel rounded p-2 overflow-auto max-h-56">{m.payload}</pre>}
              {m.example !== undefined && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted">Example</summary>
                  <pre className="mono bg-panel rounded p-2 overflow-auto max-h-48 mt-1">{JSON.stringify(m.example, null, 2)}</pre>
                </details>
              )}
            </div>
          ))}
          {!c.messages.length && <p className="text-xs text-muted">No messages are declared for this channel.</p>}
        </div>
      )}
    </li>
  );
}

/** An AsyncAPI definition as its readers see it: servers, channels with what the API does on them, messages; Generate tests. */
export function AsyncPreviewPanel({ outline, error, spec }: { outline?: AsyncOutline; error?: string; spec: string }) {
  if (error) return <Empty title="Couldn't read the document">{error}</Empty>;
  if (!outline) return <Empty title="Reading the document…" />;
  const generate = async () => {
    const ok = await confirmAction({
      title: 'Generate tests from this definition?',
      message:
        'A realtime test per channel: its example message sent through the broker or server and read back, checked against this document. The suite runs with the servers environment its import made. Test files that exist are kept.',
      confirmLabel: 'Generate tests',
    });
    if (!ok) return;
    try {
      const r = await call<{ written: Array<{ path: string; tests: number }>; skipped: string[] }>('openapi.generateTests', { path: spec });
      const n = r.written.reduce((k, f) => k + f.tests, 0);
      useApp
        .getState()
        .toast(
          r.written.length ? `${r.written.length} files, ${n} tests: review the example messages, then run the suite` : `Every file exists already: ${r.skipped.join(', ')}`,
          r.written.length ? 'success' : 'warning',
          r.written.length ? { label: 'Open Tests', onClick: () => useApp.getState().setView('tests') } : undefined,
        );
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <div className="h-full overflow-auto" data-async-preview>
      <div className="px-3 py-3 border-b border-line grid gap-1">
        <div className="flex items-center gap-2">
          <span className="font-semibold">{outline.title}</span>
          {outline.version && <Badge>v{outline.version}</Badge>}
          <Badge tone="accent">AsyncAPI {outline.asyncapi}</Badge>
          <span className="text-xs text-muted">{outline.channels.length} channels</span>
          <Button size="sm" className="ml-auto" icon={<FlaskConical size={12} />} onClick={() => void generate()}>
            Generate tests
          </Button>
        </div>
        {outline.servers.length > 0 && <div className="mono text-xs text-muted">{outline.servers.map((s) => `${s.name}: ${s.protocol}://${s.url}`).join(' · ')}</div>}
        {outline.description && <p className="text-sm text-muted whitespace-pre-wrap max-h-24 overflow-auto">{outline.description}</p>}
      </div>
      <ul className="px-1 py-2">
        {outline.channels.map((c) => (
          <ChannelRow key={c.id} c={c} />
        ))}
      </ul>
    </div>
  );
}
