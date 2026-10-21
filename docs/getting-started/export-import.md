---
title: "Export and import"
description: "Move work between TestPion workspaces in one bundle file: any items, a collection with everything it uses, a preview before import with Keep both, Replace or Skip, Undo, no secret values."
---

::: v-pre

# Export and import

Move work between workspaces, or hand it to someone, in **one file**: a TestPion **bundle** (`.testpion.zip`, or `.testpion.json` when it is small and all text). A bundle holds any items of a workspace: collections, environments, API definitions, datasets, MCP servers and mocks, proto files, script packages, test and flow files, saved gRPC calls and connections, prompts, load tests, evaluations, monitors and (only when you ask for them) AI providers.

A bundle is a **selection**, not a nesting: nothing moves on disk, and the same API definition can be used by three collections and still travels once. Secret values are **never** in a bundle.

## Export

Every list has Export… in its header menu and on each item's menu (right-click, or <kbd>Shift</kbd>+<kbd>F10</kbd>):

- **On an item** (an environment, an API definition, a dataset, an MCP server, a test file, a saved call …): Export… opens the dialog for that item.
- **On a section header** (Datasets, API definitions, MCP servers, Monitors …): Export… takes the whole list.
- **On a collection**: Export ▸ **Export with everything it uses…** adds what the collection needs, found by reading it: the environments that define the `{{variables}}` it uses, the API definitions its contract checks name, the datasets, protos and mock files its text points at, the MCP servers its requests name, the script packages it `tp.require`s, the gRPC calls, connections, monitors and load tests that belong to it, and the test and flow files that refer to it (with the datasets and MCP servers *they* use). Something that is named but not in the workspace is listed as **missing**, so a bundle never claims more than it holds.
- **File ▸ Export ▸ Bundle…** exports the whole workspace.

The dialog shows what the bundle will hold before anything is saved: the items, the file size, the secrets that will be replaced, and what is missing. **Include everything it uses** is a switch. A dataset up to 10 MB is included; a bigger one goes **by reference** (the bundle names it, the importer is told to copy the file) unless you choose *Always include the data*.

The file is saved with the usual save dialog (a download in a browser).

### Secrets

An export never contains a secret value. Every literal secret that the detector finds (the same one `git check` uses) is replaced by a `{{variable}}`: headers, auth, MCP server headers and `env`, saved-call metadata, scripts, a dataset column named `password`, a connection string's password. The dialog and the command line list each replaced secret and the variable to set after the import (`requires.secrets` in the manifest). Environment variables marked secret keep their value in the secret store and are blank in the bundle. A file that no scan could read (a binary file) is named as *exported as is*.

## Import

