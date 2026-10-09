/**
 * Application updates.
 *
 * - Windows (installed with the NSIS installer) and Linux (AppImage): the update is downloaded from the
 *   GitHub release, its SHA-512 checked against the release's latest*.yml, and installed in place;
 *   the app restarts. Workspaces, settings and secrets are kept.
 * - macOS, the Windows portable build, .deb and .rpm: in-place updates aren't possible (macOS requires a
 *   signed app; packages are owned by the system package manager), so the user is told about the new
 *   version and sent to the download page.
 */
import { app } from 'electron';
import type { AppUpdater, UpdateInfo } from 'electron-updater';
import { compareVersions } from './semver.js';

export { compareVersions };

const REPO = 'nasimuddin-dev/testpion';
const DOWNLOAD_PAGE = 'https://nasimuddin-dev.github.io/testpion/download';

export interface UpdateCheckResult {
  current: string;
  /** Newer version, or null when up to date. */
  version: string | null;
  notes: string;
  /** True when "Update Now" can download and install in place. */
  installable: boolean;
  /** Page to open when the update can't be installed in place. */
  url: string;
}

/** Whether this installation can replace itself. */
export function canInstallInPlace(): boolean {
  if (!app.isPackaged) return false;
  if (process.platform === 'win32') return !process.env.PORTABLE_EXECUTABLE_DIR; // set by the portable launcher
  if (process.platform === 'linux') return !!process.env.APPIMAGE;
  return false;
}

function notesText(notes: UpdateInfo['releaseNotes'] | string | null | undefined): string {
  if (!notes) return '';
  if (typeof notes === 'string') return notes;
  return notes.map((n) => n.note ?? '').join('\n\n');
}

export type UpdateLog = (level: 'info' | 'warn' | 'error', message: string) => void;

let configured: Promise<AppUpdater> | undefined;
/** electron-updater, loaded with the first check (not at startup) and configured once. */
function configure(onProgress: (downloaded: number, total: number | null) => void, log: UpdateLog): Promise<AppUpdater> {
  return (configured ??= import('electron-updater').then((m) => {
    const autoUpdater = (m.autoUpdater ?? (m as unknown as { default: { autoUpdater: AppUpdater } }).default.autoUpdater) as AppUpdater;
    setUp(autoUpdater, onProgress, log);
    return autoUpdater;
  }));
}

function setUp(autoUpdater: AppUpdater, onProgress: (downloaded: number, total: number | null) => void, log: UpdateLog): void {
  // electron-updater's own messages (feed URL, download, signature checks) go to the app log
  autoUpdater.logger = {
    info: (m?: unknown) => log('info', `updater: ${String(m)}`),
    warn: (m?: unknown) => log('warn', `updater: ${String(m)}`),
    error: (m?: unknown) => log('error', `updater: ${String(m)}`),
    debug: () => undefined,
  };
  autoUpdater.autoDownload = false;
  // Differential downloads send multi-range requests, which GitHub's release download servers reject
  // (HTTP 501); some networks reset the connection instead. Always download the whole (verified) file.
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.on('download-progress', (p) => onProgress(p.transferred, p.total || null));
}

/** Ask GitHub for the latest release (used where electron-updater can't install in place). */
async function latestRelease(): Promise<{ version: string; notes: string; url: string }> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': `TestPion/${app.getVersion()}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}`);
  const j = (await res.json()) as { tag_name: string; body?: string; html_url: string };
  return { version: j.tag_name.replace(/^v/, ''), notes: j.body ?? '', url: DOWNLOAD_PAGE };
}

export function createUpdater(emit: (channel: string, payload: unknown) => void, log: UpdateLog = () => undefined) {
  const progress = (downloaded: number, total: number | null) => emit('update.progress', { downloaded, total });
  return {
    async check(): Promise<UpdateCheckResult> {
      const current = app.getVersion();
      if (canInstallInPlace()) {
        const autoUpdater = await configure(progress, log);
        const r = await autoUpdater.checkForUpdates();
        const info = r?.updateInfo;
        const newer = info && compareVersions(info.version, current) > 0;
        return { current, version: newer ? info.version : null, notes: newer ? notesText(info.releaseNotes) : '', installable: true, url: DOWNLOAD_PAGE };
      }
      const latest = await latestRelease();
      const newer = compareVersions(latest.version, current) > 0;
      return { current, version: newer ? latest.version : null, notes: newer ? latest.notes : '', installable: false, url: latest.url };
    },

    /** Download (with progress events), verify and install; the app quits and restarts into the new version. */
    async install(): Promise<void> {
      if (!canInstallInPlace()) throw new Error('This installation can’t be updated in place; download the new version instead.');
      const autoUpdater = await configure(progress, log);
      // a dropped connection is retried twice before giving up
      for (let attempt = 0; ; attempt++) {
        try {
          await autoUpdater.downloadUpdate();
          break;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const transient = /net::ERR_|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|timed? ?out/i.test(msg);
          if (!transient || attempt >= 2) throw e;
          log('warn', `Update download failed (${msg}); retrying (attempt ${attempt + 2} of 3)`);
          emit('update.progress', { downloaded: 0, total: null, retry: attempt + 1 });
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        }
      }
      emit('update.progress', { downloaded: 1, total: 1, installing: true });
      // isSilent=false shows the installer's progress on Windows; forceRunAfter restarts the app afterwards
      setImmediate(() => autoUpdater.quitAndInstall(false, true));
    },
  };
}
