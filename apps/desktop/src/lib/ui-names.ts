/**
 * The names the person sees for the places of the app (rail items, tab strips, Settings tabs). They are written HERE only:
 * the rail, the tab strips, the Settings index and every sentence that points at a place read them from this file, so a
 * renamed view is one edit. The e2e plans and docs keep their own copy of the words they test; tests/unit/ui-names.test.ts
 * checks that the source does not spell a place's name anywhere else.
 */
export const VIEW_NAME = {
  home: 'Home',
  collections: 'Collections',
  debugger: 'Debugger',
  tests: 'Tests',
  monitors: 'Monitors',
  load: 'Load',
  aiQuality: 'AI Quality',
  rag: 'RAG Bots',
  environments: 'Environments',
  history: 'History',
  traces: 'Traces',
  git: 'Git',
  settings: 'Settings',
} as const;

/** The tabs of the AI Quality rail item. */
export const AI_TAB_NAME = { start: 'Start', checks: 'Checks', playground: 'Try a Prompt', compare: 'Compare', providers: 'Models and Keys' } as const;

/** The tabs of the RAG Bots rail item. */
export const RAG_TAB_NAME = { start: 'Start', bots: 'Bots', questions: 'Questions', metrics: 'Metrics', checks: 'Checks' } as const;

/** The tabs of Settings. */
export const SETTINGS_TAB_NAME = {
  appearance: 'Appearance',
  keyboard: 'Keyboard',
  requests: 'Requests',
  git: 'Git',
  proxy: 'Proxy',
  certificates: 'Certificates',
  privacy: 'Privacy & Security',
  pricing: 'Model Pricing',
  load: 'Load Testing',
  storage: 'Storage',
  assistant: 'AI Assistant',
  agents: 'AI Agents (MCP)',
  about: 'About',
} as const;

/** A place as a sentence points at it: where(VIEW_NAME.settings, SETTINGS_TAB_NAME.assistant) → "Settings ▸ AI Assistant". */
export const where = (...places: string[]): string => places.join(' ▸ ');

/** Settings ▸ <tab>, the most common pointer. */
export const inSettings = (tab: keyof typeof SETTINGS_TAB_NAME): string => where(VIEW_NAME.settings, SETTINGS_TAB_NAME[tab]);
