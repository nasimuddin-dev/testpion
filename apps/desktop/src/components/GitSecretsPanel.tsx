import { ExternalLink, KeyRound, ShieldAlert, X } from 'lucide-react';
import { useState } from 'react';
import type { ItemRef } from '@testpion/shared';
import { call } from '../api';
import { confirmAction, toastError, useApp } from '../store';
import { openRef } from '../lib/open-ref';
import { plural } from '../lib/format';
import { Button, Callout } from './ui';

/** A secret in a staged file (core's StagedSecret): never its value. */
export interface StagedSecret {
  file: string;
  kind: string;
  item: string;
  field: string;
  variable: string;
  confidence: 'high' | 'medium';
  message: string;
  ref?: ItemRef;
}

/** Kinds the app can move to a secret variable by itself (collections, environments, workspace variables). */
const FIXABLE = new Set(['collection', 'environment', 'workspace']);

/**
 * What the commit would publish, found in the STAGED files (release B of planning/git-everything.md §4e): the item, the
 * field, and the {{variable}} to use instead. A certain secret refuses the commit for good (fix it, or unstage the file); a
 * probable one can be committed after a confirmation.
 */
export function GitSecretsPanel({ findings, onChange, onCommitAnyway }: { findings: StagedSecret[]; onChange(next: StagedSecret[] | undefined): void; onCommitAnyway(): void }) {
  const ws = useApp((s) => s.workspace);
  const envName = useApp((s) => s.environment);
  const env = ws?.environments.find((e) => e.name === envName);
  const [busy, setBusy] = useState(false);
  const certain = findings.filter((f) => f.confidence === 'high');
  const fixable = findings.filter((f) => FIXABLE.has(f.kind));
  const fix = async () => {
    if (!env) return useApp.getState().toast('Choose the environment that should keep the secret values (top bar), then fix.', 'warning');
    setBusy(true);
    try {
      const r = await call<{ fixed: unknown[]; variables: string[]; scan: { blocking: StagedSecret[]; confirm: StagedSecret[] } }>('git.fixStaged', { findings: fixable, environmentId: env.id });
      const left = [...r.scan.blocking, ...r.scan.confirm];
      onChange(left.length ? left : undefined);
      useApp.getState().toast(r.fixed.length ? `${plural(r.fixed.length, 'secret')} moved to secret variables of ${env.name}: ${r.variables.join(', ')}` : 'Nothing could be fixed by itself; open each one.', r.fixed.length ? 'success' : 'warning');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const anyway = async () => {
    if (await confirmAction({ title: 'Commit probable secrets', message: `${plural(findings.length, 'value')} look like secrets. Commit anyway?`, detail: findings.map((f) => `${f.item}: ${f.field}`).join('\n'), confirmLabel: 'Commit anyway', danger: true })) onCommitAnyway();
  };
  return (
    <Callout tone="bad" block role="alert" data-staged-secrets="">
      <div className="flex items-center gap-2 font-medium">
        <ShieldAlert size={15} className="text-bad" /> Not committed: {findings.length} secret{findings.length === 1 ? ' is' : 's are'} typed into the staged files
      </div>
      <div className="text-xs text-muted">
        {certain.length ? 'A value typed into a file would go to everyone who pulls. Replace each with the {{variable}} shown (its value stays on this computer as a secret variable), then commit again. This cannot be committed anyway.' : 'These look like secrets. Replace them with the {{variable}} shown, or confirm that they are not.'}
      </div>
      <ul className="rounded-md border border-line bg-panel" aria-label="Secrets in the staged files">
        {findings.map((f, i) => (
          <li key={f.file + f.item + f.field + i} className="flex items-center gap-2 px-2 py-1 text-xs border-b border-line last:border-b-0" data-secret-item={f.item}>
            <button className="font-medium truncate hover:underline text-left" title={f.message} onClick={() => f.ref && void openRef(f.ref)}>
              {f.item}
            </button>
            <span className="text-muted truncate">{f.field}</span>
            <span className="font-mono truncate" title="Use this instead of the typed value">
              use {f.variable}
            </span>
            <span className="ml-auto flex items-center gap-1 shrink-0">
              <span className={f.confidence === 'high' ? 'text-bad' : 'text-warn'}>{f.confidence === 'high' ? 'certain' : 'probable'}</span>
              {f.ref && (
                <Button size="sm" variant="ghost" icon={<ExternalLink size={12} />} onClick={() => void openRef(f.ref!)} title="Open it to change by hand">
                  Open
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        {fixable.length > 0 && (
          <Button size="sm" variant="primary" icon={<KeyRound size={13} />} loading={busy} onClick={() => void fix()} title="Move the values to secret variables of the active environment and stage the fixed files">
            Fix all {fixable.length === findings.length ? '' : `(${fixable.length})`}
          </Button>
        )}
        <Button size="sm" icon={<X size={13} />} onClick={() => onChange(undefined)}>
          Later
        </Button>
        {!certain.length && (
          <Button size="sm" variant="danger" icon={<ShieldAlert size={13} />} onClick={() => void anyway()} title="Commit with the probable secrets in the files (after a confirmation)">
            Commit anyway…
          </Button>
        )}
      </div>
    </Callout>
  );
}
