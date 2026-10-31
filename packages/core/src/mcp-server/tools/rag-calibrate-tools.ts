/**
 * MCP tools of judge calibration (the same engine functions as `testpion rag label|calibrate`): record a person's pass/fail
 * label of a judged result, and compare a run's judge verdicts with the labels (Cohen's kappa, accuracy, TPR/TNR, confusion
 * matrix, bootstrap intervals, the disagreements, and the pass mark that would agree most). Statistics only: no model call.
 * An agent labels only what the person told it to: a label is the person's verdict, not the agent's.
 */
import { ApsError } from '../../errors.js';
import { calibrateRun, defaultLabelsName, labelResult } from '../../runner/rag-calibrate.js';
import { labelDocument } from '../../eval/chunk-labels.js';
import { embeddingMap } from '../../eval/embedding-map.js';
import { createEngineContext } from '../../engine.js';
import { makeExample } from '../../runner/rag-calibrate-example.js';
import type { AppSettings } from '../../model/types.js';
import type { SecretStore } from '../../storage/secrets.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import { str, type Tool } from '../tool.js';

export function ragCalibrateTools({ store, secrets, settings }: { store: WorkspaceStore; secrets: SecretStore; settings: AppSettings; checkEnvironment(name: unknown): string | undefined }): Tool[] {
  return [
    {
      name: 'rag_label',
      doc: { when: 'Recording the verdict a PERSON gave on a judged RAG result (pass or fail on one metric, or on the whole answer), so the judge can be calibrated against it.', whenNot: 'Deciding a verdict yourself: a label is the person’s judgement. To compare the judge with the labels use rag_calibrate.', example: { run_id: 'run_2026-10-20_ab12', result: 'eval:q-17', metric: 'faithfulness', label: 'fail', note: 'the dose is wrong' } },
      write: true,
      description:
        'Label a result of a finished RAG run: `label` pass or fail for `metric` (see `metric`). It is stored in labels/<labels>.json attached to the dataset record, so it counts for later runs of the same dataset.',
      inputSchema: {
        type: 'object',
        properties: {
          run_id: str('The finished run'),
          result: str('A result id of the run, or its dataset record id'),
          metric: str('The metric (check name or id) or `overall` (default)'),
          label: { type: 'string', enum: ['pass', 'fail'], description: 'The verdict' },
          note: str('Why'),
          labels: str('The label set name (default: the run’s evaluation)'),
          by: str('Who made the verdict'),
          document: str('Mark a retrieved document: <id>=right|partly|wrong|clear'),
          add_to_right_documents: { type: 'boolean' },
        },
        required: ['run_id', 'result'],
      },
      run: async (a) => {
        if (a.document !== undefined) {
          const m = /^(.+)=(right|partly|wrong|clear)$/.exec(String(a.document));
          if (!m) throw new ApsError('ValidationError', '`document` is <id>=right|partly|wrong|clear');
          return labelDocument(store, { run: String(a.run_id ?? ''), result: String(a.result ?? ''), doc: m[1]!, label: m[2] === 'clear' ? null : m[2] === 'right' ? 'relevant' : m[2] === 'wrong' ? 'not' : 'partly', addToRight: a.add_to_right_documents === true });
        }
        if (a.label !== 'pass' && a.label !== 'fail') throw new ApsError('ValidationError', '`label` is pass or fail');
        const r = await labelResult(store, { run: String(a.run_id ?? ''), result: String(a.result ?? ''), metric: a.metric ? String(a.metric) : 'overall', label: a.label, labels: a.labels ? String(a.labels) : undefined, by: a.by ? String(a.by) : undefined, note: a.note ? String(a.note) : undefined });
        return { saved: true, path: `labels/${r.labels}.json`, label: r.label };
      },
    },
    {
      name: 'rag_calibrate',
      doc: { when: 'Finding out whether a judge can be trusted on a metric: how well its pass/fail verdicts in a run agree with the labels people made, per metric and per judge model, and where it disagrees.', whenNot: 'Scoring answers (rag_run) or making labels (rag_label).', example: { run_id: 'run_2026-10-20_ab12', metrics: ['faithfulness'], tune: true } },
      description:
        'Calibrate the judges of a finished RAG run against labels (labels/<labels>.json, and good/bad reviews of results as `overall` labels). Per metric: n, Cohen’s kappa, accuracy, TPR, TNR, precision, the confusion matrix, a bootstrap 95% interval, per-judge numbers, the disagreements, and a verdict (kappa 0.6 or more is good, 0.4 to 0.6 fair, under that poor). With `tune` it also finds the pass mark that agrees most (nothing changes; the person applies it). No model is called (except with `map`).',
      inputSchema: {
        type: 'object',
        properties: {
          run_id: str('The finished run whose judged results are compared'),
          labels: str('The label set (default: the run’s evaluation)'),
          metrics: { type: 'array', items: { type: 'string' }, description: 'Only these metrics' },
          tune: { type: 'boolean', description: 'Also find the best pass mark per metric' },
          map: str('Instead: look-alike documents and far questions, embedded by provider/model (or judge)'),
          reviews: { type: 'boolean', description: 'Count good/bad reviews of results as `overall` labels (default true)' },
        },
        required: ['run_id'],
      },
      run: async (a) => {
        const run = String(a.run_id ?? '');
        if (a.map !== undefined) {
          const ctx = createEngineContext({ store, secrets, settings, aiSurface: 'mcp' });
          try {
            const m = await embeddingMap(store, { run, embedder: a.map === 'judge' ? undefined : String(a.map), providers: ctx.services.providers });
            return { ...m, points: m.points.length };
          } finally {
            await ctx.dispose();
          }
        }
        return calibrateRun(store, { run, labels: a.labels ? String(a.labels) : defaultLabelsName(store, run), metrics: Array.isArray(a.metrics) ? a.metrics.map(String) : undefined, tune: a.tune === true, reviews: a.reviews !== false });
      },
    },
    {
      name: 'rag_make_metric_example',
      doc: {
        when: 'A custom metric judged a sample differently from the person (see rag_calibrate’s disagreements) and the person wants that case kept as a test of the metric: the sample becomes an example of the metric’s file, with the person’s verdict as what it must say.',
        whenNot: 'Built-in metrics (they have no file), or deciding the verdict yourself: the verdict is the person’s label or what they tell you.',
        example: { metric: 'custom/polite-tone', run_id: 'run_2026-10-20_ab12', result: 'eval:q-17', expect: 'fail' },
      },
      write: true,
      description:
        'Add one example to the `examples:` list of a custom metric’s file (metrics/<id>.yaml) from a result of a finished run: the question, the answer, the reference and the retrieved chunks (a conversation: its last turns) with `expect` pass or fail, or the person’s label of that result when `expect` is left out. `rag_validate_metric` with examples then runs it, so a later edit of the metric cannot quietly break the case. The file is edited as text (comments stay); at most 50 examples; the same sample is not added twice.',
      inputSchema: {
        type: 'object',
        properties: {
          metric: str('The custom metric: custom/<id> or the file id'),
          run_id: str('The finished run the sample is from'),
          result: str('A result id of the run, or its dataset record id'),
          expect: { type: 'string', enum: ['pass', 'fail'], description: 'What the metric must say about this sample (default: the person’s label of it)' },
          name: str('A name for the example (default: the run and the record)'),
          labels: str('The label set to read the verdict from (default: the run’s evaluation)'),
        },
        required: ['metric', 'run_id', 'result'],
      },
      run: async (a) => {
        if (a.expect !== undefined && a.expect !== 'pass' && a.expect !== 'fail') throw new ApsError('ValidationError', '`expect` is pass or fail');
        const r = await makeExample(store, { metric: String(a.metric ?? ''), run: String(a.run_id ?? ''), result: String(a.result ?? ''), expect: a.expect as 'pass' | 'fail' | undefined, name: a.name ? String(a.name) : undefined, labels: a.labels ? String(a.labels) : undefined });
        return { saved: true, ...r };
      },
    },
  ];
}