**Import…** is on every section header (a section's Import takes only that kind), in **File ▸ Import Bundle…**, in the command palette, and by dropping a `.testpion.zip` or `.testpion.json` on the window.

The dialog first **previews** the file, changing nothing:

| Badge | Meaning |
|---|---|
| **New** | Not in this workspace yet. |
| **Already here** | The same item, byte for byte. Importing the same bundle twice is a no-op. |
| **Conflict** | Something else has that id, path or name. |
| **Refused** | The item is not valid (a path that leaves the workspace, a wrong shape …); the reason is shown and nothing is written. |
| **Not included** | A dataset sent by reference. |

For a conflict you choose per item, with a default for all:

- **Keep both** (the default): the incoming item is renamed (`api` becomes `api-2` and *Kinds API (imported)*; `specs/pets.yaml` becomes `specs/pets-2.yaml`), and the items imported with it that refer to it follow (a monitor's collection, a contract check's API definition, a test's MCP server name).
- **Replace**: yours is overwritten. **Undo import** brings it back byte for byte.
- **Skip**: yours stays.

Import also lists **Review before you run**: scripts, and programs an MCP server would start. **Nothing in a bundle runs on import**: scripts are text, an MCP server that starts a program stays untrusted until you allow it (Connect ▸ Always for this workspace), mocks are not started and no link is fetched. The dialog also lists the `{{variables}}` to fill in (set them as secret variables of an environment). **An AI provider or a remote MCP server never brings a key reference with it**: a bundle that names `{{$secret…}}` or `{{$env…}}` as a key, a header or a program's variable is imported without it (you enter the key yourself), and Review says where the provider or server sends things (its address) and which references were left out; replacing one of yours with another address says so and drops the key (it stays only when the address is the same). An address that itself holds a secret or environment reference is refused.

After the import a message offers **Undo** (and **Open**). Undo takes the whole import back as one step: what it made is removed, what it replaced is restored; a file you edited after the import is left as it is and named. `testpion import --list` shows the imports that can still be undone.

Workspace exports of earlier versions (`.testpion.json` from the older export, and the older `.apsworkspace.json`) are read as bundles too: they get the same preview and can be merged into the open workspace. The workspace switcher's **Export…**, the Export dialog's *The whole workspace* and `testpion workspace export` now write a bundle (`<name>.testpion.zip`), and **Import** in the workspace switcher opens a bundle as a new workspace. The older whole-workspace file is still written by **File ▸ Export ▸ Workspace (older format)…** and `testpion workspace export --legacy`, and will be removed in a later release; use **File ▸ Export ▸ Workspace as a Bundle…** instead.

A **bundle** is one file that holds several items (requests, environments, tests …) so you can move them to another workspace. Drop a `.testpion.zip` or `.testpion.json` on the window, or choose it in **File ▸ Import…**: the one Import hands a bundle over to its own preview, so exactly one dialog opens. A file that is not a bundle says so and offers **Choose another file** or **Import another format…**.

Postman, Insomnia, Bruno, OpenAPI, HAR and the other foreign formats are imported from **File ▸ Import…** as before. That dialog can be cancelled at every step, its main button is **Choose files…**, and *Coming from another tool?* shows how to export from each tool (the command palette has *Migrate from Another Tool…* too).

## From the command line

```bash
# a collection with everything it uses, as a zip
testpion export collection:clinic --uses --out clinic.testpion.zip -w my-workspace
# items of other kinds: spec:specs/pets.yaml  dataset:users.csv  mcp-server:petstore  environment:staging  test:smoke/login.yaml
testpion export spec:specs/pets.yaml dataset:users.csv --out pets.testpion.zip
# a whole section, or the whole workspace
testpion export --section mcp-server --out servers.testpion.json
testpion export --all --out everything.testpion.zip

# read a bundle without a workspace
testpion bundle inspect clinic.testpion.zip

# preview, then apply
testpion import clinic.testpion.zip -w other --preview --json
testpion import clinic.testpion.zip -w other --on-conflict keep-both --json
testpion import --undo imp-1a2b3c4d5e6f -w other
```

See [`export`](/cli/reference#export-and-export-environment), [`import`](/cli/reference#import) and [`bundle`](/cli/reference#bundle).

## For AI agents

Agents get the same safe flow over MCP ([tools](/ai-testing/mcp-server)): `export_bundle`, `describe_bundle`, `import_bundle_preview` (read-only; returns a `plan_id`), `import_bundle_apply` (the one write; needs the `plan_id` and the user's yes) and `undo_import`. `export_bundle` writes a new file under `exports/` or `.local/exports/` only, never over an existing file, and asks first. An agent cannot apply a bundle it has not previewed. `testpion import --preview --json` gives a script the same preview.

## The format

A bundle is a zip (or the JSON form: the same manifest fields plus `entries`) with:

```text
manifest.json                  the index: format, formatVersion, title, items, edges, missing, requires, flags
README.md                      a summary for a person who opens the zip (never read on import)
collections/<id>.json          one collection per file
environments/<id>.json         secret values blank
mcp-servers/<id>.json          secrets replaced by {{variables}}
providers/<id>.json            only when asked for
library/<library>/<id>.json    gRPC calls, connections, prompts, load tests, evaluations, monitors
files/<path>                   test and flow files, API definitions, datasets, protos, mocks, script packages
```

`manifest.json` has `format: "testpion-bundle"` and an integer `formatVersion` (this release writes and reads **1**; a higher one is refused with *update TestPion*). Each item lists its `kind`, `id`, `name`, `entry`, `sha256` and `size`; a mismatch with the entry is an error. A kind this version does not know is skipped with a warning, so a newer bundle still imports what an older TestPion understands.

A bundle is untrusted input. The reader refuses: a path that leaves its folder (`..`, absolute, drive, UNC, backslash, device names), links, names that differ only in case, encrypted or zip64 archives, more than 20,000 entries, an entry over 512 MB or a total over 2 GB when inflated, an entry that inflates more than 100 times its size, and a wrong checksum. Keys named `__proto__`, `constructor` and `prototype` are dropped at every depth. The destination of a file is computed from its kind and id, never taken from an entry name.

## What each kind supports

| Kind | Export | Import | Notes |
|---|---|---|---|
| Collection | yes | yes | With its folders and requests; "everything it uses" adds the rest |
| Environment | yes | yes | Secret values are blank; the production flag travels |
| Test file / Flow | yes | yes | Both are test files |
| API definition | yes | yes | |
| Dataset | yes | yes | Up to 10 MB included, bigger by reference |
| Proto file, MCP mock, Script package | yes | yes | With the gRPC call, MCP server or collection that uses them |
| MCP server | yes | yes | Secrets replaced; never trusted to start a program |
| Saved gRPC call, connection, prompt, load test, evaluation, monitor | yes | yes | |
| AI provider | yes | yes | Only when asked for; keys are never imported (you enter them), only the known fields are kept |
| Folder, request | later | later | Export the collection, or a section, for now |

:::
