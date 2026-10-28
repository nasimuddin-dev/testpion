import { CodeBlock } from './CodeBlock';
import { Copy, Download, TerminalSquare } from 'lucide-react';
import { useEffect, useState } from 'react';
import { asError, call } from '../api';
import { selectEnvironments, useApp, attempt } from '../store';
import { finishSave, type SaveResult } from '../lib/files';
import { Button, Field, Input, Modal, Select, Tabs } from './ui';
import { useCollectionTree } from '../lib/collections-store';
import { usePersisted } from '../lib/sticky';
import { useLibrary } from '../lib/library';
import { copyText } from '../lib/clipboard';
import { runInTerminal, useShellCapable } from '../lib/terminal';

interface CiConfig {
  path: string;
  content: string;
  secrets: Array<{ name: string; description: string }>;
  command: string;
  /** The same run on this computer (to try before pushing). */
  localCommand?: string;
}

type Provider = 'github' | 'gitlab' | 'azure' | 'jenkins';
const PROVIDERS: Array<{ id: Provider; label: string }> = [
  { id: 'github', label: 'GitHub Actions' },
  { id: 'gitlab', label: 'GitLab CI' },
  { id: 'azure', label: 'Azure Pipelines' },
  { id: 'jenkins', label: 'Jenkins' },
];

interface TreeNode {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  children?: TreeNode[];
}
/** The test files a pipeline can run on their own (not suites). */
const filesOf = (nodes: TreeNode[]): string[] => nodes.flatMap((n) => (n.kind === 'dir' ? filesOf(n.children ?? []) : /\.(ya?ml|json)$/i.test(n.path) && !/\.suite\./i.test(n.path) ? [n.path] : []));
const suitesOf = (nodes: TreeNode[]): string[] => nodes.flatMap((n) => (n.kind === 'dir' ? suitesOf(n.children ?? []) : n.path.endsWith('.suite.yaml') && !n.path.includes('/') ? [n.path.replace(/\.suite\.yaml$/, '')] : []));

/**
 * "Run in CI": a pipeline file that runs a suite, a collection, some test files (a flow's Deploy ▸ CI preselects
 * it) or all tests on every push. The config
 * comes from the engine (ci.config), so the app, `testpion ci` and the ci_config MCP tool agree.
 */
