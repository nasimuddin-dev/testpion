import { JSONPath } from 'jsonpath-plus';
import { ArrowLeftRight, ChevronDown, Code2, Pencil, Cookie, Download, FolderPlus, FolderTree, History, KeyRound, Sparkles, Save, Send, Square, Star, Upload } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAssistantContext } from '../lib/assistant-context';
import { asError, call, on } from '../api';
import { ask, confirmAction, promptText, toastError, useApp } from '../store';
import { useIntent, useSendShortcut, useSaveShortcut } from '../hooks';
import type { CheckConfig, Collection, CollectionNode, HttpRequestSpec, KeyValue, SavedExample, SavedHttpRequest, SseEvent } from '../types';
import { parseYaml } from '../lib/yaml';
import { fromEngineRequest, paramsFromUrl, syncPathVariables, toEngineRequest, urlFromParams } from '../lib/url';
import { CodeModal } from '../components/CodeModal';
import { CookiesModal, hostOf } from '../components/CookiesModal';
import { EnvironmentsPane, HistoryPane } from '../components/SidebarPanes';
import { SidebarShell } from '../components/SidebarShell';
import { NEW_TAB_TITLE, NoOpenTabs, tabTitle, useEditorTabs } from '../components/EditorTabs';
import { uid } from '../lib/format';

/** Browser devtools "Copy as cURL (bash/cmd) / fetch / fetch (Node.js) / PowerShell" output. */
const isRequestSnippet = (t: string) =>
  /^\s*(?:curl(?:\.exe)?\s|(?:(?:const|let|var)\s+\w+\s*=\s*)?(?:await\s+)?fetch\s*\(|(?:Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\s)/i.test(t) ||
  (/^\s*\$\w+\s*=/.test(t) && /\b(?:Invoke-WebRequest|Invoke-RestMethod)\b/i.test(t)) ||
  // HTTPie / xh: http [flags] [METHOD] URL …
  /^\s*(?:https?|xhs?)\s+(?:-\S+\s+)*(?:[A-Z]+\s+)?(?:https?:\/\/|:\d|localhost|[\w.-]+\.[a-z]{2,}|[\w.-]+:\d)/i.test(t);
const SNIPPET_LABEL: Record<string, string> = { curl: 'cURL command', fetch: 'fetch call', powershell: 'PowerShell command', httpie: 'HTTPie command' };
/** A tab name like "POST /v1/pets" for a pasted request. */
const snippetName = (r: HttpRequestSpec) => {
  let path = r.url;
  try {
    path = new URL(r.url).pathname;
  } catch {
    /* keep the raw URL */
  }
  return `${r.method} ${path}`.slice(0, 60);
};
const isEditable = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || !!el.closest('.cm-editor'));
import { addToFolder, CollectionTree, findNode, mapNodes } from '../components/CollectionTree';
import { ResponseViewer } from '../components/ResponseViewer';
import { EnvCompareDialog } from './rest/EnvCompareDialog';
import { toastAiError } from '../lib/ai-errors';
import type { TreeAssertion, TreeVariable } from '../components/JsonView';
import { saveResponseVariable } from '../lib/save-variable';
import { SseEvents } from '../components/SseEvents';
import { ErrorPanel } from '../components/Results';
import { VarInput } from '../components/VarInput';
import { Button, cx, Empty, IconButton, Input, Menu, Split } from '../components/ui';
import { ResponseSplit } from '../components/ResponseSplit';
import { METHODS, RestTab, SendResult, blankRequest, drafts, savedSnapshot } from './rest/types';
import { RequestEditor } from './rest/RequestEditor';
import { SaveModal, ImportModal } from './rest/dialogs';
import { saveAsTestFile } from '../lib/save-test';
import { RequestBreadcrumb } from '../components/RequestBreadcrumb';
import { currentCollections, refreshCollection, refreshCollections, useCollections } from '../lib/collections-store';


/** Production environments where the user chose "don't ask again" (this session only). */
const productionSendAllowed = new Set<string>();

/**
 * A request that can change data (anything but GET, HEAD and OPTIONS) sent with a production
 * environment active asks first. "Send and don't ask again" lasts until the app restarts.
 */
async function confirmProductionSend(method: string, environment: string | undefined): Promise<boolean> {
  if (!environment || /^(GET|HEAD|OPTIONS)$/i.test(method)) return true;
  const envObj = useApp.getState().workspace?.environments.find((e) => e.name === environment);
  if (!envObj?.isProduction || productionSendAllowed.has(envObj.name)) return true;
  const choice = await ask({
    title: `Send ${method.toUpperCase()} to production?`,
    message: `"${envObj.name}" is a production environment. This ${method.toUpperCase()} request may change real data.`,
    tone: 'warning',
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'always', label: "Send and don't ask again" },
      { id: 'send', label: 'Send', variant: 'danger' },
    ],
    cancelId: 'cancel',
  });
  if (choice === 'always') productionSendAllowed.add(envObj.name);
  return choice === 'send' || choice === 'always';
}

