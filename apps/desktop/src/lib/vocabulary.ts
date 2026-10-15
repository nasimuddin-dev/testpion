/**
 * WF-13: one word for one action, in every menu, toolbar and palette. Menus use these, and a unit test keeps the
 * retired variants out of the window's code.
 */
export const LABEL = {
  /** Open an item where it lives. */
  open: 'Open',
  openNewTab: 'Open in new tab',
  /** A captured exchange or a History entry as an editable request. */
  openAsRequest: 'Open as request',
  /** Show an item's row in the Collections explorer without opening it. */
  revealInSidebar: 'Reveal in sidebar',
  run: 'Run',
  runAgain: 'Run again',
  rerunFailed: 'Rerun failed',
  /** A run, a collection or test files as a CI pipeline (the Run in CI dialog). */
  runInCi: 'Run in CI…',
  /** The `testpion` command that does the same from a terminal. */
  copyCliCommand: 'Copy CLI command',
  /** One flow run in each environment picked, compared step by step (an environment matrix). */
  runInEnvironments: 'Run in several environments…',
  /** Deleting asks first. */
  delete: 'Delete…',
} as const;

/** Words that were used for the same actions and are not anymore (the unit test fails on them). */
export const RETIRED_LABELS = ['Open in tab', 'Edit & Submit', 'Save as test file…', 'View trace', 'Re-run failed', 'Run this in CI…', 'Run in environments…', 'Remove server…'];

/** The groups of an item's menu, in this order everywhere (TreeParts `NodeMenu`, every list's ⋯ and right-click). */
export const MENU_GROUPS = ['create', 'open', 'run', 'test', 'configure', 'copy', 'organize', 'delete'] as const;