export function CiDialog() {
  const req = useApp((s) => s.ci)!;
  const close = () => useApp.getState().set({ ci: undefined });
  const environments = useApp(selectEnvironments);
  const [provider, setProvider] = usePersisted<Provider>('aps.ci.provider', 'github', { parse: (v) => (v as Provider) || undefined, text: true });
  const [target, setTarget] = useState<string>(
    req.evaluation ? `evaluation:${req.evaluation}` : req.collection ? `collection:${req.collection}` : req.suite ? `suite:${req.suite}` : req.tests?.length === 1 ? `file:${req.tests[0]}` : req.tests?.length ? 'selected' : 'tests',
  );
  const [environment, setEnvironment] = useState(req.environment ?? useApp.getState().environment ?? '');
  // one flow file: how the pipeline runs it (once, per data row, in several environments), and what it keeps
  const [flowRun, setFlowRun] = useState<'once' | 'data' | 'matrix'>('once');
  const [dataFile, setDataFile] = useState('');
  const [matrix, setMatrix] = useState<string[]>([]);
  const [allowProduction, setAllowProduction] = useState(false);
  // scripts of a workspace do not see secrets or reach other hosts in a pipeline unless the owner says so (--trust-scripts)
  const [trustScripts, setTrustScripts] = useState(false);
  const [timeline, setTimeline] = useState(false);
  const [datasets, setDatasets] = useState<string[]>([]);
  // a saved RAG evaluation: the pipeline runs `testpion rag run` (its metrics, gates and a report); the judge key is a CI secret
  const evaluations = useLibrary<{ type?: string }>('evaluations');
  const ragEvaluations = evaluations.lib.items.filter((i) => i.data.type === 'rag');
  const promptEvaluations = evaluations.lib.items.filter((i) => i.data.type !== 'rag');
  const [rag, setRag] = useState({ preset: '', min: '', baseline: '', maxCost: '', compat: '', repeatTarget: '', comment: true, nightly: false, cron: '0 3 * * *', sample: '', regression: true, maxDrop: '' });
  useEffect(() => void call<Array<{ path: string }>>('datasets.list').then((d) => setDatasets(d.map((x) => x.path)), () => setDatasets([])), []);
  const shellCapable = useShellCapable();
  const production = !!environments.find((e) => e.name === environment)?.isProduction || (target.startsWith('file:') && flowRun === 'matrix' && environments.some((e) => matrix.includes(e.name) && e.isProduction));
  const [workspaceDir, setWorkspaceDir] = useState('.');
  const [openapi, setOpenapi] = useState('');
  const [suites, setSuites] = useState<string[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const collections = useCollectionTree();
  const [cfg, setCfg] = useState<CiConfig>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    void call<TreeNode[]>('tests.tree').then((t) => (setSuites(suitesOf(t)), setFiles(filesOf(t))));
  }, []);
  const options = () => {
    const [kind, value] = target.includes(':') ? [target.slice(0, target.indexOf(':')), target.slice(target.indexOf(':') + 1)] : [target, ''];
    return {
      provider,
      environment: environment || undefined,
      workspaceDir: workspaceDir.trim() || '.',
      openapi: openapi.trim() || undefined,
      // any target: data-changing requests may go to a production environment only when asked
      ...(allowProduction && production ? { allowProduction: true } : {}),
      ...(trustScripts ? { trustScripts: true } : {}),
      ...(kind === 'evaluation'
        ? { evaluation: value }
        : kind === 'rag'
        ? {
            ragEvaluation: value,
            ragPreset: rag.preset.trim() || undefined,
            ragMin: rag.min.split(/[,\s]+/).filter(Boolean),
            ragBaseline: rag.baseline.trim() || undefined,
            ragMaxCost: rag.maxCost ? Number(rag.maxCost) : undefined,
            ragCompat: rag.compat || undefined,
            ragRepeatTarget: rag.repeatTarget ? Number(rag.repeatTarget) : undefined,
            ragComment: provider === 'github' && rag.comment ? true : undefined,
            ...(rag.nightly ? { ragNightly: rag.cron.trim() || '0 3 * * *', ragSample: rag.sample ? Number(rag.sample) : undefined, ragRegression: rag.regression && provider !== 'jenkins' ? true : undefined, ragMaxDrop: rag.regression && rag.maxDrop ? Number(rag.maxDrop) : undefined } : {}),
          }
        : kind === 'suite'
        ? { suite: value }
        : kind === 'collection'
          ? { collection: value, folders: value === req.collection ? req.folders : undefined }
          : kind === 'file'
            ? {
                tests: [value],
                // a run's name / tag filter (Run in CI from a run) stays with its file
                ...(req.tests?.length === 1 && req.tests[0] === value ? { grep: req.grep, tags: req.tags } : {}),
                ...(flowRun === 'data' ? { data: dataFile } : flowRun === 'matrix' && matrix.length ? { envMatrix: matrix } : {}),
                ...(timeline ? { timelineHtml: true } : {}),
              }
            : kind === 'selected'
              ? { tests: req.tests, grep: req.grep, tags: req.tags }
              : {}),
    };
  };
  useEffect(() => {
    call<CiConfig>('ci.config', options()).then(
      (c) => (setCfg(c), setError(undefined)),
      (e) => (setCfg(undefined), setError(asError(e).message)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, target, environment, workspaceDir, openapi, flowRun, dataFile, matrix.join(','), allowProduction, trustScripts, timeline, JSON.stringify(rag)]);

  const copy = () => (cfg ? copyText(cfg.content, 'the pipeline file') : undefined);
  const save = async () => {
    await attempt(async () => {
      finishSave(await call<SaveResult>('ci.save', options()), 'Pipeline');
    });
  };

  return (
    <Modal
      title="Run in CI"
      onClose={close}
      onSubmit={() => void save()}
      width={820}
      footer={
        <>
          <span className="text-xs text-muted mr-auto">{cfg && <>Put it at <code>{cfg.path}</code> in your repository.</>}</span>
          <Button icon={<Copy size={14} />} onClick={() => void copy()} disabled={!cfg} reason="The file is not ready yet">
            Copy
          </Button>
          <Button variant="primary" icon={<Download size={14} />} onClick={() => void save()} disabled={!cfg} reason="The file is not ready yet">
            Save file…
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Tabs label="CI provider" tabs={PROVIDERS} value={provider} onChange={setProvider} />
        <div className="grid grid-cols-3 gap-3">
          <Field label="Run">
            <Select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="tests">All tests (tests/)</option>
              {(req.tests?.length ?? 0) > 1 && <option value="selected">These tests: {req.tests!.join(', ')}</option>}
              {(files.length > 0 || req.tests?.length === 1) && (
                <optgroup label="One test file">
                  {[...new Set([...(req.tests?.length === 1 ? req.tests : []), ...files])].map((f) => (
                    <option key={f} value={`file:${f}`}>
                      {f}
                    </option>
                  ))}
                </optgroup>
              )}
              {promptEvaluations.length > 0 && (
                <optgroup label="Prompt evaluations">
                  {promptEvaluations.map((i) => (
                    <option key={i.id} value={`evaluation:${i.name}`}>
                      Evaluation: {i.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {ragEvaluations.length > 0 && (
                <optgroup label="RAG evaluations">
                  {ragEvaluations.map((i) => (
                    <option key={i.id} value={`rag:${i.name}`}>
                      RAG: {i.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {suites.length > 0 && (
                <optgroup label="Suites">
                  {suites.map((s) => (
                    <option key={s} value={`suite:${s}`}>
                      Suite: {s}
                    </option>
                  ))}
                </optgroup>
              )}
              {collections.length > 0 && (
                <optgroup label="Collections">
                  {collections.map((c) => (
                    <option key={c.id} value={`collection:${c.id}`}>
                      {c.name}
                      {c.id === req.collection && req.folders?.length ? ' (selected folder)' : ''}
                    </option>
                  ))}
                </optgroup>
              )}
            </Select>
          </Field>
          <Field label="Environment">
            <Select value={environment} onChange={(e) => setEnvironment(e.target.value)}>
              <option value="">None</option>
              {environments.map((e) => (
                <option key={e.id} value={e.name} disabled={!!e.problem} title={e.problem}>
                  {e.name}
                  {e.problem ? '  (cannot be read)' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Workspace folder in the repository">
            <Input className="mono" value={workspaceDir} onChange={(e) => setWorkspaceDir(e.target.value)} placeholder="." />
          </Field>
          <Field label="OpenAPI document (optional)" hint="Pull requests fail when it has breaking changes against the target branch.">
            <Input className="mono" value={openapi} onChange={(e) => setOpenapi(e.target.value)} placeholder="openapi.yaml" />
          </Field>
        </div>
        {target.startsWith('evaluation:') && (
          <p className="text-xs text-muted" data-ci-evaluation-note>
            The pipeline runs this evaluation and fails when a case got worse than the last good run (the last run that passed; the first run has none). It stops at the cap of the evaluation (default $1.00 for a paid model), and the model&apos;s key is a CI secret, listed below.
          </p>
        )}
        {target.startsWith('rag:') && (
          <div className="grid grid-cols-3 gap-3 rounded-lg border border-line p-3 text-sm" data-ci-rag-options>
            <Field label="Gates" hint="The pipeline fails when the mean of a metric is under its minimum: faithfulness=0.8 context-recall=0.7">
              <Input className="mono" value={rag.min} onChange={(e) => setRag({ ...rag, min: e.target.value })} placeholder="faithfulness=0.8" aria-label="Gates" />
            </Field>
            <Field label="Metric preset (optional)" hint="Replaces the evaluation's metrics (testpion rag presets).">
              <Input className="mono" value={rag.preset} onChange={(e) => setRag({ ...rag, preset: e.target.value })} placeholder="rag-triad" aria-label="Metric preset" />
            </Field>
            <Field label="Baseline run (optional)" hint="Fails on a regression against this run.">
              <Input className="mono" value={rag.baseline} onChange={(e) => setRag({ ...rag, baseline: e.target.value })} placeholder="run id" aria-label="Baseline run" />
            </Field>
            <Field label="Judge budget (USD)" hint="Judging stops at this much; the rest is n/a.">
              <Input type="number" min={0} step={0.5} value={rag.maxCost} onChange={(e) => setRag({ ...rag, maxCost: e.target.value })} placeholder="no cap" aria-label="Judge budget" />
            </Field>
            <Field label="Metric names" hint="Ragas: Ragas metric names with Ragas options.">
              <Select value={rag.compat} onChange={(e) => setRag({ ...rag, compat: e.target.value })} aria-label="Metric names">
                <option value="">TestPion</option>
                <option value="ragas">Ragas</option>
              </Select>
            </Field>
            <Field label="Calls per question" hint="2 to 10 measures the system's own noise.">
              <Input type="number" min={1} max={10} value={rag.repeatTarget} onChange={(e) => setRag({ ...rag, repeatTarget: e.target.value })} placeholder="1" aria-label="Calls per question" />
            </Field>
            <label className="flex items-center gap-1.5 text-xs col-span-3">
              <input type="checkbox" checked={rag.nightly} onChange={(e) => setRag({ ...rag, nightly: e.target.checked })} data-ci-rag-nightly />
              A nightly job on a schedule instead of every push (sampled, compared with the previous night)
            </label>
            {rag.nightly && (
              <>
                <Field label="Schedule (cron, UTC)" hint="Minute hour day month weekday. GitLab: create the pipeline schedule with it in the project.">
                  <Input className="mono" value={rag.cron} onChange={(e) => setRag({ ...rag, cron: e.target.value })} placeholder="0 3 * * *" aria-label="Cron schedule" data-ci-rag-cron />
                </Field>
                <Field label="Questions per night" hint="A different set each day, so a month covers the dataset. Empty scores them all.">
                  <Input type="number" min={1} value={rag.sample} onChange={(e) => setRag({ ...rag, sample: e.target.value })} placeholder="all" aria-label="Questions per night" data-ci-rag-sample />
                </Field>
                <Field label="Largest drop allowed" hint={provider === 'jenkins' ? 'Jenkins needs the Copy Artifact plugin to fetch the previous night: no regression gate is generated.' : 'Fails when a metric fell against the previous night’s results (kept as the pipeline artifact).'}>
                  <Input type="number" min={0.01} max={1} step={0.01} disabled={!rag.regression || provider === 'jenkins'} value={rag.maxDrop} onChange={(e) => setRag({ ...rag, maxDrop: e.target.value })} placeholder="0.05" aria-label="Largest drop allowed" data-ci-rag-maxdrop />
                </Field>
                <label className="flex items-center gap-1.5 text-xs col-span-3">
                  <input type="checkbox" checked={rag.regression && provider !== 'jenkins'} disabled={provider === 'jenkins'} onChange={(e) => setRag({ ...rag, regression: e.target.checked })} data-ci-rag-regression />
                  Fail on a regression against the previous night
                </label>
              </>
            )}
            {provider === 'github' && (
              <label className="flex items-center gap-1.5 text-xs col-span-3">
                <input type="checkbox" checked={rag.comment} onChange={(e) => setRag({ ...rag, comment: e.target.checked })} data-ci-rag-comment />
                Post the metrics table as a comment on the pull request
              </label>
            )}
          </div>
        )}
        {target.startsWith('file:') && (
          <div className="grid gap-2 rounded-lg border border-line p-3 text-sm" data-ci-flow-options>
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs font-medium text-muted">Run the flow</span>
              {(['once', 'data', 'matrix'] as const).map((m) => (
                <label key={m} className="flex items-center gap-1.5 text-xs">
                  <input type="radio" name="ci-flow-run" checked={flowRun === m} onChange={() => setFlowRun(m)} data-ci-flow-run={m} />
                  {m === 'once' ? 'once' : m === 'data' ? 'once per data row' : 'in several environments'}
                </label>
              ))}
            </div>
            {flowRun === 'data' && (
              <Field label="Data">
                <Select value={dataFile} onChange={(e) => setDataFile(e.target.value)} aria-label="Data file">
                  <option value="">The flow file's own data:</option>
                  {datasets.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {flowRun === 'matrix' && (
              <div className="flex flex-wrap gap-3" data-ci-matrix>
                {environments.map((e) => (
                  <label key={e.id} className="flex items-center gap-1.5 text-xs">
                    <input type="checkbox" checked={matrix.includes(e.name)} onChange={(ev) => setMatrix(ev.target.checked ? [...matrix, e.name] : matrix.filter((x) => x !== e.name))} />
                    {e.name}
                    {e.isProduction ? ' (production)' : ''}
                  </label>
                ))}
              </div>
            )}
            <label className="flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={timeline} onChange={(e) => setTimeline(e.target.checked)} data-ci-timeline />
              Keep the run as an HTML timeline (test-results/timeline.html), also when it fails
            </label>
          </div>
        )}
        {production && (
          <label className="flex items-center gap-1.5 text-xs text-bad">
            <input type="checkbox" checked={allowProduction} onChange={(e) => setAllowProduction(e.target.checked)} data-ci-allow-production />
            Allow data-changing requests to the production environment (--allow-production)
          </label>
        )}
        <div className="grid gap-0.5">
          <label className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={trustScripts} onChange={(e) => setTrustScripts(e.target.checked)} data-ci-trust-scripts />
            Allow scripts to read secrets and call other hosts in this pipeline (--trust-scripts)
          </label>
          <span className="text-xs text-muted pl-5">
            Off: scripts in the workspace do not see secret variables and can only send to the host of their own request. Turn it on only for a repository you trust: the pipeline&apos;s secrets are then within reach of every script in it.
          </span>
        </div>
        {cfg?.localCommand && (
          <div className="grid gap-1" data-ci-local-command>
            <div className="flex items-center gap-2 text-xs">
              <span className="font-medium flex-1">Try it here first (the same run, on this computer)</span>
              <Button size="sm" icon={<Copy size={12} />} onClick={() => void copyText(cfg.localCommand!, 'Command')}>
                Copy
              </Button>
              {shellCapable && (
                <Button size="sm" icon={<TerminalSquare size={12} />} onClick={() => (runInTerminal(cfg.localCommand!), close())} data-ci-run-local>
                  Run in terminal
                </Button>
              )}
            </div>
            <CodeBlock className="mono text-xs rounded-md border border-line bg-bg p-2 whitespace-pre-wrap break-all" text={cfg.localCommand} />
          </div>
        )}
        {error && <div className="text-sm text-bad">{error}</div>}
        {cfg && (
          <>
            <CodeBlock className="mono text-xs leading-relaxed rounded-lg border border-line bg-bg p-3 max-h-[46vh] overflow-auto whitespace-pre" language={'yaml'} text={cfg.content} />
            <div className="text-sm">
              {cfg.secrets.length ? (
                <>
                  <div className="font-medium mb-1">CI secrets to create</div>
                  <ul className="text-xs text-muted flex flex-col gap-0.5">
                    {cfg.secrets.map((s) => (
                      <li key={s.name}>
                        <code className="text-fg">{s.name}</code> · {s.description}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <span className="text-xs text-muted">No secrets needed: this run uses no secret variables.</span>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
