import { useCallback, useEffect, useState } from 'react';
import type { DriftChange, McpDrift } from '@testpion/shared';
import { call } from '../../api';
import { toastError, useApp } from '../../store';
import { plural } from '../../lib/format';
import { Badge, Button } from '../ui';

interface Finding {
  level: 'error' | 'warn' | 'tip';
  code: string;
  text: string;
}
interface Check {
  protocolVersion?: string;
  conformance: { checks: number; errors: number; warnings: number; findings: Finding[]; text: string };
  drift?: McpDrift;
  approved?: { at: string; file: string };
  tools: number;
}

const TONE = { breaking: 'bad', review: 'warn', info: 'default' } as const;
const WORD = { breaking: 'Breaks callers', review: 'Review', info: 'Changed' } as const;
const FINDING_TONE = { error: 'bad', warn: 'warn', tip: 'default' } as const;
const FINDING_WORD = { error: 'Fix', warn: 'Check', tip: 'Tip' } as const;

/** The approved words and the new ones of a changed text (a description, the instructions): the review happens here. */
function BeforeAfter({ change }: { change: DriftChange }) {
  if (typeof change.before !== 'string' || typeof change.after !== 'string') return null;
  return (
    <div className="mt-0.5 grid gap-0.5 text-xs">
      <div className="text-muted" data-mcp-change-before>
        Approved: {change.before || '(empty)'}
      </div>
      <div data-mcp-change-after>Now: {change.after || '(empty)'}</div>
    </div>
  );
}

/**
 * "Changes since you approved it" and "Protocol" (Server info): what this server offers compared with the snapshot kept in
 * the workspace (mcp-snapshots/), and whether it follows the protocol where a client can see it. The same check as
 * `testpion mcp --check` and the MCP tool `mcp_server_tools` with check.
 */
export function ServerCheck({ serverId }: { serverId: string }) {
  const [check, setCheck] = useState<Check | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    call<Check>('mcp.check', { serverId })
      .then(setCheck)
      .catch(() => setCheck(null));
  }, [serverId]);
  useEffect(() => {
    setCheck(null);
    load();
  }, [load]);
  if (!check) return null;
  const { drift, conformance } = check;
  const approve = () => {
    setBusy(true);
    call<{ file: string; tools: number }>('mcp.approve', { serverId })
      .then((r) => {
        useApp.getState().toast(`Approved ${plural(r.tools, 'tool')}. Kept in ${r.file}.`, 'success');
        load();
      })
      .catch(toastError)
      .finally(() => setBusy(false));
  };
  return (
    <>
      <section className="px-3 py-2 border-b border-line text-sm" data-mcp-drift={drift ? (drift.changed ? 'changed' : 'same') : 'never'} aria-label="Changes since you approved it">
        <div className="flex items-center gap-2">
          <h3 className="font-medium">Changes since you approved it</h3>
          <div className="flex-1" />
          <Button size="sm" variant={drift && !drift.changed ? 'ghost' : 'primary'} disabled={busy || (!!drift && !drift.changes.length)} reason={drift && !drift.changes.length ? 'Nothing changed since you approved it' : undefined} title="Keep what the server offers now as approved" onClick={approve} data-mcp-approve>
            {drift ? 'Approve these changes' : 'Approve what it offers now'}
          </Button>
        </div>
        <p className="text-muted text-xs mt-0.5" data-mcp-drift-text>
          {drift ? drift.text : `Not approved yet. An agent reads a tool's description as instructions: read the ${plural(check.tools, 'tool')}, then approve. After that, every change to a description or to parameters is listed here.`}
        </p>
        {drift && drift.changes.length > 0 && (
          <ul className="mt-1 grid gap-1.5 max-h-72 overflow-auto">
            {drift.changes.map((c, i) => (
              <li key={`${c.code}-${c.item ?? ''}-${i}`} className="flex items-start gap-2 text-xs" data-mcp-change={c.level}>
                <Badge tone={TONE[c.level]}>{WORD[c.level]}</Badge>
                <div className="min-w-0">
                  <span>{c.text}</span>
                  <BeforeAfter change={c} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="px-3 py-2 border-b border-line text-sm" data-mcp-conformance={conformance.errors ? 'errors' : 'ok'} aria-label="Protocol">
        <h3 className="font-medium">Protocol</h3>
        <p className="text-muted text-xs mt-0.5" data-mcp-conformance-text>
          {conformance.text}
          {check.protocolVersion ? ` The server speaks MCP ${check.protocolVersion}.` : ''}
        </p>
        {conformance.findings.length > 0 && (
          <ul className="mt-1 grid gap-1">
            {conformance.findings.map((f, i) => (
              <li key={`${f.code}-${i}`} className="flex items-start gap-2 text-xs" data-mcp-conformance-finding={f.level}>
                <Badge tone={FINDING_TONE[f.level]}>{FINDING_WORD[f.level]}</Badge>
                <span>{f.text}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
