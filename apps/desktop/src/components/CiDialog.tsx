import { Check, Copy, Download } from 'lucide-react';
import { useEffect, useState } from 'react';
import { asError, call } from '../api';
import { toastError, useApp } from '../store';
import { finishSave, type SaveResult } from '../lib/files';
import { Button, Field, Input, Modal, Select, Tabs } from './ui';
import { useCollections } from '../lib/collections-store';
import { usePersisted } from '../lib/sticky';
import { useCopied } from '../lib/clipboard';

interface CiConfig {
  path: string;
  content: string;
  secrets: Array<{ name: string; description: string }>;
  command: string;
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
const suitesOf = (nodes: TreeNode[]): string[] => nodes.flatMap((n) => (n.kind === 'dir' ? suitesOf(n.children ?? []) : n.path.endsWith('.suite.yaml') && !n.path.includes('/') ? [n.path.replace(/\.suite\.yaml$/, '')] : []));

/**
 * "Run in CI": a pipeline file that runs a suite, a collection or all tests on every push. The config
 * comes from the engine (ci.config), so the app, `testpion ci` and the ci_config MCP tool agree.
 */
export function CiDialog() {
  const req = useApp((s) => s.ci)!;
  const close = () => useApp.getState().set({ ci: undefined });
  const environments = useApp((s) => s.workspace?.environments ?? []);
  const [provider, setProvider] = usePersisted<Provider>('aps.ci.provider', 'github', { parse: (v) => (v as Provider) || undefined, text: true });
  const [target, setTarget] = useState<string>(req.collection ? `collection:${req.collection}` : req.suite ? `suite:${req.suite}` : 'tests');
  const [environment, setEnvironment] = useState(useApp.getState().environment ?? '');
  const [workspaceDir, setWorkspaceDir] = useState('.');
  const [openapi, setOpenapi] = useState('');
  const [suites, setSuites] = useState<string[]>([]);
  const collections = useCollections();
  const [cfg, setCfg] = useState<CiConfig>();
  const [error, setError] = useState<string>();
  const { copied, copy: copyToClipboard } = useCopied();

  useEffect(() => {
    void call<TreeNode[]>('tests.tree').then((t) => setSuites(suitesOf(t)));
  }, []);
  const options = () => {
    const [kind, value] = target.includes(':') ? [target.slice(0, target.indexOf(':')), target.slice(target.indexOf(':') + 1)] : [target, ''];
    return {
      provider,
      environment: environment || undefined,
      workspaceDir: workspaceDir.trim() || '.',
      openapi: openapi.trim() || undefined,
      ...(kind === 'suite' ? { suite: value } : kind === 'collection' ? { collection: value, folders: value === req.collection ? req.folders : undefined } : {}),
    };
  };
  useEffect(() => {
    call<CiConfig>('ci.config', options()).then(
      (c) => (setCfg(c), setError(undefined)),
      (e) => (setCfg(undefined), setError(asError(e).message)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, target, environment, workspaceDir, openapi]);

  const copy = () => (cfg ? copyToClipboard(cfg.content) : undefined);
  const save = async () => {
    try {
      finishSave(await call<SaveResult>('ci.save', options()), 'Pipeline');
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <Modal
      title="Run in CI"
      onClose={close}
      width={820}
      footer={
        <>
          <span className="text-xs text-muted mr-auto">{cfg && <>Put it at <code>{cfg.path}</code> in your repository.</>}</span>
          <Button icon={copied ? <Check size={14} /> : <Copy size={14} />} onClick={() => void copy()} disabled={!cfg}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button variant="primary" icon={<Download size={14} />} onClick={() => void save()} disabled={!cfg}>
            Save file…
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Tabs tabs={PROVIDERS} value={provider} onChange={setProvider} />
        <div className="grid grid-cols-3 gap-3">
          <Field label="Run">
            <Select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="tests">All tests (tests/)</option>
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
                <option key={e.id} value={e.name}>
                  {e.name}
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
        {error && <div className="text-sm text-bad">{error}</div>}
        {cfg && (
          <>
            <pre className="mono text-xs leading-relaxed rounded-lg border border-line bg-bg p-3 max-h-[46vh] overflow-auto whitespace-pre">{cfg.content}</pre>
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
