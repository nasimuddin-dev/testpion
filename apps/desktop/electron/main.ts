import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, safeStorage, screen, session, shell, nativeTheme } from 'electron';
import { existsSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import * as nodeModule from 'node:module';
import { createRequire } from 'node:module';
import { Backend } from '../backend/backend.js';
import { LOCAL_USER } from '../backend/request-context.js';
import { openLinksIn, queueOpenLink } from '../backend/open-links.js';
import { canInstallInPlace, createUpdater } from './updater.js';
import { installAppMenu, installTextContextMenu } from './app-menu.js';
import { defaultAppDir, normalizeError, runMergeDriver, safeStorageCipher, textconvFile, type SafeStorageLike } from '@testpion/core';
import { parseMcpMode, runMcpMode } from './mcp-mode.js';
import { ptyHost } from './pty-host.js';
import { crashMessage, onRendererCrash, type CrashRecord } from './crash-recovery.js';
import { CAPTURE_SWITCH, captureScript } from './capture.js';
import { permissionAllowed } from './permissions.js';

const isDev = !!process.env.VITE_DEV_SERVER_URL;

/**
 * When each step of the start happened, in ms since the process started (the window reads them with aps:startup;
 * e2e/plans/_startup.cjs prints them): the bundle loaded, Electron ready, the window created, the backend ready, the
 * page loaded, the first paint ready to show.
 */
const startupMarks: Record<string, number> = {};
const mark = (name: string) => void (startupMarks[name] ??= Math.round(process.uptime() * 1000));
mark('mainLoaded');

// `TestPion --merge-driver %O %A %B %P`: git merges a collection file request by request (GIT-301); no window
const mergeAt = process.argv.indexOf('--merge-driver');
if (mergeAt >= 0) {
  const [base, ours, theirs] = process.argv.slice(mergeAt + 1);
  let code = 2;
  try {
    code = runMergeDriver(base!, ours!, theirs!, (l) => process.stderr.write(`${l}\n`));
  } catch (e) {
    process.stderr.write(`TestPion merge driver: ${String(e)}\n`);
  }
  app.exit(code);
}

// `TestPion --textconv <file>`: git's readable-diff driver (diff.testpion.textconv, set up by Fix git setup) prints a collection,
// environment, library, MCP servers or providers file item by item; no window
const textconvAt = process.argv.indexOf('--textconv');
if (textconvAt >= 0) {
  let code = 2;
  try {
    // written synchronously: the process ends right below, and git reads until then
    const bytes = Buffer.from(textconvFile(process.argv[textconvAt + 1]!), 'utf8');
    for (let at = 0; at < bytes.length; ) {
      try {
        at += writeSync(1, bytes, at);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EAGAIN') throw e; // a full pipe: git has not read yet
      }
    }
    code = 0;
  } catch (e) {
    process.stderr.write(`TestPion diff driver: ${String(e)}
`);
  }
  app.exit(code);
}

// `TestPion --cli …`: the testpion command line, no window (the Terminal panel's `testpion` command runs this; see
// backend/terminal.ts). The CLI is a bundle of its own (dist-electron/cli.cjs), loaded only in this mode.
const cliAt = mergeAt < 0 && textconvAt < 0 ? process.argv.indexOf('--cli') : -1;
if (cliAt >= 0) {
  app.dock?.hide();
  // exit once what was written reached the terminal
  const done = (code: number) => {
    let left = 2;
    const one = () => void (--left === 0 && app.exit(code));
    process.stdout.write('', one);
    process.stderr.write('', one);
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cli = require(join(__dirname, 'cli.cjs')) as { main(argv: string[]): Promise<number> };
    cli.main(['testpion', 'testpion', ...process.argv.slice(cliAt + 1)]).then(done, (e: unknown) => (console.error(e), done(3)));
  } catch (e) {
    console.error(`TestPion command line: ${e instanceof Error ? e.message : String(e)}`);
    done(3);
  }
}

// tp.visualizer pages run on their own origin (tpviz://<id>/) with their own security policy, so their
// scripts (charts) never share the app's origin, storage or IPC bridge
protocol.registerSchemesAsPrivileged([{ scheme: 'tpviz', privileges: { standard: true, secure: true } }]);
let win: BrowserWindow | null = null;
/** Whether the window asked for an update check this session (see the native fallback prompt). */
let rendererCheckedUpdates = false;
let nativePromptShown = false;
let backend: Backend | null = null;
/** How long the backend took to construct. */
let backendMs: number | undefined;
// The window is created before the backend (the window's start overlaps with the backend's): its calls wait for this.
let backendStarted!: (b: Backend) => void;
let backendFailed!: (e: unknown) => void;
const backendReady = new Promise<Backend>((resolve, reject) => {
  backendStarted = resolve;
  backendFailed = reject;
});
backendReady.catch(() => undefined);

// An exception nobody catches in the main process (a socket callback in the proxy, a timer) is logged and the app goes
// on. Electron's default is a native error box, and its modal loop stops the backend (every request, the proxy, the
// window's calls) until someone closes it: the HTTP Debugger's self-test froze the app that way.
// the window hears of it at most once a minute (one toast), the log has every one
let internalErrorSaid = 0;
function tellWindow(message: string): void {
  if (Date.now() - internalErrorSaid < 60_000) return;
  internalErrorSaid = Date.now();
  try {
    if (win && !win.isDestroyed() && backend) emit('app.internalError', { message: message.split('\n')[0]!.slice(0, 200) });
  } catch {
    /* the window is gone */
  }
}
process.on('uncaughtException', (e) => {
  try {
    backend?.appLog('error', `Uncaught in the main process: ${e?.stack ?? String(e)}`);
  } catch {
    /* the log itself failed */
  }
  console.error('[aps] uncaught exception', e);
  tellWindow(String(e?.message ?? e));
});
process.on('unhandledRejection', (e) => {
  try {
    backend?.appLog('error', `Unhandled rejection in the main process: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  } catch {
    /* the log itself failed */
  }
  tellWindow(e instanceof Error ? e.message : String(e));
});

// A dead page is a white window the user cannot use: log it (stderr is nowhere in the packaged app), reload it once; a second crash
// within a minute asks (Reload / Quit) instead of looping. The backend keeps running; the reloaded page reattaches its terminals.
const crashes: CrashRecord = { times: [] };
async function recoverRenderer(d: { reason: string; exitCode: number }): Promise<void> {
  console.error(`[aps] renderer gone: ${d.reason} (exit ${d.exitCode})`);
  try {
    backend?.appLog('error', crashMessage('renderer', d, process.memoryUsage() as unknown as Record<string, number>));
  } catch {
    /* the log itself failed */
  }
  if (d.reason === 'clean-exit' || quitting) return;
  const w = win;
  if (!w || w.isDestroyed()) return;
  if (onRendererCrash(crashes, Date.now(), d.reason) === 'reload') {
    w.webContents.reload();
    return;
  }
  const r = await dialog.showMessageBox(w, { type: 'error', message: "TestPion's window crashed twice", detail: `The page stopped (${d.reason}) twice within a minute. Your work on disk is safe. Reload tries again; Quit closes TestPion (the reason is in Help > Open log folder, app.log).`, buttons: ['Reload', 'Quit'], defaultId: 0, cancelId: 1, noLink: true });
  if (r.response === 0 && !w.isDestroyed()) w.webContents.reload();
  else app.quit();
}
app.on('child-process-gone', (_e, d) => {
  try {
    backend?.appLog('error', crashMessage('child', d));
  } catch {
    /* the log itself failed */
  }
});

// `TestPion --mcp-server`: serve a workspace to an AI agent over stdio, with no window (stdout is the protocol)
const mcpMode = cliAt < 0 ? parseMcpMode(process.argv) : null;
if (mcpMode) {
  console.log = console.error;
  console.info = console.error;
  app.dock?.hide();
}

// Documentation screenshot mode (scripts/capture.cjs): isolated profile, fixed size, dark theme.
const { script: capture, ignored: ignoredCapture } = captureScript(process.env, process.argv, app.isPackaged);
if (ignoredCapture) console.error(`TESTPION_CAPTURE_SCRIPT is ignored by an installed build unless the program is started with ${CAPTURE_SWITCH}`);
if (capture) {
  app.setPath('userData', join(process.env.TESTPION_HOME!, 'electron-profile'));
  nativeTheme.themeSource = 'dark';
}

// Keep using the Electron profile of installs from before the TestPion name ("FluxPion" 0.5, "ProtoPion" 0.4, "Protolens" 0.2–0.3):
// it holds the safeStorage key that decrypts saved secrets, plus UI state such as open tabs.
if (!capture && !existsSync(join(app.getPath('appData'), 'TestPion'))) {
  const legacy = ['FluxPion', 'ProtoPion', 'Protolens'].map((n) => join(app.getPath('appData'), n)).find((d) => existsSync(d));
  if (legacy) app.setPath('userData', legacy);
}

// Single instance — a second launch focuses the existing window.
if (mergeAt < 0 && cliAt < 0 && !capture && !mcpMode && !app.requestSingleInstanceLock()) app.quit();
// testpion://open?kind=…&… links (testpion open <ref>, an agent, a link in a report) open the item in this app: the
// installer registers the scheme; a run from source registers itself for this user. A link that started the app waits
// for the window (open-links.ts); later ones come through second-instance (Windows, Linux) or open-url (macOS).
if (mergeAt < 0 && cliAt < 0 && !capture && !mcpMode) {
  if (app.isPackaged) app.setAsDefaultProtocolClient('testpion');
  else if (process.env.TESTPION_REGISTER_LINKS) app.setAsDefaultProtocolClient('testpion', process.execPath, [app.getAppPath()]);
  for (const link of openLinksIn(process.argv)) queueOpenLink(link);
  app.on('open-url', (e, url) => {
    e.preventDefault();
    openLink(url);
  });
}
// The taskbar identity: the installed app uses the installer's (its shortcuts carry it). Runs from source get their own,
// or Windows ties the installed app's taskbar button to electron.exe and shows Electron's icon for it.
const APP_ID = app.isPackaged ? 'dev.nasimuddin.protolens' : 'dev.nasimuddin.protolens.source';
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

/** The window and taskbar icon: the .ico on Windows (every size), the PNG elsewhere. The packaged Windows app takes it from its .exe. */
function windowIcon(): string | undefined {
  const win32 = process.platform === 'win32';
  if (app.isPackaged) return win32 ? undefined : join(process.resourcesPath, 'icon.png');
  return join(__dirname, '..', 'build', win32 ? 'icon.ico' : join('icons', '256x256.png'));
}

/**
 * Windows and Linux: no system title bar. The app's own top bar (logo, wordmark, workspace, search) is the title bar,
 * with the window buttons drawn over its right end in the theme's colours, and the application menu behind its ☰ button.
 * macOS keeps its native title bar and menu.
 */
const overlayTitleBar = process.platform !== 'darwin';
const TITLE_BAR_HEIGHT = 48;

function createWindow(): void {
  // the window opens maximised; this size (fitted to the screen) is what it restores down to
  const area = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: capture ? 1440 : Math.min(1440, area.width),
    // capture mode renders at an exact size even on small screens
    enableLargerThanScreen: !!capture,
    useContentSize: !!capture,
    height: capture ? 900 : Math.min(900, area.height),
    minWidth: 960,
    minHeight: 600,
    title: 'TestPion',
    // the window and taskbar icon (the packaged Windows app also has it in its .exe)
    icon: windowIcon(),
    ...(overlayTitleBar ? { titleBarStyle: 'hidden' as const, titleBarOverlay: { color: nativeTheme.shouldUseDarkColors ? '#0b0f24' : '#f1f2f8', symbolColor: nativeTheme.shouldUseDarkColors ? '#c9cfe8' : '#3b4160', height: TITLE_BAR_HEIGHT } } : {}),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d1117' : '#ffffff',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      // the preload reads whether the app draws the title bar from here (no synchronous call to a busy main process)
      additionalArguments: [`--tp-titlebar=${overlayTitleBar ? 1 : 0}`, ...(capture ? ['--tp-capture=1'] : [])],
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  // the window's shells end with it (macOS keeps the app running without a window); a reload keeps them (the page reattaches)
  win.on('closed', () => backend?.terminals.dispose('window'));
  // say which program and icon the taskbar button belongs to (Windows otherwise reuses what it cached for the id)
  if (process.platform === 'win32') {
    const icon = windowIcon() ?? process.execPath;
    win.setAppDetails({ appId: APP_ID, appIconPath: icon, appIconIndex: 0, relaunchCommand: app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${app.getAppPath()}"`, relaunchDisplayName: 'TestPion' });
  }
  win.once('ready-to-show', () => {
    mark('readyToShow');
    // V8's compile cache (boot.cjs): written now, with the code compiled for the start, not only at exit
    setTimeout(() => (nodeModule as { flushCompileCache?: () => void }).flushCompileCache?.(), 3000).unref();
    if (capture) return;
    win?.maximize();
    win?.show();
    mark('shown');
  });
  installTextContextMenu(win);
  win.webContents.once('dom-ready', () => mark('domReady'));
  win.webContents.on('did-finish-load', () => (mark('didFinishLoad'), console.log('[aps] renderer loaded')));
  win.webContents.on('render-process-gone', (_e, d) => void recoverRenderer(d));
  win.on('unresponsive', () => backend?.appLog('warn', 'The window stopped responding'));
  win.on('responsive', () => backend?.appLog('info', 'The window responds again'));
  win.webContents.on('console-message', (e) => {
    const level = (e as unknown as { level?: string }).level;
    if (level === 'error' || level === 'warning') console.error(`[renderer ${level}] ${(e as unknown as { message: string }).message}`);
  });
  // never let the renderer navigate away or open windows; external links go to the OS browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    // a reload of the app's own page (location.reload(): the crash screen's Reload) also comes here: let it through
    const own = win?.webContents.getURL().split('#')[0];
    if (own && url.split('#')[0] === own) return;
    if (!isDev || !url.startsWith(process.env.VITE_DEV_SERVER_URL!)) e.preventDefault();
  });
  if (isDev) void win.loadURL(process.env.VITE_DEV_SERVER_URL!);
  else void win.loadFile(join(__dirname, '../dist/index.html'));
  if (capture) {
    const w = win;
    w.webContents.once('did-finish-load', () => {
      // runtime require of the capture steps (not bundled); only used when building docs screenshots
      let run: (win: BrowserWindow) => Promise<void>;
      try {
        run = createRequire(__filename)(capture) as (win: BrowserWindow) => Promise<void>;
      } catch (e) {
        // a capture script that doesn't load must end the run, not leave the app open
        console.error('[capture] could not load the script:', e);
        return app.exit(1);
      }
      run(w).then(
        () => app.quit(),
        (e: Error) => {
          console.error('[capture] failed:', e);
          app.exit(1);
        },
      );
    });
  }
}

