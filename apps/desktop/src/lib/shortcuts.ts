/**
 * Every keyboard shortcut of the app, grouped: the one list the Shortcuts dialog (Help ▸ Keyboard Shortcuts, ?) shows.
 * docs/getting-started/keyboard-shortcuts.md lists the same; a unit test keeps the two in step.
 */
export interface ShortcutGroup {
  title: string;
  items: Array<{ keys: string[][]; text: string }>;
}

/** The groups for a platform: its modifier names, and the views in the rail's order (for Ctrl+Alt+1…9). */
export function shortcutGroups(o: { mod: string; alt: string; shift: string; mac: boolean; views: string[] }): ShortcutGroup[] {
  const { mod, alt, shift } = o;
  return [
    {
      title: 'Anywhere',
      items: [
        { keys: [[mod, 'P']], text: 'Quick Open: go to any item (the latest first); > commands, @ what is on screen, # environments, ? help' },
        { keys: [[mod, 'K']], text: 'Command palette (Quick Open at >)' },
        { keys: [[mod, shift, 'E']], text: 'Switch environment (Quick Open at #)' },
        { keys: [[mod, shift, 'F']], text: 'Search the workspace' },
        { keys: [[mod, shift, 'R']], text: 'Run the last run again' },
        { keys: [[mod, shift, 'T']], text: 'Reopen the tab closed last' },
        {
          keys: [
            [alt, '←'],
            [alt, '→'],
          ],
          text: 'Back / forward to where you were (also the mouse back and forward buttons)',
        },
        { keys: [[mod, 'B']], text: 'Show or hide the Collections explorer' },
        { keys: [['F8'], [shift, 'F8']], text: 'Open the next / previous item of Problems (while a flow is paused in the debugger, F8 continues it)' },
        { keys: [[mod, ',']], text: 'Settings' },
        { keys: [[mod, 'J']], text: 'Ask the AI assistant about what is on screen (again: close it)' },
        { keys: [[mod, alt, 'C']], text: 'Show or hide the console' },
        { keys: [[mod, '`']], text: 'Show the terminal (and focus it)' },
        { keys: [[mod, shift, '`']], text: 'New terminal' },
        {
          keys: [[mod, alt, '1…9']],
          text: `Go to a view in the rail's order: ${o.views
            .slice(0, 9)
            .map((v, i) => `${i + 1} ${v}`)
            .join(', ')}`,
        },
        // the View menu has it on macOS
        ...(o.mac ? [] : [{ keys: [['F12']], text: 'Developer Tools' }]),
        { keys: [['?']], text: 'This list (outside a text field)' },
      ],
    },
    {
      title: 'Requests and tabs',
      items: [
        { keys: [[mod, 'Enter']], text: 'Send the request (also runs AI prompts and gRPC calls)' },
        { keys: [[mod, 'S']], text: 'Save' },
        { keys: [[mod, 'T']], text: 'New request tab' },
        { keys: [[mod, 'W']], text: 'Close the tab' },
        { keys: [[mod, shift, 'W']], text: 'Close all tabs' },
        { keys: [[mod, 'O']], text: 'Import (Postman, Insomnia, Bruno, OpenAPI, cURL …)' },
      ],
    },
    {
      title: 'Collections sidebar',
      items: [
        { keys: [['↑'], ['↓']], text: 'Move between rows' },
        { keys: [['→'], ['←']], text: 'Expand or collapse a collection, category or folder' },
        { keys: [['F2']], text: 'Rename the focused item in place (request, folder, collection, tab, environment, monitor …); Enter saves, Esc cancels' },
        { keys: [['Delete']], text: 'Delete the focused request or folder (Undo in the message)' },
        { keys: [['Enter']], text: 'Open the focused request' },
      ],
    },
    {
      title: 'Code editors',
      items: [
        { keys: [['{{']], text: 'Suggest variables' },
        { keys: [[mod, 'Space']], text: 'Suggestions (variables, tp.* snippets, JSON Schema fields)' },
        { keys: [[mod, 'F']], text: 'Find' },
        { keys: [[mod, 'H']], text: 'Replace' },
        { keys: [[mod, '/']], text: 'Comment or uncomment lines' },
        { keys: [[mod, shift, 'I']], text: 'Insert a snippet (request scripts): type to filter, Enter inserts at the cursor' },
        {
          keys: [
            [alt, '↑'],
            [alt, '↓'],
          ],
          text: 'Move lines (and environment variables, in the Envs table)',
        },
      ],
    },
    {
      title: 'Lists, menus and dialogs',
      items: [
        { keys: [['↑'], ['↓']], text: 'Move through results' },
        { keys: [['Enter']], text: 'Open or run the selected item' },
        { keys: [['Esc']], text: 'Close' },
      ],
    },
  ];
}
