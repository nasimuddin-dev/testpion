---
title: "Logs"
description: "The Logs tab of TestPion's bottom panel: what the app wrote down, how to filter it by level, save it, and turn it up when something needs a closer look."
---

# Logs

The bottom panel's **Logs** tab shows what TestPion itself wrote down while it worked: a workspace opened, a request sent, a file that could not be read, a script that failed. It is the app's own diary. The **Console** tab beside it is different: it lists the requests you sent and what their scripts printed.

Open it from the bottom panel (**Logs** next to **Console**, **Terminal** and **Problems**), or with the status bar's **Logs** button.

## Read it

- The newest 500 lines are shown, oldest first, each with its time, its level and its message. Errors are red and warnings amber.
- The **level** list above the lines keeps only one level: **Errors**, **Warnings**, **Info**, **Debug** or **Trace**.
- **Secrets are always redacted.** Passwords, tokens, keys and the fields named in [Settings ▸ Privacy & security](/security/privacy) are replaced before a line is written, at every level.

## Save it

The **down arrow** at the right end of the bar saves the log as text or as JSON lines (**▾** lists the formats), like every other output. Attach the file to a bug report, or use **Settings ▸ About ▸ Diagnostics bundle (ZIP)**, which holds the last 500 lines together with the versions and the size of the workspace. From a terminal: `testpion diagnostics --json`.

## Turn it up

By default the log holds **Info** and above. For a problem that only shows in the details, set **Settings ▸ Requests ▸ Log level** to **Debug** or **Trace**, repeat what failed, and read or save the log. Trace writes a line for every call between the window and the app, so set it back afterwards.

## Where the file is

The log is a file, `logs/app.log`, in the app's data folder. When it passes 10 MB it moves to `app.log.1` and a new one starts, so it never fills the disk. Only your account can read it.

## See also

- [Finding your way around](/getting-started/finding-your-way): the bottom panel and the status bar.
- [Save and export results](/getting-started/save-and-export-results): the down arrow.
- [Terminal](/getting-started/terminal): the bottom panel's shell.