function emit(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send('aps:event', channel, payload);
}

/** A command of the application menu, run by the renderer (menu-commands.ts). */
const menu = (command: string) => emit('menu.command', { command });

app.whenReady().then(() => {
  mark('electronReady');
  if (mergeAt >= 0 || cliAt >= 0) return;
  if (mcpMode) return void runMcpMode(mcpMode, process.env.TESTPION_HOME || defaultAppDir()).then((code) => app.exit(code));
  try {
    start();
  } catch (e) {
    failedToStart(e);
  }
});

/** Never fail silently with no window: show what went wrong. */
function failedToStart(e: unknown): void {
  dialog.showErrorBox('TestPion failed to start', `${(e as Error)?.message ?? String(e)}

Data directory: ${process.env.TESTPION_HOME || defaultAppDir()}`);
  app.quit();
}

/**
 * The window first, then the backend: Electron's main thread is also the browser's UI thread, so the backend is
 * constructed once the window's page is on its way, and the page's first calls wait for it (backendReady).
 */
function start(): void {
  // deny every web permission the app does not use (camera, microphone, location …), whatever page asks (electron/permissions.ts)
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => callback(permissionAllowed(permission, details.requestingUrl, process.env.VITE_DEV_SERVER_URL)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => permissionAllowed(permission, origin, process.env.VITE_DEV_SERVER_URL));
  ipcMain.handle('aps:rpc', async (e, method: string, params: unknown, meta?: { requestId?: unknown }) => {
    // only the app's own page (the window's top frame) may call the backend, never an embedded frame
    if (!win || e.sender !== win.webContents || e.senderFrame !== win.webContents.mainFrame) return { ok: false, error: normalizeError(new Error('Not allowed')) };
    try {
      const be = await backendReady;
      return { ok: true, data: await be.invoke(method, params, { requestId: typeof meta?.requestId === 'string' ? meta.requestId : undefined, user: LOCAL_USER }) };
    } catch (err) {
      // a plain object keeps kind and suggestions (IPC would reduce an Error to its message)
      return { ok: false, error: normalizeError(err) };
    }
  });
  ipcMain.handle('aps:startup', () => ({ backendMs, marks: { ...startupMarks } }));
  // the drawn title bar: whether there is one, its colours (the page follows the app's theme), and the ☰ menu
  ipcMain.on('aps:titlebar', (e) => (e.returnValue = overlayTitleBar));
  ipcMain.on('aps:titlebar-colors', (e, c: { color: string; symbolColor: string; height?: number }) => {
    if (!overlayTitleBar || !win || e.sender !== win.webContents) return;
    try {
      // the top bar's height in CSS pixels, times the page zoom (the UI scale setting), is its height on screen
      const height = c.height ? Math.round(c.height * win.webContents.getZoomFactor()) : TITLE_BAR_HEIGHT;
      win.setTitleBarOverlay({ color: c.color, symbolColor: c.symbolColor, height });
    } catch {
      /* not a colour Electron understands */
    }
  });
  ipcMain.on('aps:app-menu', (e, p: { x: number; y: number }) => {
    if (!win || e.sender !== win.webContents) return;
    Menu.getApplicationMenu()?.popup({ window: win, x: Math.round(p.x), y: Math.round(p.y) });
  });

  installAppMenu({
    menu,
    tabs: (command) => emit('tabs.command', { command }),
    checkForUpdates: () => emit('update.checkManual', {}),
    openExternal: (url) => void shell.openExternal(url),
  });
  protocol.handle('tpviz', (req) => {
    const page = backend?.visualizationPage(new URL(req.url).hostname);
    return new Response(page ?? 'This visualization is no longer available. Send the request again.', {
      status: page ? 200 : 404,
      headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': Backend.VIZ_CSP, 'x-content-type-options': 'nosniff' },
    });
  });
  createWindow();
  mark('windowCreated');
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  // The backend is constructed once the window has painted its first frame (ready-to-show): loading and painting the
  // page need this thread, and the page's first calls wait for the backend anyway. A page that fails to load, or takes
  // long, doesn't hold it up.
  let started = false;
  const begin = () => {
    if (started) return;
    started = true;
    clearTimeout(fallback);
    try {
      startBackend();
    } catch (e) {
      backendFailed(e);
      failedToStart(e);
    }
  };
  const fallback = setTimeout(begin, 1500);
  win?.once('ready-to-show', () => setImmediate(begin));
  win?.webContents.once('did-fail-load', begin);
  if (!win) begin();
}

