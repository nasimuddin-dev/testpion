---
title: "Keyboard shortcuts"
description: "Every keyboard shortcut of the TestPion app in one list: Quick Open, the command palette, switching environments and views, tabs, request editors, the flow designer, the HTTP Debugger, the Terminal and the Problems list."
---

::: v-pre

# Keyboard shortcuts

On macOS use <kbd>⌘</kbd> for <kbd>Ctrl</kbd> and <kbd>⌥</kbd> for <kbd>Alt</kbd>. In the app, <kbd>?</kbd> (outside a text field) or **Help ▸ Keyboard Shortcuts** shows the same list.

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
| <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>1</kbd> … <kbd>9</kbd> | Go to a view in the rail's order: 1 Home, 2 Collections, 3 Debugger, 4 Tests, 5 Monitors, 6 Load, 7 AI Lab, 8 Evaluations, 9 Environments (the rail's tooltips show each). |
| <kbd>Ctrl</kbd>+<kbd>B</kbd> | Show or hide the Collections explorer (in **Tests**, beside the flow designer, to drag requests onto the canvas). |
| <kbd>F8</kbd> / <kbd>Shift</kbd>+<kbd>F8</kbd> | Open the next / previous item of **Problems** (while a flow is paused in the debugger, <kbd>F8</kbd> continues it). |
| <kbd>Ctrl</kbd>+<kbd>J</kbd> | Ask the AI assistant about what is on screen (again: close it). |
| <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>C</kbd> | Show or hide the Console. |
| <kbd>Ctrl</kbd>+<kbd>&#96;</kbd> | Show the [Terminal](/getting-started/terminal) and focus it (again: hide the panel). |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>&#96;</kbd> | New terminal. |
| <kbd>Ctrl</kbd>+<kbd>,</kbd> | Settings. |
| <kbd>F12</kbd> | Developer Tools (Windows and Linux; **View** menu on macOS). |
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
| <kbd>Delete</kbd> | **Delete…** the focused request or folder (**Undo** in the message). |
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
