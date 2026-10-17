import { Bot, Copy, FileText, History, Info, KeyRound } from 'lucide-react';
import { askAssistant } from './ai/AiAction';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { ItemRef } from '@testpion/shared';
import { call } from '../api';
import { isRequestView, toastError, useApp } from '../store';
import { isDocView, useDocs } from '../lib/docs';
import { refOfEditorItem, refOfPlace } from '../lib/open-ref';
import { useSticky } from '../lib/sticky';
import { copyText } from '../lib/clipboard';
import { timeAgo } from '../lib/format';
import { useEditorTabsStore } from './EditorTabs';
import { PinnablePanel, usePinnablePanel } from './PinnablePanel';
import { RefLink } from './RefLink';
import { EnvBadge } from './EnvSelect';
import { Badge, Button, Empty, Segmented, SectionTitle } from './ui';

// the AI assistant (with its Markdown renderer) loads when it is first shown
const AssistantPanel = lazy(async () => ({ default: (await import('./AssistantPanel')).AssistantPanel }));

interface Info {
  ref: ItemRef;
  label: string;
  detail?: string;
  file?: string;
  collectionId?: string;
  runs: Array<{ runId: string; name: string; startedAt: string; passed: number; failed: number; errors: number; total: number; environment?: string }>;
  variables: Array<{ name: string; scope?: string; value?: string; secret?: boolean }>;
}

/** The item on screen: the active editor tab's (request editors), else the place Back / Forward recorded. */
export function useCurrentItemRef(): ItemRef | undefined {
  const view = useApp((s) => s.view);
  const payload = useApp((s) => s.nav.current.payload);
  const placeView = useApp((s) => s.nav.current.view);
  const activeDoc = useDocs((s) => s.active[view]);
  const tabItem = useEditorTabsStore((s) => {
    const group = isDocView(view) ? `${view}:${activeDoc ?? 'main'}` : view;
    const tabs = s.byView[group] ?? [];
    return (tabs.find((t) => t.key === s.activeByView[group]) ?? (tabs.length === 1 ? tabs[0] : undefined))?.item;
  });
  return useMemo(
    () => (isRequestView(view) && tabItem ? refOfEditorItem(view, tabItem) : placeView === view ? refOfPlace(view, payload) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, tabItem, placeView, JSON.stringify(payload ?? null)],
  );
}

/**
 * WF-20 the Info panel: the item on screen, the same for a request, a test file or a monitor — the {{variables}} it
 * uses with where each comes from in the active environment, its file and git state, the runs that included it, and
 * (for a request) its code. `ref.info` (core itemInfo; `item_info` for agents) reads it.
 */
