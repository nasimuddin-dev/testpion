# Export and import of everything (collections, MCP servers, API definitions, datasets, tests, environments, library items)

Status: research and plan, 2026-10-17. Nothing here is built yet.

> Owner: "There is no export and import for the MCP collection, the same for API definitions and database (dataset)
> collections. Can we do research and can we put everything on the main collection and then do export and import
> together?"

In the Collections sidebar, a collection can be exported, but the **MCP servers**, **API definitions** and **Datasets**
sections have no Export, and only API definitions have an Import. Their items have neither.

## Contents

0. [Summary and recommendation](#0-summary-and-recommendation)
1. [Inventory: what exists today](#1-inventory-what-exists-today)
2. [Research: how other API clients do it](#2-research-how-other-api-clients-do-it)
3. [Two designs, evaluated](#3-two-designs-evaluated)
4. [The plan](#4-the-plan)
5. [Phased roadmap](#5-phased-roadmap)
6. [Risks](#6-risks)
7. [Open questions for the owner](#7-open-questions-for-the-owner)

---

## 0. Summary and recommendation

**Today.**

- Collections and environments can be exported and imported in many formats.
- gRPC calls and WebSocket connections travel inside a TestPion collection file.
- Flows export as Arazzo, history exports as HAR, and API definitions come in through Import.
- The "Export Workspace" bundle (one JSON file) carries collections, environments, tests, providers, MCP servers,
  library items and script packages. It **silently leaves out** `specs/` (API definitions), `datasets/`, `mocks/`
  (MCP mocks and toolsets) and `protos/`, although the dialog promises "Every collection, environment, test file, saved
  item and setting".
- Importing a workspace bundle always creates a **new** workspace. Nothing can be merged into the open one.
- MCP servers, API definitions and datasets have **no per-item or per-section export**. Datasets have no import of a
  file either.

**Recommendation: a TestPion bundle, centred on a collection, not nesting.** The reasons:

1. "Export and import together" is a property of the **file**, not of where things are stored. A bundle gives it
   without moving a single file on disk.
2. Items are shared. A spec, a dataset or an MCP server is used by several collections and flows, so "owned by one
   collection" would be wrong for most real workspaces.
3. Nesting (B) changes the on-disk model the owner already ruled on (GIT-303: no second layout). It would need a
   migration and changes to the merge driver, the CLI paths, the MCP tools, `ItemRef`s and the cloud schema.
4. A collection-centred selection gives the experience the owner asked for: "Export collection with everything it
   uses…" pulls in the MCP servers, specs, datasets, flows, environments and saved items it references, through a
   dependency graph.
5. Import gets a **preview** with per-item conflict choices (skip, replace, keep both). Only Yaak offers a preview
   today, so this would be a differentiator.
6. The design is one registry. Each kind registers `describe/dependencies/exportItems/importItems`, the same idea as
   `NODE_KINDS` in [menus-uniform.md](menus-uniform.md), so a new kind gets export and import for free.
7. The per-kind Export… and Import… entries in every section header and node menu ship first. They are cheap and they
   fix exactly what the owner saw.
8. Nesting stays an **optional later decision** (release C) if the owner wants ownership semantics. Its cost is listed
   in §3.

---

## 1. Inventory: what exists today

### 1.1 Export and import paths

| Kind | Export | Import | Where (file:line) |
|---|---|---|---|
| Collection | TestPion JSON (with `savedItems`: gRPC calls and WS connections), Postman v2.1, OpenAPI 3.1, Bruno folder, `.http`, AsyncAPI 3.0 (its connections) | OpenAPI 3.x, Swagger 2, Postman (collection, environment, globals), Insomnia, Bruno (folder or `.bru`), Hoppscotch, HAR, WSDL, GraphQL SDL, AsyncAPI, `.http`, `.env`, Arazzo, cURL / fetch / PowerShell snippet, TestPion collection | CLI `export` `packages/cli/src/commands/data.ts:533-584`; `exportTextFormat` `packages/cli/src/commands/export-formats.ts:7`; CLI `import` `data.ts:617-670`; RPC `col.export` `apps/desktop/backend/handlers/collections.ts:423`; `col.import`, `col.importBrunoFolder` `apps/desktop/backend/rpc-params.ts:62-63`; format detection `packages/core/src/import/importers.ts` (`detectFormat`, `importAny` at :431); UI `components/ExportDialogBody.tsx:11-12`, Collections header Export `views/CollectionsView.tsx:170-302`, sidebar icon buttons `components/Explorer.tsx:717,720` |
| Saved gRPC calls / WS connections | only inside a TestPion collection file (`savedItems`) | restored with a new id when the id is taken | `packages/core/src/runner/collection-realtime.ts:121-127`; `packages/core/src/import/workspace-import.ts:59-84` (`restoreSavedItems`) |
| Environment | Postman environment JSON, `.env` | Postman environment, `.env`, Insomnia/Bruno environments (with a collection); a name clash gets "(imported)" | CLI `export-environment` `data.ts:586`; RPC `env.export` `apps/desktop/backend/handlers/workspace.ts:354`; UI `views/EnvironmentsView.tsx:392`; clash rule `workspace-import.ts:149-157` |
| Whole workspace | `testpion-workspace` JSON bundle (`exportBundle`) | `importBundle`, which **always creates a new workspace** | core `packages/core/src/storage/workspace.ts:570-597`, type `:614-630`, import `:844-866`; CLI `workspace export` `packages/cli/src/commands/workspace.ts:66-74` (no `workspace import` CLI command); RPC `ws.export` `handlers/workspace.ts:149` (default file name is still `*.apsworkspace.json` at :159), `ws.import` :167, `ws.importPick` :179, `ws.importFile` :185 (a bundle opens as a new workspace, anything else goes to `col.import`); UI `components/WorkspaceMenu.tsx:84-113,224`, File menu `App.tsx:410-412`, `menu-commands.ts:144` |
| Flow / test file | Arazzo 1.0 (one flow) | Arazzo (flows under `tests/arazzo/`; a clash gets `-2`, never replaced) | CLI `flow export` `packages/cli/src/commands/flow-export.ts:11`; `workspace-import.ts:39-56`; MCP `import_arazzo` / `export_arazzo` `packages/core/src/mcp-server/arazzo-tools.ts:18,53`; UI `views/TestsView.tsx:582` |
| API definition (`specs/`) | **none** (only a collection can be exported *as* OpenAPI) | through the general Import: an OpenAPI/Swagger import keeps the document as `specs/<slug>.<format>.<ext>` and **overwrites a file of the same name without asking**; AsyncAPI goes to `specs/asyncapi/` | `workspace-import.ts:108-113` (atomicWrite, no exists check), `:70-75`; listing `packages/core/src/openapi/spec-files.ts:50`; MCP `import_definition` `packages/core/src/mcp-server/testpion-mcp.ts:755`; section `Explorer.tsx:811` (menu: Import an OpenAPI document, New folder, Open) |
| MCP servers (`mcp-servers.json`) | **none per server or section**; only inside the workspace bundle, **verbatim** (literal header and env values included) | **none** (no import of a `claude_desktop_config.json`, `.mcp.json` or `.vscode/mcp.json`) | `workspace.ts:427-445`; section `Explorer.tsx:789` (menu: New folder, Open MCP inspector), server menu `Explorer.tsx:541-560` |
| MCP mocks and toolsets (`mocks/*.mcp-mock.yaml`) | none, and **not in the workspace bundle** | none | `McpTransportConfig` `packages/core/src/model/types.ts:183-190`; `components/mcp/ToolsetEditor.tsx:20` |
| Datasets (`datasets/`: CSV, JSON, JSONL, Markdown table, SQLite; DB datasets as `connectionEnv` + query in a test file) | **none**, and **not in the workspace bundle** | **none** (only New CSV/JSONL, Generate test data, Duplicate) | formats `packages/core/src/runner/datasets.ts:275`; DB `packages/core/src/runner/db-datasets.ts:1-10`; generate `packages/core/src/storage/dataset-files.ts`; section `Explorer.tsx:835-850`, menu `:422-428`; RPC `rpc-params.ts:79-83` |
| Library kinds (`library/<kind>.json`: `grpc`, `websocket`, `ai-prompts`, `load-tests`, `evaluations`, `monitors`, `mcp`, `mcp-folders`, `spec-folders`) | only inside the workspace bundle (`library`) | only through the workspace bundle | `workspace.ts:447-464`, `libraryKinds()` :600; labels `packages/core/src/storage/search.ts:125`; views `apps/desktop/src/lib/ref-target.ts:24`; evaluations `packages/core/src/runner/saved-evaluations.ts:12,33` |
| Providers (`providers.json`) | in the workspace bundle (keys are always `{{$secret…}}`/`{{$env…}}` refs; a literal key is refused on save) | in the bundle | `workspace.ts:414-425` |
| Script packages (`packages/*.js`) | in the bundle | in the bundle | `workspace.ts:596`, `:861` |
| History / traffic | HAR (history), sessions/HAR/SAZ (Debugger), traces | HAR, SAZ | CLI `history export-har` `packages/cli/src/commands/history.ts:32`; MCP `export_traces` `testpion-mcp.ts:515`; `views/DebuggerView.tsx:429`, `views/HistoryView.tsx:212` |
| Protos (`protos/`), payloads, baselines | not in the bundle | – | `examples/veterinary-workspace/protos` |
| Settings (app) | key bindings only (Settings ▸ Keyboard) | key bindings | `components/KeyboardSettings.tsx:87,104` |

**MCP tools.** The agent surface has `import_definition`, `import_arazzo`, `export_arazzo`, `export_traces` and
`import_and_test` (`agent-kit.ts:248`). It has **no** tool that exports or imports a collection, a workspace or a
bundle. The CLI contract lists `import` and `export` (`packages/cli/src/contract.ts:24-25`).

### 1.2 Storage on disk, ids and secrets

| Kind | Path | Format | Id | Secrets |
|---|---|---|---|---|
| Collection | `collections/<id>.json` | JSON, fixed key order, no save counter (`collectionFileContent`, `workspace.ts:882`) | `id` (slug); node ids inside | `{{var}}` references; literal tokens typed into headers or auth are found by `findCommittableSecrets` (`packages/core/src/storage/git-guard.ts:47`) |
| Environment | `environments/<id>.json` | JSON | `id` + unique name | `secret: true` variables: the value lives in the secret store (`packages/core/src/storage/secrets.ts:165` `secretKeys`), and the file holds `""` |
| Test / flow | `tests/**/*.yaml` (+ `*.suite.yaml`) | YAML (`layout:` for the designer) | path | `{{$secret.*}}`, `{{$env.*}}` |
| API definition | `specs/*.json|yaml`, `specs/asyncapi/*`; folders in `library/spec-folders.json` | the document | path | none normally |
| Dataset | `datasets/*` | CSV, JSON, JSONL, md, SQLite (binary) | path | DB connections: `connectionEnv: DATABASE_URL`, so the URL with its password stays out of the workspace (`db-datasets.ts:5-8`); a literal `postgres://user:pw@…` can still be passed on the CLI |
| MCP server | `mcp-servers.json` `{servers: McpServerConfig[]}`; folders in `library/mcp-folders.json` | JSON | `id` | `headers` (http/sse) and `env` (stdio) may hold literal values; `git check` reports them (`git-guard.ts:74-77`) but the bundle exports them as they are |
| MCP mock / toolset | `mocks/*.mcp-mock.yaml`, referenced by `mockFile` | YAML | path | – |
| Library item | `library/<kind>.json` `{folders, items: LibraryItem[]}` | JSON | `id` (`lib-…`), optional `collectionId` (`types.ts:862-872`) | in `data` (e.g. gRPC metadata) |
| Provider | `providers.json` | JSON | `id` | `apiKey` must be a template |
| Trash | `.trash/` | – | – | kinds: only `collection`, `environment`, `dataset` (`packages/core/src/storage/trash.ts:15`) |

### 1.3 How items reference each other (the dependency graph a bundle needs)

| From | To | How |
|---|---|---|
| Request | environment / collection / workspace variables | `{{name}}` by **name** (resolved at run time) |
| Request | API definition | `openapi` contract check with `spec: specs/x.json` (**path**); importers add it (`workspace-import.ts:114+`) |
| Request / collection | script packages | `tp.require('name')` |
| Saved gRPC call / connection | collection | `LibraryItem.collectionId` |
| gRPC call | proto files | `protoFiles` names / descriptor set (files under `protos/`) |
| Test file | MCP server | `server: { name: … }` (**by name**, e.g. `examples/public-workspace/tests/mcp/petstore-mcp.yaml`) |
| Test file | dataset | `dataset:` path, or `{ connectionEnv, query }` |
| Test file | API definition | `{ type: openapi, spec: specs/… }` |
| Flow | sub-flow | `type: flow` with a path relative to the file or `tests/` (`packages/core/src/runner/flow-blocks.ts:125`) |
| Flow / test from a request | collection request | a **copy** of the request (`packages/core/src/runner/test-from.ts`); no live link, so no dependency |
| MCP server (mock) | mock file | `mockFile` path |
| Monitor | collection + selection, environment | `library/monitors.json` `data.collectionId`, `selection[]`, `environment` (name) |
| Evaluation | dataset, prompt, provider/model | `library/evaluations.json` `data` |
| Load test | collection / request | `library/load-tests.json` |
| Any item | any item | `ItemRef` links (`@testpion/shared`, `packages/core/src/storage/item-refs.ts:106`) |

Nothing builds this graph today. `item-refs.ts` resolves one reference by id, and `findCommittableSecrets` walks every
kind. The bundle's `dependencies()` functions are new code.

### 1.4 The git approach

The workspace folder **is** the portable unit. `testpion git setup` writes `.gitignore`/`.gitattributes`, tidies
collection files and installs the request-level merge driver (`packages/cli/src/commands/workspace.ts:76-95`). One file per request was
decided against (GIT-303, `planning/git-integration.md:52`). For teams on git, a bundle is for moving a **part** of a
workspace (one collection with what it needs) between workspaces or to someone without the repository.

### 1.5 Gaps found (bugs to fix whatever design is chosen)

1. **G1 (bug).** The workspace bundle leaves out `specs/`, `datasets/`, `mocks/` and `protos/`, and it drops test
   files of 5 MB or more without a note (`workspace.ts:571-579`). A re-imported workspace then loses its contract
   checks, its data-driven tests and its MCP mocks, while the dialog text (`ExportDialogBody.tsx:82`) says
   "Every … saved item and setting".
2. **G2 (secret leak).** `mcpServers` are exported verbatim, so a literal `Authorization` header or a stdio `env`
   token goes into the file (`workspace.ts:593`, compare `git-guard.ts:74-77`). Collection literal tokens go out the
   same way.
3. **G3.** An OpenAPI import overwrites `specs/<slug>.openapi.json` without asking (`workspace-import.ts:108-113`).
4. **G4.** A workspace bundle cannot be merged into the open workspace; it always becomes a new one
   (`handlers/workspace.ts:185-197`).
5. **G5.** The default file name is still `*.apsworkspace.json` (`handlers/workspace.ts:159`). It should be
   `*.testpion-workspace.json` (tp-not-pm / naming).
6. **G6.** The trash cannot restore an MCP server or an API definition. Removing a server needs a confirm dialog
   instead of undo (`Explorer.tsx:559`), and an import has no undo.
7. **G7.** There is no MCP tool and no CLI `workspace import`, which breaks the AI-first rule (every feature has CLI
   `--json`, an MCP tool and llms.txt).

---

## 2. Research: how other API clients do it

| Client | Container | Bundle / format | Secrets | Conflicts and preview | Selective | CLI |
|---|---|---|---|---|---|---|
| **Postman** | Workspace → collections, environments, globals, specs (API Builder); mocks, monitors and flows are cloud objects | Collection v2.1 JSON one at a time; environment and globals separately; "Export data" bulk dump (admin, emailed link, expires in 2 days). Collection schema **3.0** is now multi-file YAML (`*.request.yaml`, `definition.yaml`, `.resources/`), and Newman runs only 2.1 [1][2][3] | local vs shared values, Secure type, Vault [4] | reports differ on "Replace / Import as copy"; Replace broke forks; today a copy is reported [5][6]. No preview except OpenAPI import options | per collection / environment | Postman API GET/PUT `/collections/{id}` (a PUT without item ids replaces every item) [7] |
| **Insomnia** | Project → collections and design documents (spec + requests + env + tests) | v5 YAML (one entity per doc, published JSON Schema), v4 JSON legacy, HAR; scopes: one collection/document, a project, "Export all data"; Git Sync stores v5 files [8] | private sub-environments are not exported; vault-encrypted secrets [9] | not documented | three scopes only | `inso export spec` (spec only) [10] |
| **Bruno** | a collection **is a folder** (`opencollection.yml` / `bruno.json`, `folder.yml`, request files, `environments/`) | copy the folder or use git; Share ▸ Bruno / Postman / OpenAPI [11][12] | secret variables: name only, "not exported"; `.env` + `.env.sample` [13][14] | not documented | per collection | `bru import openapi|wsdl` [15] |
| **Hoppscotch** | Workspace (personal/team) → collections, environments | JSON; import from another workspace; size limits 10 MB cloud / 50 MB self-hosted [16] | secrets never synced [17] | not documented | per collection | none |
| **Thunder Client** | collection / environment; Git Sync folder `thunder-tests` (paid) | TC JSON, Postman, OpenAPI (paid) [18][19] | "Local Environment" keeps secrets out of git [20] | not documented | per collection | runner only |
| **Yaak** | workspace | "Export Data": the chosen workspaces in one JSON; Directory/Git Sync [21] | private-environment option | **"Preview Import" shows the changes before applying**; into a new or existing workspace | per workspace | not confirmed |

What the field teaches:

1. Every client separates secrets from what is shared. Secrets are never exported, and only their **names** travel
   (Bruno). TestPion already does this for environments and must extend it to MCP servers, collections and DB URLs.
2. Versioned, published formats win. Postman (2.1 → 3.0) and Insomnia (v4 → v5 + JSON Schema) both publish theirs, so
   the TestPion bundle must carry `formatVersion` and ship a JSON Schema.
3. Whole-container bundles are rare and coarse. Postman's dump is admin-only and emailed, Insomnia's is a project or
   everything, and Yaak's is per workspace. **Nobody offers "this collection and everything it uses"**, so a
   dependency-aware selection is a real differentiator.
4. Only Yaak previews an import. Conflict behaviour is undocumented almost everywhere, and Postman's Replace famously
   broke forks. TestPion's preview with explicit skip/replace/keep-both per item, plus one-step undo, is the safe
   answer.
5. Postman 3.0 and Bruno moved toward **folders of small YAML files** for git. TestPion already has git-friendly
   files plus a merge driver (GIT-301/303). The bundle is for moving data, not for storing it.

Sources:
[1] https://learning.postman.com/docs/getting-started/importing-and-exporting/exporting-data/
[2] https://learning.postman.com/docs/getting-started/importing-and-exporting/importing-data/
[3] https://learning.postman.com/docs/collections/collections-schemas
[4] https://learning.postman.com/docs/sending-requests/variables/managing-environments/
[5] https://community.postman.com/t/importing-collection-breaks-forks/33007/2
[6] https://community.postman.com/t/can-no-longer-choose-to-overwrite-collections-when-importing-from-a-file/16236
[7] https://learning.postman.com/api-docs/api-reference/collections/put-collection.md
[8] https://developer.konghq.com/insomnia/import-export/
[9] https://developer.konghq.com/insomnia/environments/
[10] https://developer.konghq.com/inso-cli/reference/export_spec/
[11] https://docs.usebruno.com/opencollection-yaml/overview
[12] https://docs.usebruno.com/get-started/import-export-data/export-collections
[13] https://docs.usebruno.com/secrets-management/secret-variables
[14] https://docs.usebruno.com/secrets-management/dotenv-file
[15] https://docs.usebruno.com/bru-cli/import/options
[16] https://docs.hoppscotch.io/documentation/features/importer
[17] https://docs.hoppscotch.io/documentation/features/variables
[18] https://docs.thunderclient.com/features/import
[19] https://docs.thunderclient.com/team
[20] https://docs.thunderclient.com/features/environments
[21] https://yaak.app/docs/collaboration/import-and-export-data

---

## 3. Two designs, evaluated

### (A) The TestPion bundle: one file, any selection, dependency-aware

One file (`.testpion.zip`, or one `.testpion.json` when it is small and holds no binary data) with a `manifest.json`
and one entry per item. Any selection of kinds can go in. Selecting a collection (or a flow) adds what it uses through
the dependency graph (§1.3) and warns about what it uses but leaves out. Import shows a preview and lets the user
resolve each conflict, remaps ids, makes one undo step, and can be repeated without creating duplicates.

| | |
|---|---|
| Fits the owner's words | "export and import **together**": yes, one file with a collection and everything it uses. "Put everything on the main collection": met as **selection** ("Export collection with everything it uses…"), not storage |
| Disk model | unchanged; no migration; merge driver, CLI paths, MCP tools and `ItemRef`s unchanged |
| Shared items | natural: one spec used by three collections is exported once, and re-import dedupes by content hash |
| Cloud | the bundle is the import/export format of the cloud API too (an upload, then preview, then apply), and it is multi-user safe (apply is one transaction) |
| Cost | M–L: registry, bundle writer and reader, preview engine, dialogs |
| Risk | low; additive |

### (B) Nesting: the collection becomes the container

MCP servers, API definitions, datasets (and tests, flows, monitors, environments) belong to a collection. On disk,
`collections/<id>.json` grows sections, or collections become folders like Bruno: `collections/<name>/collection.json`,
`specs/`, `datasets/`, `mcp-servers.json`, `tests/`.

| Area | Effect |
|---|---|
| On disk | a second layout, which is exactly what GIT-303 declined (2026-10-02: "migration risk for little gain"). Every reader of `specs/`, `datasets/`, `mcp-servers.json` and `tests/` needs to look in N places (`listSpecs`, `readSpecRef`, `safePath` callers, dataset listing, `resolveMcpServer`, test discovery, suites) |
| Migration | must be non-destructive and reversible: move files into collection folders, keep the old paths readable, and keep a converter both ways. Git sees mass renames. Branches made before the migration conflict with every moved file, and the semantic merge driver must learn the new paths |
| Shared items | the main problem. `specs/petstore.json` used by two collections and three flows: who owns it? Choices: (a) copy into each owner, which duplicates and drifts; (b) keep "shared" at workspace level, so the global sections remain anyway; (c) owner plus references, which is design A with extra steps |
| References | `spec: specs/x.json` in tests and contract checks, `dataset:` paths, `server: {name}`: every path changes or gains a collection prefix. `testFromRequest` copies stay as they are, monitors (`collectionId`) are unaffected, sub-flow relative paths may break when files move |
| CLI / MCP | `--collection` becomes necessary to disambiguate same-named servers and specs, and every tool that takes a path (`import_definition`, dataset tools, `run --data datasets/…`) needs a collection scope. Both surfaces would break |
| UI | the collection tree shows sub-sections (MCP servers, API definitions, Datasets, Tests); the global sections stay as "Shared". Two places for the same kind is the opposite of [uniform UI](menus-uniform.md) |
| Cloud | ownership would make per-collection permissions possible (a plus), but the same can be modelled as tags/labels or "workspace inside workspace" in the cloud schema without changing local files |
| Cost | XL plus a migration; touches most of `packages/core/src/storage`, the runner's path resolution, git tooling, and roughly 30 RPCs/tools |

### Recommendation

1. **Now (release A):** per-kind **Export… and Import… in every section header and item menu**, through the shared
   `buildNodeMenu` registry from [menus-uniform.md](menus-uniform.md). That plan already reserves "Export…" in the
   `share` group and "Import config" on `mcp-section`; this plan adds `exportable` and `importable` capabilities. Fix
   G1–G6 at the same time.
2. **The TestPion bundle** is the "everything together" mechanism, with a collection-centred entry point: **"Export
   collection with everything it uses…"** on every collection menu, and **File ▸ Export ▸ Bundle…** for any selection.
3. **Nesting (B) is optional and later (release C),** and only if the owner wants *ownership* (deleting a collection
   deletes its specs and datasets; per-collection permissions in the cloud). If so, the cheapest form is
   **association, not storage**: a `collection.uses` list (ids/paths of specs, datasets, MCP servers and flows) saved
   in the collection file. The collection tree can then show "Uses: 2 API definitions, 1 dataset, 1 MCP server" as
   virtual sub-sections, and files do not move. That gives 90% of "everything on the main collection" for an S–M cost,
   with no migration. Real nesting on disk is not recommended.

---

## 4. The plan

### 4.1 Bundle format v1

**Container.**

- A **zip** (`<name>.testpion.zip`, media type `application/vnd.testpion.bundle+zip`). It is used whenever there are
  binary files (SQLite datasets, protos), more than 5 MB, or more than 200 entries.
- Otherwise a **single JSON** (`<name>.testpion.json`) with the same manifest and entries inlined (`content` as a
  string; base64 only if forced). Small bundles stay pasteable, readable by agents and diffable.
- Both forms are read by one reader.

**Zip layout.**

```
manifest.json                      the index (below), written first
collections/<id>.json              collection files exactly as on disk (collectionFileContent)
environments/<id>.json             secret values blanked; secret names listed in the manifest
library/<kind>/<id>.json           one LibraryItem per file (grpc, websocket, ai-prompts, load-tests, evaluations, monitors, mcp)
mcp-servers/<id>.json              one McpServerConfig per file, secrets replaced by {{variables}}
files/specs/…                      API definitions, with workspace-relative paths kept
files/datasets/…                   data files (or omitted: "reference" mode)
files/mocks/…                      MCP mock / toolset files
files/protos/…                     proto files used by included gRPC calls
files/tests/…                      test, flow and suite files
packages/<name>.js                 script packages used by included scripts
README.md                          a human summary (generated; never read on import)
```

**`manifest.json` (schema `packages/core/schemas/bundle-v1.schema.json`, also published in the docs).**

```jsonc
{
  "format": "testpion-bundle",
  "formatVersion": 1,                     // integer; readers refuse a higher major and warn on unknown fields
  "createdBy": { "app": "testpion", "version": "0.49.0" },
  "createdAt": "2026-10-17T12:00:00Z",
  "title": "Clinic API (with everything it uses)",
  "root": [{ "kind": "collection", "id": "clinic" }],   // what the user picked; the rest came in as dependencies
  "items": [
    {
      "kind": "collection", "id": "clinic", "name": "Clinic API",
      "entry": "collections/clinic.json", "sha256": "…", "size": 48211,
      "summary": { "requests": 42, "folders": 6, "scripts": 9 }
    },
    { "kind": "spec", "id": "specs/clinic.yaml", "entry": "files/specs/clinic.yaml", "sha256": "…", "size": 30110 },
    { "kind": "dataset", "id": "datasets/patients.csv", "mode": "embed", "entry": "files/datasets/patients.csv", "sha256": "…", "size": 1200443, "summary": { "rows": 10000, "columns": 8 } },
    { "kind": "dataset", "id": "pg-orders", "mode": "reference", "summary": { "db": "postgres", "connectionEnv": "DATABASE_URL", "query": "SELECT …" } },
    { "kind": "mcp-server", "id": "petstore-mcp", "name": "Petstore MCP", "entry": "mcp-servers/petstore-mcp.json", "sha256": "…" }
  ],
  "edges": [                               // the dependency graph: from uses to
    { "from": "collection:clinic", "to": "spec:specs/clinic.yaml", "via": "openapi check, 42 requests" },
    { "from": "test:tests/flows/admit.yaml", "to": "dataset:datasets/patients.csv", "via": "dataset:" }
  ],
  "missing": [                             // used but not included (the importer warns; nothing breaks silently)
    { "from": "test:tests/mcp/x.yaml", "to": "mcp-server:name=Weather", "reason": "left out by the user" }
  ],
  "requires": {                            // what the importing user has to fill in
    "variables": ["baseUrl", "patientId"],
    "secrets": [{ "name": "token", "where": "environment Staging" }, { "name": "PETSTORE_MCP_AUTHORIZATION", "where": "MCP server Petstore MCP, header Authorization" }],
    "osEnv": ["DATABASE_URL"],
    "scriptPackages": ["@clinic/utils"]
  },
  "flags": { "scripts": 9, "production": ["Production"], "strippedSecrets": 3 }
}
```

- `sha256` per entry plus the manifest's own list form an integrity check. A mismatch is a hard error.
- `id` is the item's identity in the source workspace: collection, environment, library item and server ids, and
  workspace-relative paths for file kinds. Ids are never trusted as paths; see §4.6.
- The old `testpion-workspace` bundle stays readable forever (and `aps-`/`fluxpion-`/`protopion-`/`protolens-`
  variants). The importer converts it into an in-memory bundle v1, so it gains preview and merge.

**Postman compatibility (Export ▸ Postman).** Postman v2.1 has no place for MCP servers, specs or datasets, so they
travel beside the collection, and the export reports what is lost (`notes`, as now):

- **Collection:** a v2.1 JSON as today. Collection `description` gets a generated "Uses" section listing the specs,
  datasets and MCP servers by name (docs only).
- **API definitions:** written next to it as `<name>.openapi.yaml` (zip mode: `specs/`). Postman imports these as
  APIs.
- **Environments:** Postman environment JSON per environment (secret values blank; `type: secret` kept).
- **Datasets:** CSV/JSON copied as they are (Postman's runner takes CSV/JSON iteration data). JSONL is converted to a
  JSON array, and SQLite/DB is listed as **lost**.
- **MCP servers:** Postman has MCP requests, but the collection format for them is not public/stable (unconfirmed), so
  they are **lost**. They are listed in notes, and the config is written as a `.mcp.json` file beside the collection
  that Claude/VS Code/Cursor can read.
- **Flows, monitors, evaluations, load tests:** lost (listed). Flows can additionally be written as Arazzo files
  (existing `export_arazzo`).
- **Packaging:** a zip named `<name>.postman.zip` holding these files and a README.

**Bruno folder export of a whole collection, with extras.** `collectionToBru` already writes requests and
`environments/` (`data.ts:543-556`). Add:

- `specs/` and `datasets/` (CSV) copied into the folder; Bruno ignores unknown files, and the docs mention them in
  `collection.bru` `docs`.
- Secret variables written as `vars:secret [name]` (names only).
- MCP servers as `.mcp.json` beside it.
- Tests and flows are lost, and the notes say so.

### 4.2 Architecture in `packages/core`

New modules (each small and pure where possible; no Electron, so the cloud server runs the same code):

| Module | Role |
|---|---|
| `bundle/kinds.ts` | the **`BUNDLE_KINDS` registry**: `register(kind: BundleKind)` |
| `bundle/kinds/*.ts` | one file per kind: `collection`, `environment`, `spec`, `dataset`, `mcp-server`, `mcp-mock`, `test` (tests, flows, suites), `library` (one generic adapter for every `library/<kind>.json`, parameterised by kind), `proto`, `script-package`, `provider` (opt-in; keys are refs anyway) |
| `bundle/graph.ts` | builds the dependency graph from `dependencies()` and computes the closure of a selection, the `missing` edges and cycles (sub-flows) |
| `bundle/write.ts` | streams a bundle: zip (yazl or Node `zlib` deflate raw via a small writer; pick a dependency already in the tree if there is one) or JSON |
| `bundle/read.ts` | validates (schema, limits, checksums, paths) and yields entries lazily |
| `bundle/plan.ts` | the **import preview**: for each item, an action (`create`, `identical`, `conflict`) plus the proposed id/path and the references that will be rewritten |
| `bundle/apply.ts` | applies a plan with the user's choices in one batch, records an undo journal, and emits `data.changed` once |
| `bundle/secrets.ts` | the strip-and-report pass (shared with `git-guard.ts`: one detector, `sensitive(k) && !hasVariable(v)`) |
| `bundle/legacy.ts` | the `testpion-workspace` bundle (and older names) → bundle v1 |

The kind contract:

```ts
interface BundleKind<T = unknown> {
  kind: string;                         // 'collection', 'spec', 'library:monitors' …
  label: string;                        // 'API definition'
  list(store): ItemSummary[];           // what can be picked (id, name, size, folder)
  describe(store, id): ItemSummary;     // name, size, counts for the tree and the preview
  dependencies(store, id): Edge[];      // what it uses (by id or path, with "via")
  exportItems(store, ids, ctx): AsyncIterable<BundleEntry>;  // content with secrets stripped (ctx.report collects requires/flags)
  identity(entry): { id: string; name: string; hash: string };   // for conflict detection and idempotent re-import
  importItems(store, entries, decisions, remap): Promise<Applied[]>;  // writes; returns undo records
  rewriteRefs?(entry, remap): BundleEntry; // rewrite references to remapped ids/paths
}
```

A new kind gets the export tree, the dependency closure, the preview, conflicts, undo, CLI and MCP **for free** by
registering, the same way `NODE_KINDS` gives a kind its menu. The UI reads `BUNDLE_KINDS` through RPC
(`bundle.kinds`).

`WorkspaceStore.exportBundle()` stays as a thin wrapper. It becomes "select everything", and the old JSON shape is
kept only behind `--legacy`, which fixes G1.

### 4.3 Import preview and conflict engine

**Identity.** An incoming item matches an existing one by:

1. same kind **and** same id;
2. for file kinds, same path;
3. for collections and servers, same name (a "name clash").

The item is **identical** when the content hash matches, after normalisation: `collectionFileContent`, sorted keys,
and secrets blanked on both sides. Identical items are skipped, so **re-importing the same bundle is a no-op**
(idempotent).

**Choices per conflict** (with a default for all and an override per row):

| Choice | Effect |
|---|---|
| **Skip** | keep mine; references in the bundle are rewritten to mine (same id/path) |
| **Replace** | overwrite mine; the old version goes to Recently deleted (trash) for 30 days |
| **Keep both** (default) | the incoming item gets a new id (`<slug>-<4>`) and name (`X (imported)`, `X (imported 2)`), or a path suffix (`-2`), as the importers do today (`workspace-import.ts:139-157`, `:44-52`) |
| **Merge** (collections and folders only) | node-level merge using the same three-way logic as the git merge driver (GIT-301), with the bundle as "theirs" and no base. New requests are added, changed requests follow the row's Replace/Keep choice, and nothing is deleted |

**Id remapping.** `apply` builds `remap: Map<"kind:id", newId>` before writing anything, then calls `rewriteRefs` on
every entry:

- `LibraryItem.collectionId`;
- monitor `collectionId`/`selection`;
- `spec:` paths in contract checks and tests;
- `dataset:` paths;
- `server: { name }` (rewritten to the new name when the server was renamed);
- `mockFile`;
- sub-flow paths;
- `ItemRef`s in descriptions/notes.

Node ids inside an incoming collection that collide with **another** collection get fresh ids, which is the
importers.ts:475 fix from menus-uniform P0-1.

**Preview table (core result, shared by UI, CLI and MCP).**

```jsonc
{ "items": [ { "kind": "spec", "id": "specs/clinic.yaml", "action": "conflict", "existing": { "id": "specs/clinic.yaml", "modified": "…" }, "diff": { "added": 3, "removed": 1, "changed": 4 }, "default": "keep-both", "proposed": { "id": "specs/clinic-2.yaml" }, "refsRewritten": 42 } ],
  "requires": { … },   // from the manifest, minus what this workspace already has (variables defined, secrets set)
  "warnings": [ "9 scripts will run when you send requests (they never run on import)", "Environment 'Production' is marked production" ],
  "totals": { "create": 31, "identical": 4, "conflict": 3, "skipped": 0, "bytes": 1300000 } }
```

**Undo.**

- `apply` writes an **import journal** (`.local/imports/<importId>.json`): the created paths/ids plus, for replaced
  items, trash ids.
- "Undo import" (toast action, and the History ▸ Imports list) deletes the created items and restores the replaced
  ones from the trash, as **one** step.
- The trash gains the kinds `spec`, `mcp-server`, `library-item`, `test`, `mock` and `proto` (fixes G6).

**Atomicity.**

- Entries are written to a staging folder in `.local/imports/<id>/` first. Each file is then `atomicWrite`n into place.
  `mcp-servers.json` and `library/*.json` are written once each, with all of their items.
- A failure part-way runs the journal backwards.
- The file watcher is paused for the batch, and one `data.changed` is emitted afterwards (no 9,000 events).

### 4.4 Secrets policy

1. **An export never contains a secret value.** One detector, shared with `git check`
   (`findCommittableSecrets`/`sensitive()`), runs over every entry:
   - environment `secret: true` values are blanked (as today);
   - collection headers/auth/body fields, MCP `headers` and stdio `env`, gRPC metadata and library `data` with a
     literal sensitive value are **replaced by a `{{variable}}`** (name from `variableNameFor`), and the name is added
     to `requires.secrets`;
   - DB URLs with a password (`postgres://u:p@h/db`) become `connectionEnv: DATABASE_URL` + `requires.osEnv` (the
     redaction logic of `redactDbUrl`, `db-datasets.ts:35`);
   - provider keys are already refs.
2. **The export dialog shows what was stripped** ("3 secrets replaced by variables: …") **before** writing. The CLI
   prints the same list (and `--json` returns it).
3. **Import lists what to fill in.** `requires.variables`/`secrets`/`osEnv` minus what the workspace already defines.
   After apply, a "Set up" panel offers to fill each secret into the secret store (never the file). This reuses
   `secretsToSet` from `WorkspaceImportResult`.
4. `--include-current-values` exists only for **non-secret** current values. There is **no option** to include
   secrets; bundles are for sharing.
5. **The production flag travels.** Production environments are listed in `flags.production` and shown in the preview,
   and imported environments keep the flag.

### 4.5 Size, streaming and big datasets

- **Dataset modes** per item: `embed` (the file in the zip) or `reference` (only path, size, sha256, columns and the
  first 20 rows as a sample). The importer creates a placeholder that warns "data not included: copy
  `datasets/x.csv`".
  - The default is embed when 10 MB or less, otherwise ask, with reference preselected. The 10 MB threshold is
    configurable.
  - DB datasets are always references (query plus `connectionEnv`).
- **Streaming.** The writer streams entries (no whole-bundle string in memory; today `JSON.stringify(bundle)` holds
  everything). The reader streams zip entries and validates each one as it is read.
- **Compression.** Deflate for text and stored for already-compressed data. JSON mode is used only when the total is
  5 MB or less.
- **Performance budget** (quality bar):
  - export of the `perf-large-workspace` fixture (9,000 requests) in **2 s or less** (as a zip);
  - preview of it in **1.5 s or less**;
  - apply in **3 s or less**.
  - The export tree stays virtualised. Graph building uses the existing per-file indexes (`item-refs.ts`) and a single
    parse per file. Add these numbers to `_soak` / the perf plan.

### 4.6 Safety (a bundle is untrusted input)

- **Paths.**
  - Every entry name and every `id` used as a path goes through `store.safePath(rel, base)` for the kind's root
    folder: `files/specs/` can only land under `specs/`.
  - Refuse `..`, absolute paths, drive letters, UNC, NUL bytes, symlinks/hardlinks in the zip, and duplicate names
    that differ only in case (Windows).
  - Never extract to a path the manifest doesn't list.
- **Zip bombs.**
  - Hard limits: 2 GB total uncompressed, 512 MB per entry, 20,000 entries.
  - A compression ratio above 100:1 on an entry larger than 1 MB is refused.
  - Uncompressed bytes are counted while inflating; the declared size is not trusted.
  - All limits are configurable for the CLI (`--max-size`).
- **Validation.**
  - The manifest is validated against the JSON Schema. Each entry is validated against its kind's schema (collection
    schema, `McpServerConfig`, `LibraryItem`), plus `sha256`.
  - An unknown kind is skipped with a warning, so a newer bundle still imports what this version understands.
  - A higher major `formatVersion` is refused with "update TestPion".
- **Nothing runs on import.**
  - Scripts are never evaluated. `packages/*.js` are written but not loaded.
  - MCP stdio servers are **never started**, and the preview flags `command` (e.g. "starts `npx …` when you connect").
  - Mocks are not started, and no URL in the bundle is fetched.
  - The preview lists scripts and stdio commands under **Review before you run** (the same idea as Postman's
    "scripts" warning). The workspace **trust** state (`packages/core/src/storage/trust.ts`) is set to *untrusted*
    for imported collections when trust is used.
- **YAML.** Parse with the lazy safe YAML loader (no custom tags).
- **Fuzz tests** run with malicious fixtures (§4.10).

### 4.7 RPC, CLI and MCP surface

**RPC** (window → backend; the same handlers serve the cloud host):

- `bundle.kinds()`
- `bundle.tree({ roots? })`: the selectable items with sizes, plus the dependency closure for given roots.
- `bundle.export({ selection, options })`, returning `{ path | download, stripped, requires, missing }`.
- `bundle.preview({ file | text | uploadId })`, returning the preview (§4.3) and a `planId`.
- `bundle.apply({ planId, decisions })`, returning `{ importId, created, replaced, skipped, requires }`.
- `bundle.undo({ importId })`.

Per-kind convenience calls are thin wrappers over a selection: `mcp.export`, `spec.export`, `dataset.export` (single
kind, native format when there is one; see §4.8).

**CLI** (`packages/cli/src/commands/bundle.ts`; all with `--json`, exit codes per the contract):

```
testpion export <collection> --with mcp,specs,datasets,tests,env,library [--env <name>…] [--datasets embed|reference] --out clinic.testpion.zip
testpion export --all --out ws.testpion.zip                 # the whole workspace (replaces `workspace export`; that stays as an alias)
testpion export --kind mcp-server [--id <id>…] --format testpion|mcp-json --out servers.json
testpion export --kind spec --id specs/clinic.yaml --out clinic.yaml   # the file as it is
testpion import <file> --preview [--json]                   # no changes; prints the preview table
testpion import <file> --apply --on-conflict skip|replace|keep-both|merge [--decisions decisions.json] [--json]
testpion import --undo <importId>
testpion bundle inspect <file> [--json]                      # manifest, requires, flags, checks (no workspace needed)
```

- `testpion import` without a flag keeps today's behaviour for foreign formats (Postman, OpenAPI …). For a bundle it
  defaults to `--preview` when stdout is a TTY, and it refuses without `--apply` in `--json` mode, so agents must
  choose.
- Add `testpion workspace import <file> [--name]` (new workspace) for parity with `workspace export`.

**MCP tools** (registered through `tool-contract.ts`, with docs in `tool-docs.ts` and llms.txt; this agent must not
edit `docs/public/llms.txt`, so it is a doc task for the release):

- `export_bundle { roots, with, datasets, out? }`, returning the manifest summary plus a path (or base64 for small
  bundles in cloud/remote mode).
- `import_bundle_preview { path | text }`, returning the preview and a `planId`. It is read-only.
- `import_bundle_apply { planId, decisions, onConflict }`. It is the only write and is marked destructive in the
  contract, so agents ask the user first.
- `undo_import { importId }`.
- `describe_bundle { path }`, an AI-friendly summary (see §4.9).

### 4.8 UI

**Menus** (through `lib/node-menu.ts` `NODE_KINDS` from [menus-uniform.md](menus-uniform.md); add capabilities
`exportable` (share group: **Export…**) and `importable` (create group on containers: **Import…**)):

| Node | Export… | Import… |
|---|---|---|
| Collection | Export… (existing formats) **and "Export with everything it uses…"** (bundle, collection as root) | Import into this collection… (requests from a file; merge) |
| Collection folder | Export folder… (bundle with the folder selection) | Import here… |
| `mcp-section` header | Export MCP servers… (all; formats: TestPion bundle, `.mcp.json` / `claude_desktop_config.json` / `.vscode/mcp.json`) | **Import MCP servers…** (bundle, or those config files: stdio `command/args/env`, `url`, `headers`; secrets become variables) |
| `mcp-folder` / `mcp-server` | Export… (bundle with mock file; or Copy MCP config) | – |
| `spec-section` header | Export API definitions… (zip of `specs/` or bundle) | Import an OpenAPI document (existing) **+ Import bundle…** |
| `spec` | Export… (the file as it is, or as a bundle with the collections and tests that use it) | – |
| `dataset-section` header | Export datasets… (zip / bundle; embed or reference) | **Import data file…** (CSV, JSON, JSONL, md, SQLite → `datasets/`, preview of rows; clash → keep both / replace) |
| `dataset` | Export… (the file; or CSV ⇄ JSONL conversion) | – |
| Library sections (prompts, load tests, evaluations, monitors, toolsets) and items | Export… (bundle; dependencies: an evaluation pulls its dataset and prompt, a monitor its collection) | Import… (bundle filtered to this kind) |
| Test file / folder | Export… (bundle with datasets, specs, sub-flows, MCP servers) + Export as Arazzo… (existing) | Import… (bundle / Arazzo) |
| Environment | Export ▸ Postman / .env / bundle (existing + bundle) | Import… (existing) |
| Workspace (WorkspaceMenu) | Export… → bundle with "everything" preselected | Import… → preview, with **"into this workspace" or "as a new workspace"** (fixes G4) |

**ExportDialog (one shared component; uniform UI).** It replaces today's `ExportDialogBody` format list as its
"Format" step.

- **Left:** a tree of every kind (`bundle.tree`) with checkboxes.
  - Picking a root ticks its dependencies in a second state, "included because X uses it". Hovering explains, and
    unticking one moves it to the **Missing** list with a warning.
  - Each dataset has an embed/reference switch.
- **Right:** a summary of size, item counts, **secrets that will be replaced** (names), scripts, production flags and
  missing items.
- **Format:** TestPion bundle (default) · Postman (zip) · Bruno folder · OpenAPI (collection only) · `.http` ·
  AsyncAPI. The extras each format loses are listed live.
- The dialog opens preselected from the menu it came from.

**ImportDialog.** Opened by Import…, drag-and-drop of a `.testpion.zip/json` onto the window, File ▸ Import, Home
"Import", or `testpion://import?file=` (desktop only).

1. **Summary:** a title, "made by TestPion 0.49 on …", counts, **Review before you run** (scripts, stdio commands)
   and the AI summary (optional).
2. **Preview table:** kind, name, action (Create / Identical / Conflict), a choice per row (Skip / Replace / Keep both
   / Merge) with "apply to all of this kind", a diff link (the semantic diff from the git view for collections, text
   diff for specs) and "refs rewritten: N".
3. **Requires:** variables and secrets to set (inline secret inputs that go to the secret store), OS env vars and
   missing items.
4. **Apply.** A toast offers "Imported 31 items · Undo · Open". The collection or flow chosen as root opens.

Foreign formats (Postman, Insomnia …) go through the same preview: their importers produce an in-memory bundle, which
gives one import UI for everything.

**File menu:** File ▸ Export ▸ (Collection…, Collection with everything it uses…, Environment…, Bundle…, Workspace…)
and File ▸ Import… (one entry; detects the format). The command palette gets the same items.

### 4.9 AI angle (AI-first)

- `describe_bundle` / "Summarise before import":
  - a deterministic summary (no model needed): what is inside, what it needs, what it will run, risky items
    (production environments, stdio commands, scripts using `tp.sendRequest` to unknown hosts);
  - plus an optional AI paragraph (provider via `ai-settings`, cheap tier), shown in the ImportDialog.
- After importing a Postman/Insomnia bundle, offer **AI-10 Import cleanup** (`planning/ai-features.md:346`): variables,
  chaining and tidy.
- **Agents.** The preview → apply split with a `planId` makes import safe for agents (review, then a single
  destructive call). `testpion import --preview --json` gives the same.
- **Human review.** Every AI-proposed decision (e.g. "keep both for these 3 conflicts") is shown in the preview, never
  applied silently.

### 4.10 Tests

- **Unit (core, vitest):**
  - each `BundleKind`: round trip (`export → import into an empty workspace → export` gives identical normalised
    content), **property-based** with fast-check on random collections/environments/library items/servers;
  - dependency closure (cycles in sub-flows, shared specs counted once, missing edges);
  - remap: every reference type in §1.3 is rewritten; nothing dangles (run `resolveItemRef` over all refs after
    import);
  - idempotence: the second import is all `identical` and writes no file (mtime unchanged);
  - conflict matrix: skip / replace / keep-both / merge × each kind;
  - undo: restores the byte-identical prior state, including replaced items from the trash.
- **Secrets:** fixtures with literal tokens in a header, auth, MCP `headers`, stdio `env`, gRPC metadata and a DB URL.
  The bundle must contain **no** fixture secret (a grep over the zip) and `requires` must list each one.
- **Malicious fixtures** (`tests/fixtures/bundles/evil/`): zip-slip (`../../x`, `C:\x`, `\\host\x`), symlink entries,
  a case-clash, a 1 GB bomb at 1000:1, 50k entries, a wrong sha256, a manifest > schema, an unknown kind, a higher
  `formatVersion`, YAML tags, a stdio server `command: rm`. Each must be refused or flagged, and nothing may be written
  outside the workspace.
- **Legacy:** old `testpion-workspace` / `protolens-workspace` exports from `examples/` import through the new path.
- **Postman round trip:** export with extras → import into Postman format reader → the collection is unchanged (as
  today) and the notes list the lost kinds; Bruno folder with extras → `readBrunoFolder` → same requests.
- **CLI** (integration): `export --with …`, `import --preview --json` (schema-validated output), `--apply
  --on-conflict`, `--undo`, exit codes.
- **MCP:** `import_bundle_apply` requires a `planId` from a preview; contract docs present.
- **E2E (one plan, real input, run only in the regression before release, per the memory rules):**
  - `export-import-bundle`: right-click a collection ▸ Export with everything it uses ▸ check that the tree shows the
    spec, dataset and MCP server ▸ save.
  - Then a new workspace ▸ drag the file onto the window ▸ preview shows 0 conflicts ▸ Apply ▸ the sidebar shows the
    collection, API definition, dataset and server.
  - Re-import ▸ all Identical.
  - Change one request ▸ import ▸ Conflict ▸ Keep both ▸ Undo.
  - Plus section-header Export/Import for MCP (`.mcp.json`), datasets (CSV) and specs, with screenshots for the docs.
- **Perf:** the `perf-large-workspace` export/preview/apply budgets of §4.5 in the soak/perf plan.

### 4.11 Docs

- A new page `docs/api-testing/export-import.md` ("Move work between workspaces"): bundle, choices, secrets, undo, CLI
  and MCP.
- Update:
  - `collections.md` (Export), `environments.md`;
  - `ai-testing/mcp-server.md` (tools);
  - `cli/reference.md`;
  - `features.md`, `whats-new.md`;
  - the bundle JSON Schema published under `docs/public/schemas/`;
  - llms.txt by the release step (not by this research agent).
- Screenshots: the ExportDialog tree, the ImportDialog preview, and the MCP section menu with Import.

### 4.12 Migration notes

- **No data migration** for A. Old workspace bundles keep importing, and `ws.export` writes bundle v1. `testpion
  workspace export` writes v1 by default, with `--legacy` for the old JSON for one or two releases.
- The default file name changes from `.apsworkspace.json` to `.testpion.zip` / `.testpion.json` (G5).
- Optional C ("uses" association) adds an optional `uses` key to collection files. It sorts after the known keys
  (`COLLECTION_KEY_ORDER`, `workspace.ts:879`), older versions ignore unknown keys, and the merge driver treats it as a
  set (union on merge).

---

## 5. Phased roadmap

| Release | Content | Effort |
|---|---|---|
| **A (next)** | **Fixes:** G1 (bundle includes `specs/`, `datasets/`, `mocks/`, `protos/`; notes for skipped files), G2 (strip MCP/collection secrets on export), G3 (spec import asks or keeps both), G5 (file name), trash kinds for spec/mcp-server (G6). **Per-kind Export… and Import… in every section header and item menu** via `NODE_KINDS` (`exportable`/`importable`): MCP servers (bundle + `.mcp.json`/Claude/VS Code config import and export), API definitions (file/zip export, bundle import), datasets (file import with preview, export file/zip), library kinds. **Bundle v1:** registry with the core kinds, writer/reader (zip + JSON), schema, safety limits, legacy reader. The import gets a simple preview (create / identical / conflict with a global choice of skip / keep both) and one-step undo. CLI `export --with` / `import --preview/--apply`, `workspace import`. | L (≈ 5–7 days) |
| **B** | **Dependency-aware ExportDialog** ("Export collection with everything it uses…", the missing-items list, dataset embed/reference). **Full preview/conflict engine** (per-row choices, Replace via trash, Merge for collections through the merge-driver logic, diff links, refs-rewritten counts), "Requires" setup panel, drag-and-drop, File menu, Home Import. Foreign formats through the same preview. **MCP tools** `export_bundle` / `import_bundle_preview` / `import_bundle_apply` / `undo_import` / `describe_bundle`; Postman zip and Bruno folder with extras; the AI summary; perf budgets; e2e plan; docs. | L (≈ 5–7 days) |
| **C (optional, owner decides)** | **Collection "uses" association**: a `uses` list on the collection, virtual "Uses" sub-sections in the collection tree, "Add to collection ▸" on specs/datasets/servers, and export defaults from `uses`. **Real nesting on disk is not recommended** (§3). If ownership semantics are wanted in the cloud, model them in the cloud schema (CLD) instead of the local layout. | M (≈ 3 days); real nesting XL + migration |

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| Secret leakage through a field the detector doesn't know | one shared detector with `git check`; deny-by-default for MCP `headers`/`env` (every value becomes a variable unless it is clearly non-secret, e.g. `Content-Type`); a test grep over every fixture bundle; the export dialog shows the stripped list |
| Remap misses a reference type, leaving a dangling link after import | a post-apply check: `resolveItemRef` / path existence over all rewritten refs, and the preview lists unresolved ones; property tests |
| Merge of collections diverges from the git merge driver | reuse the same function; one test suite for both |
| Large datasets bloat bundles or memory | streaming writer and reader, the reference mode, limits and progress |
| Malicious bundles (zip-slip, bombs, stdio commands) | §4.6; nothing executes on import; fuzz fixtures |
| Two export UIs drift (per-kind vs bundle) | per-kind export is a bundle selection plus a format; one ExportDialog |
| Menus plan not landed yet | release A depends on `lib/node-menu.ts` phase 1 of menus-uniform; if it slips, add the items to the existing `Section` `menu` props (`Explorer.tsx:789,811,835`) and migrate later |
| Users expect "replace" like Postman and lose work | the default is Keep both; Replace goes to the trash; one-step undo |
| Cloud: concurrent edits during apply | apply is one transaction on the server (optimistic version check per item; on a conflict, re-preview) |

---

## 7. Open questions for the owner

1. **Ownership or selection?** Is "everything on the main collection" about **exporting together** (bundle,
   recommended) or about **ownership** (deleting a collection deletes its specs and datasets; per-collection
   permissions)? Only the second needs release C.
2. **Default dataset mode:** embed up to 10 MB, otherwise reference: OK?
3. **Default conflict choice:** Keep both (safe), or Skip-identical / Replace-changed (sync-like)?
4. **MCP stdio servers in a bundle:** import them disabled until the user reviews the command (safer), or as they are
   with a warning?
5. **Providers in bundles:** include them by default (keys are refs) or opt-in only?
6. **Postman export of extras:** a zip with the specs, datasets and `.mcp.json` beside the collection, or the
   collection JSON only plus notes (today)?
7. **File extension:** `.testpion.zip` + `.testpion.json`, or one custom extension (`.tpbundle`) registered with the
   installer for double-click import?
8. **The legacy `workspace export` JSON:** keep `--legacy` for how many releases?

---

### Appendix: references in this repo

- [menus-uniform.md](menus-uniform.md): the `NODE_KINDS` registry and `share` group (Export…), `mcp-section` "Import
  config"; P0-1 node-id collision fix on import.
- [git-integration.md](git-integration.md): GIT-301 merge driver, GIT-303 (declined), the semantic diff.
- [ai-features.md](ai-features.md): AI-10 Import cleanup.
- [cloud-platform.md](cloud-platform.md): multi-user and data export (CLD).
