import { useEffect, useState } from 'react';
import { call } from '../api';
import { attempt, confirmAction, useApp } from '../store';
import { Button } from './ui';

interface Summary {
  commands: Array<{ command: string; args: string[]; at: string }>;
  hosts: Array<{ host: string; at: string }>;
  secretReads: { at: string } | null;
}

const when = (iso: string) => new Date(iso).toLocaleDateString();

/** What the open workspace was allowed on this computer: programs, the hosts its scripts may reach, reading secrets; each can be forgotten. */
export function ScriptTrustPanel() {
  const [s, setS] = useState<Summary>();
  const workspace = useApp((a) => a.workspace?.name);
  const load = () => void call<Summary>('scripts.trust').then(setS, () => setS(undefined));
  useEffect(load, [workspace]);
  const forget = async (what: { host?: string; secrets?: boolean; all?: boolean }, title: string) => {
    if (!(await confirmAction({ title, message: 'The next time a script or a program of this workspace needs it, TestPion asks again.', confirmLabel: 'Forget' }))) return;
    await attempt(async () => setS(await call<Summary>('scripts.forget', what)));
  };
  if (!s) return null;
  const none = !s.commands.length && !s.hosts.length && !s.secretReads;
  return (
    <div className="rounded-md border border-line p-3 text-sm flex flex-col gap-2" data-script-trust>
      <div className="font-medium">Script trust{workspace ? ` for ${workspace}` : ''}</div>
      <p className="text-muted">What you allowed this workspace on this computer. A workspace from git or an import starts with none of it.</p>
      {none && <p className="text-muted">Nothing is allowed yet: its scripts see no secrets and send only to the host of their own request.</p>}
      {s.secretReads && (
        <div className="flex items-center gap-2" data-trust-row="secrets">
          <span className="flex-1">Scripts may read secret variables <span className="text-muted">(since {when(s.secretReads.at)})</span></span>
          <Button size="sm" onClick={() => void forget({ secrets: true }, 'Forget that scripts may read secrets?')}>
            Forget
          </Button>
        </div>
      )}
      {s.hosts.map((h) => (
        <div key={h.host} className="flex items-center gap-2" data-trust-row="host">
          <span className="flex-1">
            Scripts may send to <span className="mono">{h.host === '*' ? 'any host' : h.host}</span> <span className="text-muted">(since {when(h.at)})</span>
          </span>
          <Button size="sm" onClick={() => void forget({ host: h.host }, `Forget ${h.host === '*' ? 'any host' : h.host}?`)}>
            Forget
          </Button>
        </div>
      ))}
      {s.commands.map((c) => (
        <div key={`${c.command} ${c.args.join(' ')}`} className="flex items-center gap-2" data-trust-row="program">
          <span className="flex-1 truncate">
            May start <span className="mono">{[c.command, ...c.args].join(' ')}</span> <span className="text-muted">(since {when(c.at)})</span>
          </span>
        </div>
      ))}
      {!none && (
        <div>
          <Button size="sm" onClick={() => void forget({ all: true }, 'Forget everything allowed for this workspace?')}>
            Forget everything
          </Button>
        </div>
      )}
    </div>
  );
}
