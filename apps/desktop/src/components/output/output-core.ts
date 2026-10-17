import { toast as sonner } from 'sonner';
import { OUTPUT_FORMATS, CLIENT_OUTPUT_LIMIT, COPY_LIMIT, PROGRESS_THRESHOLD, bytesToBase64, formatBytes, outputSurface, type OutputFormatId, type OutputSource } from '@testpion/shared';
import { call, on } from '../../api';
import { confirmAction, toastError, useApp } from '../../store';
import { downloadContent } from '../../lib/files';

/**
 * The one way the window saves an output to a file (the down arrow on every response and result): a surface describes
 * what it shows (`OutputSpec`), and this module builds the chosen format (small ones here, big ones in the backend from
 * a `source`), sends it to `output.save` (the OS "Save as…" dialog, or a browser download), shows progress with Cancel for
 * big saves and a toast with Show in folder / Open. Nothing else in the window writes files.
 */

/** One entry of a surface's format menu. */
export interface OutputFormatSpec {
  /** Unique in the spec (default: the format id): a surface may offer the same format of several parts ("Metadata (CSV)"). */
  key?: string;
  format: OutputFormatId;
  /** The menu label (default: the format's, e.g. "JSON"). */
  label?: string;
  /** Built here, from what the surface holds (small: at most 1 MB, or it should be a source). */
  build?: () => string | Uint8Array | Promise<string | Uint8Array>;
  /** Built and streamed by the backend (a spooled response body, a run's reports, the console …). */
  source?: OutputSource;
  /** The file name to suggest (default: the spec's name and the format's extension); e.g. the server's Content-Disposition name. */
  fileName?: string;
  /** The plain click saves this one (default: the first). */
  default?: boolean;
}

export interface OutputSpec {
  /** The OUTPUT_SURFACES id (also the panel's data-output marker). */
  id: string;
  /** What it is, in a sentence: "response body" → "Download response body", "Response body saved to …". */
  what: string;
  /** The file name without extension (see outputFileName). */
  name: string;
  formats: OutputFormatSpec[];
  /** Why there is nothing to download (the control is disabled with this tooltip). */
  empty?: string;
  /** The environment the output came from (its secret values are masked in redacted exports). */
  environment?: string;
  /** It came from a production environment (said in the menu and the toast). */
  production?: boolean;
}

export const formatKey = (f: OutputFormatSpec) => f.key ?? f.format;
export const formatLabel = (f: OutputFormatSpec) => f.label ?? OUTPUT_FORMATS[f.format].label;
export const defaultFormat = (spec: OutputSpec) => spec.formats.find((f) => f.default) ?? spec.formats[0];

interface SaveAnswer {
  jobId: string;
  cancelled?: boolean;
  path?: string;
  download?: { name: string; content: string; encoding: 'base64'; type: string };
  bytes?: number;
  name?: string;
  redacted?: boolean;
  notice?: string;
  canReveal?: boolean;
  canOpen?: boolean;
}

/** The parameters of output.save / output.copy for a format: its content (built now) or its source. */
async function payload(spec: OutputSpec, f: OutputFormatSpec) {
  const info = OUTPUT_FORMATS[f.format];
  const base = { surface: spec.id, format: f.format, suggestedName: f.fileName ?? `${spec.name}.${info.ext}`, label: formatLabel(f), environment: spec.environment };
  if (f.source) return { ...base, source: f.source };
  if (!f.build) throw new Error(`${formatLabel(f)} has nothing to save`);
  const v = await f.build();
  const size = typeof v === 'string' ? v.length : v.byteLength;
  // a client-built output is a view of what the window already holds; anything bigger belongs in a backend source
  if (size > CLIENT_OUTPUT_LIMIT && import.meta.env?.DEV) console.warn(`[output] ${spec.id} ${f.format} is built in the window (${formatBytes(size)}): make it a source`);
  return { ...base, content: typeof v === 'string' ? { text: v } : { base64: bytesToBase64(v) } };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Progress of the saves running now (the control shows it), by surface id. */
const listeners = new Set<() => void>();
export const running = new Map<string, { jobId: string; bytes: number; total?: number }>();
const changed = () => listeners.forEach((l) => l());
export function onRunningChange(l: () => void): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}

let jobSeq = 0;

