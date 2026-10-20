import { toast as sonner } from 'sonner';
import { aiSetupAction } from './lib/ai-errors';
import type { ReactNode } from 'react';
import { docKey, isDocView, routeDoc, useDocs } from './lib/docs';
import { create } from 'zustand';
import type { AppSettings, WorkspaceCurrent } from './types';
import type { FeedbackRequest } from './components/FeedbackDialog';
import { asError, call } from './api';
import { loadDraft, saveDraft } from './lib/draft-store';
import { setDraftScope } from './lib/ws-scope';
import { offerUndo, UNDO_MS } from './lib/undo';
import { normalizeEnvironment } from './lib/environments-store';
import { refOpenLabel, type ItemRef } from '@testpion/shared';

export type ViewId =
  | 'home'
  | 'rest'
  | 'graphql'
  | 'websocket'
  | 'grpc'
  | 'mcp'
  | 'apidef'
  | 'dataset'
  | 'ai'
  | 'evaluations'
  | 'tests'
  | 'load'
  | 'traces'
  | 'monitors'
  | 'collections'
  | 'history'
  | 'environments'
  | 'git'
  | 'debugger'
  | 'settings';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'warning' | 'error';
  text: string;
}

/**
 * A toast's button: something to do, or (WF-04) the item the toast is about, which the button opens through openRef
 * ("Open run", "Open test file" … from its kind unless `label` says otherwise). Two at most: the first is the main one.
 */
export type ToastAction = { label: string; onClick(): void } | { ref: ItemRef; label?: string; newTab?: boolean };

export interface CiRequest {
  suite?: string;
  collection?: string;
  folders?: string[];
  /** Test files or folders inside tests/ (a flow's Deploy ▸ CI: that file). */
  tests?: string[];
  /** The environment to preselect (the flow canvas's, a run's). */
  environment?: string;
  /** With tests: the name / tag filter of the run it comes from (WF-09). */
  grep?: string;
  tags?: string[];
}

/** What an assistant answer's Apply did: nothing (done), a problem (a string), or a message with an action (Open …). */
export type AssistantApplied = string | void | { done: string; action?: { label: string; onClick(): void } };

/** A response as AI checks are verified against it (core StoredResponse). */
export interface AiResponse {
  status?: number;
  headers?: Array<[string, string]>;
  body?: string;
  latencyMs?: number;
}

export interface AssistantRequest {
  task: string;
  title: string;
  context: unknown;
  question?: string;
  /**
   * Puts an answer to use where it was asked for (Add the checks to the request, Use this query, …): `run` gets the
   * answer's first code block (or its whole text) and returns a message when it can't use it, or what it did.
   */
  apply?: { label: string; run(code: string): AssistantApplied | Promise<AssistantApplied> };
  /** The privacy level chosen in "What will be sent" (else the AI settings' default). */
  privacy?: 'full' | 'metadata' | 'names';
  /** The response checks and scripts are verified against (the one on screen). */
  response?: AiResponse;
  /** The response before it: a check that passes on one and not the other pins a value that changes. */
  previous?: AiResponse;
  /** Open the review as soon as the proposal is there (generating tasks: checks, tests, a request). */
  autoReview?: boolean;
  /** "Run now" in the review: send the request again (its own editor, under the production guard); the checks are verified against the new response. */
  rerun?(): Promise<AiResponse | undefined>;
  /** The workspace item it is about (a saved request: checks and scripts are proposed for it). */
  item?: import('@testpion/shared').ItemRef;
  /** Where a generated test file goes (under tests/). */
  path?: string;
}

/**
 * "Generate integration flow with AI" (AI-1): from a collection or folder (right-click it), or from the flow canvas
 * (where describing it in words is the other source). The dialog runs the task and opens the proposal's review.
 */
/**
 * "Ask…" (AI-12): the natural-language search over History, runs, test results and traces. One dialog, opened from the
 * search box, the palette and the History / Runs / Traces filter bars (`scope` keeps the search inside the view); with a
 * `question` it asks at once.
 */
export interface AskSearchRequest {
  question?: string;
  /** Sources to stay in (history, runs, results, traces); none: all four. */
  scope?: string[];
}

