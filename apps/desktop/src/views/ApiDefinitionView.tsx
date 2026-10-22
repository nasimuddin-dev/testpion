import { ItemBreadcrumb } from '../components/ItemBreadcrumb';
import { openItemMenu } from '../lib/item-menu';
import { FileCode2, RotateCcw, Save, Sparkles, Upload } from 'lucide-react';
import { startFlowGenerate } from '../components/ai/flow-generate';
import { startAiAnalysis } from '../components/ai/ai-analysis';
import { useAiEnabled } from '../lib/use-ai-enabled';
import { LABEL } from '../lib/vocabulary';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { OnMount } from '@monaco-editor/react';
import { asError, call } from '../api';
import { copyText } from '../lib/clipboard';
import { persisted, useApp, attempt } from '../store';
import { useIntent, useSaveShortcut } from '../hooks';
import { useDoc } from '../lib/docs';
import { useSticky } from '../lib/sticky';
import { CodeEditor } from '../components/CodeEditor';
import { ApiCoverageDialog } from '../components/ApiCoverageDialog';
import { OpenApiDiffDialog } from '../components/OpenApiDiffDialog';
import { ApiLintPanel, type ApiLintProblem, type ApiLintResult } from '../components/ApiLintPanel';
import { ApiPreviewPanel, type ApiOutline } from '../components/ApiPreviewPanel';
import { ApiFuzzPanel } from '../components/ApiFuzzPanel';
import { AsyncPreviewPanel, type AsyncOutline } from '../components/AsyncPreviewPanel';
import { useSingleEditorTab } from '../components/EditorTabs';
import { Badge, Button, Empty, Tabs, useDebounced } from '../components/ui';

type Tab = 'definition' | 'preview' | 'lint' | 'fuzz' | 'coverage' | 'compare';

/** Which document each API definition tab shows (each tab is its own document). */
const tabSpec = persisted<{ spec?: string }>('apidef', {});