function startBackend(): void {
  const t0 = Date.now();
  backend = new Backend({
    appDir: process.env.TESTPION_HOME || defaultAppDir(),
    // on Linux without a keyring Electron's "encrypted" store has a public key: refused unless the person opts in (storage/secrets.ts)
    cipher: safeStorageCipher(safeStorage as unknown as SafeStorageLike),
    emit,
    // bundled with the installer (electron-builder extraResources); the repo's copy when running from source
    examplesDir: app.isPackaged ? join(process.resourcesPath, 'examples', 'public-workspace') : join(__dirname, '..', '..', '..', 'examples', 'public-workspace'),
    openExternal: (url) => shell.openExternal(url),
    openPath: (p) => shell.openPath(p),
    showItemInFolder: (p) => shell.showItemInFolder(p),
    // agents start this app with --mcp-server (from source: electron plus the app folder)
    mcpCommand: app.isPackaged ? { command: process.execPath, args: [] } : { command: process.execPath, args: [app.getAppPath()] },
    // the Terminal panel's shells (node-pty loads at the first terminal)
    terminal: ptyHost,
    saveDialog: async (opts) => (win ? (await dialog.showSaveDialog(win, opts)).filePath || undefined : undefined),
    openDialog: async (opts) => {
      if (!win) return undefined;
      const r = await dialog.showOpenDialog(win, { properties: [opts.directory ? 'openDirectory' : 'openFile'], filters: opts.filters });
      return r.canceled ? undefined : r.filePaths[0];
    },
  });

  // updates live in the Electron process (not the shared backend, which also serves the browser bridge)
  const be = backend;
  const updater = createUpdater(emit, (level, message) => be.appLog(level, message));
  const baseInfo = backend.handlers['app.info']!;
  backend.handlers['app.info'] = async (p) => ({ ...((await baseInfo(p)) as object), appVersion: app.getVersion(), packaged: app.isPackaged, canUpdateInPlace: canInstallInPlace() });
  // every check and failure is logged, so "updates don't work" can be diagnosed from the Logs panel
  backend.handlers['update.check'] = async () => {
    rendererCheckedUpdates = true;
    try {
      const r = await updater.check();
      be.appLog('info', `Update check: running ${r.current}, ${r.version ? `${r.version} available` : 'up to date'}${r.installable ? '' : ' (this installation is updated by downloading the new version)'}`);
      return r;
    } catch (e) {
      be.appLog('error', `Update check failed: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
  };
  backend.handlers['update.install'] = async () => {
    try {
      return await updater.install();
    } catch (e) {
      be.appLog('error', `Update install failed: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
  };

  // Safety net: the update prompt normally comes from the window (5 s after start). If the window can't
  // show it (it failed to render, or its renderer crashed), ask here with a native dialog instead, so a
  // broken version can always be replaced by a fixed one.
  const nativeUpdatePrompt = async (reason: string) => {
    if (nativePromptShown || !app.isPackaged || capture || be.settings.checkForUpdates === false) return;
    nativePromptShown = true;
    try {
      const r = await updater.check();
      be.appLog('info', `Update check (${reason}): running ${r.current}, ${r.version ? `${r.version} available` : 'up to date'}`);
      if (!r.version) return;
      const icon = windowIcon();
      const choice = await dialog.showMessageBox(win!, {
        type: 'info',
        title: 'TestPion',
        ...(icon ? { icon } : {}),
        message: `TestPion ${r.version} is available`,
        detail: `You have ${r.current}. ${r.installable ? 'Update now downloads it and restarts TestPion.' : 'Update now opens the download page.'}${r.notes ? `\n\n${r.notes.slice(0, 600)}` : ''}`,
        buttons: ['Update now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (choice.response !== 0) return;
      if (r.installable) await updater.install();
      else await shell.openExternal(r.url);
    } catch (e) {
      be.appLog('error', `Update check (${reason}) failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // the window's crash, or a window that never asked about updates, gets the native prompt (see above)
  win?.webContents.on('render-process-gone', () => void nativeUpdatePrompt('the window crashed'));
  const unchecked = () =>
    setTimeout(() => {
      if (!rendererCheckedUpdates) void nativeUpdatePrompt('the window did not check');
    }, 20_000);
  if (win && !win.webContents.isLoading()) unchecked();
  else win?.webContents.once('did-finish-load', unchecked);
  backendMs = Date.now() - t0;
  mark('backendReady');
  backendStarted(be);
}

/** Open a testpion:// link in the window (queued while the window or the backend is not there yet). */
function openLink(url: string): void {
  if (win && !win.isDestroyed() && backend) emit('app.openLink', { url });
  else queueOpenLink(url);
}

app.on('second-instance', (_e, argv) => {
  for (const link of openLinksIn(argv)) openLink(link);
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Quit waits (at most a few seconds) for the backend to save what is pending: cookies, a Debugger session, the history store, the
// sessions to close. Without the wait the process ended before the first await of dispose().
let quitting = false;
let disposed = false;
app.on('before-quit', (e) => {
  quitting = true;
  if (disposed || !backend) return;
  e.preventDefault();
  disposed = true;
  const done = () => app.quit();
  const timer = setTimeout(done, 4000);
  void backend.dispose().then(
    () => (clearTimeout(timer), done()),
    () => (clearTimeout(timer), done()),
  );
});
