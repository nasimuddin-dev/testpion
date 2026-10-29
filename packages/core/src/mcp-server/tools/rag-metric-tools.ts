/**
 * MCP tools for the custom metrics of a workspace (`metrics/*.yaml`, the same engine functions as `testpion rag metric`):
 * list them, create or change one (the file is checked first, and a change to a file that exists needs `overwrite`),
 * and validate a file or a draft, optionally running its examples. An agent drafts a metric with `ai_run_task`
 * (task `rag-draft-metric`), saves it here, and tries it on a sample with `rag_try_metric` (`custom/<id>`).
 * A judge or checklist metric's examples ask the judge, so running them is a deliberate step.
 */
import { stringifyYaml } from '../../util/lazy-yaml.js';
import { CUSTOM_METRIC_KINDS, customMetricTemplate, type CustomMetricKind } from '@testpion/shared';
import { ApsError } from '../../errors.js';
import { createEngineContext } from '../../engine.js';
import { compileCustomMetric, runMetricExamples, syncCustomMetrics } from '../../eval/rag/custom/compile.js';
import { parseCustomMetric, type MetricProblem } from '../../eval/rag/custom/file.js';
import { listMetricFiles, readMetricFile, writeMetricFile } from '../../storage/metric-files.js';
import type { AppSettings } from '../../model/types.js';
import type { SecretStore } from '../../storage/secrets.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import { str, type Tool } from '../tool.js';

const show = (p: MetricProblem[]) => p.map((x) => ({ level: x.level, field: x.field, message: x.message }));