/** Title and version of an OpenAPI document (JSON or YAML), for the header. */
function infoOf(text: string): { title?: string; version?: string; openapi?: string } {
  try {
    const d = JSON.parse(text) as { info?: { title?: string; version?: string }; openapi?: string; swagger?: string };
    return { title: d.info?.title, version: d.info?.version, openapi: d.openapi ?? d.swagger };
  } catch {
    const pick = (re: RegExp) =>
      re
        .exec(text)?.[1]
        ?.trim()
        .replace(/^['"]|['"]$/g, '');
    return { title: pick(/^\s{2}title:\s*(.+)$/m), version: pick(/^\s{2}version:\s*(.+)$/m), openapi: pick(/^(?:openapi|swagger):\s*(.+)$/m) };
  }
}

/**
 * An API definition (an OpenAPI document in the workspace's specs/ folder) in its own tab, like any
 * request: the document itself (editable), its API coverage and a comparison with another version.
 */
export function ApiDefinitionView() {
  const { docId } = useDoc();
  const aiOn = useAiEnabled();
  const docState = useMemo(() => tabSpec.forDoc(docId), [docId]);
  const [spec, setSpec] = useState<string | undefined>(() => docState.load().spec);
  useEffect(() => docState.save({ spec }), [spec, docState]);
  // an AsyncAPI document (kept in specs/asyncapi/): its own preview; lint, fuzz, coverage and compare read OpenAPI
  const isAsync = !!spec?.startsWith('specs/asyncapi/');
  const [tab, setTab] = useSticky<Tab>(`apidef:tab:${docId ?? 'main'}`, 'definition');
  useEffect(() => {
    if (isAsync && tab !== 'definition' && tab !== 'preview') setTab('definition');
  }, [isAsync, tab]);
  useIntent('apidef', (p) => {
    if (p?.spec) setSpec(p.spec as string);
    if (p?.tab) setTab(p.tab as Tab);
  });

  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const [error, setError] = useState<string>();
  // Retry (after the document or its outline could not be read) reads them again
  const [attemptNo, setAttemptNo] = useState(0);
  const retry = () => setAttemptNo((n) => n + 1);
  useEffect(() => {
    if (!spec) return;
    setError(undefined);
    call<{ text: string }>('openapi.spec.get', { path: spec }).then(
      (r) => {
        setText(r.text);
        setSaved(r.text);
      },
      (e) => setError(asError(e).message),
    );
  }, [spec, attemptNo]);
  const dirty = text !== saved;
  const save = async () => {
    if (!spec || !dirty) return;
    await attempt(async () => {
      await call('openapi.spec.save', { path: spec, text });
      setSaved(text);
      useApp.getState().toast(`Saved ${spec}`, 'success');
    });
  };
  useSaveShortcut('apidef', () => void save());

  // lint the text as it is typed (a moment after typing stops): the Lint tab, and markers in the editor
  const [lint, setLint] = useState<ApiLintResult>();
  const settledText = useDebounced(text, 400);
  useEffect(() => {
    if (!settledText || isAsync) return;
    void call<ApiLintResult>('openapi.lint', { text: settledText }).then(setLint, () => setLint(undefined));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledText]);
  // the operations as the docs read them, for the Preview tab (only while it is shown)
  const [outline, setOutline] = useState<{ outline?: ApiOutline; async?: AsyncOutline; error?: string }>({});
  useEffect(() => {
    if (!text || tab !== 'preview') return;
    setOutline((o) => (o.error ? {} : o));
    const t = setTimeout(() => {
      const p = isAsync
        ? call<AsyncOutline>('asyncapi.outline', { text }).then((o) => setOutline({ async: o }))
        : call<ApiOutline>('openapi.outline', { text }).then((o) => setOutline({ outline: o }));
      void p.catch((e) => setOutline({ error: asError(e).message }));
    }, 300);
    return () => clearTimeout(t);
  }, [text, tab, isAsync, attemptNo]);
  const editor = useRef<{ ed: Parameters<OnMount>[0]; monaco: Parameters<OnMount>[1] }>(undefined);
  const reveal = useRef<ApiLintProblem>(undefined);
  const mark = () => {
    const e = editor.current;
    const model = e?.ed.getModel();
    if (!e || !model) return;
    const S = e.monaco.MarkerSeverity;
    e.monaco.editor.setModelMarkers(
      model,
      'openapi-lint',
      (lint?.problems ?? []).map((p) => ({
        severity: p.severity === 'error' ? S.Error : p.severity === 'warning' ? S.Warning : S.Info,
        message: `${p.message} (${p.rule})`,
        startLineNumber: p.line,
        startColumn: p.column,
        endLineNumber: p.endLine,
        endColumn: p.endColumn,
      })),
    );
    const r = reveal.current;
    if (r) {
      reveal.current = undefined;
      e.ed.revealLineInCenter(r.line);
      e.ed.setSelection({ startLineNumber: r.line, startColumn: r.column, endLineNumber: r.endLine, endColumn: r.endColumn });
      e.ed.focus();
    }
  };
  useEffect(mark, [lint]);
  const openProblem = (p: ApiLintProblem) => {
    reveal.current = p;
    if (tab === 'definition') mark();
    else setTab('definition');
  };

  const info = useMemo(() => infoOf(saved), [saved]);
  const name = spec?.replace(/^specs\//, '');
  useSingleEditorTab('apidef', spec ? { title: name!, badge: isAsync ? 'ASYNC' : 'API', badgeClass: 'kind-api', item: spec, dirty } : undefined);

  if (!spec)
    return (
      <Empty
        icon={<FileCode2 size={28} />}
        title="Open an API definition"
        actions={[{ label: 'Import OpenAPI', icon: <Upload size={14} />, onClick: () => useApp.getState().openIntent('collections', { import: true }) }]}
      >
        Pick an OpenAPI document under <b>API definitions</b> in the sidebar, or import one: it's kept in the workspace for contract checks, API coverage and comparing versions.
      </Empty>
    );
  return (
    <div className="h-full flex flex-col min-w-0">
      {/* WF-11: API definitions › folder › file, like every item view */}
      <ItemBreadcrumb
        label="Where this API definition is"
        crumbs={[{ label: 'API definitions' }, ...name!.split('/').slice(0, -1).map((f) => ({ label: f }))]}
        name={name!.split('/').pop()!}
        dirty={dirty}
        // its ⋯: the API definition's menu as its row in the explorer has it (lib/node-menu.ts)
        actions={openItemMenu('spec', { ref: { kind: 'spec', path: spec }, name: name!, on: { revealFile: () => void attempt(() => call('workspace.revealFile', { path: spec })), copyPath: () => void copyText(spec, 'the path') } })}
      />
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line shrink-0 min-w-0">
        <FileCode2 size={16} className="text-muted shrink-0" />
        <span className="font-semibold truncate" title={spec}>
          {info.title || name}
        </span>
        {info.version && <Badge>v{info.version}</Badge>}
        {info.openapi && (
          <Badge tone="accent">
            {info.openapi.startsWith('2') ? 'Swagger' : 'OpenAPI'} {info.openapi}
          </Badge>
        )}
        <span className="mono text-xs text-muted truncate">{spec}</span>
        {!isAsync && aiOn && (
          <>
            <Button className="ml-auto" icon={<Sparkles size={14} />} onClick={() => startFlowGenerate({ mode: 'spec', spec })} title="Tests for the gaps in what is tested of this API definition: positive, negative, boundary and security" data-generate-spec-tests>
              {LABEL.generateSpecTests}
            </Button>
            <Button icon={<Sparkles size={14} />} onClick={() => startAiAnalysis({ kind: 'drift', spec })} title="Real traffic compared with this definition: what differs, who is right, and the fix verified against the same traffic" data-check-traffic>
              {LABEL.checkTraffic}
            </Button>
          </>
        )}
        <Button className={isAsync || !aiOn ? 'ml-auto' : undefined} icon={<Save size={14} />} disabled={!dirty} reason="Nothing changed yet" onClick={() => void save()} title="Save (Ctrl+S)">
          Save
        </Button>
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'definition', label: 'Definition' },
          { id: 'preview', label: 'Preview' },
          ...(isAsync
            ? []
            : [
                {
                  id: 'lint' as const,
                  label: 'Lint',
                  badge: lint && (lint.counts.error || lint.counts.warning) ? <Badge tone={lint.counts.error ? 'bad' : 'warn'}>{lint.counts.error || lint.counts.warning}</Badge> : undefined,
                  title: lint ? `${lint.counts.error} errors, ${lint.counts.warning} warnings, ${lint.counts.info} notes` : undefined,
                },
                { id: 'fuzz' as const, label: 'Fuzz' },
                { id: 'coverage' as const, label: 'Coverage' },
                { id: 'compare' as const, label: 'Compare versions' },
              ]),
        ]}
      />
      <div className="flex-1 min-h-0">
        {tab === 'definition' ? (
          error ? (
            <Empty title="Couldn't open the document" actions={[{ label: 'Retry', icon: <RotateCcw size={13} />, onClick: retry }]}>
              {error}
            </Empty>
          ) : (
            <CodeEditor
              language={/\.json$/i.test(spec) ? 'json' : 'yaml'}
              path={spec}
              value={text}
              onChange={setText}
              onMount={(ed, monaco) => {
                editor.current = { ed, monaco };
                mark();
              }}
            />
          )
        ) : tab === 'preview' && isAsync ? (
          <AsyncPreviewPanel outline={outline.async} error={outline.error} spec={spec} onRetry={retry} />
        ) : tab === 'preview' ? (
          <ApiPreviewPanel outline={outline.outline} error={outline.error} spec={spec} onRetry={retry} />
        ) : tab === 'lint' ? (
          <ApiLintPanel spec={spec} text={text} result={lint} onOpen={openProblem} />
        ) : tab === 'fuzz' ? (
          <ApiFuzzPanel spec={spec} />
        ) : tab === 'coverage' ? (
          <ApiCoverageDialog inline spec={spec} onClose={() => undefined} />
        ) : (
          <OpenApiDiffDialog inline before={spec} onClose={() => undefined} />
        )}
      </div>
    </div>
  );
}
