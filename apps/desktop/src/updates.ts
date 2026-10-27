import { asError, bridge, call, on } from './api';
import { ask, useApp, toastError } from './store';
import { summariseNotes } from './lib/release-notes';

const SKIP_KEY = 'aps.update.skip';
const MB = 1024 * 1024;
/** How often a running app looks for a new release (many people keep it open for days). */
const RECHECK_MS = 6 * 60 * 60 * 1000;
/** Versions already offered in this session: background re-checks don't ask again after "Later". */
const offered = new Set<string>();

interface UpdateCheckResult {
  current: string;
  version: string | null;
  notes: string;
  installable: boolean;
  url: string;
}

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* the check simply runs again next time */
  }
}

/**
 * Downloads, verifies and installs the update; the app restarts into the new version. When the
 * download fails (network reset, proxy …) the user can try again or get the installer from the website.
 */
async function install(version: string, downloadUrl: string): Promise<void> {
  const { set } = useApp.getState();
  set({ progress: { title: `Updating to ${version}`, message: 'Downloading the update…', fraction: null } });
  const off = on<{ downloaded: number; total: number | null; installing?: boolean; retry?: number }>('update.progress', (p) => {
    const message = p.installing
      ? 'Verifying and installing… TestPion will restart.'
      : p.retry
        ? `The connection dropped; trying again (attempt ${p.retry + 1})…`
        : `Downloading the update… ${(p.downloaded / MB).toFixed(1)}${p.total ? ` of ${(p.total / MB).toFixed(1)}` : ''} MB`;
    useApp.getState().set({ progress: { title: `Updating to ${version}`, message, fraction: p.total && !p.installing ? p.downloaded / p.total : null } });
  });
  try {
    await call('update.install');
    // the app quits while the installer runs; if it doesn't, keep the dialog up briefly
  } catch (e) {
    set({ progress: null });
    const choice = await ask({
      title: "The update couldn't be downloaded",
      tone: 'warning',
      message: `TestPion ${version} wasn't installed; your current version is unchanged.`,
      detail: `${asError(e).message}\n\nThis is usually a brief network problem. Try again, or download the installer from the website and run it: your workspaces, settings and secrets are kept either way. Details are in Logs.`,
      buttons: [
        { id: 'close', label: 'Close' },
        { id: 'web', label: 'Download from the website' },
        { id: 'retry', label: 'Try again', variant: 'primary' },
      ],
      cancelId: 'close',
    });
    if (choice === 'retry') return install(version, downloadUrl);
    if (choice === 'web') await call('app.openExternal', { url: downloadUrl }).catch(() => undefined);
  } finally {
    setTimeout(off, 60_000);
  }
}

/**
 * Checks GitHub for a newer release and asks the user what to do.
 * `manual` reports "up to date" and errors, and ignores a previously skipped version.
 */
export async function checkForUpdates({ manual }: { manual: boolean }): Promise<'available' | 'current' | 'error' | 'unsupported'> {
  const { toast } = useApp.getState();
  if (bridge.kind !== 'electron') {
    if (manual) toast('Updates are only available in the desktop app.');
    return 'unsupported';
  }
  let found: UpdateCheckResult;
  try {
    found = await call<UpdateCheckResult>('update.check');
  } catch (e) {
    // the reason (and electron-updater's own log) is also in the Logs panel
    if (manual) toast(`Couldn't check for updates: ${asError(e).message}. Check your internet connection and try again; details are in Logs.`, 'error');
    return 'error';
  }
  if (!found.version) {
    if (manual) toast(`You're up to date. TestPion ${found.current} is the latest version.`, 'success');
    return 'current';
  }
  if (!manual && (load(SKIP_KEY) === found.version || offered.has(found.version))) return 'available';
  offered.add(found.version);

  const notes = summariseNotes(found.notes);
  const choice = await ask({
    title: 'Update available',
    tone: 'info',
    message: `TestPion ${found.version} is available. You have ${found.current}.`,
    detail:
      (notes ? `What's new:\n${notes}\n\n` : '') +
      (found.installable
        ? 'Update now to download and install it. The download is verified, then it replaces your current version; your workspaces, settings and secrets are kept, and the app restarts.'
        : 'Download the new version and install it over this one; your workspaces, settings and secrets are kept.'),
    buttons: [
      { id: 'skip', label: 'Skip this version' },
      { id: 'later', label: 'Later' },
      { id: 'install', label: found.installable ? 'Update Now' : 'Download', variant: 'primary' },
    ],
    cancelId: 'later',
  });
  if (choice === 'skip') store(SKIP_KEY, found.version);
  if (choice === 'install') {
    if (found.installable) await install(found.version, found.url);
    else await call('app.openExternal', { url: found.url }).catch((e: Error) => toastError(e, "Couldn't open the download page"));
  }
  return 'available';
}

/** Checks when the desktop app starts (after startup settles) and every few hours while it runs, when enabled in Settings. */
export function scheduleUpdateCheck(): void {
  if (bridge.kind !== 'electron') return;
  const s = useApp.getState();
  if (s.settings?.checkForUpdates === false || !s.info?.packaged) return;
  setTimeout(() => void checkForUpdates({ manual: false }), 5000);
  setInterval(() => {
    if (useApp.getState().settings?.checkForUpdates !== false) void checkForUpdates({ manual: false });
  }, RECHECK_MS);
}
