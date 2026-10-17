# Everything under Git

Owner request (2026-10-17): "All items should be under Git. Do research and provide a solution." Trigger: sections
(MCP servers, API definitions, datasets) whose items lack the utility menus, export / import and change marks that
collections have. The goal is that **every kind of workspace item is versioned, reviewable and restorable through Git
exactly like a collection request** — in the app, the CLI and the MCP server.

Status: research + design. No code changed. Line numbers are as of v0.48.1 + the uncommitted tree on 2026-10-17.
Related plans: `planning/git-integration.md` (GIT-101…GIT-403, all done except GIT-303), `planning/menus-uniform.md`
(`NODE_KINDS` UI registry), `planning/export-import.md` (`BUNDLE_KINDS`). §4a merges all three into **one** core kind registry with facets.

---

## 1. Inventory: every kind of workspace content

Layout comment: `packages/core/src/storage/workspace.ts:84-88`. Generated git files: `packages/core/src/storage/git-files.ts:8-33`.

Legend for columns: **Ser** = written by a stable serializer (fixed key order, no volatile fields, GIT-101). **Ign/Attr** =
what the generated `.gitignore` / `.gitattributes` say. **Watch** = `changeKind()` in
`packages/core/src/storage/workspace-watcher.ts:23-35` (drives `data.changed` kinds for outside *and* own writes,
`apps/desktop/backend/own-writes.ts:12-15`).

| # | Kind | Where on disk | Ser | Ign / Attr | Watch kind | Notes |
|---|---|---|---|---|---|---|
| 1 | Collection (+ folders, HTTP/GraphQL/SOAP requests, examples, scripts, auth) | `collections/<slug>.json` | **Yes**: `collectionFileContent` fixed key order, `version`/`updatedAt` moved to `.local/meta.json` (`workspace.ts:878-891`, `:318-320`) | tracked; `merge=testpion` (`git-files.ts:30`) | collections | the reference implementation |
| 2 | Environment | `environments/<slug>.json` | **Partial**: secret values stripped (`workspace.ts:391`), but key order is whatever the editor object had (`writeJson(…, clean)` `:404`); `order` rewritten for every env on reorder (`:375-377`) | tracked; `merge=testpion` (`:31`) | environments | |
| 3 | Workspace settings + workspace variables | `workspace.json` | **Partial**: `updatedAt` kept stable on edit (`workspace.ts:172-175`), but `createdAt`/`updatedAt` still in the file; migrations write a `.bak-*` next to it (`:135`) which is **not ignored** | tracked; no merge driver | workspace | `.bak-*` files show up as untracked noise |
| 4 | Test files and flows (incl. `layout:`) | `tests/**/*.yaml` | **Partial**: written as text by the editor / `yaml.stringify(v,{lineWidth:0})` (`apps/desktop/src/lib/yaml.ts:4`); key order = object order; designer state (breakpoints, pins) kept out in `.local/flows` (`runner/flow-history.ts:272`) | tracked; line merge only | tests | flow semantic diff exists (`git/flow-diff.ts`, "rearranged" for `layout:` `:191`) |
| 5 | Library kinds: `grpc`, `websocket`, `ai-prompts`, `load-tests`, `evaluations`, `monitors` (labels `packages/shared/src/item-ref.ts:112-119`), plus folder-only libraries `mcp-folders`, `spec-folders` (`apps/desktop/src/components/Explorer.tsx:311-312`) | `library/<kind>.json` (`workspace.ts:447-464`) | **No**: each item carries a volatile `updatedAt` written on every save (`apps/desktop/src/lib/library.ts:40`, `packages/core/src/runner/monitors.ts:199`, `Explorer.tsx:499`); item key order = object order. Folders sorted (`workspace.ts:454`) | tracked; `merge=testpion` (`git-files.ts:32`) | library | `LIBRARY_LABEL` lacks `mcp-folders`, `spec-folders` → "Saved item …" in Git |
| 6 | MCP servers (stdio env, http headers, mock file) | `mcp-servers.json` (one file, `servers[]`) (`workspace.ts:427-445`) | **No**: array in UI order, keys in object order, no canonical form | tracked; **no** merge attribute; `MERGED_BY_MEANING` excludes it (`git/git.ts:6`) → line merge | mcp | secrets in `env` / `headers` (see §1e) |
| 7 | MCP toolsets / MCP mocks | `mocks/*.mcp-mock.yaml` (`backend/handlers/mcp.ts:162`, `:172-193`) | Partial (YAML from the form or raw text) | tracked; line merge | **other** | not a sidebar section of its own |
| 8 | AI providers | `providers.json` (`workspace.ts:414-425`) | **No** canonical form; literal `apiKey` refused (`:419-423`) but `headers` not checked | tracked; no merge attribute | providers | |
| 9 | API definitions (OpenAPI / Swagger / AsyncAPI) | `specs/*.{json,yaml}`, `specs/asyncapi/*` (`openapi/spec-files.ts:49-56`, `import/workspace-import.ts:110,131`) | user / imported documents (kept as given — correct) | tracked; line merge; **no `text eol=lf` exception problem**, but no size policy | specs | spec folders live in `library/spec-folders.json` |
| 10 | Datasets (CSV, JSON, JSONL, Markdown, **SQLite**) | `datasets/*` (`storage/dataset-files.ts`, handlers `backend/handlers/collections.ts:254-379`) | user data, kept as given | tracked; `*.sqlite binary` (`git-files.ts:28`) but no LFS, no size warning; edits up to 50 MB allowed (`collections.ts:280`) | **tests** (`workspace-watcher.ts:28` maps datasets to tests) | handlers emit their own `{kind:'datasets'}` |
| 11 | Script packages (`tp.require`) | `packages/<name>.js` (`workspace.ts:283-300`) | text | tracked; line merge | other | |
| 12 | Debugger rules | `debugger/rules.json` ("committed, so a team shares them", `backend/handlers/debugger-rules.ts:3,33`) | object order | tracked; line merge | other | rules can hold header rewrites with tokens — not scanned |
| 13 | Debugger capture sessions + autosave | `debugger/*.har` (`debugger/capture-history.ts:8-16`) | n/a | **ignored** (`git-files.ts:17`) | other (watcher still reports them: `debugger` is not in `IGNORED_TOP`, `workspace-watcher.ts:20`) | `ItemRef` comment says `debugger/sessions/<name>.har` (`item-ref.ts:46`) but the code writes `debugger/<name>.har`; keep the ignore line in sync |
| 14 | Response baselines | `baselines/*.json` (`workspace.ts:518-540`) | n/a | **ignored** (`git-files.ts:14`) | ignored | arguably team data (regression baselines) — owner decision |
| 15 | Runs, traces, payloads, reports, certificates seen | `runs/` (incl. `runs/certificates.json`, `storage/certificates.ts:24`), `traces/`, `payloads/`, `reports/` | n/a | ignored | ignored | correct |
| 16 | Local state | `.local/meta.json`, `.local/trust.json` (`trust.ts:18`), `.local/ai/proposals` (`ai/proposal.ts:135`), `.local/flows`, `.local/git-proposal.json` | n/a | ignored (`.local/`) | ignored | correct |
| 17 | History / current values / metadata DB | `database.sqlite*`, `metadata.jsonl` | n/a | ignored | ignored | correct |
| 18 | Trash | `trash/` with its own `.gitignore` (`storage/trash.ts:39`); kinds collection / environment / dataset only (`trash.ts:15,30`) | n/a | ignored | ignored | MCP servers, specs, library items are deleted without trash |
| 19 | Agent files | `AGENTS.md`, `CLAUDE.md`, `.cursor/rules/testpion.mdc` (`agents/agent-files.ts:26`) | marker-delimited, sorted facts (`agent-facts.ts:102`) | tracked | other | fine |
| 20 | Future: RAG metrics | `metrics/*.yaml` (`planning/rag-testing.md:53`) | to design | would be tracked, line merge | other | register it from day one |
| 21 | Not in the workspace | app settings, providers' secret values, debugger root CA (`debugger/certificate.ts:29`, home dir) | — | — | — | correct; never in git |

