/**
 * WF-13: one word for one action, in every menu, toolbar and palette. Menus use these, and a unit test keeps the
 * retired variants out of the window's code. Node menus (every tree and list row) are built by lib/node-menu.ts from
 * these labels only.
 */
export const LABEL = {
  /** Open an item where it lives. */
  open: 'Open',
  openNewTab: 'Open in new tab',
  /** A captured exchange or a History entry as an editable request. */
  openAsRequest: 'Open as request',
  /** Show an item's row in the Collections explorer without opening it. */
  revealInSidebar: 'Reveal in sidebar',
  /** Show an item's file in the system's file manager. */
  revealFile: 'Reveal file',
  run: 'Run',
  runAgain: 'Run again',
  rerunFailed: 'Rerun failed',
  runCollection: 'Run collection',
  runFolder: 'Run folder',
  /** A run, a collection or test files as a CI pipeline (the Run in CI dialog). */
  runInCi: 'Run in CI…',
  /** The `testpion` command that does the same from a terminal. */
  copyCliCommand: 'Copy CLI command',
  /** One flow run in each environment picked, compared step by step (an environment matrix). */
  runInEnvironments: 'Run in several environments…',
  monitor: 'Monitor on a schedule…',
  generateFlow: 'Generate integration flow with AI…',
  generateSecurityTests: 'Generate security tests with AI…',
  checkTraffic: 'Check traffic against this spec with AI…',
  suggestChecks: 'Suggest checks with AI…',
  whyFlaky: 'Why is this flaky?',
  askAi: 'Ask AI',
  /** The submenu of a node's AI items (a node with one AI item shows it flat). */
  aiActions: 'AI',
  writeScriptAi: 'Write a script with AI…',
  fixScriptAi: 'Fix this script with AI…',
  explainScriptAi: 'Explain this script with AI',
  saveAsTest: 'Save as test…',
  createTestFileFromCollection: 'Create test file from collection…',
  createTestFileFromFolder: 'Create test file from folder…',
  /** Asks for the folder's name (the ellipsis says so, as every item that opens a dialog). */
  newFolder: 'New folder…',
  /** The submenu of the other request kinds a collection can hold. */
  newRequest: 'New request',
  import: 'Import…',
  expandAll: 'Expand all',
  collapseAll: 'Collapse all',
  copyLink: 'Copy link',
  /** The submenu of a request's code forms (cURL, PowerShell, fetch …). */
  copyAs: 'Copy as',
  copyPath: 'Copy path',
  copyGrpcurl: 'Copy as grpcurl',
  copyUrl: 'Copy URL',
  export: 'Export…',
  /** The Export submenu (its items open the export dialog or say what they export). */
  exportSubmenu: 'Export',
  /** Export ▸ the scripts rewritten to Postman's pm.* (TestPion writes tp.*; pm.* only for Postman). */
  forPostman: 'For Postman (pm.*)…',
  /** Export ▸ a TestPion bundle of the collection with the environments, API definitions, datasets, MCP servers and tests it uses. */
  exportWithUses: 'Export with everything it uses…',
  convertScriptsTp: 'Convert scripts to tp.*',
  settings: 'Settings…',
  historyInGit: 'History in git…',
  gitMenu: 'Git',
  stageInGit: 'Stage changes',
  discardInGit: 'Discard changes…',
  rename: 'Rename',
  renameFolder: 'Rename folder',
  duplicate: 'Duplicate',
  /** Move to another folder or collection (a dialog); "Move to folder" is the submenu of a list's folders. */
  moveTo: 'Move to…',
  moveToFolder: 'Move to folder',
  moveToCollection: 'Move to collection',
  addFavorite: 'Add to favorites',
  removeFavorite: 'Remove from favorites',
  // the actions of one kind (packages/shared/src/node-menu.ts, KIND_ACTIONS)
  editFolder: 'Edit folder (scripts, variables, auth)',
  collectionSettings: 'Settings, runner & docs',
  connect: 'Connect',
  disconnect: 'Disconnect',
  copyMcpConfig: 'Copy MCP config',
  openMcpInspector: 'Open MCP inspector',
  openApiDefinitions: 'Open API definitions',
  lint: 'Lint',
  apiCoverage: 'API coverage',
  compareVersions: 'Compare versions',
  generateTests: 'Generate tests…',
  generateFlows: 'Generate integration flows…',
  generateSpecTests: 'Generate tests from this spec…',
  tidyImport: 'Tidy with AI…',
  fixImportLeftovers: 'Fix what the import left…',
  preview: 'Preview',
  runWithDataset: 'Run a collection with it',
  useInTest: 'Use in a test',
  generateData: 'Generate test data…',
  edit: 'Edit',
  runNow: 'Run now',
  pause: 'Pause',
  resume: 'Resume',
  runWithData: 'Run with data…',
  exposeMcp: 'Expose as MCP tool…',
  exportArazzo: 'Export as Arazzo…',
  exportReport: 'Export report…',
  copyRunId: 'Copy run id',
  triageWithAi: 'Explain and fix failures with AI…',
  openRequest: 'Open request',
  openTrace: 'Open trace',
  openRun: 'Open run',
  makeActive: 'Make active',
  recentlyDeleted: 'Recently deleted…',
  /** Deleting puts the item in Recently deleted (or asks first where nothing can bring it back). */
  delete: 'Delete…',
  deleteFolder: 'Delete folder…',
  // every tab strip's menu (DocTabStrip, plus what EditorTabs adds)
  keepOpen: 'Keep open',
  closeTab: 'Close tab',
  closeOtherTabs: 'Close other tabs',
  closeTabsToRight: 'Close tabs to the right',
  closeAllTabs: 'Close all tabs',
  reopenClosedTab: 'Reopen closed tab',
  pinTab: 'Pin tab',
  unpinTab: 'Unpin tab',
  duplicateTab: 'Duplicate tab',
  // the down arrow of every output (OutputDownload)
  includeSecrets: 'Include secrets…',
  fromProductionEnvironment: 'From the production environment',
  chooseDownloadFormat: 'Choose a download format',
} as const;

/** Words that were used for the same actions and are not anymore (the unit test fails on them). */
export const RETIRED_LABELS = [
  'Open in tab',
  'Edit & Submit',
  'Save as test file…',
  'View trace',
  'Re-run failed',
  'Run this in CI…',
  'Run in environments…',
  'Remove server…',
  'Move to',
  'Delete folder',
  'Convert scripts to pm.*',
];

/**
 * The groups of every node menu, in this order everywhere (lib/node-menu.ts enforces it): create · open · tree (Expand
 * all, Collapse all) · run · share · tools · git · edit · danger. Declared once, in @testpion/shared (the CLI and MCP
 * print the same shapes).
 */
export { MENU_GROUPS, type MenuGroup } from '@testpion/shared';
