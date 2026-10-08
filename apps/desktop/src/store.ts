import { toast as sonner } from 'sonner';
import type { ReactNode } from 'react';
import { docKey, isDocView, routeDoc, useDocs } from './lib/docs';
import { create } from 'zustand';
import type { AppSettings, WorkspaceCurrent } from './types';
import type { FeedbackRequest } from './components/FeedbackDialog';
import { asError, call } from './api';
import { loadDraft, saveDraft } from './lib/draft-store';

export type ViewId =
  | 'home'
  | 'rest'
  | 'graphql'
  | 'websocket'
  | 'grpc'
  | 'mcp'
  | 'apidef'
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

export interface CiRequest {
  suite?: string;
  collection?: string;
  folders?: string[];
}

/** What an assistant answer's Apply did: nothing (done), a problem (a string), or a message with an action (Open …). */
export type AssistantApplied = string | void | { done: string; action?: { label: string; onClick(): void } };

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
}

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
  info?: { version: string; appVersion?: string; packaged?: boolean; canUpdateInPlace?: boolean; secretBackend: string; metaBackend?: string; platform: string; nativeDialogs?: boolean; checkTypes: string[]; electron?: string; node?: string };
  paletteOpen: boolean;
  searchOpen: boolean;
  logsOpen: boolean;
  /** The Collections explorer panel next to the navigation rail (Ctrl+B). */
  explorerOpen: boolean;
  toggleExplorer(open?: boolean): void;
  /** Which tab of the bottom panel is shown. */
  bottomTab: 'console' | 'logs';
  assistant?: AssistantRequest;
  shortcutsOpen?: boolean;
  /** The "Run in CI" dialog, with what to run preselected. */
  ci?: CiRequest;
  /** The "Compare OpenAPI versions" dialog. */
  openapiDiff?: boolean;
  /** The API coverage dialog; `runId` preselects a run. */
  apiCoverage?: { runId?: string; spec?: string };
  /** The "Variable usages" dialog, with the variable to show (true: none chosen yet). */
  variableUsages?: string | true;
  /** The "Record traffic" dialog. */
  recordOpen?: boolean;
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
  toast(text: string, kind?: Toast['kind'], action?: { label: string; onClick(): void }): void;
  setActivity(key: string, label?: string): void;
  openIntent(view: ViewId, payload: any): void;
  /** Back / forward through the places visited (views and the items opened in them), like a browser. */
  nav: { back: NavLocation[]; forward: NavLocation[]; current: NavLocation };
  goBack(): void;
  /** The request editor used last (Collections on the rail returns to it). */
  lastRequestView: ViewId;
  /** Record the item a view just opened by itself (e.g. a click in its own list), so Back returns to it. */
  markPlace(view: ViewId, payload: Record<string, unknown>): void;
  goForward(): void;
  refreshWorkspace(): Promise<void>;
  saveSettings(s: AppSettings): Promise<void>;
  setEnvironment(name?: string): void;
}

let toastId = 0;

/** The request editors: they use the Collections explorer as their (only) sidebar and aren't on the rail. */
export const REQUEST_VIEWS: ViewId[] = ['rest', 'graphql', 'grpc', 'websocket', 'mcp', 'apidef', 'collections'];
export const isRequestView = (v: ViewId) => REQUEST_VIEWS.includes(v);

/** A place in the app: a view, and the item opened in it when there is one. */
export interface NavLocation {
  view: ViewId;
  /** Intent payload that reopens the item (only "open this" keys, never actions like newTab or import). */
  payload?: Record<string, unknown>;
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
  set({ nav: { back: [...back, current].slice(-NAV_LIMIT), forward: [], current: next } });
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
  toast: (text, kind = 'info', action) => {
    const id = ++toastId;
    // a toast with an action (Undo) stays longer, so there is time to use it
    const duration = action ? 8000 : kind === 'error' || kind === 'warning' ? 7000 : 3500;
    set({ toasts: [...get().toasts, { id, kind, text }] });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), duration);
    (kind === 'error' ? sonner.error : kind === 'success' ? sonner.success : kind === 'warning' ? sonner.warning : sonner)(text, { duration, ...(action ? { action: { label: action.label, onClick: action.onClick } } : {}) });
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
    const ws = await call<WorkspaceCurrent>('ws.current');
    const stored = ws ? localStorage.getItem(`aps.env.${ws.id}`) : null;
    const env = ws?.environments.find((e) => e.name === (get().environment ?? stored)) ?? ws?.environments[0];
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

/** Show an error (anything thrown) as an error toast; a missing AI key offers "Add the key" (AI Lab ▸ Providers, its key field). */
export function toastError(e: unknown): void {
  const err = asError(e);
  const provider = (err.details as { setup?: { provider?: string } } | undefined)?.setup?.provider;
  useApp
    .getState()
    .toast(err.message, 'error', provider ? { label: 'Add the key', onClick: () => useApp.getState().openIntent('ai', { providerId: provider, tab: 'providers' }) } : undefined);
}

/** Persist per-view drafts in localStorage (UI state only — never secrets or responses). */
export function persisted<T>(key: string, fallback: T): { load(): T; save(v: T): void; forDoc(docId?: string): { load(): T; save(v: T): void } } {
  return {
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