export interface FlowGenerateRequest {
  /** The collection or folder preselected. */
  source?: { collectionId: string; folderId?: string };
  /** Start on "Describe in words" (the canvas of an open flow). */
  mode?: 'collection' | 'describe' | 'spec';
  /** mode spec: the API definition preselected (specs/…). */
  spec?: string;
  /** The flow file the result goes to (the open flow: its review shows the diff); default a new file under tests/flows/. */
  path?: string;
  /** describe: the open flow's steps, as context. */
  steps?: unknown[];
  environment?: string;
  /** The open flow designer applies an accepted flow itself (one undo step); else it is written through ai.applyProposal. */
  onAccept?(text: string): Promise<boolean>;
}

/**
 * An AI analysis (AI-2 / AI-5): "Explain and fix failures with AI" on a failed run, or "Why is this flaky?" on a flaky
 * test. The dialog shows what is analysed and the estimate, runs it, and opens the findings with their fixes in the review.
 */
/** "Tidy this import with AI" (AI-10) for a collection; `source` is the import's format. */
export interface TidyImportRequest {
  collectionId: string;
  source?: string;
}

export type AiAnalysisRequest = { kind: 'triage'; runId: string; title?: string } | { kind: 'flaky'; testId: string; title?: string };

export interface DialogButton {
  id: string;
  label: string;
  variant?: 'primary' | 'default' | 'danger';
  /** Its icon; without one, the label picks it (Create → +, Delete → bin, Cancel → ×, …). */
  icon?: ReactNode;
}

/** What kind of message a dialog is; sets its icon and colour (see the Design docs page). */
export type DialogTone = 'info' | 'question' | 'warning' | 'danger' | 'success';

export interface DialogRequest {
  title: string;
  message: string;
  /** Icon and colour; defaults to "question" when there are several buttons, else "info". */
  tone?: DialogTone;
  /** What the dialog is about (a key for an environment, a folder …), in place of the tone's icon. */
  icon?: ReactNode;
  detail?: string;
  buttons: DialogButton[];
  cancelId: string;
  /** Show a text field; its value is passed to resolve. */
  input?: { value: string; placeholder?: string; multiline?: boolean };
  resolve(id: string, value?: string): void;
}

export interface ProgressState {
  title: string;
  message: string;
  /** 0..1, or null for indeterminate. */
  fraction: number | null;
}

/** Cross-view "open this thing" requests (e.g. history → REST tab, search → test file). */
export interface Intent {
  view: ViewId;
  payload: any;
  nonce: number;
  /** For multi-document editors: the document (tab) that handles it. */
  docId?: string;
}