export function ContextInfo() {
  const ref = useCurrentItemRef();
  const environment = useApp((s) => s.environment);
  // read only while the panel is shown (unpinned and closed, it waits at the edge)
  const { open } = usePinnablePanel();
  const [info, setInfo] = useState<Info>();
  const [git, setGit] = useState<string>();
  const key = JSON.stringify(ref ?? null);
  useEffect(() => {
    setInfo(undefined);
    setGit(undefined);
    if (!ref || !open) return;
    let live = true;
    call<Info>('ref.info', { ref, environment }).then(
      (i) => {
        if (!live) return;
        setInfo(i);
        if (i.file)
          void call<{ repository?: boolean; files: Array<{ path: string; state?: string; staged?: boolean }> }>('git.status').then(
            (st) => live && setGit(!st.repository ? 'not in git' : (st.files.find((f) => f.path === i.file || f.path.endsWith(`/${i.file}`))?.state ?? 'unchanged')),
            () => undefined,
          );
      },
      () => live && setInfo(undefined),
    );
    return () => void (live = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, environment, open]);
  if (!ref)
    return (
      <Empty icon={<Info size={22} />} title="Nothing open">
        Open a request, a test file, a monitor or another item: what it uses and where it is kept show here.
      </Empty>
    );
  if (!info) return <div className="p-3 text-sm text-muted">Reading…</div>;
  const copyCode = async () => {
    if (ref.kind !== 'request') return;
    try {
      const c = await call<{ items: Array<{ id: string; kind: string; request?: unknown; items?: unknown[] }> }>('col.get', { id: ref.collectionId });
      const find = (nodes: Array<{ id: string; kind: string; request?: unknown; items?: unknown[] }>): { request?: unknown } | undefined => {
        for (const n of nodes) {
          if (n.id === ref.requestId) return n;
          const inner = n.kind === 'folder' ? find((n.items ?? []) as typeof nodes) : undefined;
          if (inner) return inner;
        }
        return undefined;
      };
      const node = find(c.items);
      if (!node?.request) return;
      const text = await call<string>('http.curl', { request: node.request, environment, collectionId: ref.collectionId, requestId: ref.requestId });
      await copyText(text, 'the request as cURL');
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <div className="flex-1 min-h-0 overflow-auto p-3 flex flex-col gap-4 text-sm" data-context-info={ref.kind}>
      <div className="min-w-0">
        <RefLink to={ref} label={info.label} className="font-semibold" />
        {info.detail && <div className="text-xs text-muted truncate">{info.detail}</div>}
      </div>
      <section>
        <SectionTitle>
          <span className="inline-flex items-center gap-1.5">
            <KeyRound size={13} />
            Variables · <EnvBadge name={environment} className="font-normal" />
          </span>
        </SectionTitle>
        {info.variables.length ? (
          <ul className="flex flex-col gap-1" data-context-variables>
            {info.variables.map((v) => (
              <li key={v.name} className="flex items-center gap-2 min-w-0" title={v.scope ? `${v.name}: from ${v.scope}` : `${v.name}: not set here`}>
                <span className="mono text-xs truncate">{`{{${v.name}}}`}</span>
                <span className={v.scope ? 'text-xs text-muted truncate flex-1 text-right mono' : 'text-xs text-bad flex-1 text-right'}>{v.scope ? v.value : 'not set'}</span>
                {v.scope && <Badge>{v.scope}</Badge>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted">It uses no {'{{variables}}'}.</p>
        )}
      </section>
      {info.file && (
        <section>
          <SectionTitle>
            <span className="inline-flex items-center gap-1.5">
              <FileText size={13} />
              File
            </span>
          </SectionTitle>
          <div className="flex items-center gap-2 min-w-0">
            <span className="mono text-xs truncate flex-1" title={info.file}>
              {info.file}
            </span>
            {git && git !== 'not in git' ? (
              <RefLink to={{ kind: 'git-file', path: info.file }} icon={false} className="text-xs shrink-0">
                {git}
              </RefLink>
            ) : (
              git && <span className="text-xs text-muted shrink-0">{git}</span>
            )}
          </div>
        </section>
      )}
      <section>
        <SectionTitle>
          <span className="inline-flex items-center gap-1.5">
            <History size={13} />
            Last runs
          </span>
        </SectionTitle>
        {info.runs.length ? (
          <ul className="flex flex-col gap-1" data-context-runs>
            {info.runs.map((r) => (
              <li key={r.runId} className="flex items-center gap-2 min-w-0">
                <RefLink to={{ kind: 'run', runId: r.runId }} label={r.name} icon={false} className="truncate flex-1" />
                <Badge tone={r.failed || r.errors ? 'bad' : 'ok'}>
                  {r.passed}/{r.total}
                </Badge>
                <span className="text-xs text-muted shrink-0">{timeAgo(r.startedAt)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted">No run included it yet.</p>
        )}
      </section>
      {ref.kind === 'request' && (
        <section>
          <SectionTitle>
            <span className="inline-flex items-center gap-1.5">
              <Copy size={13} />
              Code
            </span>
          </SectionTitle>
          <Button size="sm" icon={<Copy size={12} />} onClick={() => void copyCode()}>
            Copy as cURL
          </Button>
        </section>
      )}
    </div>
  );
}

/**
 * WF-20 the right side: one pinnable host (as in Visual Studio) with the Info panel and the AI assistant. Unpinned it
 * waits as a tab on the edge and slides over the content; pinned it docks. Asking the assistant anything shows it.
 */
export function RightPanel() {
  const assistant = useApp((s) => s.assistant);
  const [tab, setTab] = useSticky<'info' | 'assistant'>('right:tab', 'info', { persist: true });
  useEffect(() => {
    if (assistant) setTab('assistant');
  }, [assistant, setTab]);
  const shown = tab === 'assistant' ? 'assistant' : 'info';
  return (
    <PinnablePanel
      id="right"
      title={shown === 'assistant' ? 'Assistant' : 'Info'}
      side="right"
      defaultWidth={400}
      autoUnpinBelow={100_000}
      revealKey={assistant ? JSON.stringify(assistant).slice(0, 120) : undefined}
    >
      <div className="flex items-center px-2 py-1.5 border-b border-line shrink-0">
        <Segmented
          label="Right panel"
          value={shown}
          onChange={setTab}
          options={[
            { value: 'info', label: 'Info' },
            { value: 'assistant', label: 'Assistant' },
          ]}
        />
      </div>
      {shown === 'info' ? (
        <ContextInfo />
      ) : assistant ? (
        <Suspense fallback={null}>
          <AssistantPanel key={JSON.stringify(assistant).slice(0, 200)} />
        </Suspense>
      ) : (
        <Empty
          icon={<Bot size={22} />}
          title="Ask the assistant"
          actions={[{ label: 'Ask the assistant', icon: <Bot size={13} />, onClick: () => askAssistant() }]}
        >
          It sees what is on screen (never secret values) and proposes changes for you to review.
        </Empty>
      )}
    </PinnablePanel>
  );
}