export function ragMetricTools({ store, secrets, settings, checkEnvironment }: { store: WorkspaceStore; secrets: SecretStore; settings: AppSettings; checkEnvironment(name: unknown): string | undefined }): Tool[] {
  const known = () => new Set(listMetricFiles(store).map((f) => f.id));
  return [
    {
      name: 'rag_list_custom_metrics',
      doc: { when: 'Seeing which custom metrics the workspace has, whether each is usable, and what is wrong with the ones that are not.', whenNot: 'Listing the built-in catalogue (rag_metrics lists those too, custom ones included under the group custom).', example: { include_text: false } },
      description: 'The custom metrics of the workspace (metrics/*.yaml): id, name, kind (judge, checklist, rule, formula, embedding-set, script), version, whether it is registered (usable as custom/<id> wherever a metric is named), errors, warnings and example count. `include_text` adds each file’s YAML.',
      inputSchema: { type: 'object', properties: { include_text: { type: 'boolean', description: 'Add the YAML of each file' } } },
      run: (a) => {
        const sync = syncCustomMetrics(store);
        const k = known();
        const files = listMetricFiles(store).map((f) => {
          const p = parseCustomMetric(f.text, { fileId: f.id, known: k });
          return {
            id: f.id,
            metric: `custom/${f.id}`,
            path: f.path,
            name: p.metric?.name ?? f.id,
            kind: p.metric?.kind,
            version: p.metric?.version,
            examples: p.metric?.examples?.length ?? 0,
            registered: sync.registered.includes(`custom/${f.id}`),
            problems: show(sync.files.find((x) => x.id === f.id)?.problems ?? p.problems),
            ...(a.include_text === true ? { text: f.text } : {}),
          };
        });
        return { count: files.length, kinds: CUSTOM_METRIC_KINDS.map((k) => ({ id: k.id, summary: k.summary })), metrics: files };
      },
    },
    {
      name: 'rag_save_custom_metric',
      doc: { when: 'Creating or changing a custom metric file after the person agreed to it (a draft from ai_run_task rag-draft-metric, or one you wrote).', whenNot: 'Trying a metric on a sample (rag_try_metric) or checking a draft without writing it (rag_validate_metric).', example: { id: 'clinic-tone', content: 'id: clinic-tone\nkind: judge\ncriteria: Polite and never promises a diagnosis.\n' } },
      write: true,
      description:
        'Write metrics/<id>.yaml. The file is checked first: an error (a missing criterion, an unknown metric in a formula, a rule that needs a model) refuses the write and says why. Give `content` (the YAML) or `kind` (a starting file of that kind is written). A file that exists is replaced only with `overwrite: true` (and `confirm: true`: ask the user). Check a draft first with rag_validate_metric. The metric is usable at once as custom/<id>.',
      inputSchema: {
        type: 'object',
        properties: {
          id: str('The metric id: lower-case letters, digits and hyphens; the file name'),
          content: str('The YAML of the file'),
          kind: { type: 'string', enum: CUSTOM_METRIC_KINDS.map((k) => k.id), description: 'Write a starting file of this kind instead of `content`' },
          overwrite: { type: 'boolean', description: 'true: replace a file that exists (needs confirm: true)' },
        },
        required: ['id'],
      },
      run: (a) => {
        const id = String(a.id ?? '');
        if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) throw new ApsError('ValidationError', `"${id}" is not a metric id: lower-case letters, digits and hyphens`);
        const text = typeof a.content === 'string' && a.content.trim() ? a.content : stringifyYaml(customMetricTemplate((a.kind as CustomMetricKind | undefined) ?? 'judge', id));
        const p = parseCustomMetric(text, { fileId: id, known: known() });
        if (!p.metric) throw new ApsError('ValidationError', `The metric file is not valid: ${p.problems.filter((x) => x.level === 'error').map((x) => `${x.field ? `${x.field}: ` : ''}${x.message}`).join('; ')}`, { suggestions: ['Fix the file and save again; rag_validate_metric checks a draft without writing it.'] });
        const exists = !!readMetricFile(store, id);
        if (exists && a.overwrite !== true) throw new ApsError('ValidationError', `metrics/${id}.yaml exists: pass overwrite: true to replace it`);
        const f = writeMetricFile(store, id, text);
        const sync = syncCustomMetrics(store);
        return { written: true, path: f.path, metric: `custom/${id}`, registered: sync.registered.includes(`custom/${id}`), problems: show(p.problems) };
      },
    },
    {
      name: 'rag_validate_metric',
      doc: { when: 'Checking a custom metric file (or a draft) and, with run_examples, whether its examples come out as written.', whenNot: 'Writing it (rag_save_custom_metric) or scoring a real sample (rag_try_metric).', example: { id: 'clinic-tone', run_examples: false } },
      write: true,
      description:
        'Check a custom metric: the fields, the references of a formula, the rules, the cycles. Name a saved file by `id`, or pass a draft as `content`. With `run_examples: true` the examples run through the metric and each must come out as its `expect`; a rule or script metric runs for free, a judge or checklist metric asks the judge (costs money: estimate with rag_estimate first, or use judge: a local model).',
      inputSchema: {
        type: 'object',
        properties: {
          id: str('A saved metric file'),
          content: str('A draft: the YAML text (instead of id)'),
          run_examples: { type: 'boolean', description: 'Run the examples (a judged metric asks the judge)' },
          judge: str('The judge as provider/model for a judged metric’s examples'),
          environment: str('Environment name'),
        },
      },
      run: async (a) => {
        let text = typeof a.content === 'string' ? a.content : undefined;
        let fileId = typeof a.id === 'string' ? a.id : undefined;
        if (text === undefined) {
          if (!fileId) throw new ApsError('ValidationError', 'rag_validate_metric needs an id or content');
          text = readMetricFile(store, fileId)?.text;
          if (text === undefined) throw new ApsError('ValidationError', `No metric file metrics/${fileId}.yaml`);
        } else fileId ??= /^id:\s*["']?([a-z0-9-]+)/m.exec(text)?.[1];
        const p = parseCustomMetric(text, { fileId, known: known() });
        const out: Record<string, unknown> = { ok: !!p.metric, problems: show(p.problems), ...(p.metric ? { metric: { id: p.metric.id, kind: p.metric.kind, version: p.metric.version, examples: p.metric.examples?.length ?? 0 } } : {}) };
        if (p.metric && a.run_examples === true) {
          const ctx = createEngineContext({ store, secrets, settings, environment: checkEnvironment(a.environment), aiSurface: 'mcp' });
          try {
            const j = typeof a.judge === 'string' && a.judge ? { provider: a.judge.split('/')[0], ...(a.judge.includes('/') ? { model: a.judge.split('/').slice(1).join('/') } : {}) } : undefined;
            const examples = await runMetricExamples(compileCustomMetric(p.metric), { providers: ctx.services.providers, ragJudge: ctx.services.ragJudge, judge: j });
            out.examples = examples;
            out.ok = examples.every((e) => e.ok);
          } finally {
            await ctx.dispose();
          }
        }
        return out;
      },
    },
  ];
}