interface AppState {
  view: ViewId;
  setView(v: ViewId): void;
  workspace?: WorkspaceCurrent;
  environment?: string;
  settings?: AppSettings;
  info?: { version: string; appVersion?: string; packaged?: boolean; canUpdateInPlace?: boolean; secretBackend: string; metaBackend?: string; platform: string; nativeDialogs?: boolean; checkTypes: string[]; electron?: string; node?: string; capabilities?: { shell?: boolean } };
  paletteOpen: boolean;
  /** What the palette opens with (Quick Open's mode prefix: '' items, '>' commands, '#' environments); unset: '>'. */
  paletteQuery?: string;
  searchOpen: boolean;
  logsOpen: boolean;
  /** The Collections explorer panel next to the navigation rail (Ctrl+B). */
  explorerOpen: boolean;
  /** The explorer beside the Tests view (requests dragged from it onto a flow's canvas): opened there on purpose only. */
  explorerInTests?: boolean;
  toggleExplorer(open?: boolean): void;
  /** Which tab of the bottom panel is shown. */
  bottomTab: 'console' | 'logs' | 'terminal' | 'problems';
  assistant?: AssistantRequest;
  /** The "Generate integration flow with AI" dialog (AI-1). */
  flowGenerate?: FlowGenerateRequest;
  /** The "Ask…" search dialog (AI-12). */
  askSearch?: AskSearchRequest;
  /** Explain and fix failures (AI-2) / Why is this flaky? (AI-5). */
  aiAnalysis?: AiAnalysisRequest;
  /** Tidy this import with AI (AI-10). */
  tidyImport?: TidyImportRequest;
  shortcutsOpen?: boolean;
  /** The "Run in CI" dialog, with what to run preselected. */
  ci?: CiRequest;
  /** The "Compare OpenAPI versions" dialog. */
  openapiDiff?: boolean;
  /** The Export bundle dialog (lib/transfer.ts): what to export. */
  exportBundle?: import('./lib/transfer').ExportRequest;
  /** The Import bundle dialog (lib/transfer.ts): a section limits it to that kind. */
  importBundle?: import('./lib/transfer').ImportRequest;
  /** The API coverage dialog; `runId` preselects a run. */
  apiCoverage?: { runId?: string; spec?: string };
  /** The "Variable usages" dialog, with the variable to show (true: none chosen yet). */
  variableUsages?: string | true;
  /** The "Record traffic" dialog. */
  recordOpen?: boolean;
  /** The cookie jar (status bar ▸ Tools ▸ Cookies…). */
  cookiesOpen?: boolean;
  /** Help ▸ Send feedback, with what to start from (a crash's error, a kind). */
  feedback?: FeedbackRequest;
  /** Bumped when environments change outside the Environments view (e.g. a variable renamed everywhere). */
  envsVersion?: number;
  toasts: Toast[];
  activity: Record<string, string>;
  intent?: Intent;
  mcpConnected: number;
  dialog?: DialogRequest;
  progress?: ProgressState | null;
  set(p: Partial<AppState>): void;
  /**
   * A message at the bottom right. `opts.undo`: the message is about something reversible (a delete): it gets Undo for
   * 8 s, also Ctrl/Cmd+Z (lib/undo.ts); the undo's failure is shown as an error.
   */
  toast(text: string, kind?: Toast['kind'], action?: ToastAction | ToastAction[], opts?: { undo?: () => unknown; restored?: string }): void;
  setActivity(key: string, label?: string): void;
  openIntent(view: ViewId, payload: any): void;
  /** Back / forward through the places visited (views and the items opened in them), like a browser. */
  nav: { back: NavLocation[]; forward: NavLocation[]; current: NavLocation };
  goBack(): void;
  /** The request editor used last (Collections on the rail returns to it). */
  lastRequestView: ViewId;
  /** Record the item a view just opened by itself (e.g. a click in its own list), so Back returns to it. */
  markPlace(view: ViewId, payload: Record<string, unknown>): void;
  /** Show an item in the Collections explorer now (WF-11): its collection and folders open and its row scrolls into view; no id: the open item. */
  reveal?: { id?: string; nonce: number };
  /** Name the place on screen (openRef knows the item's name once it resolved it). */
  labelPlace(view: ViewId, label: string): void;
  goForward(): void;
  refreshWorkspace(): Promise<void>;
  saveSettings(s: AppSettings): Promise<void>;
  setEnvironment(name?: string): void;
}

let toastId = 0;
/** The toast with Undo shown for each message: the same message again replaces it (its Undo is the newer delete's). */
const undoToastFor = new Map<string, string>();

/** A toast action as a button; one about an item opens it through openRef (loaded on first use: open-ref imports this store). */
function toastButton(a: ToastAction): { label: string; onClick(): void } {
  if (!('ref' in a)) return { label: a.label, onClick: a.onClick };
  return { label: a.label ?? refOpenLabel(a.ref), onClick: () => void import('./lib/open-ref').then((m) => m.openRef(a.ref, { newTab: a.newTab })) };
}

const NO_ENVIRONMENTS: WorkspaceCurrent['environments'] = [];
/** The open workspace's environments, for `useApp(selectEnvironments)`: the same empty list while none is open (a new [] per read would re-render forever). */
export const selectEnvironments = (s: { workspace?: WorkspaceCurrent }): WorkspaceCurrent['environments'] => s.workspace?.environments ?? NO_ENVIRONMENTS;

/** The request editors: they use the Collections explorer as their (only) sidebar and aren't on the rail. */
export const REQUEST_VIEWS: ViewId[] = ['rest', 'graphql', 'grpc', 'websocket', 'mcp', 'apidef', 'dataset', 'collections'];
export const isRequestView = (v: ViewId) => REQUEST_VIEWS.includes(v);

/** A place in the app: a view, and the item opened in it when there is one. */
export interface NavLocation {
  view: ViewId;
  /** Intent payload that reopens the item (only "open this" keys, never actions like newTab or import). */
  payload?: Record<string, unknown>;
  /** What Back / Forward and Recent places call it: "GET List patients · Veterinary API" (WF-10). */
  label?: string;
}