/** A tab's contents from a saved request (opening it, or taking the version on disk). */
function tabFromSaved(n: SavedHttpRequest): RestTab {
  return {
    id: uid('tab-'),
    name: n.name,
    request: fromEngineRequest(structuredClone(n.request)),
    preRequestScript: n.preRequestScript,
    testScript: n.testScript,
    assertions: n.assertions ?? [],
    requestId: n.id,
    examples: n.examples,
    description: n.description,
    dirty: false,
    base: savedSnapshot(n),
  };
}

export function RestView() {
  const [tabs, setTabs] = useState<RestTab[]>(() => {
    const d = drafts.load();
    // drafts from before the URL/params sync kept the query only in the Params table
    if (d.tabs.length) return d.tabs.map((t) => (t.request.url.includes('?') ? t : { ...t, request: fromEngineRequest(t.request) }));
    // first launch gets a blank request; if the user closed every tab (active saved as ''), keep it that way
    return d.active === '' ? [] : [blankRequest()];
  });
  const [active, setActive] = useState<string>(() => drafts.load().active ?? tabs[0]?.id ?? '');
  const [results, setResults] = useState<Record<string, SendResult>>({});
  const [sending, setSending] = useState<Record<string, string>>({});
  const collections = useCollections();
  const [filter, setFilter] = useState('');
  const [favoritesOnly, setFavoritesOnly] = useState(() => localStorage.getItem('aps.rest.favoritesOnly') === 'true');
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [comparingEnvs, setComparingEnvs] = useState(false);
  const [showCookies, setShowCookies] = useState(false);
  const [side, setSideState] = useState<'collections' | 'environments' | 'history'>(() => {
    try {
      return (localStorage.getItem('aps.rest.sidebar') as 'collections') || 'collections';
    } catch {
      return 'collections';
    }
  });
  const setSide = (v: typeof side) => {
    setSideState(v);
    try {
      localStorage.setItem('aps.rest.sidebar', v);
    } catch {
      /* ignore */
    }
  };
  const env = useApp((s) => s.environment);
  // with every tab closed, a stable placeholder keeps the hooks below simple; the editor shows an empty state
  const placeholder = useMemo(() => blankRequest(), []);
  const noTabs = tabs.length === 0;
  const tab = tabs.find((t) => t.id === active) ?? tabs[0] ?? placeholder;
  const streams = useRef<Record<string, string>>({});
  /** Server-Sent Events arriving for requests still being sent, by send id (shown live). */
  const [liveEvents, setLiveEvents] = useState<Record<string, SseEvent[]>>({});

  useEffect(() => drafts.save({ tabs, active }), [tabs, active]);
  // the shared list (lib/collections-store): fetched once for the sidebar, this view and the breadcrumbs (useCollections)
  const loadCollections = refreshCollections;
  useEffect(
    () =>
      on<Array<{ id: string; chunk: string }>>('http.chunks', (items) => {
        for (const it of items) streams.current[it.id] = (streams.current[it.id] ?? '') + it.chunk;
      }),
    [],
  );
  useEffect(
    () =>
      on<Array<{ id: string; event: SseEvent }>>('http.sse', (items) =>
        setLiveEvents((cur) => {
          const next = { ...cur };
          for (const it of items) next[it.id] = [...(next[it.id] ?? []), it.event];
          return next;
        }),
      ),
    [],
  );

  const update = (patch: Partial<RestTab>) => setTabs((ts) => ts.map((t) => (t.id === tab.id ? { ...t, ...patch, dirty: true } : t)));

  // files changed outside the app (GIT-103 / GIT-302): open requests follow their saved version; a tab with unsaved
  // edits asks first, and only when that very request changed on disk
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  useEffect(
    () =>
      on<{ kinds: string[] }>('workspace.changedOnDisk', (p) => {
        if (!p.kinds.includes('collections')) return;
        void refreshCollections().then(async (cols) => {
          for (const t of tabsRef.current) {
            if (!t.collectionId || !t.requestId || t.base === undefined) continue;
            const n = findNode(cols.find((c) => c.id === t.collectionId)?.items ?? [], t.requestId);
            if (!n || n.kind !== 'http') continue;
            const now = savedSnapshot(n);
            if (now === t.base) continue;
            const take = () => setTabs((ts) => ts.map((x) => (x.id === t.id ? { ...x, ...tabFromSaved(n), id: x.id, collectionId: x.collectionId, pinned: x.pinned } : x)));
            if (!t.dirty) {
              take();
              continue;
            }
            const choice = await ask({
              title: `"${t.name}" changed on disk`,
              message: 'A pull, a branch switch or another editor changed this request while you were editing it.',
              detail: 'Keep mine: your edits stay, and saving replaces the new version with them. Take the new version: your unsaved edits are dropped.',
              tone: 'warning',
              buttons: [
                { id: 'mine', label: 'Keep mine' },
                { id: 'theirs', label: 'Take the new version', variant: 'primary' },
              ],
              cancelId: 'mine',
            });
            if (choice === 'theirs') take();
            else setTabs((ts) => ts.map((x) => (x.id === t.id ? { ...x, base: now } : x)));
          }
        });
      }),
    [],
  );
  const setReq = (patch: Partial<HttpRequestSpec>) => update({ request: { ...tab.request, ...patch } });
  const setExamples = (examples: SavedExample[]) => setTabs((ts) => ts.map((t) => (t.requestId && t.requestId === tab.requestId ? { ...t, examples } : t)));
  /** URL bar edits update the Params table and path variables (Postman behaviour). */
  const setUrl = (url: string) => setReq({ url, params: paramsFromUrl(url, tab.request.params), pathVariables: syncPathVariables(url, tab.request.pathVariables) });
  /** Params table edits rebuild the URL's query string. */
  const setParams = (params: KeyValue[]) => setReq({ params, url: urlFromParams(tab.request.url, params) });
  /**
   * Pasting a cURL / fetch / PowerShell snippet imports it. From the URL bar it fills the current
   * tab; pasted anywhere else in the view it fills a pristine tab or opens a new one.
   */
  const importSnippet = async (text: string, into: 'current' | 'auto' = 'current') => {
    try {
      const { format, request } = await call<{ format?: string; request: HttpRequestSpec }>('http.parseSnippet', { text });
      const req = fromEngineRequest(request);
      const name = snippetName(request);
      const target = tabs.find((t) => t.id === active);
      const reuse = into === 'current' ? !!target : !!target && !target.dirty && !target.requestId;
      if (reuse && target) setTabs((ts) => ts.map((t) => (t.id === target.id ? { ...t, request: req, name: t.requestId ? t.name : name, dirty: true } : t)));
      else {
        const t: RestTab = { ...blankRequest(), name, request: req, dirty: true };
        setTabs((ts) => [...ts, t]);
        setActive(t.id);
      }
      useApp.getState().toast(`Imported ${SNIPPET_LABEL[format ?? 'curl'] ?? 'request'}`, 'success');
    } catch (e) {
      useApp.getState().toast(`Couldn't import the pasted request: ${asError(e).message}`, 'error');
    }
  };
  const importSnippetRef = useRef(importSnippet);
  importSnippetRef.current = importSnippet;
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      // views stay mounted in the background; only the visible REST view handles the paste
      if (useApp.getState().view !== 'rest' || isEditable(e.target) || isEditable(document.activeElement)) return;
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (!isRequestSnippet(text)) return;
      e.preventDefault();
      void importSnippetRef.current(text, 'auto');
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  const openRequest = (c: Collection, n: CollectionNode) => {
    if (n.kind === 'graphql') return useApp.getState().openIntent('graphql', { collectionId: c.id, requestId: n.id });
    if (n.kind !== 'http') return;
    useApp.getState().markPlace('rest', { collectionId: c.id, requestId: n.id });
    const existing = tabs.find((t) => t.requestId === n.id);
    if (existing) return setActive(existing.id);
    const t: RestTab = { ...tabFromSaved(n), id: uid('tab-'), collectionId: c.id };
    setTabs((ts) => [...ts, t]);
    setActive(t.id);
  };

  useIntent('rest', async (p) => {
    if (p?.tabCommand) return runTabCommand(p.tabCommand);
    // "Describe with AI" from an empty GraphQL, gRPC, WebSocket or MCP view
    if (p?.describe) return void describeRequest();
    if (p?.newTab) {
      const t = blankRequest();
      setTabs((ts) => [...ts, t]);
      setActive(t.id);
    } else if (p?.collectionId) {
      // the shared list is kept current by the saves' events: open from it (reading every collection again for one
      // request re-rendered the whole explorer); a request saved a moment ago and not in it yet is read on its own
      let c = currentCollections().find((x) => x.id === p.collectionId);
      if (!c || !findNode(c.items, p.requestId)) c = await call<Collection>('col.get', { id: p.collectionId }).catch(() => undefined);
      const n = c && findNode(c.items, p.requestId);
      if (c && n) openRequest(c, n);
      // "More code snippets…" in the collection tree
      if (c && n && p.showCode) setShowCode(true);
    } else if (p?.request) {
      const t: RestTab = { ...blankRequest(), name: p.name ?? 'From history', request: fromEngineRequest(p.request) };
      setTabs((ts) => [...ts, t]);
      setActive(t.id);
    }
  });

  const send = async () => {
    if (!(await confirmProductionSend(tab.request.method, env))) return;
    const id = uid('send-');
    const tabId = tab.id;
    setSending((s) => ({ ...s, [tabId]: id }));
    streams.current[id] = '';
    useApp.getState().setActivity(id, `Sending ${tab.request.method} ${tab.name}`);
    try {
      const r = await call<SendResult & { id: string }>('http.send', {
        id,
        name: tab.name,
        request: toEngineRequest(tab.request),
        environment: env,
        collectionId: tab.collectionId,
        requestId: tab.requestId,
        preRequestScript: tab.preRequestScript,
        testScript: tab.testScript,
        assertions: tab.assertions,
        stream: tab.request.headers?.some((h) => /accept/i.test(h.key) && /event-stream/.test(h.value)),
      });
      const curl = await call<string>('http.code', { request: toEngineRequest(tab.request), environment: env, collectionId: tab.collectionId, requestId: tab.requestId, language: 'curl' }).catch(() => undefined);
      setResults((rs) => ({ ...rs, [tabId]: { ...r, curl, stream: streams.current[id] || undefined } }));
      if (r.blockedEnv?.length)
        useApp.getState().toast(`This request reads the OS environment variable${r.blockedEnv.length === 1 ? '' : 's'} ${r.blockedEnv.map((n) => `$env.${n}`).join(', ')}, which the app does not allow by default. Settings ▸ Privacy lists the ones requests may read.`, 'warning', {
          label: 'Open Settings',
          onClick: () => useApp.getState().openIntent('settings', { tab: 'privacy' }),
        });
      else if (r.unresolved?.length && !r.error) useApp.getState().toast(`Unresolved variables: ${r.unresolved.join(', ')}`, 'error');
    } catch (e) {
      setResults((rs) => ({ ...rs, [tabId]: { error: asError(e) } }));
    } finally {
      delete streams.current[id];
      setLiveEvents((cur) => {
        const next = { ...cur };
        delete next[id];
        return next;
      });
      useApp.getState().setActivity(id);
      setSending((s) => {
        const n = { ...s };
        delete n[tabId];
        return n;
      });
    }
  };
  const cancel = () => sending[tab.id] && call('http.cancel', { id: sending[tab.id] });
  useSendShortcut('rest', () => (noTabs || sending[tab.id] ? undefined : void send()));

  const saveCollection = async (c: Collection) => {
    await call('col.save', c);
    await refreshCollection(c.id);
  };

  const saveTab = async (collectionId: string, name: string, folderId?: string) => {
    const c = await call<Collection>('col.get', { id: collectionId }).catch(() => undefined);
    if (!c) return useApp.getState().toast('That collection no longer exists — pick another one', 'error');
    const exists = tab.requestId ? findNode(c.items, tab.requestId) : undefined;
    // examples are saved on their own, so keep what is on disk
    const examples = exists?.kind === 'http' ? exists.examples : undefined;
    const node: SavedHttpRequest = {
      kind: 'http',
      id: tab.requestId ?? uid('req-'),
      name,
      request: toEngineRequest(tab.request),
      description: tab.description?.trim() ? tab.description : undefined,
      preRequestScript: tab.preRequestScript,
      testScript: tab.testScript,
      assertions: tab.assertions,
      examples,
    };
    const items = exists ? mapNodes(c.items, (n) => (n.id === node.id ? node : n)) : addToFolder(c.items, folderId, node);
    await saveCollection({ ...c, items });
    // the snapshot of the request as the file holds it (the writer normalises), so a later disk change is compared fairly
    const stored = await call<Collection>('col.get', { id: collectionId }).then((c) => findNode(c.items, node.id), () => undefined);
    const base = savedSnapshot(stored?.kind === 'http' ? stored : node);
    setTabs((ts) => ts.map((t) => (t.id === tab.id ? { ...t, name, collectionId, requestId: node.id, dirty: false, base } : t)));
    useApp.getState().toast('Saved', 'success');
  };

  const quickSave = () => (noTabs ? undefined : tab.collectionId && tab.requestId ? saveTab(tab.collectionId, tab.name) : setSaving(true));
  useSaveShortcut('rest', () => void quickSave());

  // pinned tabs first, in their own order
  const ordered = [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)];
  /** Close several tabs, asking once when any has unsaved changes. */
  const closeTabs = async (ids: string[]) => {
    const closing = tabs.filter((x) => ids.includes(x.id));
    if (!closing.length) return;
    const dirty = closing.filter((x) => x.dirty);
    if (
      dirty.length &&
      !(await confirmAction({
        title: 'Unsaved changes',
        message: dirty.length === 1 ? `"${dirty[0]!.name}" has unsaved changes.` : `${dirty.length} of the tabs you are closing have unsaved changes.`,
        detail: 'Close anyway and discard them? Save with Ctrl+S to keep them.',
        confirmLabel: 'Discard changes',
        danger: true,
      }))
    )
      return;
    // closing the last tab leaves none (Postman-style), not a new blank request
    const rest = tabs.filter((x) => !ids.includes(x.id));
    setTabs(rest);
    if (ids.includes(active)) {
      const i = ordered.findIndex((x) => x.id === active);
      const after = ordered.slice(i + 1).find((x) => !ids.includes(x.id)) ?? [...ordered.slice(0, i)].reverse().find((x) => !ids.includes(x.id));
      setActive(after?.id ?? rest[0]?.id ?? '');
    }
  };
  const closeTab = (id: string) => closeTabs([id]);
  /** File menu / command palette / tab bar ⋯: pinned tabs are kept by the bulk commands. */
  const runTabCommand = (command: string) => {
    const unpinned = ordered.filter((x) => !x.pinned).map((x) => x.id);
    if (command === 'close') {
      const cur = tabs.find((x) => x.id === active);
      if (cur && !cur.pinned) closeTab(cur.id);
    } else if (command === 'closeOthers') closeTabs(unpinned.filter((id) => id !== active));
    else if (command === 'closeAll') closeTabs(unpinned);
  };
  const duplicateTab = (t: RestTab) => {
    const copy: RestTab = { ...structuredClone(t), id: uid('tab-'), name: `${t.name} copy`, collectionId: undefined, requestId: undefined, examples: undefined, pinned: false, dirty: true };
    setTabs((ts) => {
      const i = ts.findIndex((x) => x.id === t.id);
      return [...ts.slice(0, i + 1), copy, ...ts.slice(i + 1)];
    });
    setActive(copy.id);
  };
  /** Rename a tab (edited in place in the tab strip); a saved request is renamed in its collection too. */
  const renameTabTo = async (t: RestTab, name: string) => {
    if (!name || name === t.name) return;
    setTabs((ts) => ts.map((x) => (x.id === t.id ? { ...x, name } : x)));
    if (!t.collectionId || !t.requestId) return;
    try {
      const c = await call<Collection>('col.get', { id: t.collectionId }).catch(() => undefined);
      if (!c || !findNode(c.items, t.requestId)) return;
      await saveCollection({ ...c, items: mapNodes(c.items, (x) => (x.id === t.requestId ? { ...x, name } : x)) });
    } catch (e) {
      toastError(e);
    }
  };

  /** Save a tab's request as a YAML test file (tab menu). */
  const saveTabAsTest = (t: RestTab) =>
    void saveAsTestFile(t.name, { kind: 'http', request: toEngineRequest(t.request), preRequestScript: t.preRequestScript, testScript: t.testScript, status: results[t.id]?.response?.status }, t.assertions);

  const result = results[tab.id];
  // "Ask the assistant" includes the open request and its latest response (secrets are hidden by the backend)
  useAssistantContext(
    'rest',
    useCallback(() => {
      if (tab === placeholder || !tab.request.url) return undefined;
      const res = result?.response;
      const err = result?.error as { kind?: string; message?: string } | undefined;
      return {
        label: `${tab.request.method} ${tab.request.url}${res ? ` · ${res.status}` : err ? ' · error' : ''}`,
        context: {
          request: { name: tab.name, method: tab.request.method, url: tab.request.url, headers: tab.request.headers?.filter((h) => h.enabled !== false).map((h) => ({ key: h.key, value: h.value })), body: tab.request.body },
          ...(res ? { response: { status: res.status, statusText: res.statusText, headers: res.headers.slice(0, 20), body: res.bodyPreview.slice(0, 4000) } } : {}),
          ...(err ? { error: { kind: err.kind, message: err.message } } : {}),
        },
      };
    }, [tab, result]),
  );
  const saveExample = async () => {
    const res = result?.response;
    if (!res) return;
    if (!tab.collectionId || !tab.requestId) {
      useApp.getState().toast('Save the request to a collection first, then save responses as examples', 'error');
      return setSaving(true);
    }
    const name = await promptText('Save as example', { value: `${res.status} ${res.statusText}`.trim(), okLabel: 'Save', message: 'Sensitive headers and values are masked before the example is saved to the collection.' });
    if (!name?.trim()) return;
    try {
      const body = tab.request.body && 'content' in tab.request.body ? tab.request.body.content : undefined;
      const ex = await call<SavedExample>('col.addExample', {
        collectionId: tab.collectionId,
        requestId: tab.requestId,
        name,
        environment: env,
        response: { status: res.status, statusText: res.statusText, headers: res.headers, bodyPreview: res.bodyPreview, truncated: res.truncated, json: res.json },
        request: { method: tab.request.method, url: tab.request.url, headers: tab.request.headers?.filter((h) => h.enabled !== false && h.key), body },
      });
      setExamples([...(tab.examples ?? []), ex]);
      useApp.getState().toast(`Saved example "${ex.name}"`, 'success');
    } catch (e) {
      toastError(e);
    }
  };

  /** Natural language → a new request tab (nothing is sent until the user clicks Send). */
  const describeRequest = async () => {
    const description = await promptText('Describe a request', {
      message: 'Describe the request in plain words. The AI assistant fills in method, URL, headers and body; you review it before sending.',
      placeholder: 'Create a patient named Biscuit, a dog, owned by customer 123',
      okLabel: 'Generate',
    });
    if (!description?.trim()) return;
    const actId = uid('ai-');
    useApp.getState().setActivity(actId, 'Generating a request with AI');
    try {
      const r = await call<{ name?: string; request: HttpRequestSpec; model: string }>('ai.generateRequest', { description, environment: env });
      const t: RestTab = { ...blankRequest(), name: r.name ?? 'AI request', request: fromEngineRequest(r.request), dirty: true };
      setTabs((ts) => [...ts, t]);
      setActive(t.id);
      useApp.getState().toast(`Request drafted by ${r.model}: review it before sending`, 'info');
    } catch (e) {
      toastAiError(e);
    } finally {
      useApp.getState().setActivity(actId);
    }
  };
  const generateTests = result?.response
    ? async () => {
        const res = result.response!;
        const actId = uid('ai-');
        useApp.getState().setActivity(actId, 'Generating tests with AI');
        try {
          const r = await call<{ script: string; model: string }>('ai.generateTests', {
            environment: env,
            request: { method: tab.request.method, url: tab.request.url },
            response: { status: res.status, headers: res.headers.slice(0, 20), body: res.bodyPreview.slice(0, 6000), timeMs: res.durationMs },
          });
          update({ testScript: tab.testScript?.trim() ? `${tab.testScript.trimEnd()}\n\n${r.script}` : r.script });
          useApp.getState().toast(`Added tests by ${r.model} to the Post-response script (Scripts tab). Send again to run them.`, 'success');
        } catch (e) {
          toastAiError(e);
        } finally {
          useApp.getState().setActivity(actId);
        }
      }
    : undefined;
  const explain = result?.response
    ? () =>
        useApp.getState().set({
          assistant: { task: 'explain-response', title: 'Explain this response', context: { request: { method: tab.request.method, url: tab.request.url }, status: result.response!.status, headers: result.response!.headers.slice(0, 20), body: result.response!.bodyPreview.slice(0, 6000) } },
        })
    : undefined;

  // a field clicked in the response tree becomes a check in the request's Tests tab
  // a snapshot check whose API changed on purpose: keep the current response (at the check's path) as its copy
  const updateSnapshot = (path: string) => {
    const json = result?.response?.json;
    if (json === undefined) return;
    const value = path === '$' ? json : JSONPath({ path, json: json as object, wrap: false });
    let n = 0;
    update({ assertions: tab.assertions.map((a) => (a.type === 'snapshot' && ((a.path as string | undefined) || '$') === path ? (n++, { ...a, expected: value }) : a)) as never });
    useApp.getState().toast(n ? 'Snapshot updated. Save the request to keep it.' : 'No snapshot check for that part of the response', n ? 'success' : 'error');
  };

  const addAssertion = (a: TreeAssertion) => {
    update({ assertions: [...tab.assertions, a as never] });
    useApp.getState().toast(`Added a check on ${a.path} (Tests tab). Save the request to keep it.`, 'success');
  };

  // a response field kept in a variable: the test script sets it after every send, and it is set now too
  const saveVariable = async (v: TreeVariable) => {
    const testScript = await saveResponseVariable(v, env, tab.testScript);
    if (testScript !== undefined) update({ testScript });
  };

  /** Checks suggested by the assistant (a YAML list) go into a tab's Tests tab. */
  const addSuggestedChecks = (tabId: string, code: string): string | void => {
    let parsed: unknown;
    try {
      parsed = parseYaml(code);
    } catch {
      return 'it is not valid YAML';
    }
    const list = Array.isArray(parsed) ? parsed : ((parsed as { tests?: unknown[]; assertions?: unknown[] } | null)?.tests ?? (parsed as { assertions?: unknown[] } | null)?.assertions ?? []);
    const checks = list.filter((x): x is CheckConfig => !!x && typeof x === 'object' && typeof (x as { type?: unknown }).type === 'string');
    if (!checks.length) return 'it has no checks';
    if (!tabs.some((t) => t.id === tabId)) return 'the request was closed';
    setTabs((ts) => ts.map((t) => (t.id === tabId ? { ...t, assertions: [...t.assertions, ...checks], dirty: true } : t)));
  };
  const suggest = result?.response
    ? () =>
        useApp.getState().set({
          assistant: {
            task: 'generate-assertions',
            title: 'Suggested assertions',
            context: { request: { method: tab.request.method, url: tab.request.url }, status: result.response!.status, headers: result.response!.headers.slice(0, 20), body: result.response!.bodyPreview.slice(0, 6000) },
            apply: { label: 'Add to the checks', run: (code) => addSuggestedChecks(tab.id, code) },
          },
        })
    : undefined;

  // REST's tabs are shown in the shared tab strip above every request editor (with the other editors' tabs)
  useEditorTabs(
    'rest',
    ordered.map((t) => ({
      key: `rest:${t.id}`,
      view: 'rest' as const,
      title: tabTitle(t.name, NEW_TAB_TITLE.rest),
      badge: t.request.method,
      badgeClass: `method-${t.request.method}`,
      item: t.requestId,
      dirty: t.dirty,
      pinned: t.pinned,
      onSelect: () => setActive(t.id),
      onClose: () => void closeTab(t.id),
      closeMany: (keys: string[]) => void closeTabs(keys.map((k) => k.replace(/^rest:/, ''))),
      // the tab menu itself is the shared one (EditorTabs), the same on every request tab
      onRenameTo: (name: string) => renameTabTo(t, name),
      onDuplicate: () => duplicateTab(t),
      onSaveAsTest: () => saveTabAsTest(t),
      onTogglePin: () => setTabs((ts) => ts.map((x) => (x.id === t.id ? { ...x, pinned: !x.pinned } : x))),
    })),
    noTabs ? undefined : `rest:${tab.id}`,
  );
  return (
    <>
    <Split id="rest-sidebar" sidebar collapsed initial={20} min={12}>
      <SidebarShell
        id="rest"
        value={side}
        onChange={(v) => setSide(v as typeof side)}
        panes={[
          {
            id: 'collections',
            label: 'Collections',
            icon: <FolderTree size={13} />,
            render: () => (
              <>
                  <div className="flex items-center gap-1 px-2 pb-2">
                    <Input className="flex-1 h-7 min-h-7 text-sm" placeholder="Filter requests" value={filter} onChange={(e) => setFilter(e.target.value)} />
                    <IconButton
                      label={favoritesOnly ? 'Show all requests' : 'Show favorites only'}
                      active={favoritesOnly}
                      onClick={() => setFavoritesOnly((current) => {
                        localStorage.setItem('aps.rest.favoritesOnly', String(!current));
                        return !current;
                      })}
                    >
                      <Star size={14} fill={favoritesOnly ? 'currentColor' : 'none'} />
                    </IconButton>
                    <IconButton label="Import (OpenAPI, Postman, Insomnia, Bruno, HAR …)" onClick={() => setImporting(true)}>
                      <Upload size={14} />
                    </IconButton>
                    <Menu
                      width={260}
                      trigger={
                        <IconButton label="Export a collection" disabled={!collections.length}>
                          <Download size={14} />
                        </IconButton>
                      }
                      items={[
                        ...collections.slice(0, 12).map((c) => ({ label: `${c.name} (Postman v2.1)`, icon: <Download size={14} />, onSelect: () => useApp.getState().openIntent('collections', { collectionId: c.id, export: 'postman' }) })),
                        { label: 'More formats (TestPion, OpenAPI, Bruno, workspace)…', icon: <FolderTree size={14} />, separator: true, onSelect: () => useApp.getState().setView('collections') },
                      ]}
                    />
                    <IconButton
                      label="New collection"
                      onClick={async () => {
                        const name = await promptText('New collection', { message: 'Collection name', placeholder: 'My API', okLabel: 'Create' });
                        if (name) await saveCollection({ schemaVersion: '1.0', id: uid('col-'), name, version: 0, variables: [], items: [], updatedAt: '' });
                      }}
                    >
                      <FolderPlus size={14} />
                    </IconButton>
                  </div>
                  <div className="flex-1 overflow-auto">
                    {collections.length ? (
                      <CollectionTree
                        collections={collections}
                        filter={filter}
                        favoritesOnly={favoritesOnly}
                        activeRequestId={tab.requestId}
                        onOpen={openRequest}
                        onChange={saveCollection}
                        onMoved={(ids, from, to) => setTabs((ts) => ts.map((t) => (t.requestId && ids.includes(t.requestId) && t.collectionId === from ? { ...t, collectionId: to } : t)))}
                        onRun={(c, folderId) => useApp.getState().openIntent('collections', { collectionId: c.id, run: true, folderId })}
                        onNewRequest={async (c, folderId) => {
                          const t = blankRequest();
                          const node: SavedHttpRequest = { kind: 'http', id: uid('req-'), name: 'New request', request: t.request, assertions: t.assertions };
                          await saveCollection({ ...c, items: addToFolder(c.items, folderId, node) });
                          openRequest(c, node);
                        }}
                      />
                    ) : (
                      <Empty
                        icon={<FolderTree size={22} />}
                        title="No collections yet"
                        actions={[{ label: 'Import', icon: <Upload size={12} />, primary: false, onClick: () => setImporting(true) }]}
                      >
                        Save a request with Ctrl+S, create a collection, or import OpenAPI, Postman, Insomnia, Bruno or HAR.
                      </Empty>
                    )}
                  </div>
              </>
            ),
          },
          { id: 'environments', label: 'Environments', icon: <KeyRound size={13} />, render: () => <EnvironmentsPane /> },
          {
            id: 'history',
            label: 'History',
            icon: <History size={13} />,
            render: () => (
              <HistoryPane
                onOpen={(item) => {
                  if (!item.request) return;
                  const t: RestTab = { ...blankRequest(), name: item.name, request: fromEngineRequest(item.request as HttpRequestSpec) };
                  setTabs((ts) => [...ts, t]);
                  setActive(t.id);
                }}
              />
            ),
          },
        ]}
      />
      <div className="h-full flex flex-col min-w-0" data-collection-id={tab.collectionId}>
        {noTabs ? (
          <NoOpenTabs onDescribe={() => void describeRequest()} />
        ) : (
        <>
        <RequestBreadcrumb collectionId={tab.collectionId} requestId={tab.requestId} name={tab.name} dirty={tab.dirty} onSave={() => void quickSave()} />
        <div className="flex items-center gap-2 p-2 border-b border-line shrink-0">
          {/* the app's own menu instead of a native <select>: the desktop app's native popup didn't let people pick a method */}
          <Menu
            align="start"
            width={150}
            items={[
              ...[...METHODS, ...(METHODS.includes(tab.request.method) ? [] : [tab.request.method])].map((m) => ({
                label: m,
                icon: <span aria-hidden className={cx('block w-2 h-2 rounded-full bg-current', `method-${m}`)} />,
                onSelect: () => setReq({ method: m }),
              })),
              {
                label: 'Custom…',
                icon: <Pencil size={13} />,
                separator: true,
                onSelect: async () => {
                  const m = await promptText('Custom HTTP method', { message: 'Any method name, e.g. PROPFIND, PURGE or LINK.', value: 'PROPFIND', okLabel: 'Use' });
                  if (m) setReq({ method: m.toUpperCase() });
                },
              },
            ]}
            trigger={
              <button
                aria-label="Method"
                aria-haspopup="menu"
                className={cx('field mono font-bold w-28 inline-flex items-center justify-between gap-1 text-left', `method-${tab.request.method}`)}
              >
                <span className="truncate">{tab.request.method}</span>
                <ChevronDown size={13} className="shrink-0 text-muted" />
              </button>
            }
          />
          <VarInput
            ariaLabel="Request URL"
            className="flex-1 h-8"
            value={tab.request.url}
            onChange={setUrl}
            onPasteText={(text) => (isRequestSnippet(text) ? (void importSnippet(text), true) : false)}
            placeholder="Enter a URL, paste cURL / fetch / PowerShell, or use {{baseUrl}}/path"
            onEnter={send}
            collectionId={tab.collectionId}
          />
          {sending[tab.id] ? (
            <Button variant="danger" icon={<Square size={12} />} onClick={cancel}>
              Cancel
            </Button>
          ) : (
            <Button variant="primary" icon={<Send size={13} />} onClick={send} title="Send (Ctrl+Enter)">
              Send
            </Button>
          )}
          <IconButton label="Compare across environments" onClick={() => setComparingEnvs(true)}>
            <ArrowLeftRight size={16} />
          </IconButton>
          <IconButton label="Code snippet" onClick={() => setShowCode(true)}>
            <Code2 size={16} />
          </IconButton>
          <IconButton label="Describe a request with AI" onClick={() => void describeRequest()}>
            <Sparkles size={16} />
          </IconButton>
          <IconButton label="Cookies" onClick={() => setShowCookies(true)}>
            <Cookie size={16} />
          </IconButton>
          <Button icon={<Save size={13} />} onClick={quickSave} title="Save (Ctrl+S)">
            Save
          </Button>
        </div>
        <ResponseSplit id="rest-req-res" initialBelow={45}>
          <RequestEditor tab={tab} update={update} setReq={setReq} setParams={setParams} setExamples={setExamples} />
          <div className="h-full min-h-0 flex flex-col">
            {sending[tab.id] && liveEvents[sending[tab.id]!] ? (
              <SseEvents events={liveEvents[sending[tab.id]!]!} live onStop={cancel} />
            ) : sending[tab.id] ? (
              <div className="h-full grid place-items-center text-muted text-sm">
                <div className="flex flex-col items-center gap-2">
                  <div className="relative w-40 h-1 bg-panel2 overflow-hidden rounded indeterminate" />
                  Sending request… <span className="text-xs">Ctrl+Enter again is disabled while sending</span>
                </div>
              </div>
            ) : result?.error ? (
              <div className="overflow-auto">
                <ErrorPanel error={result.error} context={{ request: { method: tab.request.method, url: tab.request.url } }} />
              </div>
            ) : result?.response ? (
              <ResponseViewer response={result.response} checks={result.checks} traceId={result.traceId} curl={result.curl} stream={result.stream} scriptLogs={result.scriptLogs} visualizer={result.visualizer} requestId={tab.requestId} historyId={result.historyId} onSuggestAssertions={suggest} onAddAssertion={addAssertion} onUpdateSnapshot={updateSnapshot} onSaveVariable={(v) => void saveVariable(v)} onSaveExample={() => void saveExample()} onGenerateTests={generateTests && (() => void generateTests())} onExplain={explain} />
            ) : (
              <Empty icon={<Send size={28} />} title="Send a request to see the response">
                Press <b>Ctrl+Enter</b> to send. Variables like <span className="var-token mono">{'{{baseUrl}}'}</span> resolve from the active environment.
              </Empty>
            )}
          </div>
        </ResponseSplit>
        </>
        )}
      </div>
    </Split>
      {saving && <SaveModal collections={collections} defaultName={tab.name} onClose={() => setSaving(false)} onSave={(cid, name, folder) => (setSaving(false), void saveTab(cid, name, folder))} onCreate={saveCollection} />}
      {importing && <ImportModal onClose={() => setImporting(false)} onDone={loadCollections} />}
      {showCookies && <CookiesModal initialDomain={hostOf(tab.request.url) || undefined} onClose={() => setShowCookies(false)} />}
      {comparingEnvs && <EnvCompareDialog tab={tab} onClose={() => setComparingEnvs(false)} />}
      {showCode && <CodeModal request={toEngineRequest(tab.request)} collectionId={tab.collectionId} requestId={tab.requestId} onClose={() => setShowCode(false)} />}
    </>
  );
}

