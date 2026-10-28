import { useState } from 'react';
import { useRpc } from '../../lib/use-rpc';
import { AiAction } from '../ai/AiAction';
import { Field, Input, Select, Toggle } from '../ui';

interface AuthorContext {
  datasets: Array<{ path: string; name: string; format: string }>;
  specs: string[];
}
interface AuthorInputs {
  runnable: number;
  total: number;
  records: number;
  notRunnable: Array<{ id: string; missing: string[] }>;
}

/**
 * "Draft an evaluation with AI" for the RAG target of an evaluation (ai-features.md AI-11): the person says what they want to
 * find out and which dataset of the workspace to use, sees how many metrics that data can support, and the AI task drafts the
 * whole evaluation (dataset slice, metrics with pass marks, judge options, gates). It goes through the one AI button, so
 * "What will be sent", the cost estimate and the shared proposal review are the ones every AI feature has; the proposal's
 * verifier has already dry-run the evaluation on a few samples (nothing sent to a judge) when the review opens.
 */
export function RagAuthorAction({ target }: { target: string }) {
  const [goal, setGoal] = useState('');
  const [dataset, setDataset] = useState('');
  const [slice, setSlice] = useState(false);
  // the records the evaluation runs, also as a file of their own: datasets/<dataset>-slice.jsonl
  const sliceFile = slice && dataset ? `${dataset.replace(/\.[^.]+$/, '')}-slice` : undefined;
  const context = useRpc<AuthorContext>('rag.author.context', undefined, { keep: true, reloadOn: ['data.changed'] });
  const inputs = useRpc<AuthorInputs>('rag.author.inputs', { target, dataset: dataset || undefined }, { keep: true });
  return (
    <div className="grid gap-2 border border-line rounded-lg p-2" data-rag-author>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,14rem)] gap-2">
        <Field label="What do you want to find out?" hint="Optional: the AI picks metrics and pass marks for it.">
          <Input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Answers come from the handbook and never invent a dose" aria-label="What do you want to find out" data-rag-author-goal />
        </Field>
        <Field label="Test cases" hint="Its columns decide which metrics can run.">
          <Select value={dataset} onChange={(e) => setDataset(e.target.value)} aria-label="Dataset to draft the evaluation for" data-rag-author-dataset>
            <option value="">None</option>
            {(context?.datasets ?? []).map((d) => (
              <option key={d.path} value={d.name}>
                {d.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {dataset && <Toggle checked={slice} onChange={setSlice} label="Also save the cases it runs as a test-case file" title={`Writes datasets/${dataset.replace(/\.[^.]+$/, '')}-slice.jsonl: a file you can open, compare and reuse (a saved evaluation keeps its dataset inside)`} data-rag-author-slice />}
      <div className="flex items-center gap-2 flex-wrap">
        <AiAction
          label="Draft an evaluation with AI"
          hint="The AI drafts the metrics, pass marks, judge options and gates; TestPion drops what cannot run on this data, dry-runs the rest on a few samples (nothing is sent to a judge) and offers it as a proposal you review."
          request={() => ({ task: 'rag-author-evaluation', title: 'Draft a RAG evaluation', question: goal || undefined, context: { target, dataset: dataset || undefined, goal: goal || undefined, sliceFile } })}
        />
        {inputs && (
          <span className="text-xs text-muted" data-rag-author-inputs title={inputs.notRunnable.slice(0, 12).map((n) => `${n.id}: needs ${n.missing.join(', ')}`).join('\n')}>
            {inputs.runnable} of {inputs.total} metrics can run on {dataset ? `${dataset} (${inputs.records} records)` : 'what the target returns'}
          </span>
        )}
      </div>
    </div>
  );
}