/** Save one format of a surface: dialog, progress (big ones), toast. `includeSecrets` only after the person confirmed. */
export async function saveOutput(spec: OutputSpec, f: OutputFormatSpec, opts: { includeSecrets?: boolean } = {}): Promise<void> {
  if (running.has(spec.id)) return;
  const jobId = `out-${Date.now().toString(36)}-${++jobSeq}`;
  const state = { jobId, bytes: 0, total: undefined as number | undefined };
  running.set(spec.id, state);
  changed();
  let toastShown = false;
  const started = Date.now();
  const cancel = () => void call('output.cancel', { jobId }).catch(() => undefined);
  const off = on<{ jobId: string; bytes: number; total?: number }>('output.progress', (e) => {
    if (e.jobId !== jobId) return;
    state.bytes = e.bytes;
    state.total = e.total;
    changed();
    // big saves (or slow ones) say how far they are, with Cancel
    if ((e.total ?? e.bytes) > PROGRESS_THRESHOLD || Date.now() - started > 300) {
      toastShown = true;
      sonner(`Saving ${spec.what}… ${formatBytes(e.bytes)}${e.total ? ` of ${formatBytes(e.total)}` : ''}`, { id: jobId, duration: Infinity, action: { label: 'Cancel', onClick: cancel } });
    }
  });
  try {
    const r = await call<SaveAnswer>('output.save', { ...(await payload(spec, f)), jobId, includeSecrets: !!opts.includeSecrets });
    if (r.cancelled) {
      if (toastShown) useApp.getState().toast('Saving was cancelled: no file was written', 'info');
      return;
    }
    const notes = [r.redacted ? 'secrets masked' : '', r.notice ?? '', spec.production ? 'from the production environment' : ''].filter(Boolean).join(' · ');
    if (r.download) {
      downloadContent(r.download.name, r.download.content, { encoding: 'base64', type: r.download.type });
      useApp.getState().toast(`${cap(spec.what)} downloaded as ${r.download.name}${notes ? ` (${notes})` : ''}`, r.notice ? 'warning' : 'success');
    } else if (r.path) {
      const actions = [
        ...(r.canReveal ? [{ label: 'Show in folder', onClick: () => void call('output.reveal', { jobId: r.jobId }).catch(toastError) }] : []),
        ...(r.canOpen ? [{ label: 'Open', onClick: () => void call('output.reveal', { jobId: r.jobId, open: true }).catch(toastError) }] : []),
      ];
      useApp.getState().toast(`${cap(spec.what)} saved to ${r.path}${notes ? ` (${notes})` : ''}`, r.notice ? 'warning' : 'success', actions.length ? actions : undefined);
    }
  } catch (e) {
    toastError(e);
  } finally {
    off();
    if (toastShown) sonner.dismiss(jobId);
    running.delete(spec.id);
    changed();
  }
}

/** Save with the secrets a redacted export masks, after the person confirmed it. */
export async function saveWithSecrets(spec: OutputSpec, f: OutputFormatSpec): Promise<void> {
  const ok = await confirmAction({
    title: 'Include secrets in the file?',
    message: `The ${spec.what} is saved with the values that are masked by default: Authorization and cookie headers, tokens, API keys and the values of secret variables. Anyone with the file can use them.`,
    confirmLabel: 'Save with secrets',
    danger: true,
  });
  if (ok) await saveOutput(spec, f, { includeSecrets: true });
}

/** Copy a format's text (built and redacted like a save): what the Copy beside the down arrow does. */
export async function copyOutput(spec: OutputSpec, f: OutputFormatSpec): Promise<void> {
  try {
    const info = outputSurface(spec.id);
    let text: string;
    let redacted = false;
    // the person's own data that the window holds is copied as it is; everything else goes through the backend's builders
    if (f.build && info?.redaction !== 'redacted-default') {
      const v = await f.build();
      if (typeof v !== 'string') throw new Error(`${formatLabel(f)} is not text: download it instead`);
      text = v;
    } else {
      const r = await call<{ text: string; redacted: boolean }>('output.copy', await payload(spec, f));
      text = r.text;
      redacted = r.redacted;
    }
    if (text.length > COPY_LIMIT) throw new Error(`Too large to copy (${formatBytes(text.length)}): download it instead`);
    await navigator.clipboard.writeText(text);
    useApp.getState().toast(`Copied the ${spec.what} as ${formatLabel(f)}${redacted ? ' (secrets masked)' : ''}`, 'success');
  } catch (e) {
    toastError(e);
  }
}

/* ------------------------------------------------------------------ Ctrl+Shift+S: the output where you are */

/** Each mounted control, by its button: what Ctrl+Shift+S and the palette run. */
const controls = new Map<HTMLElement, { download(): void; openMenu(): void }>();
let lastTarget: Element | null = null;
let tracking = false;

function track(): void {
  if (tracking) return;
  tracking = true;
  const note = (e: Event) => {
    if (e.target instanceof Element) lastTarget = e.target;
  };
  document.addEventListener('pointerdown', note, true);
  document.addEventListener('focusin', note, true);
}

export function registerControl(button: HTMLElement, c: { download(): void; openMenu(): void }): () => void {
  track();
  controls.set(button, c);
  return () => void controls.delete(button);
}

const visible = (el: HTMLElement) => el.isConnected && !el.closest('[hidden], [aria-hidden=true]') && el.getClientRects().length > 0;

/** The control of the output nearest to where the person last clicked or focused (else the first one on screen). */
function focusedControl(): { download(): void; openMenu(): void } | undefined {
  const shown = [...controls.entries()].filter(([b]) => visible(b));
  if (!shown.length) return undefined;
  for (let el = lastTarget?.isConnected ? lastTarget : null; el; el = el.parentElement) {
    const near = shown.find(([b]) => el!.contains(b));
    if (near) return near[1];
  }
  return shown[0]![1];
}

/** Ctrl+Shift+S (`download-output`): save the focused output in its default format; `menu`: open its format menu. */
export function downloadFocusedOutput(menu = false): void {
  const c = focusedControl();
  if (!c) return useApp.getState().toast('No output here to download: open a response or a result first', 'info');
  if (menu) c.openMenu();
  else c.download();
}
