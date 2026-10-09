import { Menu, nativeImage, nativeTheme, type BrowserWindow, type MenuItemConstructorOptions, type NativeImage } from 'electron';
import { MENU_ICONS } from './menu-icons.generated.js';

/**
 * The application menu (File, Edit, View, Window, Help), with an icon on every item in the app's icon
 * style (lucide, see scripts/make-menu-icons.cjs). On macOS the icons are template images, which the
 * system tints; on Windows and Linux the ink follows the light or dark theme, and the menu is rebuilt
 * when the theme changes.
 */
export interface AppMenuActions {
  /** A command run by the renderer (menu-commands.ts). */
  menu(command: string): void;
  /** Request tab commands (the REST view). */
  tabs(command: 'new' | 'close' | 'closeOthers' | 'closeAll'): void;
  checkForUpdates(): void;
  openExternal(url: string): void;
}

const mac = process.platform === 'darwin';
const cache = new Map<string, NativeImage>();

function icon(name: keyof typeof MENU_ICONS): NativeImage | undefined {
  const set = MENU_ICONS[name];
  if (!set) return undefined;
  const ink = mac || !nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  const key = `${name}:${ink}`;
  let img = cache.get(key);
  if (!img) {
    img = nativeImage.createFromDataURL(set[ink][0]);
    img.addRepresentation({ scaleFactor: 2, dataURL: set[ink][1] });
    if (mac) img.setTemplateImage(true);
    cache.set(key, img);
  }
  return img;
}

function build(a: AppMenuActions): Menu {
  const item = (o: MenuItemConstructorOptions & { i?: keyof typeof MENU_ICONS }): MenuItemConstructorOptions => {
    const { i, ...rest } = o;
    return i ? { ...rest, icon: icon(i) } : rest;
  };
  const sep: MenuItemConstructorOptions = { type: 'separator' };
  const DOCS = 'https://nasimuddin-dev.github.io/testpion/';
  return Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        item({ label: 'New Request Tab', i: 'newTab', accelerator: 'CmdOrCtrl+T', click: () => a.tabs('new') }),
        item({
          label: 'New',
          i: 'new',
          submenu: [
            item({ label: 'HTTP Request', i: 'http', click: () => a.menu('new-http') }),
            item({ label: 'GraphQL Query', i: 'graphql', click: () => a.menu('new-graphql') }),
            item({ label: 'gRPC Request', i: 'grpc', click: () => a.menu('new-grpc') }),
            item({ label: 'WebSocket / Socket.IO Connection', i: 'websocket', click: () => a.menu('new-websocket') }),
            item({ label: 'MCP Server…', i: 'mcp', click: () => a.menu('new-mcp-server') }),
            sep,
            item({ label: 'Collection…', i: 'collection', click: () => a.menu('new-collection') }),
            item({ label: 'Environment…', i: 'environment', click: () => a.menu('new-environment') }),
            item({ label: 'Monitor…', i: 'monitor', click: () => a.menu('new-monitor') }),
            item({ label: 'Workspace…', i: 'workspace', click: () => a.menu('new-workspace') }),
          ],
        }),
        item({ label: 'Open Workspace Folder…', i: 'openFolder', click: () => a.menu('open-workspace') }),
        sep,
        item({ label: 'Import…', i: 'import', accelerator: 'CmdOrCtrl+O', click: () => a.menu('import') }),
        item({
          label: 'Export',
          i: 'export',
          submenu: [
            item({ label: 'Collection (Postman v2.1)…', i: 'exportCollection', click: () => a.menu('export-collection') }),
            item({ label: 'Current Environment…', i: 'environment', click: () => a.menu('export-environment') }),
            item({ label: 'Workspace…', i: 'workspace', click: () => a.menu('export-workspace') }),
          ],
        }),
        sep,
        item({ label: 'Save', i: 'save', accelerator: 'CmdOrCtrl+S', click: () => a.menu('save') }),
        sep,
        item({ label: 'Close Tab', i: 'closeTab', accelerator: 'CmdOrCtrl+W', click: () => a.tabs('close') }),
        item({ label: 'Close Other Tabs', i: 'closeOthers', click: () => a.tabs('closeOthers') }),
        item({ label: 'Close All Tabs', i: 'closeAll', accelerator: 'CmdOrCtrl+Shift+W', click: () => a.tabs('closeAll') }),
        sep,
        item({ label: 'Settings…', i: 'settings', accelerator: 'CmdOrCtrl+,', click: () => a.menu('settings') }),
        sep,
        mac ? item({ role: 'close', label: 'Close Window', i: 'closeWindow', accelerator: 'CmdOrCtrl+Alt+W' }) : item({ role: 'quit', label: 'Exit', i: 'quit' }),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        item({ role: 'undo', i: 'undo' }),
        item({ role: 'redo', i: 'redo' }),
        sep,
        item({ role: 'cut', i: 'cut' }),
        item({ role: 'copy', i: 'copy' }),
        item({ role: 'paste', i: 'paste' }),
        item({ role: 'delete', i: 'delete' }),
        sep,
        item({ role: 'selectAll', i: 'selectAll' }),
      ],
    },
    {
      label: 'View',
      submenu: [
        item({ role: 'reload', i: 'reload' }),
        // F12 on Windows and Linux: Ctrl+Shift+I belongs to the script editor (Insert snippet…)
        item({ role: 'toggleDevTools', i: 'devtools', ...(mac ? {} : { accelerator: 'F12' }) }),
        sep,
        item({ role: 'resetZoom', i: 'resetZoom' }),
        item({ role: 'zoomIn', i: 'zoomIn' }),
        item({ role: 'zoomOut', i: 'zoomOut' }),
        sep,
        item({ role: 'togglefullscreen', i: 'fullscreen' }),
      ],
    },
    {
      label: 'Window',
      submenu: [
        item({ role: 'minimize', i: 'minimize' }),
        item({ role: 'zoom', i: 'maximize', label: mac ? 'Zoom' : 'Maximize' }),
        ...(mac ? [sep, { role: 'front' as const }] : [item({ role: 'close', i: 'closeWindow' })]),
      ],
    },
    {
      role: 'help',
      submenu: [
        item({ label: 'Check for Updates…', i: 'updates', click: () => a.checkForUpdates() }),
        sep,
        item({ label: 'Open Examples Workspace', i: 'examples', click: () => a.menu('open-examples') }),
        item({ label: 'Keyboard Shortcuts', i: 'shortcuts', click: () => a.menu('shortcuts') }),
        sep,
        item({ label: 'Documentation', i: 'docs', click: () => a.openExternal(DOCS) }),
        item({ label: 'Release Notes', i: 'releaseNotes', click: () => a.openExternal(`${DOCS}changelog`) }),
        sep,
        item({ label: 'Send Feedback or Report a Problem…', i: 'issue', click: () => a.menu('feedback') }),
      ],
    },
  ]);
}