### 1c. What Git UI each kind gets today

Evidence: `apps/desktop/src/lib/git.ts:26-31` builds `items: Map<itemId, change>` from `git.changes`; `<ChangeMark>` is
rendered in **one** tree place, the request row (`components/CollectionTree.tsx:1018`, fed at `:851`); the other three
uses are inside GitView (`views/GitView.tsx:437, 488, 790`). `git.collections` is computed and never used.

- **Git view** lists files by raw path, no kind icon (`GitView.tsx:437-440`), semantic changes under each file
  (`:484-505`); *Compare* only for `collection | environment | test` (`:497-501`); no filter; stage / discard per file
  only (`:443-455`); no stash UI.
- **Semantic diff** (`packages/core/src/git/semantic.ts:167-193`): collections (per request / folder), environments
  (per variable), flow / test files (per step, `flow-diff.ts`), library files (per item, `:53-74`). Everything else —
  MCP servers, providers, specs, datasets, mocks, packages, debugger rules, workspace.json — is `kind: 'other'`, title =
  path, no details (`:186-190`). `refOfChange` gives those a `git-file` ref (`:43`) even though `refOfWorkspacePath`
  (`item-ref.ts:132-139`) could name specs and datasets.
- **Item history / restore**: `GitItemHistoryBody.tsx:21` accepts `{collectionId,itemId?} | {environmentId}` only; the
  backend `git.history` / `git.restoreFile` / `git.restoreItem` throw for anything else (`backend/handlers/git.ts:179-205`).
  Menus offering it: collection, request (`CollectionTree.tsx:802, 1034`), environment (`EnvironmentsView.tsx:336`).
- **Discard / Compare with HEAD** exist only in GitView, never in an item menu. `NodeMenu`
  (`components/TreeParts.tsx:382-492`) has an `onHistory` slot but no discard / compare / export slots.
- **Blame**: none anywhere (`git.ts` has no blame). **Stash**: only implicit during pull (`git/git.ts:391-420`).
- **Conflict screen**: per-item three-way for `^(collections|environments|library)/[^/]+\.json$` (`git/git.ts:6`,
  `GitView.tsx:793`); every other file is whole-file Keep mine / Take theirs.
- **Merge driver** (`git/merge.ts:177-185`): dispatches on shape — environment (`variables` w/o `items`), library
  (`folders`+`items`), else collection. `mcp-servers.json` (`servers`) and `providers.json` (`providers`) fall to the
  collection branch, fail its `items` check and return `undefined` → `git merge-file` (`:215-227`). They are also not in
  `.gitattributes`, so git never calls the driver for them anyway.

### 1e. Secrets per kind

`findCommittableSecrets` (`packages/core/src/storage/git-guard.ts:47-90`) scans: collections (security lint "typed in",
collection variables), environments, workspace variables, MCP servers (env / headers by *sensitive key name* only),
providers (`apiKey`). One-click fix (`fixCommittableSecrets`, `:163+`) handles collections, environments, workspace;
**MCP servers and providers are "skipped"** with advice. The library save warns (`backend/handlers/workspace.ts:250-254`,
`findLiteralSecrets`) but `git check` never scans library items.

Not scanned at all: library items (gRPC metadata, WebSocket headers / query tokens, monitor request copies, AI prompts),
test and flow YAML (`headers: Authorization: Bearer …` typed in a step), provider `headers`, `debugger/rules.json`
header rewrites, `mocks/*.yaml`, `packages/*.js`, specs (example tokens, `servers` with basic-auth URLs), datasets
(DB connection strings with passwords, real PII), `workspace.json` non-variable fields. Detection is key-name based —
a token under a harmless key (`"value": "ghp_…"`) is missed; no value patterns (gitleaks-style) exist. The scan reads
the **store**, not the staged blobs, so a file outside the known kinds is invisible to it.

