import { RefreshCw, ShieldCheck, Vault } from 'lucide-react';
import { useEffect, useState } from 'react';
import { asError, call } from '../api';
import { allowSecretRefs } from '../lib/secret-refs';
import { useApp } from '../store';
import { Button } from './ui';

interface RefRow {
  key: string;
  ref: string;
  label: string;
  commandLine: string;
  allowed: boolean;
  read: boolean;
  error?: string;
}

/** The variables of an environment read from a secret manager (op://, vault:// …): allowed and read, or a way to allow them. */
export function SecretRefsLine({ environment, version }: { environment: string; version: unknown }) {
  const [rows, setRows] = useState<RefRow[]>([]);
  const load = () => void call<RefRow[]>('secrets.refs', { environment }).then(setRows, () => setRows([]));
  useEffect(load, [environment, version]);
  if (!rows.length) return null;
  const waiting = rows.filter((r) => !r.allowed && !r.error);
  const tools = [...new Set(rows.map((r) => r.label).filter(Boolean))].join(', ');
  return (
    <div className="text-xs flex items-center gap-2 flex-wrap bg-panel rounded-md p-2" data-secret-refs>
      <Vault size={13} className="shrink-0 text-muted" />
      <span>
        From {tools}:{' '}
        {rows.map((r, i) => (
          <span key={r.key} title={r.error ?? r.commandLine}>
            {i > 0 && ', '}
            <span className="mono">{r.key}</span>{' '}
            <span className={r.error ? 'text-bad' : r.read ? 'text-ok' : 'text-muted'}>({r.error ? 'invalid' : r.read ? 'read' : r.allowed ? 'read on use' : 'not allowed yet'})</span>
          </span>
        ))}
      </span>
      <span className="ml-auto flex gap-1">
        {waiting.length > 0 && (
          <Button size="sm" icon={<ShieldCheck size={12} />} onClick={() => void allowSecretRefs(environment, waiting).then(load)}>
            Allow…
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          icon={<RefreshCw size={12} />}
          title="Forget the values read and read them again (after rotating a secret)"
          onClick={() => void call('secrets.refresh', { environment }).then(load, (e) => useApp.getState().toast(asError(e).message, 'error'))}
        >
          Read again
        </Button>
      </span>
    </div>
  );
}
