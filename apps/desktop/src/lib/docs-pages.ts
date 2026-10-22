import type { ViewId } from '../store';

/**
 * The docs page of every view (a path under DOCS_URL, docs/<path>.md in the repository): the top bar's ? opens the
 * one of the view on screen. A page header or a dialog with a page of its own passes it as `help` instead. A unit
 * test checks that every page (and anchor) exists.
 */
export const VIEW_DOCS: Record<ViewId, string> = {
  home: 'getting-started/finding-your-way',
  rest: 'api-testing/rest',
  graphql: 'graphql/overview',
  websocket: 'api-testing/websocket',
  grpc: 'api-testing/grpc',
  mcp: 'mcp/overview',
  apidef: 'api-testing/collections#documentation',
  dataset: 'test-runner/datasets',
  ai: 'ai-testing/overview',
  evaluations: 'ai-testing/evaluations',
  tests: 'test-runner/overview',
  load: 'performance/load-testing',
  traces: 'test-runner/traces',
  monitors: 'test-runner/monitors',
  collections: 'api-testing/collections',
  history: 'getting-started/finding-your-way#history-send-it-again',
  environments: 'api-testing/environments',
  git: 'getting-started/git',
  debugger: 'api-testing/http-debugger',
  settings: 'getting-started/finding-your-way#settings',
};