### 1f. Large / binary content

No size policy anywhere. Datasets can be 50 MB text (`collections.ts:280`) or SQLite of any size; specs can be large;
HAR sessions are ignored (good). GitHub warns at 50 MB and rejects 100 MB per file (see §3). No LFS hint, no
`.gitattributes` `filter=lfs` lines, no "track by reference" option.

### 1g. CLI / MCP

CLI `testpion git status|changes|diff|commit|log|branch|switch|pull|sync|resolve|conflicts|push|setup|check|hook install`
(`packages/cli/src/commands/git.ts:30-258`, `workspace.ts:76-128`). MCP: `git_status` (refs are always `git-file`,
`mcp-server/git-tools.ts:54-61`), `git_diff` (semantic; per-item side-by-side), `git_log` (file or collection), `git_conflicts`,
`git_resolve`, `git_sync`, `git_propose_commit`. Missing: `--kind` filters, item history for anything but a request (no
CLI/MCP item history at all), restore, discard, stage by item.

### 1h. Refresh

Own writes and outside writes both become `data.changed {kinds, paths}` (`backend.ts:377-405`, `own-writes.ts`). UI
consumers: `lib/data-changed.ts:8` `FileKind` (same 9 kinds); Explorer reloads gRPC, WS, MCP, specs, folders, datasets on
**any** `data.changed` (`Explorer.tsx:329-339`, unfiltered); AI lab / Load / Evaluations do not subscribe; datasets ride on
`tests` from the watcher but on `datasets` from handlers (two spellings for one kind). After a branch switch
`rewritten()` emits a blanket refresh (`backend/handlers/git.ts:59-68`), so checkout works, but kind-precise refresh does not.

---

## 2. Gap table (kind × capability)

✓ done · ◐ partial · ✗ missing. "Row" = Git view row with item name + kind icon. "Mark" = ChangeMark on the item's
tree row. "Hist" = per-item history + restore. "Conf" = per-item conflict screen.

