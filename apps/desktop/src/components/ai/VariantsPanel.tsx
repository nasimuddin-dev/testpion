import { FlaskConical, GitCompareArrows, Pencil, Play, Plus, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { EvalVariant, EvalVariantsSummary } from '@testpion/core';
import { call } from '../../api';
import { attempt, confirmAction } from '../../store';
import { formatCost, plural } from '../../lib/format';
import { useSticky } from '../../lib/sticky';
import { useRpc } from '../../lib/use-rpc';
import type { ProviderConfig } from '../../types';
import { EvalMatrix } from '../EvalMatrix';
import type { RunRow } from '../RunsOverview';
import { Button, cx, Empty, Field, Input, LinkButton, Modal, NamedOptions, Select, Textarea, useDebounced } from '../ui';

/** What the panel reads of the evaluation as edited. */
export interface VariantsDraft {
  name: string;
  type: 'llm' | 'rag';
  provider: string;
  model: string;
  system?: string;
  prompt: string;
  temperature?: number;
  variants?: EvalVariant[];
}

interface RunVariantsPlan {
  evaluation: string;
  variants: Array<{ letter: string; label: string; cases: number; calls: number; costUsd?: number; seconds: number; summary: string; free: boolean }>;
  total: { variants: number; cases: number; calls: number; costUsd: number; priced: boolean; seconds: number; free: boolean; ask: boolean };
}

const time = (s: number) => (s < 1 ? 'a moment' : s < 90 ? `~${Math.round(s)} s` : `~${Math.round(s / 60)} min`);
const letter = (i: number) => String.fromCharCode(65 + i);

/** What a variant changes, in a few words: "Haiku", "another prompt", "Haiku · another prompt". */
function changes(v: EvalVariant, draft: VariantsDraft, providers: ProviderConfig[]): string {
  const parts: string[] = [];
  if (v.provider && v.provider !== draft.provider) parts.push(providers.find((p) => p.id === v.provider)?.name ?? v.provider);
  if (v.model && v.model !== draft.model) parts.push(v.model);
  if (v.prompt && v.prompt !== draft.prompt) parts.push('another prompt');
  return parts.join(' · ') || 'no change yet';
}

/** One variant: its name, which model, which prompt version. Saved into the evaluation; the evaluation itself stays "Current". */
function VariantDialog({ initial, draft, providers, taken, onSave, onClose }: { initial?: EvalVariant; draft: VariantsDraft; providers: ProviderConfig[]; taken: string[]; onSave(v: EvalVariant): void; onClose(): void }) {
  const [v, setV] = useState<EvalVariant>(initial ?? { label: '' });
  const set = (p: Partial<EvalVariant>) => setV((x) => ({ ...x, ...p }));
  const label = v.label.trim();
  const clash = !!label && (taken.some((t) => t.toLowerCase() === label.toLowerCase()) || label.toLowerCase() === 'current');
  const reason = !label ? 'Give the variant a name' : clash ? `A variant called “${label}” exists already` : !v.provider && !v.model && !v.prompt ? 'Choose another model or write another prompt: otherwise there is nothing to compare' : undefined;
  const save = () => !reason && onSave({ ...v, label });
  return (
    <Modal
      title={initial ? `Edit “${initial.label}”` : 'Add a variant'}
      onClose={onClose}
      onSubmit={save}
      width={560}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={!!reason} reason={reason} data-variant-save>
            {initial ? 'Save' : 'Add variant'}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 text-sm" data-variant-dialog>
        <Field label="Name" hint="Shown in the comparison, for example “Shorter prompt” or “Haiku”">
          <Input value={v.label} onChange={(e) => set({ label: e.target.value })} aria-label="Variant name" data-variant-name />
        </Field>
        <div className="grid grid-cols-2 gap-2 [&>*]:min-w-0">
          <Field label="Model provider">
            <Select value={v.provider ?? ''} onChange={(e) => set({ provider: e.target.value || undefined, model: e.target.value ? (providers.find((p) => p.id === e.target.value)?.defaultModel ?? '') : undefined })} aria-label="Variant provider">
              <option value="">Same as the evaluation</option>
              <NamedOptions items={providers} />
            </Select>
          </Field>
          <Field label="Model">
            <Input className="mono" value={v.model ?? ''} placeholder={draft.model || 'the provider’s default'} onChange={(e) => set({ model: e.target.value || undefined })} aria-label="Variant model" data-variant-model />
          </Field>
        </div>
        <Field label="Prompt version" hint="Leave empty to use the same prompt as Current. The test cases are the same for every variant.">
          <Textarea rows={6} className="mono" value={v.prompt ?? ''} placeholder={draft.prompt} onChange={(e) => set({ prompt: e.target.value || undefined })} aria-label="Variant prompt" data-variant-prompt />
        </Field>
        <LinkButton icon={null} onClick={() => set({ prompt: draft.prompt })} className="justify-self-start text-xs">
          Start from the current prompt
        </LinkButton>
      </div>
    </Modal>
  );
}

/**
 * Compare mode (AU-16): the evaluation and its variants (another prompt version, another model) on the same cases. The bar
 * adds a variant; Run runs them all; the table says who passed more, cost less and was faster, with one sentence under it;
 * the matrix below shows the cases where they differ. The numbers and the sentence come from core (`eval.variantsSummary`),
 * the same as `testpion eval variants` and the `eval_variants` tool.
 */
export function VariantsPanel({ draft, onVariants, providers, environment, runs, onClose }: { draft: VariantsDraft; onVariants(v: EvalVariant[]): void; providers: ProviderConfig[]; environment?: string; runs: RunRow[]; onClose?(): void }) {
  const variants = draft.variants ?? [];
  const [dialog, setDialog] = useState<{ index?: number }>();
  // the runs of this session's last comparison: they are what the table shows (else the latest run of each variant)
  const [started, setStarted] = useSticky<string[] | undefined>(`eval:variants:${draft.name}`, undefined);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const key = JSON.stringify(started ?? null) + tick;
  const slim = useMemo(() => ({ name: draft.name, type: draft.type, provider: draft.provider, model: draft.model, system: draft.system, prompt: draft.prompt, temperature: draft.temperature, variants }), [draft.name, draft.type, draft.provider, draft.model, draft.system, draft.prompt, draft.temperature, variants]);
  const summary = useRpc<EvalVariantsSummary>('eval.variantsSummary', { draft: slim, ...(started ? { runs: started } : {}) }, { reloadOn: ['run.finished'], keep: true, enabled: variants.length > 0, scope: key });
  // while this session's runs are going, ask again now and then: the finish events can arrive before the summary files are written
  const waiting = !!started && !!summary && !summary.ready;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => setTick((n) => n + 1), 1500);
    return () => clearInterval(t);
  }, [waiting]);
  const picked = useDebounced(draft, 300);
  const plan = useRpc<RunVariantsPlan>('eval.runVariants', { draft: picked, environment, dryRun: true }, { keep: true, enabled: variants.length > 0 && !!picked.provider, reloadOn: ['data.changed'] });
  const dataRuns = useMemo(() => runs, [runs]);

  const run = async () => {
    if (plan?.total.ask) {
      const ok = await confirmAction({
        title: 'These runs cost money',
        message: `The ${plan.total.variants} variants make about ${plan.total.calls} calls and cost about ${formatCost(plan.total.costUsd)}.`,
        detail: 'Set “Only the first … cases” under Options to try a few cases first.',
        confirmLabel: `Run ${plan.total.variants} variants`,
      });
      if (!ok) return;
    }
    setBusy(true);
    await attempt(async () => {
      const r = await call<{ runs: Array<{ runId: string }> }>('eval.runVariants', { draft, environment, confirm: true });
      setStarted(r.runs.map((x) => x.runId));
    });
    setBusy(false);
  };

  if (!variants.length)
    return (
      <>
        <Empty
          icon={<GitCompareArrows size={26} />}
          title="Compare two versions"
          actions={[{ label: 'Add a variant', icon: <Plus size={13} />, onClick: () => setDialog({}) }, ...(onClose ? [{ label: 'Back to the run', onClick: onClose }] : [])]}
        >
          Run the same test cases on another model or another prompt version and see which passes more, costs less and is faster. The evaluation itself is the first version, “Current”.
        </Empty>
        {dialog && <VariantDialog draft={draft} providers={providers} taken={[]} onSave={(v) => (onVariants([v]), setDialog(undefined))} onClose={() => setDialog(undefined)} />}
      </>
    );

  const reason = !draft.provider ? 'Choose a model for Current first' : !plan ? 'Estimating the cost …' : undefined;
  return (
    <div className="h-full flex flex-col min-h-0" data-variants-panel>
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 border-b border-line text-xs">
        <span className="text-muted mr-1">Variants</span>
        <span className="inline-flex items-center rounded-md border border-line bg-panel2 px-2 h-6" data-variant-chip="A" title="The evaluation as it is">
          A: Current
        </span>
        {variants.map((v, i) => (
          <span key={v.label} className="inline-flex items-center gap-1 rounded-md border border-line bg-panel2 pl-2 pr-0.5 h-6" data-variant-chip={letter(i + 1)}>
            <button className="inline-flex items-center gap-1 hover:text-accent" onClick={() => setDialog({ index: i })} aria-label={`Edit ${v.label}`} title={`Edit ${v.label}`}>
              {letter(i + 1)}: {v.label}
              <span className="text-muted">· {changes(v, draft, providers)}</span>
              <Pencil size={10} className="text-muted" />
            </button>
            <button className="p-0.5 rounded hover:bg-hover text-muted" aria-label={`Remove ${v.label}`} title="Remove this variant" onClick={() => onVariants(variants.filter((_, j) => j !== i))} data-variant-remove>
              <X size={11} />
            </button>
          </span>
        ))}
        {variants.length < 5 && (
          <Button size="sm" icon={<Plus size={12} />} onClick={() => setDialog({})} data-variant-add>
            Add variant
          </Button>
        )}
        <Button size="sm" variant="primary" className="ml-auto" icon={<Play size={12} />} loading={busy} onClick={() => void run()} disabled={!!reason} reason={reason} data-variants-run>
          Run {plan ? plural(plan.total.variants, 'variant') : 'variants'}
          {plan && plan.total.cases ? ` on ${plural(plan.total.cases, 'case')}` : ''}
          {plan ? ` · ${plan.total.free ? 'free' : plan.total.priced ? `about ${formatCost(plan.total.costUsd)}` : 'cost unknown'} · ${time(plan.total.seconds)}` : ''}
        </Button>
        {onClose && (
          <LinkButton icon={null} onClick={onClose}>
            Back to the run
          </LinkButton>
        )}
      </div>
      {summary && !summary.ready ? (
        <p className="px-3 py-2 text-sm text-muted border-b border-line" data-variants-waiting>
          {started ? summary.conclusion : `No run yet for ${summary.waiting.join(', ')}. Run the variants to compare them.`}
        </p>
      ) : summary ? (
        <div className="border-b border-line px-3 py-2" data-variants-summary>
          <table className="text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="pr-4 py-1 font-medium" />
                {summary.columns.map((c) => (
                  <th key={c.letter} className="pr-4 py-1 font-medium">
                    {c.letter}: {c.label}
                  </th>
                ))}
                <th className="py-1 font-medium">Winner</th>
              </tr>
            </thead>
            <tbody>
              {summary.rows.map((r) => (
                <tr key={r.metric} data-variants-row={r.metric}>
                  <td className="pr-4 py-0.5 text-muted">{r.label}</td>
                  {r.values.map((v, i) => (
                    <td key={i} className={cx('pr-4 py-0.5 tabular-nums', r.winner === summary.columns[i]!.letter && 'font-semibold text-ok')}>
                      {v}
                    </td>
                  ))}
                  <td className="py-0.5 text-xs text-muted" data-variants-winner>
                    {r.winnerText}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1.5 text-sm" data-variants-conclusion>
            {summary.conclusion}
          </p>
          <p className="text-xs text-muted">There is no overall best: each row names its own winner. Pick by what matters to you.</p>
        </div>
      ) : null}
      <div className="flex-1 min-h-0">
        {summary?.ready ? (
          <EvalMatrix runs={dataRuns} onRun={() => void run()} pinned={{ runs: summary.runs, baseline: summary.runs[0] }} />
        ) : (
          <Empty icon={<FlaskConical size={24} />} title="Cases side by side" actions={[{ label: 'Run the variants', icon: <Play size={13} />, onClick: () => void run(), disabled: !!reason, title: reason }]}>
            After the variants have run, every case is listed with its result in each variant, and “Failed” shows the cases that differ.
          </Empty>
        )}
      </div>
      {dialog && (
        <VariantDialog
          initial={dialog.index !== undefined ? variants[dialog.index] : undefined}
          draft={draft}
          providers={providers}
          taken={variants.filter((_, i) => i !== dialog.index).map((v) => v.label)}
          onSave={(v) => (onVariants(dialog.index !== undefined ? variants.map((x, i) => (i === dialog.index ? v : x)) : [...variants, v]), setDialog(undefined))}
          onClose={() => setDialog(undefined)}
        />
      )}
    </div>
  );
}
