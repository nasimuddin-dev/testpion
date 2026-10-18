---
title: "Keyboard shortcuts"
description: "Every keyboard shortcut of the TestPion app in one list: Quick Open, the command palette, switching environments and views, tabs, request editors, the flow designer, the HTTP Debugger, the Terminal and the Problems list."
---

::: v-pre

# Keyboard shortcuts

On macOS use <kbd>⌘</kbd> for <kbd>Ctrl</kbd> and <kbd>⌥</kbd> for <kbd>Alt</kbd>. In the app, <kbd>?</kbd> (outside a text field) or **Help ▸ Keyboard Shortcuts** shows the same list. The tables list the **default** keys.

## Change the keys {#change-the-keys}

**Settings ▸ Keyboard** (also **Change the keys…** in the <kbd>?</kbd> list, and <kbd>Ctrl</kbd>+<kbd>K</kbd> ▸ *Keyboard Shortcuts: Change the Keys…*) lists every shortcut with a search box (by what it does or by its keys). The ones under **Anywhere** can be changed, except <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>1</kbd>…<kbd>9</kbd> (the rail's), <kbd>F12</kbd> and <kbd>Ctrl</kbd>+<kbd>Z</kbd>:

1. Click a shortcut's keys: it says **Press keys…**. Press the new combination (<kbd>Esc</kbd> cancels, <kbd>Backspace</kbd> turns the shortcut off).
2. Keys another command has are named (*Ctrl+P is already “Quick Open”*): **Use it here** moves them to this command and gives the other one this command's old keys. Keys an editor or the system keeps (<kbd>Ctrl</kbd>+<kbd>S</kbd>, <kbd>Ctrl</kbd>+<kbd>C</kbd>, <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>1</kbd>…<kbd>9</kbd> …) and a key alone that typing needs (a letter, <kbd>Shift</kbd>+a letter) are refused with the reason.
3. ↺ beside a shortcut puts its default back; **Reset all** puts every default back.
4. **Export…** saves your changes as `testpion-keybindings.json` (`{ "testpionKeybindings": 1, "bindings": { "palette": "Mod+Shift+P" } }`, only the keys you changed; `Mod` = <kbd>Ctrl</kbd> / <kbd>⌘</kbd>); **Import…** reads such a file on another computer and says what it skipped.

Your keys are this computer's (the app's `settings.json`, `keybindings`), and the shortcuts list (<kbd>?</kbd>), the tooltips, the top bar and the command palette's hints show them. The editors' own keys (send, save, find …) are listed for reference and keep their keys. The native **File** menu shows the default key of **Settings…**.

<figure class="aps-screenshot">
  <img src="/images/settings-keyboard.jpg" alt="Settings ▸ Keyboard: a search box, Reset all, Export and Import, and every shortcut grouped as in this page, the app-wide ones with their keys to click and change" width="1440" height="900" loading="lazy">
</figure>

## Anywhere