| Kind | Tracked | Stable ser. | Mark | Row | Sem. diff | Hist | Discard/restore in menu | Merge drv | Conf | Secret scan | CLI/MCP by item | Refresh |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Request (HTTP/GQL/SOAP) | ✓ | ✓ | ✓ `CollectionTree.tsx:1018` | ◐ name, no icon | ✓ | ✓ | ◐ restore only | ✓ | ✓ | ✓ | ◐ diff only | ✓ |
| Collection / folder | ✓ | ✓ | ✗ (folder, header) | ◐ | ✓ | ◐ collection only, no folder | ◐ | ✓ | ✓ | ✓ | ◐ | ✓ |
| gRPC call / WS connection (library) | ✓ | ✗ `updatedAt` | ✗ `CollectionTree.tsx:687-724` (ids are in `git.items`!) | ◐ | ✓ | ✗ | ✗ | ✓ | ✓ | ✗ (warn on save only) | ◐ | ◐ |
| Environment | ✓ | ◐ key order | ✗ | ◐ | ✓ | ✓ | ◐ restore | ✓ | ✓ | ✓ | ◐ | ✓ |
| Workspace settings/vars | ✓ | ◐ | ✗ | ✗ path | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ vars | ✗ | ✓ |
| Test file | ✓ | ◐ | ✗ (`TestsView.tsx:1040-1097`) | ◐ | ✓ steps | ✗ | ✗ | ✗ line | ✗ | ✗ | ◐ | ✓ |
| Flow | ✓ | ◐ | ✗ | ◐ | ✓ (layout aware) | ✗ | ✗ | ✗ line | ✗ | ✗ | ◐ | ✓ |
| AI prompt / load test / evaluation / monitor (FolderList) | ✓ | ✗ `updatedAt` | ✗ (FolderList has no mark) | ◐ label | ✓ "settings" only | ✗ | ✗ | ✓ | ✓ | ✗ | ◐ | ◐ (views don't subscribe) |
| **MCP server** | ✓ | ✗ | ✗ (`Explorer.tsx:789-809`) | ✗ path `mcp-servers.json` | ✗ | ✗ | ✗ | ✗ | ✗ | ◐ key names, no fix | ✗ | ◐ blanket |
| MCP folders / spec folders | ✓ | ◐ | ✗ | ◐ "Saved item" | ◐ | ✗ | ✗ | ✓ | ✓ | n/a | ✗ | ◐ |
| MCP mock / toolset | ✓ | ◐ | ✗ (no section) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ◐ other |
| AI provider | ✓ | ✗ | ✗ (`ai/Providers.tsx:101-124`) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ◐ apiKey only, no fix | ✗ | ✓ |
| **API definition** | ✓ | n/a (user doc) | ✗ (`Explorer.tsx:811-833`; not even Rename/Delete) | ✗ path | ✗ (no OpenAPI-aware diff in git; `OpenApiDiffDialog` exists but not wired) | ✗ | ✗ | ✗ line | ✗ | ✗ | ✗ | ✓ specs |
| **Dataset** | ✓ (binary too) | n/a | ✗ (`Explorer.tsx:835-868`) | ✗ path | ✗ (rows/columns diff possible) | ✗ | ✗ | ✗ line | ✗ | ✗ | ✗ | ◐ two kind names |
| Script package | ✓ | n/a | ✗ (no section) | ✗ | ✗ text | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ◐ other |
| Debugger rules | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ◐ other |
| Debugger HAR sessions | ignored (✓ by design) | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | watcher reports ignored files (bug) |
| Baselines | ignored (decision) | — | — | — | — | — | — | — | — | — | — | — |

**What the owner's three screenshots show, explained.** MCP servers, API definitions and datasets are rendered by
ad-hoc `Row`s inside `Explorer.tsx` (not CollectionTree, not FolderList), so they get neither the shared node menu nor a
ChangeMark; in the core they are not item kinds of the git layer at all (`SemanticChange.kind` has no `mcp-server`,
`spec`, `dataset`, `semantic.ts:16`), so even a perfect UI would have nothing per item to show. The fix therefore has
to start in core (registry), not in the three views.

---

## 3. Research: how others do it

Web research, 2026-10-17. Links marked *(canonical)* are standard documentation pages that were not re-opened for this
plan. Hoppscotch and Kreya have little public documentation on file layout.

**API clients: which items each one versions**

| Tool | What is in git | Not in git | Git UI / conflicts |
|---|---|---|---|
| Bruno | Each collection is a folder: `bruno.json`, `collection.bru`, `folder.bru`, one `.bru` per request, `environments/*.bru` ([version control](https://www.mintlify.com/usebruno/bruno/integrations/version-control), [git integration](https://www.mintlify.com/usebruno/bruno/concepts/git-integration)) | Secret values are never written to disk ([blog](https://blog.usebruno.com/managing-secrets)); `.env` is ignored and a `.env.sample` is committed ([docs](https://docs.usebruno.com/v2/secrets-management/dotenv-file)); history, cookies and the token cache stay local | init / diff / pull / clone are free; commit / push / branches / conflicts are paid ([overview](https://docs.usebruno.com/git-integration/overview)) |
| Insomnia | Git Sync writes the project's resources as YAML in your own repository: collections, design documents, mock servers, global environments ([version control](https://developer.konghq.com/insomnia/version-control)); since Insomnia 11 at project level ([how-to](https://developer.konghq.com/how-to/synchronize-with-git/)) | Their docs warn that app metadata produces diffs even when nothing in a request changed ([git sync](https://developer.konghq.com/insomnia/git-sync)) | Three-way merge view on pull/push, one side per conflict ([three-way merge](https://developer.konghq.com/insomnia/three-way-merge/)) |
| Postman (Native Git) | `postman/{collections,environments,globals,specs,flows,mocks,documents}` plus `.postman/` config ([sync](https://learning.postman.com/docs/use/native-git/sync)); the Collection 3.0 format splits a collection across several YAML files | Local environment values; secrets must not go in the repository | Desktop only. Matching is by **name**, not content (Update / Keep both / Rename), and pull only offers collections, environments, globals and specs ([sync](https://learning.postman.com/docs/use/native-git/sync)) |
| Yaak | One `yaak.<id>.yaml` per resource; environments only when marked "sharable" ([directory sync](https://yaak.app/docs/using-yaak/local-directory-git-sync)) | Non-shared environments | Built-in commit / push / pull / history; changes made on disk are summarised and confirmed; you choose which changes to commit from a request diff |
| Thunder Client / Requestly / Kreya | JSON in a `thunder-tests` folder ([docs](https://docs.thunderclient.com/get-started)); plain JSON local workspaces ([Requestly](https://requestly.com/features/local-projects/)); Kreya says its files are "git-diffable" ([kreya.app](https://kreya.app/)) | — | Minimal |
| Hoppscotch | Cloud real-time sync; no native git file sync found | — | — |

**What this means for TestPion.** No competitor versions *every* kind:
- Postman's own pull dialog leaves out flows, mocks and documents.
- Insomnia's metadata creates noise diffs.
- Bruno keeps app state out of the files.

TestPion already goes further on semantic merge (no other tool merges by request id). Three things are worth copying:
- Yaak's **"commit only the changes you pick from an item diff"**.
- Bruno's **".env.sample" pattern**: commit the shape, never the values.
- Postman's **folder per kind**, which TestPion already has.

Two things to avoid:
- Postman's matching by name.
- Insomnia's volatile metadata, which is exactly what `updatedAt` in `library/*.json` does today.

**"Everything as code" tools.** They share one rule: track what people write; ignore derived files, caches, state and
anything holding secrets; and commit a sample for any config that is ignored.
- Terraform: track `*.tf` and `.terraform.lock.hcl`; ignore `.terraform/` and `*.tfstate*`, because state holds secrets in plain text ([tips](https://terraform-essentials.readthedocs.io/en/latest/tips-and-tricks/terraform-git.html)).
- dbt: ignore `target/`, `dbt_packages/`, `logs/` and `.env`; credentials live outside the project in `~/.dbt/profiles.yml` ([dbt](https://docs.getdbt.com/faqs/Troubleshooting/gitignore)).
- Grafana Git Sync: one dashboard JSON per file; a UI save becomes a commit or a pull request ([Grafana](https://grafana.com/docs/grafana/latest/as-code/observability-as-code/provision-resources/provisioned-dashboards/)).

**IDE git UI.**

| Feature | VS Code | JetBrains |
|---|---|---|
| Change badges in the tree | `FileDecorationProvider` with `propagate: true`, so parent folders show their children's changes ([API](https://vscode-api.js.org/classes/vscode.FileDecoration.html)). This is the model for ChangeMark on containers and section headers. | — |
| History and blame | Timeline view with per-file commits, inline blame and a status-bar blame item ([history](https://code.visualstudio.com/docs/sourcecontrol/history)) | Annotate (blame), Show history, Compare with revision ([investigate changes](https://www.jetbrains.com/help/idea/investigate-changes.html), *canonical*) |
| Partial staging | Stage / Revert Selected Ranges | Partial commits by chunk ([commit](https://www.jetbrains.com/help/idea/commit-and-push-changes.html), *canonical*) |
| Conflicts | Three-way merge editor ([merge conflicts](https://code.visualstudio.com/docs/sourcecontrol/merge-conflicts)) | — |
| Grouping and setting aside work | — | Changelists and shelve ([shelve](https://www.jetbrains.com/help/idea/shelve-changes-dialog.html)) |

TestPion's equivalents are per item rather than per line: stage this item, discard this item, the item's history, and
blame showing who last changed the item.

**Merging JSON and YAML.**
- Custom merge drivers: a `merge=<name>` attribute plus `git config merge.<name>.driver "cmd %O %A %B"`; the driver writes the result to `%A` and exits non-zero on conflict ([gitattributes](https://git-scm.com/docs/gitattributes#_defining_a_custom_merge_driver), *canonical*). This is what TestPion has for three file kinds.
- Generic structural drivers: [git-json-merge](https://github.com/bkad/git-json-merge), [composer-git-merge-driver](https://github.com/balbuf/composer-git-merge-driver), and Mergiraf, which merges on the syntax tree for JSON, YAML and more and has a `mergiraf review` step ([LWN](https://lwn.net/Articles/1042355)).
- Why line merges fail on JSON: a line merge can "succeed" and still produce duplicate keys ([article](https://braindetox.kr/en/posts/mergiraf_syntax_git_merge.html)). This argues for registering the driver for **every** JSON kind, including `mcp-servers.json` and `providers.json`.
- Common guidance from these tools: arrays keyed by a stable id, canonical serialization (stable key order, LF line endings, trailing newline), and no timestamps.
- Mergiraf could serve as the fallback for YAML test and flow files instead of `git merge-file`. That is an owner decision, since it adds a dependency.

**`.gitattributes` options.**
- `* text=auto eol=lf` normalises line endings.
- `diff=<name>` with `diff.<name>.textconv` makes `git diff` and `git log -p` readable. It is one-way and does not apply to `format-patch` ([commit](https://code.googlesource.com/git/+/678852d918e874c99590ba6e857efeef974a3fb9%5E%21)).
- `-diff` or `binary` suppresses text diffs for big files.
- `linguist-generated=true` collapses a file in GitHub pull-request diffs ([linguist](https://github.com/github-linguist/linguist/blob/main/docs/overrides.md), *canonical*).

**Large files.**
- GitHub warns above 50 MiB per file, blocks above 100 MiB, and recommends repositories under 1 GB ([GitHub](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)).
- With LFS, a diff only shows the pointer file ([freeCodeCamp](https://www.freecodecamp.org/news/collaborate-on-data-science-projects-with-dagshub/)), so TestPion's dataset diff must read the LFS object itself.
- DVC is the alternative: pointer files in git and the data on any remote ([DVC](https://s.dvc.org/user-guide)). The "track by reference" option in §4f is a light version of this.
- Working rule (inferred from the above): plain git for a few MB of text, LFS for binary files or anything of tens of MB.

**Secret scanning.**
- gitleaks: rules and allowlists in `.gitleaks.toml`, `# gitleaks:allow` on a line, `.gitleaksignore` by fingerprint, and a pre-commit hook ([guide](https://tessl.io/registry/testland/gitleaks-scanning/files/references/custom-rules-and-triage.md)).
- TruffleHog checks whether a found key still works. Accurate but slow, so it suits CI rather than pre-commit.
- detect-secrets keeps a `.secrets.baseline` file, so only new findings are flagged ([comparison](https://appsecsanta.com/secret-scanning-tools/gitleaks-alternatives)).
- GitHub push protection blocks a push that contains a known secret. Free on public repositories; Advanced Security on private ones (*canonical*).
- Patterns that matter for API-client files: `Authorization: Bearer|Basic`, `x-api-key`, `scheme://user:pass@host`, private keys, JWTs. Bruno's community advice is to reject any literal value that is not a `{{var}}`, which TestPion already does by key name.
- TestPion's design: key-name rules per kind plus gitleaks-style value patterns, and an allowlist file that is committed and reviewed (like `.gitleaksignore`).

**CODEOWNERS.**
- GitHub looks for the file in `.github/`, the repository root, then `docs/`. The last matching pattern wins, and the copy on the base branch is the one used ([GitHub](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)).
- It only enforces review together with "Require review from Code Owners". The repository already uses that (memory: repo protection).
- An owner team with no members fails silently.
- TestPion can generate a starter file with one line per kind folder (`environments/`, `mcp-servers.json`, `providers.json`, `.gitattributes`), with the owner names left for the user to fill in.

---

## 4. Solution

### The 8-line version

1. **One core item-kind registry** (`packages/core/src/kinds/`) — every kind declares file glob, stable serializer, id/name extraction, `describeChange`, merge strategy, secret patterns, size policy and ItemRef; git, export/import and menus all read it.
2. **Stable files for every kind** — canonical writers (sorted known keys, items by id where order is not meaning, no `updatedAt`), migrated once by `testpion git setup`; a round-trip test per kind.
3. **Git layer is registry-driven** — `describeGitChanges`, `describeItemDiff`, item history/restore/discard, merge driver and conflict detail dispatch on the registry, so MCP servers, providers, specs, datasets, tests, prompts, monitors … all get per-item rows, diffs, history and three-way conflicts.
4. **Uniform UI** — one `<ChangeMark>` on every tree/list row of every section (incl. folder and section headers with counts) from one `useGitMarks()` keyed by ItemRef; `NODE_KINDS` gets a `git` group (History…, Compare with last commit, Discard changes…, Stage) for every versioned kind.
5. **Git view by item** — rows named by item with kind icons, filter by kind, stage/commit/discard by item (hunk-level for JSON via the serializer), blame "last changed by" per item.
6. **Fix git setup** — one action / `testpion git setup --fix` completes `.gitignore` / `.gitattributes` (merge driver for every JSON kind, `diff=testpion` textconv, LFS lines on request), un-tracks what must be ignored, warns about what is ignored but should be shared.
7. **Secrets and size gates** — commit-time scan over the staged blobs of every kind (key names + gitleaks-style value patterns), one-click "move to secret store" for every kind incl. MCP servers and providers; size thresholds with LFS / track-by-reference offers for datasets and specs.
8. **Parity + proof** — `testpion git status|diff|history|restore|discard --kind/--ref` and matching MCP tools via the tool contract; a gap-matrix test that fails when a registered kind lacks a capability, plus e2e on real input for MCP server, API definition and dataset.

### 4a. The registry (core, one for all three plans)

New `packages/core/src/kinds/registry.ts` (types in `packages/shared/src/item-kinds.ts` so the UI can import the
static part). It extends — does not replace — `ITEM_REF_FIELDS` / `ITEM_KIND_LABEL` (`item-ref.ts:56-109`).

```ts
interface WorkspaceKind<T = unknown> {
  kind: ItemKind | `saved:${string}`;          // 'mcp-server', 'spec', 'dataset', 'saved:monitors' …
  label: string; icon: string;                  // Git view + menus
  files: { glob: string; layout: 'one-file-per-item' | 'items-in-file' | 'raw-document' };
  serializer?: { read(text: string): T; write(value: T): string };   // canonical; absent for raw documents
  items?(file: T): Array<{ id: string; name: string; value: unknown; folder?: string }>; // items-in-file kinds
  refOf(path: string, itemId?: string): ItemRef;
  describeChange(before?: unknown, after?: unknown): string[];       // "URL, 2 headers", "3 rows added"
  parts?(item: unknown): Record<string, string>;                       // side-by-side + conflict parts (requestParts today)
  merge: 'by-id' | 'fields' | 'text' | 'binary-ours';
  secrets: { keys?: RegExp[]; values?: SecretPattern[]; fix?: 'secret-variable' | 'secret-store' | 'none' };
  size?: { warnBytes: number; lfsBytes: number };
  capabilities: Array<'versioned' | 'exportable' | 'importable' | 'restorable' | 'trash'>;
}
```

- **Consumers:** `git/semantic.ts` (replace the regex chain `:182-190` with `kindOfPath(path)`), `git/merge.ts`
  (`mergeWorkspaceTexts` dispatch by registry, not by shape), `git/git.ts` `MERGED_BY_MEANING` (from registry),
  `git-files.ts` (generated `.gitattributes` lines), `workspace-watcher.ts` `changeKind` (kind names from registry —
  removes the datasets→tests alias), `git-guard.ts` (per-kind scanners), `template-update.ts:40-45` (its own
  `mergeKind` duplicate), export/import (`planning/export-import.md`), and the UI `NODE_KINDS` (`menus-uniform.md:296`)
  which gets `capabilities` from here so "versioned" ⇒ git menu group, "exportable" ⇒ Export….
- **One registry, three facets, not three registries.**
  - `planning/export-import.md` §4.2 (`:356-390`) proposes `BUNDLE_KINDS` / `BundleKind` (`list`, `describe`, `dependencies`, `exportItems`, `identity`, `importItems`, `rewriteRefs`). `menus-uniform.md` proposes the UI `NODE_KINDS`. Both are keyed by the same kind names (`collection`, `spec`, `dataset`, `mcp-server`, `mcp-mock`, `test`, `library:<kind>`, `script-package`, `provider`).
  - Proposal: a single `packages/core/src/kinds/` registry. Each kind file exports one object with a **storage/git facet** (this plan: files, serializer, items, `describeChange`, `parts`, merge, secrets, size), a **bundle facet** (export-import's methods) and **capabilities** that `NODE_KINDS` reads through RPC (`kinds.list`).
  - `bundle/kinds.ts` becomes a view over it (`registry.filter(k => k.bundle)`).
  - Both plans name the secret detector as shared: export-import's `bundle/secrets.ts` and `git-guard.ts` should become one per-kind scanner, defined here (§4e).
  - Kind names: use export-import's `library:<kind>` spelling (this document's `saved:<kind>` is the same thing) and map it to the existing ItemRef `{kind:'saved', library}`.
- **Where it stays honest:** a unit test iterates the registry (see §4j).

### 4b. Stable serializers (GIT-101 for every kind)

| Kind | Change |
|---|---|
| Library items | drop `updatedAt` from the file (move to `.local/meta.json` like collections, `workspace.ts:873-876`); fixed item key order `id, name, folder, collectionId, data`; `data` keys sorted except known ordered keys |
| MCP servers | canonical `{schemaVersion, servers:[…]}` with fixed keys `id, name, folder, transport, command/url/mockFile, args, cwd, env (sorted), headers`; array keeps user order (it is display order) |
| Providers | same pattern; `headers` keep order |
| Environments | fixed key order `id, name, isProduction, order, variables, …rest sorted` |
| workspace.json | drop `updatedAt` from the file (keep in `.local/meta.json`); ignore `workspace.json.bak-*` |
| Debugger rules | fixed key order, items by id |
| Tests / flows | keep authored text; only the designer's writes go through a canonical YAML emitter (known key order: `name, description, defaults, expose, output, tests, layout`, as `flow-diff.ts:141`); round `layout` coordinates to integers so a drag of 0.3 px is not a change |
| Specs, datasets, packages, mocks | raw documents: never rewritten by the app except on explicit edit (already true) |

Migration: `makeGitReady` (`git-ready.ts:16-34`) gets a loop over registry kinds instead of collections only; it reports
"tidied N files" and is idempotent.

### 4c. Git view and item-level operations

- **Rows by item.** `describeGitChanges` returns, for every changed file, items via `kind.items()` (MCP server
  "Weather (stdio)", provider "OpenAI", dataset "patients.csv: 12 rows added, column `dob` removed", spec "clinic.yaml:
  2 paths added, `GET /patients` response changed" — using the existing OpenAPI diff in `OpenApiDiffDialog`'s engine).
  Each row: kind icon, item name, details, ChangeMark, `RefLink`. Filter chips by kind (shared `FilterChips`).
- **Compare** for every kind (parts from `kind.parts`, falling back to text). **History / Restore** generalised:
  `git.history({ref})`, `git.restore({ref, rev})` work for any ref whose kind declares `restorable` (item-in-file kinds
  replace one item, like `replaceCollectionItem`; file kinds restore the file). `gitItemHistory` (`semantic.ts:264`)
  becomes kind-generic (`kind.items()` instead of `findCollectionItem`).
- **Discard item** — for item-in-file kinds: write HEAD's version of that one item back via the serializer (the same
  code as restore with `rev=HEAD`); for file kinds: `gitDiscard`.
- **Stage item** — build the blob "index version with only this item changed" through the serializer and
  `git update-index --cacheinfo` / `git apply --cached` of a generated patch (VS Code-style "stage selected ranges", but
  by item). Commit by item / kind / all follows from staging.
- **Blame per item** — `git log -L` on the item's line range (found from the canonical serializer) → "last changed by
  X in abc123, 3 days ago" in the item's Info panel.
- **Stash** — Git view ▸ "Set changes aside" / "Put back" (`git stash push -u` / `pop`), reusing the pull code
  (`git/git.ts:391-420`).
- **ChangeMark everywhere** — `useGitMarks()` returns `Map<refKey, change>` (from `SemanticChange.ref`, not just
  `itemId`) plus aggregated counts per container (folder, collection, section header). One `TreeRowShell` slot renders
  it (`menus-uniform.md:373`), so CollectionTree folders/headers/saved items, FolderList rows, Explorer MCP/spec/dataset
  rows, Tests tree, Environments (view and pane) and Providers all get it at once.
- **Menus** — add a `git` group to `MENU_GROUPS` (`menus-uniform.md:272-281`): *History in git…*, *Compare with last
  commit*, *Discard changes…* (with undo), *Stage* — present for every `versioned` kind when the workspace is a repo;
  disabled with a reason when the item is unchanged.

### 4d. Workspace init and "Fix git setup"

Generated `.gitignore` additions: `workspace.json.bak-*`, `debugger/**/*.har` (covers a `sessions/` sub-folder),
`*.tmp-*`. Generated `.gitattributes` from the registry:

```
* text=auto eol=lf
*.png binary
*.jpg binary
*.sqlite binary
collections/*.json   merge=testpion diff=testpion
environments/*.json  merge=testpion diff=testpion
library/*.json       merge=testpion diff=testpion
mcp-servers.json     merge=testpion diff=testpion
providers.json       merge=testpion diff=testpion
debugger/rules.json  merge=testpion
datasets/*.csv       text eol=lf linguist-generated=false
# added only when the owner turns LFS on (Fix git setup ▸ Large files):
# datasets/*.sqlite filter=lfs diff=lfs merge=lfs -text
```

`git config diff.testpion.textconv "<testpion> git textconv"` (registered with the merge driver in
`gitSetupMergeDriver`, `git/git.ts:676-679`) prints the semantic summary + canonical JSON, so plain `git diff` / `git
log -p` in a terminal reads by item.

**Fix git setup** (Workspace menu, Git view banner, `testpion git setup --fix --json`, MCP `git_setup`): detects and
offers to fix — missing ignore/attribute lines; merge driver / textconv not configured; tracked files that should be
ignored (`git ls-files runs/ traces/ .local/ database.sqlite …` → `git rm --cached`); untracked-but-shareable kinds
(e.g. `library/` never added); non-canonical files (re-serialize); files over the size policy; a pre-commit hook not
installed.

### 4e. Secrets

- Scan the **staged blobs** (`git diff --cached --name-only` + `git show :path`) through each kind's scanner, plus a
  value-pattern pass for all text files (gitleaks-style: AWS keys, GitHub/GitLab tokens, Slack, JWT, private keys,
  `Authorization: Bearer`, URLs with `user:pass@`, connection strings `Password=`), entropy only as a hint.
- New scanners: library items (gRPC metadata, WS headers/query, monitor requests, prompts), tests/flows YAML, provider
  headers, debugger rules, mocks, specs (`servers` with credentials, example tokens), dataset connection strings.
- Fixes: extend `fixCommittableSecrets` with `mcp-server` (value → secret store key `mcp.<id>.<field>`, file gets
  `{{$secret.mcp.<id>.<field>}}`), `provider` headers, library items and test steps (→ `{{variable}}` + secret env var).
- Policy: block on high-confidence findings, warn on medium; allowlist in `.testpion/secrets-allow.json` (committed,
  reviewed) — never "skip forever" silently. Datasets: warn on PII-looking columns (email, ssn, dob) with "generate
  synthetic data instead" (GenerateDataDialog exists).

### 4f. Datasets and big files

Thresholds (registry `size`): warn at 5 MB in the commit panel, strong warning + LFS offer at 50 MB, refuse to stage
≥ 100 MB without LFS (GitHub's hard limit). "Track by reference" option for a dataset: a small
`datasets/<name>.ref.json` (`{ url | path, sha256, rows }`) is committed, the data stays local or is downloaded on
demand. HAR sessions stay ignored, with a per-session "Share this session" toggle that copies a redacted HAR to
`debugger/shared/` (tracked).

### 4g. Conflicts for every kind

The shared conflict screen (`GitConflictDialog.tsx`) is already generic over `items` with `parts`. With the registry:
`gitConflictDetail` / `gitResolve` (`git/git.ts:604-662`) dispatch on `kind.merge`: `by-id` (collections, environments,
library, MCP servers, providers, debugger rules) → per-item three-way; `fields` (workspace.json) → per-field; `text`
(tests, flows, specs, mocks, packages, CSV) → per-hunk with the line view and Keep mine / Take theirs per hunk;
`binary-ours` (SQLite) → whole file with sizes / row counts shown. Open tabs with unsaved edits keep the existing
"keep mine / take the new version" prompt for every kind.

### 4h. Refresh

`changeKind` returns registry kinds (`mcp-server`, `provider`, `spec`, `dataset`, `package`, `mock`,
`debugger-rules`, `saved:<kind>`); ignore what `.gitignore` ignores (add `debugger/*.har` to the watcher's ignore set).
`lib/data-changed.ts` `FileKind` imports the list. Explorer reloads only the sections whose kinds changed; AI lab,
Load, Evaluations, Monitors, Providers subscribe with `touchesFiles`.

### 4i. CLI / MCP parity

- `testpion git status --kind mcp-server --json` (items, not only files), `testpion git diff --semantic [--kind]`,
  `testpion git history <ref|link>`, `testpion git restore <ref> --rev <rev>`, `testpion git discard <ref>`,
  `testpion git stage <ref>`, `testpion git textconv <file>` (hidden), `testpion git setup --fix`.
- MCP: `git_status` returns item refs (not only `git-file`), `git_history`, `git_restore` / `git_discard` (write,
  with confirmation semantics like `git_propose_commit`), `git_setup_check`; all declared in `tool-contract.ts` with
  `tool-docs.ts` when/whenNot entries.

### 4j. Tests, performance, docs

- **Round-trip test per registered kind** (fixtures in `tests/fixtures/kinds/<kind>/`): read → write → read → write
  is byte-identical; writing a re-ordered object gives the same bytes.
- **Gap-matrix test** (`tests/unit/kind-capabilities.test.ts`): for each kind with `versioned`, assert a serializer
  or `raw-document` layout, `describeChange`, `refOf`, a `.gitattributes` line when `merge !== 'text'`, a scanner, a
  `changeKind` mapping, a `NODE_KINDS` entry with the git group, and a ChangeMark slot (UI side via `nodeMenuShape`).
  Adding a kind without them fails CI.
- **Merge-driver tests per kind** (extend `tests/unit/git-merge.test.ts:82-115`): different items combine, same item
  conflicts, both sides add, delete vs edit.
- **Secret fixtures**: one positive + one negative per kind and per value pattern (`tests/unit/git-guard.test.ts`).
- **e2e (real input)** in `apps/desktop/e2e/plans/git-everything.cjs`: edit an MCP server's URL in the UI → ChangeMark
  on its row and on the section header count → Git view row "MCP server Weather: URL" with icon → Compare → History
  after commit → Discard from the row menu; same for an API definition (import a changed file) and a dataset (add a
  row in the grid); a conflict on `mcp-servers.json` from a bare-remote teammate resolved per server.
- **Perf**: `git.changes` on a 9,000-item workspace (`perf-large-workspace` plan) under 200 ms warm: status is cached
  by `data.changed` epoch (`backend.ts:246-254`), semantic description is cached per `(path, blob sha)`; unchanged
  files are never parsed. Budget enforced in the perf suite.
- **Docs**: `docs/getting-started/git.md` gets "What is in git (per kind)", Fix git setup, LFS, textconv;
  `docs/cli/reference.md` and the MCP tool list. (`docs/public/llms.txt` is generated — not edited by hand.)

### 4k. Roadmap

**Release A — registry + gap closure (≈ 6–8 days).**
- Core registry with every kind of §1, used by semantic.ts, merge.ts, git.ts, watcher, git-files (2 d).
- Stable serializers for library (drop `updatedAt`), MCP servers, providers, environments, workspace.json; migration in `makeGitReady`; round-trip tests (1.5 d).
- Semantic diff + Git view rows with name + icon + Compare for MCP servers, providers, specs (OpenAPI diff), datasets (rows/columns), tests, packages, rules; kind filter (1.5 d).
- `useGitMarks` by ref + ChangeMark on every row and section header (with `TreeRowShell` from menus-uniform phase 1, or a stop-gap slot) (1 d).
- `.gitignore` fixes (`.bak-*`, HAR glob), `.gitattributes` from the registry, merge driver for `mcp-servers.json` / `providers.json`; watcher ignores HAR (0.5 d).
- Gap-matrix test (0.5 d).

**Release B — item-level operations + safety (≈ 7–9 days).**
- Generic history / restore / discard by ref (backend, GitItemHistory, menus `git` group) (2 d).
- Stage by item, commit by item/kind, stash UI, blame "last changed by" (2 d).
- Conflict screen for every kind (`by-id`, `fields`, `text` hunks, `binary-ours`) (1.5 d).
- Staged-blob secret scan with per-kind scanners + value patterns, fixes for MCP servers / providers / library / tests, allowlist (2 d).
- CLI / MCP parity (`--kind`, history, restore, discard, stage, setup --fix) (1 d).
- e2e plan git-everything + perf budget (1 d).

**Release C — polish (≈ 3–4 days).**
- Fix git setup wizard (tracked-but-ignored, untracked-but-shared, hook, driver) (1 d).
- textconv diff driver; size policy + LFS offer + track-by-reference datasets; shared HAR sessions (1.5 d).
- CODEOWNERS template generator per kind folder (e.g. `environments/ @team/platform`), docs (1 d).

### Risks

- **Rewriting files to canonical form makes one big diff** per workspace — do it once in Fix git setup with its own commit message ("TestPion: canonical files"), never silently on open.
- **Item-level staging builds index blobs** — must be exact or a commit loses a change; guarded by round-trip tests and a "show what will be committed" preview.
- **Secret value patterns false-positive** on example tokens in specs/tests — warn-level for low confidence, allowlist file.
- **Registry migration touches git, merge, watcher, export, menus** — land core first behind the same outputs (snapshot tests on `describeGitChanges` for today's kinds must not change).
- **MCP server display order is meaningful** — merging by id must keep a stable order (ours' order, theirs' additions appended), as library merge does.
- **Cloud**: everything is in core and RPC; the item-staging plumbing must also work with the isomorphic-git backend (CLD) — keep it on `GitService` methods, not shelling out from handlers.

### Owner decisions

1. Baselines (`baselines/`): keep ignored, or share them (they are regression references a team may want)?
2. Canonical rewrite of existing files: one-time via Fix git setup (recommended) or on next save only?
3. Secret findings: block the commit (today) for all kinds, or warn for low-confidence value patterns?
4. Datasets: LFS offer at 50 MB (recommended) and track-by-reference — or keep datasets always in plain git?
5. HAR sessions: stay ignored with an explicit "Share session" (recommended), or tracked by default?
6. One file per item (GIT-303, Bruno-style) stays **not** built: the registry + merge driver + textconv give per-item review without a layout migration (recommended to keep the 2026-10-02 decision).