/** Set the application menu, and rebuild it when the OS switches between light and dark. */
export function installAppMenu(a: AppMenuActions): void {
  Menu.setApplicationMenu(build(a));
  if (!mac) nativeTheme.on('updated', () => Menu.setApplicationMenu(build(a)));
}

/**
 * Right-click on a text field (URL bar, inputs, text areas) or selected text: Electron shows no menu by
 * default. The code editor has its own menu and doesn't reach this.
 */
export function installTextContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_e, p) => {
    const f = p.editFlags;
    const withIcon = (o: MenuItemConstructorOptions, i: keyof typeof MENU_ICONS): MenuItemConstructorOptions => ({ ...o, icon: icon(i) });
    let items: MenuItemConstructorOptions[] = [];
    if (p.isEditable)
      items = [
        withIcon({ role: 'undo', enabled: f.canUndo }, 'undo'),
        withIcon({ role: 'redo', enabled: f.canRedo }, 'redo'),
        { type: 'separator' },
        withIcon({ role: 'cut', enabled: f.canCut }, 'cut'),
        withIcon({ role: 'copy', enabled: f.canCopy }, 'copy'),
        withIcon({ role: 'paste', enabled: f.canPaste }, 'paste'),
        withIcon({ role: 'delete', enabled: f.canDelete }, 'delete'),
        { type: 'separator' },
        withIcon({ role: 'selectAll', enabled: f.canSelectAll }, 'selectAll'),
      ];
    else if (p.selectionText.trim()) items = [withIcon({ role: 'copy' }, 'copy')];
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
}