/** Names a place when it is recorded, and notes the item it shows (lib/open-ref.ts sets it: the store knows no items). */
let placeNamer: ((l: NavLocation) => string | undefined) | undefined;
export function setPlaceNamer(f: (l: NavLocation) => string | undefined): void {
  placeNamer = f;
}
function named(l: NavLocation): NavLocation {
  if (l.label || !placeNamer) return l;
  try {
    const label = placeNamer(l);
    return label ? { ...l, label } : l;
  } catch {
    return l;
  }
}

/** Intent keys that identify an item to open; everything else (newTab, reset, import, run …) is an action, not a place. */
const PLACE_KEYS = ['collectionId', 'requestId', 'savedId', 'monitorId', 'environmentId', 'serverId', 'historyId', 'runId', 'path', 'tab'];
const ACTION_KEYS = ['newTab', 'reset', 'import', 'export', 'run', 'create', 'addServer', 'request', 'runCurrent', 'runAll', 'exportLatest', 'mock'];
function replayable(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as Record<string, unknown>;
  if (ACTION_KEYS.some((k) => p[k] !== undefined && p[k] !== false)) return undefined;
  const out = Object.fromEntries(PLACE_KEYS.filter((k) => p[k] !== undefined).map((k) => [k, p[k]]));
  return Object.keys(out).length ? out : undefined;
}
function lastRequest(view: ViewId): { lastRequestView?: ViewId } {
  if (!isRequestView(view) || view === 'collections') return {};
  try {
    localStorage.setItem('aps.lastRequestView', view);
  } catch {
    /* storage unavailable */
  }
  return { lastRequestView: view };
}
const sameLocation = (a: NavLocation, b: NavLocation) => a.view === b.view && JSON.stringify(a.payload ?? null) === JSON.stringify(b.payload ?? null);
const NAV_LIMIT = 50;
type Get = () => AppState;
type Set = (p: Partial<AppState>) => void;
/** Remember where we were before going to `next` (a new place clears Forward, like a browser). */
function record(get: Get, set: Set, next: NavLocation) {
  const { back, current } = get().nav;
  if (sameLocation(current, next)) return;
  set({ nav: { back: [...back, current].slice(-NAV_LIMIT), forward: [], current: named(next) } });
}
function travel(get: Get, set: Set, dir: 'back' | 'forward') {
  const { back, forward, current } = get().nav;
  const from = dir === 'back' ? back : forward;
  const to = from[from.length - 1];
  if (!to) return;
  const nav = dir === 'back' ? { back: back.slice(0, -1), forward: [...forward, current].slice(-NAV_LIMIT), current: to } : { back: [...back, current].slice(-NAV_LIMIT), forward: forward.slice(0, -1), current: to };
  localStorage.setItem('aps.view', to.view);
  if (isDocView(to.view) && !to.payload) useDocs.getState().ensure(to.view);
  set({ nav, view: to.view, ...lastRequest(to.view), ...(to.payload ? { intent: { view: to.view, payload: to.payload, nonce: Date.now(), docId: routeDoc(to.view, to.payload) } } : {}) });
}

