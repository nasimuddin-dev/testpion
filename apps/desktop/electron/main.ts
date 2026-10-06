import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, safeStorage, screen, shell, nativeTheme } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Backend } from '../backend/backend.js';
import { canInstallInPlace, createUpdater } from './updater.js';
import { installAppMenu, installTextContextMenu } from './app-menu.js';
import { defaultAppDir, normalizeError, runMergeDriver } from '@testpion/core';
import { parseMcpMode, runMcpMode } from './mcp-mode.js';

const isDev = !!process.env.VITE_DEV_SERVER_URL;

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

// pm.visualizer pages run on their own origin (tpviz://<id>/) with their own security policy, so their
// scripts (charts) never share the app's origin, storage or IPC bridge
protocol.registerSchemesAsPrivileged([{ scheme: 'tpviz', privileges: { standard: true, secure: true } }]);
let win: BrowserWindow | null = null;
/** Whether the window asked for an update check this session (see the native fallback prompt). */
let rendererCheckedUpdates = false;
let nativePromptShown = false;
let backend: Backend | null = null;

// `TestPion --mcp-server`: serve a workspace to an AI agent over stdio, with no window (stdout is the protocol)
const mcpMode = parseMcpMode(process.argv);
if (mcpMode) {
  console.log = console.error;
  console.info = console.error;
  app.dock?.hide();
}

// Documentation screenshot mode (scripts/capture.cjs): isolated profile, fixed size, dark theme.
const capture = process.env.TESTPION_CAPTURE_SCRIPT;
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
if (mergeAt < 0 && !capture && !mcpMode && !app.requestSingleInstanceLock()) app.quit();
// The taskbar identity: the installed app uses the installer's (its shortcuts carry it). Runs from source get their own,
// or Windows ties the installed app's taskbar button to electron.exe and shows Electron's icon for it.
const APP_ID = app.isPackaged ? 'dev.nasimuddin.protolens' : 'dev.nasimuddin.protolens.source';
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

function osBackendName(): string {
  if (process.platform === 'win32') return 'Windows DPAPI';
  if (process.platform === 'darwin') return 'macOS Keychain';
  const b = (safeStorage as unknown as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend?.();
  return b ? `Linux ${b}` : 'Linux Secret Service';
}

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
  // fit the screen: a smaller screen (a laptop at 125 %) opens the window maximised instead of past its edges
  const area = screen.getPrimaryDisplay().workAreaSize;
  const small = !capture && (area.width < 1440 || area.height < 900);
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
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  // say which program and icon the taskbar button belongs to (Windows otherwise reuses what it cached for the id)
  if (process.platform === 'win32') {
    const icon = windowIcon() ?? process.execPath;
    win.setAppDetails({ appId: APP_ID, appIconPath: icon, appIconIndex: 0, relaunchCommand: app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${app.getAppPath()}"`, relaunchDisplayName: 'TestPion' });
  }
  win.once('ready-to-show', () => {
    if (capture) return;
    if (small) win?.maximize();
    win?.show();
  });
  installTextContextMenu(win);
  win.webContents.on('did-finish-load', () => console.log('[aps] renderer loaded'));
  win.webContents.on('render-process-gone', (_e, d) => console.error(`[aps] renderer gone: ${d.reason} (exit ${d.exitCode})`));
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
  if (mergeAt >= 0) return;
  if (mcpMode) return void runMcpMode(mcpMode, process.env.TESTPION_HOME || defaultAppDir()).then((code) => app.exit(code));
  try {
    start();
  } catch (e) {
    // never fail silently with no window: show what went wrong
    dialog.showErrorBox('TestPion failed to start', `${(e as Error).message}

Data directory: ${process.env.TESTPION_HOME || defaultAppDir()}`);
    app.quit();
  }
});

function start(): void {
  const t0 = Date.now();
  backend = new Backend({
    appDir: process.env.TESTPION_HOME || defaultAppDir(),
    cipher: {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (s) => safeStorage.encryptString(s),
      decrypt: (b) => safeStorage.decryptString(b),
      backend: osBackendName(),
    },
    emit,
    // bundled with the installer (electron-builder extraResources); the repo's copy when running from source
    examplesDir: app.isPackaged ? join(process.resourcesPath, 'examples', 'public-workspace') : join(__dirname, '..', '..', '..', 'examples', 'public-workspace'),
    openExternal: (url) => shell.openExternal(url),
    openPath: (p) => shell.openPath(p),
    // agents start this app with --mcp-server (from source: electron plus the app folder)
    mcpCommand: app.isPackaged ? { command: process.execPath, args: [] } : { command: process.execPath, args: [app.getAppPath()] },
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

  ipcMain.handle('aps:rpc', async (e, method: string, params: unknown) => {
    // only the app's own page (the window's top frame) may call the backend, never an embedded frame
    if (!win || e.sender !== win.webContents || e.senderFrame !== win.webContents.mainFrame) return { ok: false, error: normalizeError(new Error('Not allowed')) };
    try {
      return { ok: true, data: await backend!.invoke(method, params) };
    } catch (err) {
      // a plain object keeps kind and suggestions (IPC would reduce an Error to its message)
      return { ok: false, error: normalizeError(err) };
    }
  });
  ipcMain.handle('aps:startup', () => ({ backendMs: Date.now() - t0 }));
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
    const page = be.visualizationPage(new URL(req.url).hostname);
    return new Response(page ?? 'This visualization is no longer available. Send the request again.', {
      status: page ? 200 : 404,
      headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': Backend.VIZ_CSP, 'x-content-type-options': 'nosniff' },
    });
  });
  createWindow();
  win?.webContents.on('render-process-gone', () => void nativeUpdatePrompt('the window crashed'));
  win?.webContents.once('did-finish-load', () =>
    setTimeout(() => {
      if (!rendererCheckedUpdates) void nativeUpdatePrompt('the window did not check');
    }, 20_000),
  );
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  void backend?.dispose();
});
