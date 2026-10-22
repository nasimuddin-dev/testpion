import { Plus, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import type { ProbeSetInfo } from '@testpion/core';
import { call } from '../../api';
import { toastError, useApp } from '../../store';
import { useRpc } from '../../lib/use-rpc';
import { Badge, Button, Spinner } from '../ui';

/**
 * The seeded safety probe sets: prompts a safe RAG system should refuse, resist or answer carefully, written into the
 * workspace as ordinary datasets (`datasets/probes-<set>.jsonl`) that you extend by adding lines. A file that is there is
 * never overwritten. Run them with an evaluation of type RAG and the Safety preset.
 */
export function ProbeSets() {
  const [stamp, setStamp] = useState(0);
  const sets = useRpc<ProbeSetInfo[]>('rag.probeSets', { stamp }, { keep: true });
  const [busy, setBusy] = useState<string>();
  const add = async (ids?: string[]) => {
    setBusy(ids?.join(',') ?? 'all');
    try {
      const r = await call<{ written: string[]; skipped: string[] }>('rag.probeSets.add', { sets: ids });
      useApp.getState().toast(r.written.length ? `Added ${r.written.length} probe set${r.written.length === 1 ? '' : 's'} to datasets/` : 'Nothing to add: the files are already there', 'success');
      setStamp((s) => s + 1);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(undefined);
    }
  };
  if (!sets)
    return (
      <div className="p-4">
        <Spinner />
      </div>
    );
  const missing = sets.filter((s) => !s.inWorkspace).map((s) => s.id);
  return (
    <section className="mt-8 max-w-2xl" data-rag-probes>
      <h3 className="font-semibold flex items-center gap-2 mb-1">
        <ShieldCheck size={15} /> Safety probe sets
      </h3>
      <p className="text-muted mb-3">
        Prompts a safe system should refuse (jailbreaks, other people’s data, abuse), resist (instructions planted in the text to read), answer carefully (bias bait), or answer anyway (harmless look-alikes, to count false refusals). They become datasets in the workspace; add your own lines to the files. Run one with an evaluation of type RAG and the <b>Safety</b> preset.
      </p>
      <div className="rounded-lg border border-line divide-y divide-line/70">
        {sets.map((s) => (
          <div key={s.id} className="flex items-start gap-3 px-3 py-2" data-rag-probe-set={s.id}>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium">{s.title}</span>
                <span className="mono text-xs text-muted">{s.file}</span>
                {s.inWorkspace ? <Badge tone="ok">{s.records} records</Badge> : <Badge>{s.builtIn} built in</Badge>}
              </div>
              <div className="text-xs text-muted">{s.description}</div>
              <div className="text-xs text-muted">Metrics: {s.metrics.join(', ')}</div>
            </div>
            {!s.inWorkspace && (
              <Button size="sm" icon={busy === s.id ? <Spinner /> : <Plus size={12} />} disabled={busy !== undefined} reason="Still adding" onClick={() => void add([s.id])} data-rag-probe-add={s.id}>
                Add
              </Button>
            )}
          </div>
        ))}
      </div>
      {missing.length > 1 && (
        <Button className="mt-2" size="sm" disabled={busy !== undefined} reason="Still adding" onClick={() => void add()} data-rag-probe-add-all>
          Add all {missing.length} missing sets
        </Button>
      )}
    </section>
  );
}