export const useApp = create<AppState>((set, get) => ({
  // first launch opens the Home view
  view: (localStorage.getItem('aps.view') as ViewId) || 'home',
  setView: (view) => {
    localStorage.setItem('aps.view', view);
    if (view !== get().view) record(get, set, { view });
    if (isDocView(view)) useDocs.getState().ensure(view);
    set({ view, ...lastRequest(view) });
  },
  lastRequestView: ((): ViewId => {
    try {
      const v = localStorage.getItem('aps.lastRequestView') as ViewId | null;
      return v && isRequestView(v) && v !== 'collections' ? v : 'rest';
    } catch {
      return 'rest';
    }
  })(),
  nav: { back: [], forward: [], current: { view: (localStorage.getItem('aps.view') as ViewId) || 'rest' } },
  goBack: () => travel(get, set, 'back'),
  markPlace: (view, payload) => record(get, set, { view, payload: replayable(payload) }),
  labelPlace: (view, label) => {
    const { nav } = get();
    if (nav.current.view !== view || nav.current.label === label || !nav.current.payload) return;
    set({ nav: { ...nav, current: { ...nav.current, label } } });
  },
  goForward: () => travel(get, set, 'forward'),
  paletteOpen: false,
  searchOpen: false,
  logsOpen: false,
  explorerOpen: (() => {
    try {
      return localStorage.getItem('aps.explorer') !== 'closed';
    } catch {
      return true;
    }
  })(),
  toggleExplorer: (open) => {
    const next = open ?? !get().explorerOpen;
    try {
      localStorage.setItem('aps.explorer', next ? 'open' : 'closed');
    } catch {
      /* storage unavailable */
    }
    set({ explorerOpen: next });
  },
  bottomTab: 'console',
  toasts: [],
  activity: {},
  mcpConnected: 0,
  set: (p) => set(p),
  toast: (text, kind = 'info', actions, opts) => {
    const id = ++toastId;
    const sonnerId = `t${id}`;
    // Undo comes first, before any other action (Open …)
    const undo = opts?.undo;
    // the same delete twice (deleted, restored, deleted again): one message with the newer Undo, never two alike
    if (undo) {
      const before = undoToastFor.get(text);
      if (before) sonner.dismiss(before);
      undoToastFor.set(text, sonnerId);
      setTimeout(() => undoToastFor.get(text) === sonnerId && undoToastFor.delete(text), 8000);
    }
    const undoButton = undo && {
      label: 'Undo',
      onClick: offerUndo(
        // then it says so ("Restored the request …"), or why it could not
        () =>
          void Promise.resolve()
            .then(undo)
            .then(() => get().toast(opts?.restored ?? 'Undone', 'success'), toastError),
        UNDO_MS,
        () => sonner.dismiss(sonnerId),
      ),
    };
    const [main, second] = [...(undoButton ? [undoButton] : []), ...[actions ?? []].flat().map(toastButton)];
    // a toast with an action (Undo, Open run) stays longer, so there is time to use it
    const duration = main ? 8000 : kind === 'error' || kind === 'warning' ? 7000 : 3500;
    set({ toasts: [...get().toasts, { id, kind, text }] });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), duration);
    (kind === 'error' ? sonner.error : kind === 'success' ? sonner.success : kind === 'warning' ? sonner.warning : sonner)(text, { id: sonnerId, duration, ...(main ? { action: main } : {}), ...(second ? { cancel: second } : {}) });
  },
  setActivity: (key, label) => {
    const a = { ...get().activity };
    if (label) a[key] = label;
    else delete a[key];
    set({ activity: a });
  },
  openIntent: (view, payload) => {
    localStorage.setItem('aps.view', view);
    record(get, set, { view, payload: replayable(payload) });
    set({ view, ...lastRequest(view), intent: { view, payload, nonce: Date.now(), docId: routeDoc(view, payload) } });
  },
  refreshWorkspace: async () => {
    const raw = await call<WorkspaceCurrent>('ws.current');
    // environment files are hand-edited and merged: every one has a text name and a list of variables here
    const ws = raw && { ...raw, environments: (raw.environments ?? []).map(normalizeEnvironment) };
    const stored = ws ? localStorage.getItem(`aps.env.${ws.id}`) : null;
    // an environment whose file cannot be read is never the active one
    const usable = ws?.environments.filter((e) => !e.problem) ?? [];
    const env = usable.find((e) => e.name === (get().environment ?? stored)) ?? usable[0];
    if (ws?.id !== get().workspace?.id) {
      // another workspace: its own tabs, drafts and documents (lib/ws-scope), switched before its views mount; Back,
      // Forward and a pending "open this" point at the old workspace's items
      setDraftScope(ws?.id);
      const view = get().view;
      set({ workspace: ws, environment: env?.name, nav: { back: [], forward: [], current: { view } }, intent: undefined });
      return;
    }
    set({ workspace: ws, environment: env?.name });
  },
  saveSettings: async (s) => {
    const saved = await call<AppSettings>('settings.save', s);
    set({ settings: saved });
  },
  setEnvironment: (name) => {
    const ws = get().workspace;
    if (ws && name) localStorage.setItem(`aps.env.${ws.id}`, name);
    set({ environment: name });
  },
}));

/**
 * A system notification (the window is in the background) about an item: clicking it brings the window up with the
 * item open (WF-04). Nothing when the person has not allowed notifications. `tag` replaces an earlier one of the same.
 */
