import { History } from 'lucide-react';
import type { PromptVersions } from '@testpion/core';
import { asError, call } from '../../api';
import { timeAgo } from '../../lib/format';
import { useRpc } from '../../lib/use-rpc';
import { confirmAction, promptText, toastError, useApp } from '../../store';
import { Badge, Button, cx } from '../ui';

/**
 * The versions of an evaluation's prompt (A-4, A-5): save the prompt as a named version, see the result of the run made with each
 * one, and make one current. A version under the pass line, worse than the prompt in use, or never run asks first and says the
 * numbers. The prompt in use is kept as "Before …" when it was not a version, so nothing is lost.
 */
export function PromptVersionsBar({ evaluation, dirty, onUsed }: { evaluation?: string; dirty: boolean; onUsed(v: { prompt: string; system?: string }): void }) {
  const data = useRpc<PromptVersions>('eval.versions', evaluation ? { evaluation } : undefined, { enabled: !!evaluation, reloadOn: ['data.changed', 'run.finished'] });
  const toast = useApp.getState().toast;
  const saveReason = !evaluation ? 'Save the evaluation first: versions belong to a saved evaluation' : dirty ? 'Save your changes first: a version is made from the saved prompt' : data?.currentSaved ? 'This prompt is already saved as a version' : undefined;

  const save = async () => {
    if (!evaluation) return;
    const name = await promptText('Save this prompt as a version', { message: 'Name it by what is different, for example "Shorter prompt" or "Ask for JSON".', placeholder: 'Version name', okLabel: 'Save version' });
    if (!name) return;
    try {
      await call('eval.saveVersion', { evaluation, name });
      toast(`Saved the version "${name}"`, 'success');
    } catch (e) {
      toastError(e);
    }
  };

  const use = async (v: PromptVersions['versions'][number]) => {
    if (!evaluation) return;
    const finish = (r: { version: string; kept?: string }) => {
      onUsed({ prompt: v.prompt, system: v.system });
      toast(`"${r.version}" is now the prompt${r.kept ? `; the one before is kept as "${r.kept}"` : ''}`, 'success');
    };
    try {
      finish(await call('eval.useVersion', { evaluation, version: v.id }));
    } catch (e) {
      const message = asError(e).message;
      if (!/Confirm to make it current anyway/.test(message)) return toastError(e);
      // under the pass line, worse than the prompt in use, or never run: the numbers, then the person decides
      const yes = await confirmAction({ title: `Make “${v.name}” the prompt?`, message: message.replace(/^ValidationError: ?/, '').replace(/ Confirm to make it current anyway\.$/, ''), confirmLabel: 'Make it current anyway', tone: 'warning' });
      if (!yes) return;
      try {
        finish(await call('eval.useVersion', { evaluation, version: v.id, confirm: true }));
      } catch (e2) {
        toastError(e2);
      }
    }
  };

  const inUse = data?.versions.find((v) => v.current);
  return (
    <details className="border-b border-line text-sm" data-prompt-versions>
      <summary className="px-3 py-1.5 cursor-pointer select-none flex items-center gap-2 text-muted">
        <History size={13} />
        Prompt versions
        {data && (
          <span className="text-xs" data-version-summary>
            {data.versions.length ? `${data.versions.length} saved · in use: ${inUse ? inUse.name : 'not saved as a version'}` : 'none saved yet'}
          </span>
        )}
      </summary>
      <div className="px-3 pb-2 flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => void save()} disabled={!!saveReason} reason={saveReason} title="Keep this wording under a name, with the result of the run made with it" data-version-save>
            Save as version…
          </Button>
          {data?.passLine ? <span className="text-xs text-muted">Pass line {data.passLine}%</span> : null}
        </div>
        {data?.versions.length ? (
          <ul className="flex flex-col" data-version-list>
            {data.versions.map((v) => {
              const under = !!v.run && typeof data.passLine === 'number' && v.run.passRate * 100 < data.passLine;
              return (
                <li key={v.id} className="flex items-center gap-2 py-1 border-t border-line/60 first:border-t-0 text-xs" data-version={v.name} data-version-current={v.current ? 'true' : undefined}>
                  <span className="min-w-0 flex-1 truncate" title={v.note || v.prompt}>
                    <span className="font-medium">{v.name}</span> <span className="text-muted">· {timeAgo(v.at)}{v.note ? ` · ${v.note}` : ''}</span>
                  </span>
                  {v.run ? (
                    <span className={cx('tabular-nums', under ? 'text-bad' : 'text-muted')} title={`The latest run made with this prompt, ${timeAgo(v.run.startedAt)}`} data-version-result>
                      {v.run.passed} of {v.run.total} passed ({Math.round(v.run.passRate * 100)}%)
                    </span>
                  ) : (
                    <span className="text-muted" data-version-result>
                      not run yet
                    </span>
                  )}
                  {v.current ? (
                    <Badge tone="accent">in use</Badge>
                  ) : (
                    <Button size="sm" onClick={() => void use(v)} title="Make this the evaluation’s prompt. Under the pass line, worse than the prompt in use, or never run: it asks first." data-version-use={v.name}>
                      Make current
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-xs text-muted">Save the wording you have as a version, change the prompt, run again, and compare the two here.</p>
        )}
        {data && !data.currentSaved && data.currentRun && (
          <p className="text-xs text-muted">
            The prompt in use is not saved as a version; its last run passed {data.currentRun.passed} of {data.currentRun.total}.
          </p>
        )}
      </div>
    </details>
  );
}
