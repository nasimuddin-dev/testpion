import { Plus, X } from 'lucide-react';
import type { RagJudgeSetup } from '@testpion/shared';
import type { ProviderConfig } from '../../types';
import { Field, IconButton, Input, Select, Toggle } from '../ui';

/** The judge panel of an evaluation: a jury, both document orders, repeats, short-circuit, shared claims, and the limits of the run. */
export function RagJudgeOptions({
  judge,
  maxCostUsd,
  maxCalls,
  providers,
  onChange,
}: {
  judge: RagJudgeSetup;
  maxCostUsd?: number;
  maxCalls?: number;
  providers: ProviderConfig[];
  onChange(p: { judge?: RagJudgeSetup; maxJudgeCostUsd?: number; maxJudgeCalls?: number }): void;
}) {
  const set = (p: Partial<RagJudgeSetup>) => onChange({ judge: { ...judge, ...p } });
  const judges = judge.judges ?? [];
  return (
    <details className="text-xs rounded-lg border border-line px-2 py-1" data-rag-judge-options>
      <summary className="cursor-pointer text-muted select-none">
        Judge options
        {judges.length || judge.swap || (judge.repeat ?? 1) > 1 || judge.shortCircuit || judge.shareClaims || judge.allowImages || maxCostUsd || maxCalls ? ' · set' : ''}
      </summary>
      <div className="grid gap-2 mt-2 pb-1">
        <div>
          <div className="text-muted mb-1">Jury: more judges score each sample; their scores are combined</div>
          {judges.map((j, i) => (
            <div key={i} className="flex items-center gap-1 mb-1">
              <Select className="h-6 min-h-6 py-0 text-xs flex-1" aria-label={`Jury judge ${i + 1} provider`} value={j.provider ?? ''} onChange={(e) => set({ judges: judges.map((x, k) => (k === i ? { provider: e.target.value || undefined, model: providers.find((p) => p.id === e.target.value)?.defaultModel || undefined } : x)) })}>
                <option value="">Choose a provider</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
              <Input className="h-6 min-h-6 text-xs mono flex-1" value={j.model ?? ''} placeholder="model" aria-label={`Jury judge ${i + 1} model`} onChange={(e) => set({ judges: judges.map((x, k) => (k === i ? { ...x, model: e.target.value || undefined } : x)) })} />
              <IconButton label="Remove this judge" onClick={() => set({ judges: judges.filter((_, k) => k !== i) })}>
                <X size={12} />
              </IconButton>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <IconButton label="Add a judge to the jury" onClick={() => set({ judges: [...judges, {}] })} data-rag-add-judge>
              <Plus size={12} />
            </IconButton>
            {judges.length > 1 && (
              <label className="flex items-center gap-1">
                combined by
                <Select className="h-6 min-h-6 py-0 text-xs" value={judge.aggregate ?? 'majority'} onChange={(e) => set({ aggregate: e.target.value as RagJudgeSetup['aggregate'] })} aria-label="How the jury combines">
                  <option value="majority">majority</option>
                  <option value="mean">mean</option>
                  <option value="min">lowest</option>
                </Select>
              </label>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          <Toggle checked={judge.swap === true} onChange={(v) => set({ swap: v || undefined })} title="Judge the documents in their order and in the opposite order; a disagreement is a tie, which does not pass" label="Judge both document orders" />
          <label className="flex items-center gap-1" title="Ask n times (after the first, the cache is skipped) and report how often the verdicts flipped">
            Repeat
            <Input type="number" min={1} max={10} className="h-6 min-h-6 w-14 text-xs" value={judge.repeat ?? 1} onChange={(e) => set({ repeat: Math.max(1, Number(e.target.value)) || undefined })} aria-label="Judge repeats" />
          </label>
          <Toggle checked={judge.shortCircuit === true} onChange={(v) => set({ shortCircuit: v || undefined })} title="Skip the judged answer metrics of a sample whose free retrieval metrics already failed" label="Skip judging when retrieval failed" />
          <Toggle checked={judge.shareClaims === true} onChange={(v) => set({ shareClaims: v || undefined })} title="Split the answer into claims once and let faithfulness and answer relevance judge them (on by default from three metrics that read claims)" label="Share the answer’s claims" />
          <Toggle
            checked={judge.allowImages === true}
            onChange={(v) => set({ allowImages: v || undefined })}
            data-rag-allow-images=""
            title="Pictures in the question or in the retrieved chunks go to the judge as data. A picture cannot be masked, so this is off unless you turn it on; the judge must be a model that can see (a local vision model works). The estimate and Try say how many pictures are sent."
            label="Send pictures to the judge (multimodal metrics; they cannot be masked)"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Stop judging at (USD)">
            <Input type="number" step="0.1" className="h-7 min-h-7 text-xs" value={maxCostUsd ?? ''} placeholder="no limit" onChange={(e) => onChange({ maxJudgeCostUsd: e.target.value ? Number(e.target.value) : undefined })} aria-label="Most the judge may cost" />
          </Field>
          <Field label="Most judge calls">
            <Input type="number" className="h-7 min-h-7 text-xs" value={maxCalls ?? ''} placeholder="no limit" onChange={(e) => onChange({ maxJudgeCalls: e.target.value ? Number(e.target.value) : undefined })} aria-label="Most judge calls" />
          </Field>
        </div>
      </div>
    </details>
  );
}