export function notifySystem(title: string, body: string, opts: { ref?: ItemRef; tag?: string } = {}): void {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const n = new Notification(title, { body, ...(opts.tag ? { tag: opts.tag } : {}) });
  const ref = opts.ref;
  if (ref)
    n.onclick = () => {
      window.focus();
      void import('./lib/open-ref').then((m) => m.openRef(ref));
      n.close();
    };
}

/**
 * Show an error (anything thrown) as an error toast; a missing AI key offers "Add the key" (AI Lab ▸ Providers, its key
 * field), and a push the remote refused (someone pushed first) offers "Pull & push" (the Git view syncs).
 */
export function toastError(e: unknown): void {
  const err = asError(e);
  // an AI setup problem (a key, no model, Local only) offers its fix (lib/ai-errors.ts, the one place that decides)
  const setup = aiSetupAction(err);
  const behind = isPushRejected(err);
  useApp.getState().toast(err.message, 'error', setup ?? (behind ? { label: 'Pull & push', onClick: () => useApp.getState().openIntent('git', { sync: true }) } : undefined));
}

/** A push the remote refused because it has commits this branch does not (the core's hint says "pull first"). */
export const isPushRejected = (e: unknown): boolean => {
  const err = asError(e);
  return [err.message, ...err.suggestions].some((t) => /pull first|non-fast-forward|\[rejected\]|fetch first/i.test(t));
};

/** Persist per-view drafts in localStorage (UI state only — never secrets or responses). */
export function persisted<T>(key: string, fallback: T): { load(): T; save(v: T): void; forDoc(docId?: string): { load(): T; save(v: T): void }; defaults: T } {
  return {
    /** What a new document starts from. */
    defaults: fallback,
    /** The draft of one document of a multi-document editor (`main` is the plain key). */
    forDoc: (docId?: string) => persisted<T>(`${key}${docKey(docId)}`, fallback),
    load() {
      return loadDraft<T>(key) ?? fallback;
    },
    /** Written a moment later (lib/draft-store), not on every keystroke. */
    save(v: T) {
      saveDraft(key, v);
    },
  };
}

/** Modal question with custom buttons; resolves with the chosen button id (or cancelId on Escape). */
export function ask(req: Omit<DialogRequest, 'resolve'>): Promise<string> {
  return new Promise((resolve) =>
    useApp.getState().set({
      dialog: {
        ...req,
        resolve: (id) => {
          useApp.getState().set({ dialog: undefined });
          resolve(id);
        },
      },
    }),
  );
}

/**
 * Standard confirmation (replaces window.confirm(), which shows an unstyled OS box). Resolves true
 * when the user confirms. `danger` makes it a destructive confirmation with a red button.
 */
export function confirmAction(opts: { title: string; message: string; detail?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean; tone?: DialogTone; icon?: ReactNode }): Promise<boolean> {
  return ask({
    title: opts.title,
    message: opts.message,
    detail: opts.detail,
    icon: opts.icon,
    tone: opts.tone ?? (opts.danger ? 'danger' : 'question'),
    buttons: [
      { id: 'cancel', label: opts.cancelLabel ?? 'Cancel' },
      { id: 'ok', label: opts.confirmLabel ?? 'OK', variant: opts.danger ? 'danger' : 'primary' },
    ],
    cancelId: 'cancel',
  }).then((id) => id === 'ok');
}

/**
 * Ask for a line of text. Replaces window.prompt(), which Electron does not support (it returns null
 * without showing anything). Resolves with the trimmed text, or null when cancelled or left empty.
 */
export function promptText(title: string, opts: { message?: string; value?: string; placeholder?: string; okLabel?: string; detail?: string; icon?: ReactNode } = {}): Promise<string | null> {
  return new Promise((resolve) =>
    useApp.getState().set({
      dialog: {
        title,
        message: opts.message ?? '',
        detail: opts.detail,
        icon: opts.icon,
        input: { value: opts.value ?? '', placeholder: opts.placeholder },
        buttons: [
          { id: 'cancel', label: 'Cancel' },
          { id: 'ok', label: opts.okLabel ?? 'OK', variant: 'primary' },
        ],
        cancelId: 'cancel',
        resolve: (id, value) => {
          useApp.getState().set({ dialog: undefined });
          resolve(id === 'ok' && value?.trim() ? value.trim() : null);
        },
      },
    }),
  );
}