| Keys | What it does |
|---|---|
| <kbd>Ctrl</kbd>+<kbd>P</kbd> | **Quick Open**: the items you opened lately, any item by name as you type. First character: **>** commands, **@** the focused editor's commands, **#** environments and variables, **?** help. See [Finding your way around](/getting-started/finding-your-way#open-an-item). |
| <kbd>Ctrl</kbd>+<kbd>K</kbd> | The command palette (Quick Open on **>** commands). On the flow canvas it lists the canvas's actions first. |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> | Switch environment (Quick Open on **#**). |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> | Search the workspace. |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> | Run the last run again, as it ran (same files or collection, same environment). |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> | Reopen the tab you closed last, in whichever tab bar it was. |
| <kbd>Alt</kbd>+<kbd>←</kbd> / <kbd>Alt</kbd>+<kbd>→</kbd> | Back / forward to where you were (also the mouse's back and forward buttons). |
| <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>1</kbd> … <kbd>9</kbd> | Go to a view shown on the rail, in its order: by default 1 Home, 2 Collections, 3 Tests, 4 Environments, 5 History (the rail's tooltips show each; [rearrange the rail](/getting-started/finding-your-way#choose-what-the-rail-shows) and the numbers follow). |
| <kbd>Ctrl</kbd>+<kbd>B</kbd> | Show or hide the Collections explorer (in **Tests**, beside the flow designer, to drag requests onto the canvas). |
| <kbd>F8</kbd> / <kbd>Shift</kbd>+<kbd>F8</kbd> | Open the next / previous item of **Problems** (while a flow is paused in the debugger, <kbd>F8</kbd> continues it). |
| <kbd>Ctrl</kbd>+<kbd>J</kbd> | Ask the AI assistant about what is on screen (again: close it). |
| <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>C</kbd> | Show or hide the Console. |
| <kbd>Ctrl</kbd>+<kbd>&#96;</kbd> | Show the [Terminal](/getting-started/terminal) and focus it (again: hide the panel). |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>&#96;</kbd> | New terminal. |
| <kbd>Ctrl</kbd>+<kbd>,</kbd> | Settings. |
| <kbd>F12</kbd> | Developer Tools (Windows and Linux; **View** menu on macOS). |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> | Undo a delete while its message shows **Undo** (8 seconds; outside text fields and editors, which keep their own undo). |
| <kbd>?</kbd> | The list of shortcuts (outside a text field). |

## Requests and tabs

| Keys | What it does |
|---|---|
| <kbd>Ctrl</kbd>+<kbd>Enter</kbd> | Send the request (also runs AI prompts and gRPC calls). |
| <kbd>Ctrl</kbd>+<kbd>S</kbd> | Save. |
| <kbd>Ctrl</kbd>+<kbd>T</kbd> | New request tab. |
| <kbd>Ctrl</kbd>+<kbd>W</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>W</kbd> | Close the tab / all tabs. |
| <kbd>Ctrl</kbd>+<kbd>O</kbd> | Import (Postman, Insomnia, Bruno, OpenAPI, Arazzo, cURL …). |
| <kbd>F2</kbd> | Rename the focused tab or item in place; <kbd>Enter</kbd> saves, <kbd>Esc</kbd> cancels. |
| Middle-click a tab | Close it. Double-click a preview tab (its name in italics) to keep it. |

## Collections explorer and lists

| Keys | What it does |
|---|---|
| <kbd>↑</kbd> / <kbd>↓</kbd> | Move between rows. |
| <kbd>→</kbd> / <kbd>←</kbd> | Expand or collapse a collection, category or folder. |
| <kbd>Enter</kbd> | Open the focused item. |
| <kbd>F2</kbd> | Rename it. |
| <kbd>Delete</kbd> | **Delete…** the focused item: a request, folder, collection, MCP server, API definition, dataset, saved item, monitor, test file … (**Undo** in the message). |
| <kbd>Shift</kbd>+<kbd>F10</kbd> / the menu key | Open the focused row's menu: the same as its ⋯ and its right-click, in every tree and list. |
| <kbd>*</kbd> | **Expand all** inside the focused collection, folder or section. |
| Letters | Jump to the next row whose name starts with what you type. |
| <kbd>↑</kbd> / <kbd>↓</kbd> or <kbd>J</kbd> / <kbd>K</kbd> | Move through a run's results. |
| <kbd>Esc</kbd> | Close a menu or dialog. |

## Code editors

| Keys | What it does |
|---|---|
| <kbd>{{</kbd> | Suggest variables. |
| <kbd>Ctrl</kbd>+<kbd>Space</kbd> | Suggestions (variables, `tp.*` snippets, JSON Schema fields). |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>I</kbd> | Insert a snippet by name (request scripts). |
| <kbd>Ctrl</kbd>+<kbd>F</kbd> / <kbd>Ctrl</kbd>+<kbd>H</kbd> | Find / replace. |
| <kbd>Ctrl</kbd>+<kbd>/</kbd> | Comment or uncomment lines. |
| <kbd>Alt</kbd>+<kbd>↑</kbd> / <kbd>Alt</kbd>+<kbd>↓</kbd> | Move lines (and environment variables in the Environments table). |

## Flow designer

On the canvas of a test file's **Flow** tab (see [Design a flow](/test-runner/integration-testing#design-a-flow)):

| Keys | What it does |
|---|---|
| Click / <kbd>Shift</kbd>+click | Select a step / add one to the selection. |
| <kbd>Shift</kbd>+drag | Select with a box. |
| <kbd>Ctrl</kbd>+<kbd>A</kbd> / <kbd>Esc</kbd> | Select everything / nothing. |
| <kbd>Delete</kbd> | Remove the selected steps, notes or connection. |
| <kbd>Ctrl</kbd>+<kbd>D</kbd> | Duplicate the selected steps. |
| <kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>Ctrl</kbd>+<kbd>V</kbd> | Copy steps, to this or another flow. |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Y</kbd> (or <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd>) | Undo / redo any canvas change. |
| <kbd>Enter</kbd> | Open the selected step in the editor. |
| <kbd>Ctrl</kbd>+<kbd>F</kbd> | Find a step (<kbd>Enter</kbd> / <kbd>Shift</kbd>+<kbd>Enter</kbd>: next / previous match). |
| <kbd>Ctrl</kbd>+<kbd>K</kbd> | The canvas's actions first, then the app's commands. |
| <kbd>Space</kbd>+drag, middle button | Pan (as does a plain drag on the empty canvas and two fingers on a trackpad); the wheel or a pinch zooms. |
| <kbd>F9</kbd> | Add or remove a breakpoint on the selected step. |
| <kbd>F8</kbd> / <kbd>F10</kbd> | While paused: **Continue** / **Step over**. |
| <kbd>Ctrl</kbd>+<kbd>Enter</kbd> | Save a sticky note you are writing. |

## Reviewing an AI proposal

In the review of suggested checks, tests, a flow, a request, or the fixes for a failed run or a flaky test ([proposals](/ai-testing/ai-features#proposals-review-accept-undo)):

| Keys | What it does |
|---|---|
| <kbd>Tab</kbd> | Move through the items and their buttons. |
| <kbd>Space</kbd> | Tick or untick the focused item. |
| <kbd>Enter</kbd> | On an item's title: show or hide its diff. |
| <kbd>Ctrl</kbd>+<kbd>Enter</kbd> | **Accept selected** (on a flow's canvas review: **Accept**; for a failed run: **Apply selected fixes**; after Attempt to fix: **Keep the fix**). |
| <kbd>Esc</kbd> | Close the review (nothing is applied). |

## HTTP Debugger

| Keys | What it does |
|---|---|
| <kbd>↑</kbd> / <kbd>↓</kbd> | Move through the exchanges. |
| <kbd>Enter</kbd> | **Open as request**: the selected exchange in a request tab. |
| <kbd>Ctrl</kbd>/<kbd>Shift</kbd>+click | Select several exchanges (for **Save to collection…** or **Create flow from selection…**). |
| <kbd>Delete</kbd> | Delete the selected exchanges. |
| <kbd>Ctrl</kbd>+<kbd>F</kbd> | The filter box. |
| <kbd>Ctrl</kbd>+<kbd>E</kbd> | Clear the session. |
| <kbd>F5</kbd> / <kbd>F6</kbd> | The **Timeline** / **Structure** panel. |

## Terminal

Keys typed in a terminal go to the shell, not to the app (<kbd>Ctrl</kbd>+<kbd>K</kbd>, <kbd>Ctrl</kbd>+<kbd>R</kbd> …). <kbd>Ctrl</kbd>+<kbd>C</kbd> stops the running command; <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> copies (selecting text copies too) and <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> pastes. See [Terminal](/getting-started/terminal#using-it).

:::
