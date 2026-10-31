---
title: "CLI reference"
description: "Reference for the testpion command-line interface."
---

# CLI reference

::: tip In short
The `testpion` command does from a terminal what the app does: run tests, send a request, run a collection, check an AI evaluation. Most people need the ten commands below. The full list follows them.
:::

## The ten commands most people use

| I want to… | Command |
|---|---|
| Run my tests | `testpion test` (or `testpion run --suite regression`) |
| Send one request and read the answer | `testpion send "https://example.com/api"` |
| Run a whole collection | `testpion run-collection "My API" -e Staging` |
| See what is failing in my workspace | `testpion problems` |
| Find a request or test | `testpion search payment` |
| Run an AI evaluation | `testpion eval run "Support intents"` |
| Try the AI sample with no key | `testpion eval sample` |
| Check a RAG bot with no key | `testpion rag sample` |
| Share work through git | `testpion git sync` |
| Set up an AI assistant to use TestPion | `testpion agents init` |

A few more that came with teamwork and AI quality:

| I want to… | Command |
|---|---|
| See what my team changed lately | `testpion git activity` |
| See what a pull would bring | `testpion git incoming` |
| Tell git who I am | `testpion git identity --name "Ana" --email ana@example.com` |
| Write a note for my team on Home | `testpion workspace note "Start with Staging."` |
| List the secrets this computer still needs | `testpion secrets --missing` |
| Check the test cases of an evaluation | `testpion eval lint "Support intents"` |
| See what changed between two prompts | `testpion eval version-diff "Support intents" "Shorter"` |
| Place a bot run's questions and documents by meaning | `testpion rag map <run>` |
| Check how easy an MCP server is for an agent | `testpion mcp --lint -- node server.js` |

Add `--json` to almost any command to get the answer as data for a script, and `--help` to see its options. A command that finds a problem exits with a non-zero number, which is how CI knows to fail. Add `-w <folder>` to say which workspace; without it, the nearest `workspace.json` is used.

::: v-pre

```text
testpion test [paths...]      Run test files, directories, globs or a *.suite.yaml
testpion test <flow> --data [file] | --env-matrix <envs>   One flow file once per data row, or in several environments side by side
testpion test from-request <item>   Save a saved request (a folder, a collection, any item ref) as a test file, like Save as test… in the app
testpion run --suite <name>   Run tests/<name>.suite.yaml from a workspace (or testpion run <file> for one test file)
testpion search <words>       Find items by name or content, like Quick Open (Ctrl+P); each hit has a ref for testpion open
testpion search --ask "…"    Ask in your own words about History, runs, test results and traces; the model only translates, TestPion searches
testpion problems             What is failing in the workspace, as the app's Problems list (alias: attention; exit 1 on a high-severity item)
testpion send <request|url>   Send one saved request (scripts, auth, checks) or a URL and print the response, like curl
testpion run-collection <collection>   Run a collection like Postman's Collection Runner / Newman
testpion mock-graphql --schema <file>   Fake data for any query against a GraphQL schema (see GraphQL mock server)
testpion mock <collection>    Serve a collection's saved examples on localhost
testpion graphql-subscribe <endpoint> -q <doc>   Run a GraphQL subscription and print the events
testpion graphql-op <Type.field> --endpoint <url> Build a ready-to-run operation for a root field (or --schema <file>)
testpion lint <collection>    Security review of a collection's requests (--fail-on high for CI)
testpion fuzz <spec>           Fuzz an API from its OpenAPI document: server errors, invalid input accepted (local hosts only)
testpion vars move <c> --to <envs> Move collection variables into environments (each can set its own value)
testpion tidy <collection>     Duplicate requests, typed-in hosts, empty folders, unused variables (--remove-* fixes)
testpion replace <c> <find> <with> Find and replace across a collection's requests (preview; --apply saves)
testpion agent-info               What an AI agent needs to use TestPion here, as JSON (workspace, commands, exit codes, MCP setup)
testpion kinds [kind]            The kinds of item a workspace holds and what each offers (open, rename, delete with undo, run, CI …), with why an action never applies, and the menus of its rows (--json)
testpion item delete|restore <ref|id> -w   Delete any item to Recently deleted by its ref (collection:<id>, environment:<id>, dataset:<name>, spec:specs/<path>, mcp-server:<id>), or put one back (--json)
testpion output <output>        Save an output of the app (run results, History, traces, a timeline, a matrix, the changes …) to a file, byte for byte as the app's down arrow does (--format, --out, --list)
testpion trust list|forget      What you allowed a workspace on this computer: programs, hosts its scripts may reach, reading secrets (forget --host h | --secrets | --all; --json)
testpion open <ref>              Open an item in the TestPion app by its ref (a testpion://open link, the JSON "ref" of --json output, or kind:id); checked first (--json, --print)
testpion tests-from-spec <spec> Write a first test suite from an API definition (examples and invalid requests)
testpion integration-suite <spec|collection> Write an integration suite: a flow per resource (create, read, update, list, delete), the login first
testpion generate-data <name>  Generate rows of test data into datasets/ from a JSON schema or an API operation
testpion export <c> -f http    Write a collection as an .http file (REST Client, JetBrains HTTP Client)
testpion export <c> -f asyncapi Write a collection's connections as an AsyncAPI 3.0 document
testpion openapi-ops <spec>    List an OpenAPI document's operations by tag (--json: schemas and a request per operation)
testpion secrets <environment> Check an environment's secret manager references (op://, vault://, aws-sm:// …)
testpion record <target>      Record traffic through a local reverse proxy; -w saves it as a collection (see Record traffic)
testpion debug (or debugger) [capture] [--throttle modem|edge|slow-3g|3g|slow-4g|custom [--down-kbps n --up-kbps n --latency-ms n]] [-p port] [-o session.har] [--rules debugger/rules.json] [--decrypt] [--system-proxy --yes] [--dry-run] [-w workspace] [--json] [--save-collection [name] | --to <collection>] [--group host|path|none]   The HTTP Debugger's proxy: other programs' traffic (HTTP_PROXY=…), printed as it happens (program, process id, server); rules applied
testpion debugger remap [host=target] [--keep-host] [--scheme auto|http|https] [--list] [--remove <host>] [--import-hosts [file]] [--rules file] [--dry-run] [--json]   Host remapping rules of a rules file (default: the workspace's debugger/rules.json); the hosts-file entries are imported switched off
testpion debugger rule [--add '<json>'|@file] [--list] [--remove <id>] [--rules file] [--dry-run] [--json]   Any Debugger rule as JSON (map local, path rewrite, body replace, faults, WebSocket frame rules, remap); the fields are checked like the rule editor does
testpion debugger capture --upstream <http://host:port> [--upstream-user u] [--no-upstream-for hosts] [--upstream-system] [--ca-file pem...] [--client-cert host=cert:key...] [--large-session]   Send the capture through a corporate gateway, trust extra authorities, present client certificates (TESTPION_UPSTREAM_PASSWORD, TESTPION_CLIENT_KEY_PASSPHRASE); keep the whole session past 5,000 exchanges
testpion debugger gateway --upstream <url> [--url target] [--json]   Try a gateway: open a tunnel (https) or ask for the head (http) through it
testpion debugger launch <program> [args...] [--proxy url] [--ca pem] [--kind node|python|java|dotnet|curl|chromium|firefox|other] [--preview] [--json]   Start a program with the proxy variables and switches its runtime reads
testpion debugger export <file> [--saz out.saz] [--bundle out.tpbundle] [--har out.har] [--notes text] [--rules file] [--json]   A session (HAR, SAZ or bundle) as a Fiddler SAZ, a masked share bundle or a HAR
testpion debugger farx <file.farx> [--rules file] [--dry-run] [--json]   Import Fiddler AutoResponder rules, best effort (what was imported, imported off, skipped)
testpion debugger diff <before> <after> [--ignore-query] [--include-size] [--timing-ms n] [--fail-on-diff] [--json]   Compare two captures: requests added, removed, status or timing changed
testpion debugger open <bundle.tpbundle> [--out session.har] [--json]   What a share bundle holds: notes, environment, rules, exchanges
testpion debug certificate [--install | --remove] [--yes] [--dry-run] [--json]   The root certificate HTTPS decryption signs with: where it is, its fingerprint, whether this computer trusts it (`known: false` when it cannot tell); --install and --remove change the trust store and need --yes when the command cannot ask
testpion mock-mcp <file>      Serve an MCP mock (stdio, or --http) for AI agents and MCP clients
testpion env set|unset|get <env> -w   Set or remove plain variables of an environment (secrets stay in the app); set --also-in <envs> [--copy] adds them to others where missing
testpion vars usages|rename -w   Where a variable is used; rename it everywhere
testpion openapi-diff <old> <new>   List breaking changes between two OpenAPI versions (--fail-on-breaking for CI)
testpion openapi-lint [specs...]     Lint OpenAPI documents: broken $refs, undeclared path parameters, duplicate operationIds …
testpion eval list|run <name>   Evaluations saved in the app: list them, or run one by name (exit 1 on failures)
testpion eval sample   Make the sample evaluation (10 cases, the offline demo model, no key) and run it
testpion eval estimate <name>   What a run would cost before it starts: cases, calls, dollars, seconds, the spend cap
testpion eval check <name> --type contains --expected x   Try one check on one case: the reply, passed or failed, why
testpion eval generate-cases <name> --from prompt   Write test cases with AI (from the prompt, a spec, a collection, documents or History), verified, as a proposal
testpion eval trust <run|last>   Grade ten answers yourself and see how often the AI reviewer agreed
testpion eval summary [run]   How a run went in a few sentences: 17 of 20 passed, the checks, the failed cases, against the last run
testpion eval why <run> <case>   Why one case failed: an AI reviewer's reason, or the AI assistant (--dry-run shows what would be sent)
testpion eval diff <run> <case>   A case's answer against the run before it
testpion eval variants <name>   Compare the versions of an evaluation (eval run <name> --variants runs them)
testpion eval compare <run> --baseline <run>   Compare an evaluation run with a baseline case by case; exit 1 on regressions (for CI)
testpion eval matrix <runs...>   Evaluation runs side by side: cases × variants, against a baseline (a page at a time)
testpion rag targets|probe|connect|metrics|metric|probes|presets|run|rescore|compare|cache|import|export   RAG systems under test: connect, probe, the 138 metrics, your own metrics, run with gates, re-score, compare, convert datasets
testpion agents init [--targets agents,claude,cursor]   Write or refresh AGENTS.md (and a CLAUDE.md pointer, a Cursor rule) for coding agents
testpion coverage <spec> -w   API coverage: which OpenAPI operations and responses the runs exercised (--min for CI)
testpion docs <collection>    Write Markdown (or --html) documentation for a collection
testpion export <collection>  Export a collection as Postman v2.1 (or TestPion JSON)
testpion export <kind:id…> --out <file>   A TestPion bundle of any items (`folder:<collection>/<folder>` and `request:<collection>/<request>` for a part of a collection, --section <kind>, --folder <kind:name> for the items in a folder of a list, --all, --uses for everything they use, --exclude kind:id… to leave some of those out, --globals / --no-globals for the workspace variables)
testpion export <collection> --format postman|bruno --extras --out <zip|folder>   A collection for another tool with what it uses (environments, workspace variables as Postman globals, API definitions, data files, .mcp.json); secret values never
testpion bundle inspect <file>   Read a bundle without a workspace: what it holds, what it needs, what to review
testpion export-environment <name>   Export an environment in Postman's format
testpion mcp-server           Serve a workspace to AI agents over MCP (stdio)
testpion load <url>           Safeguarded load test (--threshold "p95<500" "errors<1%" to pass/fail; --grpc <method> for a gRPC server; --collection, or --test-file <flow> for a whole flow per virtual user)
testpion import <bundle> -w [--preview] [--on-conflict keep-both|replace|skip] [--globals merge|replace|skip] [--into <collection[/folder]>]   Preview or import a TestPion bundle; --globals decides what happens to the workspace variables it carries, --into adds its collection's requests under a collection or folder, --undo <importId> takes an import back
testpion import <input...> -w [--preview|--apply] [--report file]   Import OpenAPI/Swagger, Postman, Insomnia, Bruno (a collection folder too), Hoppscotch, OpenCollection YAML, WSDL (SOAP), a GraphQL schema, HAR, collections, Arazzo workflows (as flow files), or a copied cURL / fetch / PowerShell request; several files, a folder or a ZIP are previewed first. `import-report [id]` and `import-undo <id…>` read and take back an import
testpion env list|order|diff -w  List environments; set their order; compare two
testpion monitor list|add|remove|run|results|uptime|start -w  Collections or test files (flows) on a schedule (monitors; add --test-file <path>)
testpion ci <github|gitlab|azure|jenkins> -w  A CI pipeline file for a suite, collection or tests (--start, --wait-for: start the system under test first; --run last: what a run ran; one flow: --data, --env-matrix, --timeline-html)
testpion lint-tests [paths] -w   Check test files before running them: unknown types, check types, misspelt keys, dependsOn ids (--json; exit 1 on errors)
testpion flow <file> -w       A test file as a flow: the steps in columns with the latest run's results and the designer's checks (cycles, steps that never run; -e <env> also unset variables) (--json for steps, edges, layers, problems, checks, notes and frames, and `inheritedAuth`: per HTTP step the `defaults: auth:` it runs with, `overridden: true` when it has its own; --dot for Graphviz)
testpion flow runs <file> -w  A flow's run history, newest first; --run <id> shows that run's steps with the variables after each (--json)
testpion flow edit <file> -w  Edit a flow as the app's designer does: --op '<json>' (addStep, updateStep, connect, removeStep, addNote, addFrame …; a JSON list for several), --connect <a> --to <b>, --remove <step>, --parallel <group> --steps a,b, --finally <steps>, --webhook [path] / --no-webhook, --dry-run (--json)
testpion flow export <file> --arazzo -w   A flow as an Arazzo 1.0 workflow document (-o file.arazzo.yaml, --spec specs/api.yaml, --json)
testpion flow from-har <file.har> -w   Recorded traffic as a flow file: values that flow between requests extracted, noise left out, secrets as variables (-o tests/x.yaml, -e env, --dry-run, --json)
testpion flow report <file> -w   A run of a flow as a timeline with its critical path (--run <id>, --html out.html, --json)
testpion flows -w             The flows exposed as MCP tools (test files and suites with an expose: block): tool, file, inputs (--json)
testpion serve flows -w       Run flows behind their webhooks (webhook: blocks): POST JSON to the path, get the flow's output (--port 4020, --host, -e env, --jsonl)
testpion scripts convert --to tp|pm -w   Rewrite collection scripts between Postman's pm.* and TestPion's tp.*, or --from bruno|insomnia|thunder|hoppscotch to tp.* (--file for one script, --lift-tests, --dry-run)
testpion wait-for <url>       Wait until a URL answers (the health check before integration tests); exit 3 when it never does
testpion trash list|restore|empty -w  Recently deleted collections, environments, datasets, API definitions and MCP servers (30 days)
testpion history list|stats|diff|test|export-har -w  Response history of saved requests; response times; compare two responses; a test across runs; HAR export
testpion workspace list|create|rename|delete|export   Manage workspaces (see Workspaces); export writes <name>.testpion.json, secrets replaced by {{variables}}
testpion git setup|check|hook install -w   Make a workspace git-ready; find secrets before a commit (check --staged scans the staged files, what a commit would publish: exit 1 on a finding); a pre-commit hook
testpion git status|changes|diff|commit|log|branch|switch|pull|push|sync|resolve -w   Git for the workspace (pull --ff-only: only a plain fast-forward, never a merge, exit 1 when it cannot; sync: pull & push in one step; status --by-item [--kind <kind…>] lists the changed items by name) (see Keep your workspace in git)
testpion git history|blame <item> -w   One item in git: its versions with what each changed (history -n <count>), or who last changed each field (blame). `<item>` is a link from the app, `kind:id` (`mcp-server:weather`, `environment:staging`) or `file#itemId` (`mcp-servers.json#weather`); --json
testpion git restore <item> --rev <commit> [--dry-run] -w   Write an older version of just that item back; prints the title and each part that changes (old → new) and an `undoId`; --dry-run writes nothing
testpion git discard-item|stage-item|unstage-item <item> [--dry-run] -w   Discard the uncommitted change of one item (the rest of its file keeps its changes), or stage / unstage just that item (in a file with several items only its change goes into the index, the others stay unstaged; a file that is one item stages whole; a file with several items goes as one file: the message names the other changed items that come along)
testpion git fix [--dry-run] [--hook] [--untrack] -w   Fix git setup in one previewed, undoable step: .gitignore and .gitattributes (line endings, merge and diff drivers on every JSON kind), the drivers in the repository config, existing files rewritten once into the stable format, optionally the pre-commit secret check and `git rm --cached` of tracked files the ignore rules ignore. Idempotent; works without git or outside a repository (the file steps still run); `--dry-run --json` is the plan (`steps`, `rewritten`, `files`, `largeFiles`); a real run prints an `undoId` for `git undo`
testpion git large [--check] [--track <file> --lfs|--reference [--source <where>]] [--dry-run] -w   Files over the size policy (5 MB note, 50 MB offer, 100 MB refused in a commit); `--check` compares every `<file>.ref` with the data on this computer (exit 1 when one is missing or different); `--track` moves one out of plain git: `--lfs` (a Git LFS rule in .gitattributes) or `--reference` (a `.ref` file with the sha256, the data git-ignored); --json
testpion git share-session <name> | unshare-session <name> | shared-sessions [--dry-run] -w   Share a saved Debugger session: a copy masked once more with the export redaction goes to `debugger/shared/<name>.har` (tracked); the session stays git-ignored; --json
testpion git codeowners [--owner <owner>] [--write] -w   A starter CODEOWNERS with a line per kind folder (printed; `--write` puts it in .github/CODEOWNERS when the workspace is the repository; never overwrites a CODEOWNERS that exists); --json
testpion git allow-secret <hash> --reason <text> | disallow-secret <hash> | allowed-secrets -w   The staged secret scan's allowlist (`.testpion/secrets-allow.json`, committed, read in review): let one value through by the `hash` of a finding in `git check --staged --json`; an entry names file, item, field and a fingerprint, never the value
testpion git fix-secrets -e <environment> -w   What the one-click fix would do for secrets typed into staged MCP servers, providers, saved items, tests and other files: the `{{variable}}` each value becomes (the values move to secret variables in the app, whose secret store the command line does not have)
testpion git undo [id] [--list] -w   Undo the last restore or discard (or the one with this id); --list shows the undoable operations (the newest 30)
testpion git stash push -m <name> [--dry-run] | list | show [n|hash] | apply [n|hash] | pop [n|hash] | drop [n|hash] -w   Set the uncommitted changes aside under a name and put them back (n: the number in `stash list`, 0 = newest); --json
testpion git conflicts [file] [--resolve ours|theirs] -w   After a pull that stopped on conflicts: each file by what it holds (`items` with their clashing fields, `text` hunks with where they are, `binary` with the sizes of both sides) and the key of each; --resolve settles every conflicted file (or the one given) with one side
testpion git resolve <file> --ours|--theirs|--pick <key=ours|theirs…>|--edit <key=value…> -w   Settle a conflicted file: a side for everything, a side per conflict key, or your own value (--edit item:r1#request.url='"https://…"' takes JSON for an item or field key, --edit hunk:0='the lines to keep' plain text for a hunk key)
testpion diff <from> [to] -w  What changed between two commits, by meaning (--markdown for a pull-request comment)
testpion mcp [--url|--sse|--server <name> -w] [--call <tool> --args <json>] [--json]   Inspect an MCP server (a saved one with --server), or call one of its tools
testpion ws <url> [-m msg] [-e event=json]    Talk to a WebSocket or Socket.IO server and print the replies
testpion mqtt <url> [-s topic] [-p topic=msg] Subscribe and publish on an MQTT broker and print what arrives
testpion kafka <brokers> [-r topic] [-p topic=value] Read and produce Kafka topics and print what arrives
testpion grpc <target> [method] [-p protos]   Call a gRPC method, or list the methods (.proto files or server reflection)
testpion report <results.jsonl>              Re-generate reports
```

The command line starts from one bundled file, `dist/bundle.js`, which `bin/testpion.js` loads while it is newer than the build (a command takes about half the time it did: roughly 0.9 s instead of 2.0 s on a loaded machine); `--version` and `--help` answer from an index written at build time. Set `TESTPION_UNBUNDLED=1` to load the separate files instead.

## JSON output, dry runs and scripts

Every command that takes `--json` prints **one envelope** on stdout, whatever happens (success, a failed check, a wrong argument, a missing file):

```json
{
  "schema_version": 1,
  "command": "eval compare",
  "status": "failed",
  "data": { "passed": false, "counts": { "regressed": 3 } },
  "errors": [],
  "warnings": [],
  "metrics": { "duration_ms": 412, "exit_code": 1 }
}
```

- `status` follows the exit code: `ok` (0), `failed` (1: a test or check failed), `error` (2 configuration, 3 execution). An error is `{ code, message, hint, retryable }`: `code` is the kind (`ConfigurationError`, `NetworkError`, `TimeoutError` …), `hint` what to do, `retryable` whether trying again may help (network, timeouts, rate limits, server errors).
- `data` is exactly what the command printed as JSON before 0.46: **migrate a script with `jq .data`** (`testpion collections --json | jq '.data[].name'`).
- `warnings` collects what the command also wrote to stderr (a collection file that could not be read …).
- With `--json` stdout holds only the envelope: everything written for people goes to stderr.

**`--jsonl`** on the commands that stream (`test`, `run`, `run-collection`, `eval run`, `load`, `serve flows`, `debug`, `monitor start`, `record`): a line per event as it happens (`{ schema_version, command, type: "result" | "row" | "call" | "exchange" | "listening", data }`), then the envelope as the last line with `type: "result"`. `serve flows --json` and `debug --json` printed lines before and now mean `--jsonl`. `test <file> --data <rows> --json` streams its rows inside the envelope's `data` (`{ rows, summary }`), so a run of 100,000 rows needs no memory.

**`--dry-run`** on the commands that write files or change state (`import`, `export`, `export-environment`, `docs`, `ci`, `report`, `workspace-report`, `env set / unset / order`, `vars rename`, `replace`, `workspace create / rename / delete / export`, `trash restore / empty`, `monitor add / remove`, `datasets`, `generate-data`, `tests-from-spec`, `integration-suite`, `test from-request`, `flow export`, `history export-har`, `git setup`, `git fix`): the command runs against a copy of the workspace and of the app folder, every write outside them is diverted and every delete skipped, and the result lists each file it would add, change or delete (`dry_run: { applied: false, changes: [{ path, change, bytes }] }` in the envelope). Commands with a dry run of their own (`tidy`, `agents init`, `vars move`, `flow edit`, `flow from-har`, `scripts convert`, `git restore`, `git discard-item`, `git stage-item`, `git unstage-item`, `git stash push`) keep it.

**`--non-interactive`** (the default with `CI` or `TESTPION_NON_INTERACTIVE=1`): a command never waits for input; where it would (a token read from the terminal by `jwt -`) it fails at once with a hint. When a command fails and stdout is not a terminal, stderr suggests the `--json` form.

**`--json` is on every command**, so an agent never has to know which ones take it (on a command that already printed JSON it only wraps it in the envelope; on the plumbing git calls, `merge-driver` and `git textconv`, and on `mcp-server`, whose stdout is not ours, it is accepted and ignored). `testpion agent-info` prints plain JSON as before, and `--json` puts the same object in the envelope's `data`. `mock` and `mock-graphql` with `--json` print one line when they listen: `{ type: "listening", data: { url } }`.

**`--yes`** on every command that deletes or overwrites, the CLI twin of `confirm: true` on the MCP tools that confirm (`item delete`, `import-undo`, `import --undo`, `git resolve`, `git sync`, `git restore`, `git discard-item`, `git stash push / apply / pop / drop`, `git undo`, `git unshare-session`, `git fix`, `git large --track`, `git codeowners --write`, `tidy`, `vars rename`, `vars move`, `replace --apply`, `flow edit --remove`, `ai apply`, `ai undo`, `integration-suite / tests-from-spec / generate-data / rag capture --overwrite`, `agents init --force`, `settings set / reset`, `workspace delete`, `trash empty`). On a terminal the command asks "Continue?"; when it cannot ask (`--non-interactive`, CI, a pipe) it refuses before anything changed, exit code 2, and answers what the MCP tool answers: `data: { confirmationRequired: true, wouldDo, hint }`. Show the person `wouldDo`, then repeat the command with `--yes`; `--dry-run` shows what it would change. The commands whose whole purpose is to send or spend what you named (`run`, `rag run`, `security run`, `ai attempt-fix` …) ask nothing.

**`--max-cost <usd>`** on the commands that call the AI model (`ai run`, `ai triage`, `ai script`, `generate tests`, `tidy --ai`, `flow generate`, `security generate`, `openapi-drift --ai`, `search --ask`, `rag generate-dataset / draft-references / author`): the command refuses before anything is sent when one call could cost more (the context plus the most the answer may use, at the price in Settings ▸ Model pricing; a model on this computer is free). The MCP tools take `max_cost_usd` the same way, and every AI result carries `usage` and `costUsd`.

**One structure.** Related commands live under one word, and `testpion --help` lists them in groups: `lint` (`lint <collection>`, `lint tests`, `lint openapi`), `mock` (`mock <collection>`, `mock mcp`, `mock graphql`) and `openapi` (`diff`, `ops`, `drift`, `coverage`, `fuzz`). The old spellings `lint-tests`, `openapi-lint`, `mock-mcp`, `mock-graphql`, `openapi-diff`, `openapi-ops`, `openapi-drift`, `coverage` and `fuzz` keep working, and so does `openapi lint`. A collection called `tests`, `openapi`, `mcp` or `graphql` is reached with `lint collection tests` / `mock collection mcp`. `node packages/cli/dist/index.js` works like `bin/testpion.js`.

**A wrong command** answers with a hint: a misspelt command says `Did you mean testpion agent-info?` (and in the `--json` envelope, `errors[].hint`).

## `settings`

The app's settings (the ones in Settings in the window, per computer) for scripts and agents: `testpion settings get [key] [--describe] --json` shows them with the defaults filled in (never a secret, never the lists the app keeps for itself), `testpion settings set defaultTimeoutMs=60000 ai.dailyBudgetUsd=2 theme=dark` changes them (lists are comma separated; `--dry-run` shows the change), `testpion settings reset <keys…> | --all` puts them back. MCP: `get_settings`, `set_settings` (asks for `confirm: true`).

## `auth token`

`testpion auth token <collection> [request] [-e environment] [--cached] --json` runs the OAuth 2.0 grant of a collection, or of a request (its own auth, else its folder's or the collection's) now, as **Get token** does in the Authorization tab: whether the token call works, when the token ends, its scope, and the token masked. MCP: `auth_token`.

## Environment variables {#environment-variables}

| Variable | What it does |
|---|---|
| `TESTPION_HOME` | The app's data folder (settings, workspaces, secrets) instead of the default one |
| `TESTPION_NON_INTERACTIVE=1` | Never wait for input (also set by `CI`) |
| `TESTPION_SECRET_<NAME>` | The value of a secret variable (the CLI has no OS keychain) |
| `TESTPION_AI_PROVIDER`, `TESTPION_AI_MODEL` (`_SMALL`, `_LARGE`), `TESTPION_AI_LOCAL_ONLY` | The AI model the CLI and CI use |
| `TESTPION_NO_PROXY`, `TESTPION_USE_SYSTEM_CA`, `TESTPION_CA_FILE` | Outbound proxy off, the OS certificate store, extra CA certificates |
| `TESTPION_BLOCK_PRIVATE_NETWORKS`, `TESTPION_ALLOW_HOSTS`, `TESTPION_ALLOW_PROCESSES` | The network policy for shared use ([privacy](/security/privacy)) |
| `TESTPION_REGISTER_LINKS` | Register the `testpion://` links with the operating system when the desktop app starts |
| `TESTPION_DEBUGGER_CERTS` | Where the HTTP Debugger keeps its root certificate |
| `TESTPION_EXAMPLES` | The examples workspace the web host serves |
| `TESTPION_WORKSPACE` | The workspace the Terminal panel starts in |

## Paging {#paging}

A command that lists something that can grow long comes a page at a time, the same way everywhere (and like the MCP tools): `-n/--limit` (how many; 100 unless the command says otherwise, at most 500: the same numbers as the MCP tools), and `--cursor <c>` (the `nextCursor` of the page before) or `--offset <n>` (the same as a number). A list that was cut says so: in text mode a last line `100 of 2500 requests shown; more: --cursor o5k`, and with `--json` the envelope has `page` (`{ total, limit, truncated, nextCursor }`) and a warning with the same line, while `data` stays the plain list, so a script that reads `.data` is unchanged. A list that fits has no `page`. To read all of it, repeat the command with `nextCursor` until `page` is gone.

```bash
testpion history flaky -w my-workspace --json -l 500                       # page.nextCursor says where the next page starts
testpion history flaky -w my-workspace --json -l 500 --cursor "$NEXT"
```

Paged: `history list` (default 20, at most 500), `history flaky`, `history results <runId>`, `search` (plain words, `--ask` and `--query-json`: the answer's `outcome` has `truncated` and `nextCursor` / `nextOffset`), `requests <collection>`, `env list` and `datasets show` (rows; `truncated` and `nextCursor` are in the data). Lists of what the user made by hand (collections, monitors, evaluations) are not cut.

## Results as files {#results-as-files}

The commands that already write files: `test`, `run-collection` and `eval run` (`-o, --out <dir>` and `-r` for the JUnit, JSON, HTML and Markdown reports), `report` (reports from a `results.jsonl`), `load --json <file>`, `history export-har -o <file>`, `debug -o <file.har>`, `flow report <file> --html <out>`, `export` / `workspace export` and `docs -o`. Most commands that print a result now also take `--out <file>` and `--format`, and `testpion output` saves any output of the app: see [`output`](#output) below. Anything else prints to stdout, so `testpion send … > body.json` keeps a body.

`--out <file>` and `--format` on `send` (the body), `history list` (History as HAR, CSV or JSON), `monitor results` (CSV, JSON), `git diff` (patch, Markdown), `eval matrix` (CSV, JSON, Markdown, HTML) and `testpion output` use the same builders, formats and redaction as the app's down arrow ([Save and export results](/getting-started/save-and-export-results)), so a file written here is byte for byte the file the app saves. The MCP server has the same in its `save_output` tool ([MCP server](/ai-testing/mcp-server)).

## `test` / `run` options

| Option | Description |
|---|---|
| `-w, --workspace` | Workspace name or directory (default: nearest `workspace.json`). |
| `-e, --environment` | Environment name. |
| `--allow-production` | Allow data-changing requests (POST, PUT, PATCH, DELETE, mutations …) to an environment marked as production; without it they fail with *needs confirmation* and reads still run. Also for `send`, `run-collection`, `load`, `eval run`, `serve flows`, `monitor add / run / start` and `ai attempt-fix`. See [Production](/api-testing/environments#production). |
| `-c, --concurrency` | Parallel workers. |
| `--retries`, `--timeout` | Retries per failing test; per-test timeout in ms. |
| `-r, --reporter` | `console junit json html markdown` |
| `-o, --out` | Output directory (default `runs/<runId>` in the workspace, or `./testpion-results/<runId>` outside one). |
| `-t, --tags`, `-g, --grep` | Filter tests. |
| `--bail` | Stop after the first failure. |
| `--resume <runId>` | Continue an interrupted run. |
| `--var k=v` | Runtime variable (repeatable). |
| `--baseline`, `--save-baseline`, `--fail-on-regression` | Regression testing. |
| `--trace all\|failures\|none` | Trace persistence. |
| `--log-level` | Enable debug logging; secrets stay redacted. |
| `--watch` | Run again whenever a test, collection, environment or data file in the workspace (or the given paths) changes, until Ctrl+C. Results and reports the run writes don't count as changes. |
| `--rerun-failed [runId]` | Run only the tests that failed or errored in a run (default: the last one). In the app: **Rerun failed** on a finished run; **Run again** (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> for the last run) runs the whole run again as it ran. |
| `--triage` | After a run with failures: the failures grouped by likely cause and — with an [AI model set up](/ai-testing/ai-features#set-up-a-model) — explained with verified fixes, printed as a *Triage* section and written to `triage.md` / `triage.json` beside the results; the JUnit, HTML and Markdown reports get a *Triage (AI)* section when a model answered. Never changes the exit code. Also for `run-collection`. See [Explain and fix failures](/ai-testing/ai-features#explain-and-fix-failures-triage). |
| `--from <step>` | One flow file: run this step and the steps after it; the steps before it are seeded from `--seed-run` (default: the latest run of the file that has them). In the app: **Run from here**. |
| `--to <step>` | One flow file: run this step with only the steps it waits for. In the app: **Run to here**. |
| `--seed-run <runId>` | One flow file: the run whose variables and responses seed the steps before `--from`; alone, replays that run from its first failing step (see `testpion flow runs`). |
| `--data [file]` | `test`, one flow file: run it once per row of a CSV, JSON or JSONL file, a SQLite database, or `postgres://…` / `mysql://…` / `env:NAME` with `--data-query`; each row's columns are variables, with `{{$row.column}}` and `{{$index}}`. Without a value: the file's own `data:`. Exit 1 when a row failed, or when nothing ran (every row skipped every step, e.g. they wait for a step in another file: the run is **skipped**, not passed). See [Run a flow at scale](/test-runner/integration-testing#run-a-flow-at-scale). |
| `--data-query <sql>`, `--data-limit <n>`, `--data-concurrency <n>` | With `--data`: the `SELECT` of a database; at most this many rows; rows at once (default 1). `--bail` stops at the first failing row. |
| `--env-matrix <names...>` | `test`, one flow file: run it in each environment (`dev,staging,prod`, or `-e` repeated) and print a step × environment matrix with the values that differ marked. Exit 1 when an environment failed, or when nothing ran in any environment (**skipped**). |
| `--allow-skipped` | With `--data` or `--env-matrix`: a run where nothing ran exits 0 (it is still reported as skipped). |
| `--json` | The [envelope](#json-output-dry-runs-and-scripts) with the run in `data` (`summary`, `reports`, `outDir`); with `--data`, `data` streams `{ "rows": [ … ], "summary": { … } }`; with `--env-matrix`, the matrix. |
| `--jsonl` | A JSON line per result as it finishes, then the envelope (for scripts and AI agents). |
| `--otlp <url>`, `--otlp-header k:v` | Send the run's traces to an OpenTelemetry collector (OTLP/HTTP); without `--otlp`, `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` are used. See [traces](/test-runner/traces). Also for `run-collection`. |

## `test from-request`

Saves a saved request as a test file under `tests/`, the same as **Save as test…** in the app. A folder or a whole collection becomes one file with a test per request.

```bash
testpion test from-request "Veterinary API/Patients/Create a patient" -w my-workspace
testpion test from-request "Veterinary API/Patients" -n "Patients smoke" --json
testpion test from-request "saved:grpc:lib-123" --json      # any item ref: a saved gRPC call, a History entry …
```

| Option | Description |
|---|---|
| `-w, --workspace` | Workspace name or directory (default: nearest `workspace.json`). |
| `-n, --name` | The test's (or the file's) name; default: the request's. |
| `--json` | Print `{ path, tests, ref }`. |

## `search`

Finds items in a workspace by name or content, like Quick Open in the app; each hit's `ref` goes to `testpion open`.

```bash
testpion search patients -w my-workspace
testpion search "create order" --json -n 5
```

**`--ask "<question>"`** searches **History, runs, test results and traces** from a question in your own words (the app's *Ask…*). The configured model only translates the question into a validated search query (it sees the question, the time and the field names, never your data); TestPion runs the query itself, read-only, and says how the question was understood — the query in plain words, the model's assumptions, then the hits, each with a `ref` for `testpion open`:

```bash
testpion search --ask "failed payment calls last week over 2 s"
testpion search --ask "flaky tests in staging" --in results --json
testpion search --ask "payments" --no-ai          # the words as typed, no model
testpion search --ask "…" --dry-run               # send nothing: print what would be sent
testpion search --query-json '{"where":[{"field":"status","op":"gte","value":500}],"limit":10}'
testpion search --query-json @query.json --in history     # a query from a file ("-": stdin)
```

| Option | |
|---|---|
| `--ask <question>` | The question. Without a model, or when the model fails or its query is not valid, the words are searched as typed (`mode: "text"`, the reason in `fallback`; exit `0`). |
| `--query-json <spec>` | Run a query directly, with no model: JSON, `@file` or `-`. `{"sources": ["history"], "where": [{"field", "op", "value"}], "sort": {"by": "time", "dir": "desc"}, "limit": 25}`. The fields and operators are in [Ask: search in your own words](/getting-started/finding-your-way#ask); an invalid query exits `2` and lists what is allowed. |
| `--in <sources>` | Stay inside some sources: `history`, `runs`, `results`, `traces` (comma-separated). |
| `-n/--limit`, `--cursor`, `--offset` | The page of matches (`--ask` / `--query-json`: 1 to 200, default 25; plain words: default 20); they replace the query's own `limit` and `offset`. A cut list says `more: --cursor …`: [Paging](#paging). |
| `--no-ai`, `--dry-run`, `--privacy`, `--provider`, `--model` | As for [`ai run`](#ai). |
| `--json` | `{ question, mode: "ai" \| "text" \| "query", query, explain, chips, assumptions, fallback?, outcome: { rows, matched, truncated, nextOffset?, nextCursor?, perSource, capped, notes, ms }, model?, usage?, costUsd? }`. |

The call is counted in `testpion ai usage` as the task `nl-search`.

## `send`

Sends one request and prints the response body (pretty-printed JSON), like `curl`. The request is a saved one, by name, with its scripts, auth (inherited too), variables and checks, or a URL:

```bash
testpion send "Veterinary API/Authentication/Get access token" -e Development -i
testpion send "Get patient" -e Development --fail          # a unique name is enough
testpion send "{{baseUrl}}/patients?limit=2" -e Development --json   # a URL uses this folder's workspace (or -w) for its environments
testpion send https://api.example.com/items -X POST -H "Content-Type: application/json" -d '{"name":"Rex"}'
```

| Option | Description |
|---|---|
| `-e, --environment` | Environment whose variables resolve (and the collection's). |
| `--allow-production` | Allow a data-changing request to an environment marked as production. |
| `-X`, `-H`, `-d` | Method, headers and body, for a URL. |
| `-i, --include` | Also print the status line and response headers. |
| `--fail` | Exit `1` on an HTTP error status (400+) or a failed check. |
| `--json` | The envelope, with `{ status, statusText, url, durationMs, headers, body, checks }` in `data`. |
| `--out <file>` | Write the body to a file instead of printing it: as received by default (like `curl -o`), or laid out with `--format json`, minified with `--format json-min`, or `text`, `html`, `xml`. With `--json`, `data.saved` says where and how big. |

Check results go to stderr, so `testpion send … | jq` gets only the body.

## `output` {#output}

```bash
testpion output --list                         # what can be saved, with formats and parameters (--json for a script)
testpion output history -w clinic --out history.har            # History as HAR (the format from the file name)
testpion output history -w clinic --failed --format csv --out failed.csv
testpion output run.results -w clinic --run run-2026-10-18-0932 --format junit --out junit.xml
testpion output git.diff -w clinic --format md --out changes.md
testpion output response.body -w clinic --history-id h-7f3 --format json --out body.json
```

Saves an output of the app to a file, as the **down arrow** in the window does: the same builders, the same formats and the same secrets policy ([Save and export results](/getting-started/save-and-export-results)). `testpion output --list` shows what it can save from a workspace:

| Output | Formats | Parameters |
|---|---|---|
| `run.results` | html, json, junit, md, csv, zip | `--run` (the run id) |
| `flow.timeline` | html, json | `--run`, or `--file` (a flow file: its latest run) |
| `flow.grid` | csv, json, html | `--data-run`, `--status` |
| `eval.matrix` | csv, json, md, html | `--runs <ids…>`, `--baseline` |
| `history` | har, csv, json | `-q`, `--kind`, `--failed`, `-n` |
| `traces` | json (OTLP) | `--traces <ids…>`, or `-q`, `--kind`, `--failed`, `-n` |
| `monitor.runs` | csv, json | `--monitor`, `-n` |
| `runs.overview` | csv, json | `-q`, `-n` |
| `git.diff` | diff, md | `--path`, `--staged` |
| `workspace.report` | html | `--days` |
| `response.body`, `graphql.response` | raw, json, csv … | `--history-id` (a saved response body) |

The console of a running app, the Debugger session and what only the window holds (a selected exchange, a chart, an AI answer) are saved from the app.

| Option | Description |
|---|---|
| `--out <file>` | The file to write (without it the text is printed; `--json` needs it). It is written through a `.part` file and renamed when complete, so a failure leaves no half file. |
| `--format <format>` | One of the output's formats; by default the one the `--out` extension names (`.csv`, `.har`, `.md` …), else the output's default. |
| `--include-secrets` | Keep the secrets that are masked by default (not for outputs that are masked when they are recorded). A script has no dialog to confirm in: the flag is the confirmation. |
| `-e, --environment` | Mask this environment's secret values as well. |
| `--json` | `{ surface, format, path, bytes, redacted, notice }` in the envelope. |

## `collections` and `requests`

What a workspace holds, for scripts and AI agents (`--json`), the same as the `list_collections` and `list_requests` MCP tools:

```bash
testpion collections                     # each collection: requests, gRPC calls, connections
testpion doctor -w my-workspace          # Node.js, SQLite, secrets, proxy, certificates, workspace files (exit 1 on errors)
testpion runs prune --dry-run --json    # delete runs beyond the retention (newest 500, none older than 90 days; --keep, --days)
testpion diagnostics --json              # for a bug report: versions, settings without secrets, the last 500 log records, workspace size (masked)
testpion storage -w my-workspace --delete-runs-older-than 30   # disk use; clean up old runs
testpion load-history -w my-workspace          # earlier load tests: req/s, p95 (and server p95), errors, pass rules
testpion variable-flow "Veterinary API"  # who sets and uses each variable; exit 1 on used-before-set / never-set
testpion attention -w my-workspace --markdown    # what needs attention (exit 1 on a high-severity item); --markdown to post it
testpion problems --json                 # the same list as the app's Problems (alias of attention): kind, group, type (failure / error / warning), ref
testpion certificates --warn 21          # TLS certificates of the hosts called, soonest to expire first; exit 1 if one expires within 21 days
testpion certificates --check api.example.com:443 https://auth.example.com --warn 21   # connect and check now (trust, days left)
testpion workspace-report -o report.html # what needs attention, activity, collection health, monitors (with 30-day uptime) and runs as one HTML file to share
testpion datasets                        # data files in datasets/ (for run-collection -d); SQLite tables too
testpion requests "Veterinary API"       # its requests, then its gRPC calls and WebSocket / MQTT connections
testpion requests "Veterinary API" --json
testpion requests "Veterinary API" --health   # plus latest status, median time and failures from the app, and which have no checks
```

## `run-collection`

Runs a collection one request at a time, in order, with its `tp.*` scripts, like Postman's Collection Runner or Newman. `<collection>` is a collection name or id in the workspace, a collection file (TestPion or Postman v2.1 JSON), or an http(s) link to one (e.g. a collection published in a repository). A collection file runs in a temporary workspace, so your own workspace isn't changed (its results go to `./testpion-results/<runId>`). A run of a workspace collection is recorded in the workspace's history with what it ran — the collection, the requests and folders picked, the iterations — so the app's **Run again** and **Run in CI…**, `ci --run last`, `--rerun-failed` and the [triage](/ai-testing/ai-features#explain-and-fix-failures-triage) (`--triage`, `ai triage`) find its saved requests.

```bash
# a collection in the workspace
testpion run-collection "Veterinary API" -e Development

# Newman-style: Postman collection + environment files, one iteration per CSV row
testpion run-collection api.postman_collection.json -e staging.postman_environment.json -d users.csv -r console junit
```

| Option | Description |
|---|---|
| `-e, --environment` | Environment name, or a Postman environment file. |
| `--allow-production` | Allow the data-changing requests of the run in an environment marked as production. |
| `-d, --iteration-data` | CSV, JSON or JSONL data file, or a SQLite database: one row per iteration (`tp.iterationData`, `{{column}}`). |
| `--iteration-query` | With a SQLite database as `-d`: the read-only `SELECT` whose rows are the iterations. |
| `-n, --iteration-count` | Number of iterations (default: the number of data rows, or 1). |
| `--delay-request <ms>` | Pause between requests. |
| `--watch` | Run again whenever the collection, an environment or the data file changes, until Ctrl+C. |
| `--rerun-failed [runId]` | Run only the requests that failed in a run of this collection (default: the last run). The earlier requests they need run first, marked `[setup]`: those whose scripts set a `{{variable}}` the failed ones use (a token), and what those need in turn. Their results are reported (failures too) but do not count toward the rerun's totals or exit code. A value set another way (by hand, a collection script) is not looked for: give it with `--env-var`. |
| `--folder <name...>` | Only run these folders or requests, by name or id (repeatable). |
| `--bail`, `--timeout` | Stop after the first failure; per-request timeout in ms. |
| `--cookie-jar <file>` | Start with the cookies in this JSON file (TestPion format or a Newman cookie jar). |
| `--export-cookie-jar <file>` | Write the run's cookie jar to this JSON file afterwards (plain text: keep it out of git). |
| `-g, --globals <file>` | A Postman globals file. |
| `--env-var <key=value>`, `--global-var <key=value>` | Set an environment or global variable (repeatable); overrides the files. |
| `--export-environment <file>`, `--export-globals <file>` | Write the environment / globals after the run, including values scripts set, as Postman files. Secret values are left empty. |
| `-k, --insecure` | Don't verify TLS certificates (development servers only). |
| `--suppress-exit-code` | Exit `0` even when tests fail (configuration errors still exit `2`). |
| `--reporter-junit-export <file>` | Also write the JUnit report to this file. |
| `--triage` | After a run with failures (of a workspace collection): the failures grouped by likely cause and, with a model, explained with verified fixes; `triage.md` / `triage.json` beside the results. Never changes the exit code. |
| `-w`, `-r`, `-o`, `--var`, `--trace`, `--baseline` … | Same as `test`. |

**Coming from Newman?** Most command lines work after replacing `newman run` with `testpion run-collection`: `-e`, `-g`, `-d`, `-n`, `--folder`, `--env-var`, `--global-var`, `--delay-request`, `--timeout-request`, `--bail`, `-k`, `--export-environment`, `--export-globals`, `--suppress-exit-code`, `--reporters` and `--reporter-junit-export` mean the same.

```bash
# newman run api.json -e staging.json -g globals.json --env-var token=$TOKEN --reporters cli,junit --reporter-junit-export out.xml
testpion run-collection api.json -e staging.json -g globals.json --env-var token=$TOKEN --reporters console junit --reporter-junit-export out.xml
```

Variables set by scripts carry over to later requests and iterations, and so do cookies (see [Cookies](/api-testing/cookies)). `tp.execution.setNextRequest()` changes the order. Outside a workspace, reports go to `./testpion-results/<runId>` unless you pass `-o`.

Exit codes: `0` success, `1` test failure, `2` configuration error, `3` execution error.

## `coverage`

Shows which operations of an OpenAPI 3 / Swagger 2 document, and which of their documented response codes, your tests and requests exercised. It reads the workspace's latest run by default. It also lists operations that were never called, observed codes the document doesn't describe, and requests to paths it doesn't have. See [API coverage](/test-runner/ci-cd#api-coverage).

```bash
testpion coverage specs/pets.yaml                        # the latest run
testpion coverage specs/pets.yaml --run run-abc --history 500 --markdown coverage.md
testpion coverage https://api.example.com/openapi.json --min 80   # exit 1 below 80%
```

| Option | Description |
|---|---|
| `--run <id...>` | Use these runs instead of the latest one. |
| `--history [n]` | Also use the last `n` request history entries (default 1000). |
| `--base-url <url>` | Only count requests under this URL. |
| `--exclude-deprecated` | Leave deprecated operations out of the totals. |
| `--min <percent>` | Exit `1` when fewer operations are covered. |
| `--markdown <file>` | Also write a Markdown report, e.g. for a pull request comment. |
| `--json` | The full report as JSON, for scripts and AI agents. |

## `openapi-diff`

Compares two versions of an OpenAPI 3 / Swagger 2 document (files or http(s) links) and lists breaking and other changes. See [Catch breaking API changes](/test-runner/ci-cd#catch-breaking-api-changes).

| Option | Description |
|---|---|
| `--fail-on-breaking` | Exit `1` when there are breaking changes. |
| `--breaking-only` | Leave out the non-breaking changes. |
| `--json` | Print `{ breaking, nonBreaking, operations }` as JSON. |

## `openapi-lint`

Lints OpenAPI 3 / Swagger 2 documents (files or http(s) links; with none given, every document in the workspace's `specs/` folder). Each problem is printed as `file:line:column`, with its level and rule. See [Lint API definitions](/test-runner/ci-cd#lint-api-definitions) for the rules.

```bash
testpion openapi-lint specs/clinic.yaml
testpion openapi-lint --fail-on warning --disable operation-tags,component-unused
```

| Option | Description |
|---|---|
| `-w, --workspace <dir>` | With no documents given: the workspace folder whose `specs/` to lint. |
| `--disable <rules>` | Rules to leave out, comma separated. |
| `--severity <level>` | Show only `error`, `warning` or `info` (the default) and worse. |
| `--fail-on <level>` | Exit `1` when a problem of this level or worse is found: `error` (the default), `warning`, `info` or `none`. |
| `--rules` | List the rules and exit. |
| `--json` | Print a list with one `{ file, problems, counts, operations }` per document as JSON (a list even for one document). |

## `mock`

Serves the [saved examples](/api-testing/collections#examples) of a collection on `127.0.0.1` until you press Ctrl+C. See [Mock servers](/api-testing/mock-servers) for how requests are matched to examples.

```bash
testpion mock "Veterinary API" -p 4545
testpion mock api.postman_collection.json      # Postman saved responses work too
```

| Option | Description |
|---|---|
| `-w, --workspace` | Workspace name or directory (default: nearest `workspace.json`). |
| `-p, --port <port>` | Port to listen on (default: any free port; the URL is printed). |
| `--delay <ms>` | Delay every response. |
| `-q, --quiet` | Don't log requests. |

## `mock-mcp`

Serves an [MCP mock](/mcp/mocking) (`*.mcp-mock.yaml`: tools with canned responses, resources, prompts). By default it speaks MCP over stdio, so AI agents can start it as a command; logs go to stderr.

```bash
testpion mock-mcp mocks/customer.mcp-mock.yaml
testpion mock-mcp mocks/customer.mcp-mock.yaml --http -p 3333   # Streamable HTTP on 127.0.0.1
```

| Option | Description |
|---|---|
| `--http` | Serve over Streamable HTTP on `127.0.0.1` instead of stdio (the URL is printed). |
| `-p, --port <port>` | Port for `--http` (default: any free port). |

## `graphql-op`

Builds a [ready-to-run operation](/graphql/schema-explorer#build-an-operation) for one root field: variables for its arguments (with placeholder values) and a selection of its fields. The schema comes from `--schema` (SDL or an introspection result) or by introspecting `--endpoint`.

```bash
testpion graphql-op Query.patient --endpoint http://127.0.0.1:4011/graphql -H 'Authorization: Bearer …'
testpion graphql-op Mutation.createPatient --schema schema.graphql --json
```

| Option | Description |
|---|---|
| `--schema <file>` / `--endpoint <url>` | Where the schema comes from. |
| `-H, --header <key:value...>` | Headers for introspection. |
| `-d, --depth <n>` | Levels of nested objects to select (default 2, at most 6). |
| `--required-args` | Only the required arguments. |
| `--json` | Print `{ operation, operationName, query, variables }`. |

## `ws`

Connects to a [WebSocket or Socket.IO](/api-testing/websocket) server, sends messages (WebSocket) or emits events (Socket.IO) in order, prints everything the server sends while it listens, then closes. The exit code is 3 when it can't connect (the reason is printed).

```bash
testpion ws ws://127.0.0.1:4013 -m '{"type":"ping"}' -m second
testpion ws http://127.0.0.1:4015/chat -e 'say={"text":"hi"}' --ack --json
```

| Option | Description |
|---|---|
| `-m, --message <text...>` | WebSocket messages, in order. |
| `-e, --emit <event=json...>` | Socket.IO events with their argument (a JSON list gives several arguments). Implies Socket.IO. |
| `--ack` | Socket.IO: wait for acknowledgements. |
| `--socketio` | Use Socket.IO (the default for `http(s)://` URLs). |
| `-H, --header <key:value...>` | Handshake headers. |
| `--auth <json>` | Socket.IO handshake auth payload. |
| `-w, --wait <ms>` | How long to listen after sending (default 1500). |
| `--json` | Print the result as JSON, for scripts and AI agents. |

## `mqtt`

Connects to an [MQTT broker](/api-testing/websocket#mqtt), subscribes to topic filters, publishes messages in order, prints everything that arrives while it listens, then disconnects. The exit code is 3 when it can't connect (for example when the broker refuses the login).

```bash
testpion mqtt mqtt://127.0.0.1:4016 -s 'clinic/+/vitals' -w 5000
MQTT_PASSWORD=… testpion mqtt mqtts://broker.example.com -u vet -s 'clinic/7/acks' -p 'clinic/7/commands={"action":"recheck"}' -q 1 --json
```

| Option | Description |
|---|---|
| `-s, --subscribe <topic...>` | Topic filters to subscribe to first (`+` and `#` wildcards). |
| `-p, --publish <topic=payload...>` | Messages to publish, in order. |
| `-q, --qos <0\|1\|2>` | QoS for the subscriptions and messages (default 0). |
| `--retain` | Publish retained messages. |
| `-i, --client-id <id>` | Client ID (default: random). |
| `-u, --username <name>` | Username. The password is read from the environment variable named by `--password-env` (default `MQTT_PASSWORD`), never from the command line. |
| `--mqtt5` | Use MQTT 5 (default 3.1.1). |
| `-w, --wait <ms>` | How long to listen after publishing (default 1500). |
| `--json` | Print the result as JSON, for scripts and AI agents. |

## `kafka`

Connects to a [Kafka cluster](/api-testing/websocket#kafka), reads topics (new messages, or with `-b` from the beginning) in a consumer group of its own, produces messages in order, prints everything that arrives while it listens, then disconnects. The exit code is 3 when it can't connect.

```bash
testpion kafka kafka://127.0.0.1:4017 -r clinic.events -b
KAFKA_PASSWORD=… testpion kafka kafkas://broker.example.com:9094 -u app --mechanism scram-sha-512 -r confirmations -p 'orders={"id":42}' -k order-42 -H source:testpion --json
```

| Option | |
|---|---|
| `-r, --read <topic...>` | Topics to read (new messages). |
| `-b, --from-beginning` | Read the topics from the beginning. |
| `-p, --produce <topic=value...>` | Messages to produce, in order. |
| `-k, --key <key>` | The key of the produced messages. |
| `-H, --header <name:value...>` | Headers of the produced messages. |
| `-g, --group <id>` | Consumer group (default: one of its own). |
| `-u, --username`, `--mechanism`, `--password-env` | SASL login; the password comes from an environment variable (default `KAFKA_PASSWORD`). |
| `-w, --wait <ms>` | How long to listen after producing (default 3000). |
| `--json` | The result as JSON. |

## `grpc`

Calls a [gRPC](/api-testing/grpc) method described by `.proto` files (or, without `-p`, by the server through server reflection), or lists the methods (with example requests) when no method is given. The exit code is 0 for status `OK` and 1 otherwise.

```bash
testpion grpc localhost:4014 -p protos/vet/v1/pets.proto                  # list methods
testpion grpc localhost:4014 vet.v1.PetService/GetPet -p protos/vet/v1/pets.proto -d '{"id": "1"}'
testpion grpc grpcs://api.example.com vet.v1.PetService/ListPets -p pets.proto -H "authorization:Bearer $TOKEN" --json
```

| Option | Description |
|---|---|
| `-p, --proto <files...>` | The `.proto` files, including the ones they import. Leave out to use server reflection. |
| `-d, --data <json>` | The request message as JSON (a JSON list for client streaming), or `@file.json`. Default `{}`. |
| `-H, --metadata <key:value...>` | Metadata entries. |
| `--tls` | Use TLS (also on with a `grpcs://` address). |
| `--timeout <ms>` | Deadline (default 30000). |
| `--json` | Print the result as JSON, for scripts and AI agents. |

## `docs`

Writes the [documentation](/api-testing/collections#documentation) of a collection as Markdown: the collection description, a table of contents, then every folder and request with its description, URL, auth, parameters, headers, body and saved examples. Sensitive values are masked.

```bash
testpion docs "Veterinary API" -o API.md
testpion docs "Veterinary API" --html -o api.html   # one self-contained page to publish
testpion docs api.postman_collection.json > API.md
```

| Option | Description |
|---|---|
| `-w, --workspace` | Workspace name or directory (default: nearest `workspace.json`). |
| `-o, --out <file>` | Write to a file instead of standard output. |
| `--no-examples` | Leave out saved examples. |

## `feedback`

Build a feedback or problem report as Markdown, and a link to a pre-filled GitHub issue (nothing is sent). `-k` is `bug`, `idea`, `ui` or `question`; `--diagnostics` adds the version and platform; home folders and secret-looking values are masked.

```bash
testpion feedback -k idea -t "Import Swagger 2 examples" -m "Examples in Swagger 2 files are not imported" --json
```

## `agents init`

Write (or refresh) `AGENTS.md` in the workspace root, for coding agents (Claude Code, Codex, Cursor, Copilot): the workspace's folders, collections, environments (names only, never values), tests and flows, the commands and exit codes, the MCP server, how to add a request, a test or a flow, and the secrets and production rules. `--targets` adds `claude` (a one-line `CLAUDE.md` that imports `@AGENTS.md`) and `cursor` (`.cursor/rules/testpion.mdc`); AGENTS.md is always written.

Only the part between `<!-- testpion:begin -->` and `<!-- testpion:end -->` is TestPion's: your text around it, its line endings and a BOM stay as they are, and running it again replaces only that part (a file whose text would not change is not written). A `CLAUDE.md` that already names `AGENTS.md` gets no second pointer; a link inside the workspace (CLAUDE.md → AGENTS.md) is written once, a link outside it is left alone.

| Option | |
|---|---|
| `--targets <list>` | `agents` (always), `claude`, `cursor`, comma-separated |
| `--force` | repair broken markers (a begin without its end, two blocks) instead of skipping the file |
| `--dry-run` | report what would be written, write nothing |
| `--json` | `{ workspace, root, dryRun, files: [{ target, path, status, reason? }] }`; status is `created`, `updated`, `unchanged` or `skipped` |

Exit code `2` when a file was skipped (broken markers, a folder where the file should be) or a target is unknown. `testpion agents-md` (0.45) is the same as `agents init`; `agents-md --stdout` prints the AGENTS.md part. The app does the same in **Settings ▸ AI agents (MCP) ▸ Write AGENTS.md** and agents with the `agents_init` MCP tool. See [Use TestPion from AI agents](/ai-testing/mcp-server#agents-md).

```bash
testpion agents init -w my-workspace --targets agents,claude,cursor --json
```

## `ai`

TestPion's own [AI tasks](/ai-testing/ai-features) from the terminal and CI, with the model of `--provider` / `--model`, `TESTPION_AI_PROVIDER` / `TESTPION_AI_MODEL` (`_SMALL` / `_LARGE` per tier), or the app settings. Calls are counted in the workspace's AI usage (surface `cli`, or `ci` when `CI` is set) and refused over the caps of the AI settings; `TESTPION_AI_LOCAL_ONLY=1` allows only models on this computer.

| Command | What it does |
|---|---|
| `ai tasks` | The tasks: id, title, tier, output, whether it proposes changes, verifiers. |
| `ai run <task>` | Run a task. Context from `--item <ref>` (`request:<c>:<r>`, `history:<id>`, `run:<id>[:<resultId>]` (`run:last`: the newest finished run, the rule of `ci --run last`), `test:<path>`, `flow:<path>`, `spec:<path>`, `collection:<id>`, `folder:<c>:<f>`) and/or `--context <json\|@file>`; `-q` the question; `--privacy full\|metadata\|names`; `--hint`; `--path` where a test file goes; `--target` where a request goes; `--max-tokens`; `-e` environment (variable names only). Prints the answer (streamed) and, for a generating task, a **proposal** with each item's verification. `--dry-run` prints what would be sent and sends nothing. `--apply [--items i1,i3]` applies at once. |
| `ai triage` | Explain and fix a failed run's failures (`--run <id\|last>`, default `last`: the newest finished run with failures): grouped by cause, each with evidence, a confidence and a fix verified against the failing and the last passing response, as a proposal (nothing changes before `--apply` or `ai apply`). `--privacy full\|metadata\|names`, `--hint`, `--provider` / `--model`, `--no-ai` (the grouping alone; also what you get, with exit code `0`, when no model is set up), `--dry-run`, `--apply [--items i1,i3]`, `--json`. See [Explain and fix failures](/ai-testing/ai-features#explain-and-fix-failures-triage). |
| `ai attempt-fix <id>` | A flaky-test analysis (`ai run analyze-flaky --item test:<path>[:<step>]` or `test-case:<testId>`): apply its fix (the ticked items, or `--items`) and run the test `--times` times (default 5, 1–20); prints *Stable: passed 5/5*, *Still flaky* or *Failing*, kept with the proposal (exit code `0` whatever the verdict: `--json` has `attempt.verdict`; `ai undo <id>` puts the test back); in an environment marked as production its data-changing requests need `--allow-production`. See [Why is this flaky?](/ai-testing/ai-features#why-is-this-flaky) |
| `ai apply <id>` | Apply a proposal's ticked items (or `--items`). Takes the generic `--dry-run` (lists the files it would write; nothing changes). |
| `ai undo <id>` | Put back what an applied proposal replaced. |
| `ai discard <id>` | Discard a proposal. |
| `ai proposals` | The workspace's proposals (`--status`), or one in full (`--id`). |
| `ai usage` | Calls, tokens and cost today and over `--days` (default 30), per task, model and surface, and the caps. |

```bash
testpion ai tasks --json | jq -r '.data.tasks[] | select(.proposes) | .id'
testpion ai run generate-assertions --item request:veterinary-api:req-get --dry-run
testpion ai run explain-error --context @error.json --privacy metadata --provider ollama
testpion ai run design-flow -q "create a patient, read it back" --path flows/patients.yaml --json | jq -r .data.proposal.id
testpion ai apply ai-mvbu2qjg9a3b644187 --json
testpion ai triage --privacy metadata --dry-run          # the last failed run: its groups, and what would be sent
testpion ai triage --run last --apply                     # causes, verified fixes, applied (then rerun the affected tests)
testpion test tests/ --triage                             # CI: a Triage section after a failed run; the exit code is the run's
testpion ai run analyze-flaky --item test:jobs/report.yaml    # why a test is flaky, with a verified fix (--no-ai, or no model: TestPion's own finding)
testpion ai attempt-fix ai-mvckdy5ve28aa50ec9 --times 5   # apply it, run the test 5 times: Stable: passed 5/5
```

`suggest-assertions` is an alias of `generate-assertions`, `generate-tests` of `generate-pm-tests`. A task that answers in JSON (`triage-run`, `analyze-flaky` …) is printed as its proposal — the findings with their evidence, then the items — not as the raw JSON. With `--item request:<c>:<r>`, suggested checks and tests are verified against the request's latest response in History (sent from the app); without one each item says *no response to check against*. `ai run --json` returns `{ task, taskVersion, provider, model, text, truncated, finishReason, problems, repairs, calls, usage, ms, preview, proposal?, applied? }`; `preview` is what was (or, with `--dry-run`, would be) sent: the model, privacy level, sections, masks and estimate (and the messages on a dry run). Exit code `2` when no model is set up (`ConfigurationError`, *The AI assistant is off*) — except `analyze-flaky`, which then prints TestPion's own finding (the signature, the likely pattern, *note: no model configured*) and exits `0`, as with `--no-ai` (`--json`: `{ task, testId, name, signals, runs, finding, ai: false, fallback }`) — Local only refuses the provider, or a cap refuses the call — nothing was sent. Exit code `1` (envelope `status: "failed"`) when the answer is still invalid after the repairs: `problems` lists why (without `--json` they are printed under the answer). With the global `--dry-run`, `ai apply` prints *would apply …* and the files it would change, nothing else. See [AI features](/ai-testing/ai-features#from-the-terminal-agents-and-ci).

## `rag` {#rag}

RAG systems under test (the RAG bots rail item ▸ Bots; the guide is [RAG testing](/ai-testing/rag), the metrics are [RAG metrics](/ai-testing/rag-metrics)). All take `--json`.

| Command | What it does |
|---|---|
| `rag sample` | The first result in one command: makes an offline bot (an MCP mock with four clinic documents), six questions and the evaluation *Sample: clinic bot* with the offline demo model as the reviewer, and runs it (4 of 6 pass; two fail on purpose). `--no-run` only makes it. No key, no network, no server. |
| `rag targets` | The RAG targets of the workspace (protocol, the mapping in a line, what stops one from being called). |
| `rag probe [target] [question]` | One real question to a target (a saved one, or `--file target.yaml`): the answer, the retrieved contexts with id, score and source, usage and latency, the warnings of the mapping, and with `--raw` the response the mapping reads. `-e` picks the environment; `--allow-production` as for any request that is not a read. |
| `rag connect <preset\|file> --name <name>` | Save a target without the app, from a preset (`openai-compatible`, `openai-compatible-stream`, `langserve`, `llamaindex`, `haystack`, `dify`, `flowise`, `generic-json`) or from a request file. `--var key=value` puts a value into the request (`{{ragUrl}}`), `--answer`, `--contexts`, `--text`, `--id`, `--score` set the mapping, `--concurrency`, `--rpm`, `--retries` the limits, `--read-only`. |
| `rag metrics` | The catalogue: id, kind (no model / judge / embeddings), direction, what it reads, judge calls per sample, other names. `--group`, `--kind`, `--search` (an id, an older name or a Ragas name). |
| `rag metric show <name>` | One metric: what, how, a worked example, inputs, calls, the names it answers to and the options a Ragas name implies. |
| `rag metric test <name>` | Try a metric on one sample (`--sample file.json`, `--run <id> --record <id>`, `--probe "q" --target <name>`, or `--question --answer --context --reference --reference-id`). `--dry-run` prints the exact judge prompts and sends nothing (and says how many pictures would be sent); `--judge provider/model`, `--option mode=chunks`, `--image <file|url|data:>` with `--allow-images` for a multimodal metric (the judge must be able to see). A conversation, tool calls or a safety probe come in the `--sample` file (`record`). Exit 1 when it does not pass. |
| `rag metric list\|new\|validate\|export\|import` | Your custom metrics (`metrics/*.yaml`, see [Custom RAG metrics](../ai-testing/custom-metrics.md)): list them, start a file of a kind (`new <id> --kind judge\|checklist\|rule\|formula\|embedding-set\|script\|dag`, or `--from-description "…"` to have the AI draft it), check one and run its examples (`validate <id> --examples`), copy to or from another workspace. |
| `rag metric example <metric> --run <run> --result <id>` | Make an example of a labelled sample: it is added to the `examples:` of the custom metric's file, `--expect pass\|fail` (default: your label of that result) being what the metric must say. |
| `rag generate-dataset <docs…>` | A test set from documents: `--url`, `--count`, `--types single-hop,multi-hop,abstract,unanswerable,adversarial`, `--name`, `--seed`, `--persona`/`--style` (who asks and how, repeatable), `--dedupe embedding` and `--embedder` (find repeats by meaning), `--judge`, `--max-cost`, `--estimate`/`--dry-run`, `--apply`. It only proposes; `--apply` adds the rows that passed their checks to `datasets/<name>.jsonl`. |
| `rag capture` | A dataset from real calls: `--target`, `--from history\|debugger\|run\|har\|messages` (`--messages <WebSocket log>`; a gRPC or MCP target is read from History as questions), `--name`, `--limit`, `--sample`, `--dedupe`, `--since/--until`, `--as-questions`, `--dry-run`. Secrets and personal data are masked first. |
| `rag draft-references <dataset>` | The AI drafts reference answers for the records of a captured dataset that have none, from the passages each record retrieved (`--ids`, `--limit`, `--judge`, `--apply`, `--estimate`); every draft is checked against its passages. |
| `rag label <run>`, `rag label list\|clear` | Record your pass/fail verdict on a metric of a result (`--result id --metric m --pass\|--fail`); stored in `labels/*.json`. |
| `rag calibrate` | How well the judge agrees with your labels, per metric and judge model; `--tune` finds the pass mark that agrees most, `--apply` writes it, `--min-kappa k` exits 1 below k, `--out file` (`--format md\|json`) writes the report as a file; a jury shows a row for each member. |
| `rag author --target t` | Have the AI draft an evaluation (`--dataset`, `--docs`, `--spec`, `--goal`, `--slice-file`, `--apply`, `--estimate`); the gates are saved in the evaluation; dry-run on a few samples before it is offered. |
| `rag trend <evaluation>` | Metric means run by run (`--metric`, `--runs`, `--format table\|csv\|json`, `--fail-on-drop`); a change of judge is marked, not read as a drop. |
| `rag matrix <run>` | The samples × metrics matrix of a run: `--format csv\|json\|html` (default json), `--table` for the per-metric table instead, `--names ragas` to name the columns as Ragas does, `--ragas-result file` to add the scores of a Ragas result table beside yours, `-o file`. |
| `rag presets` | The metric presets (`rag-triad`, `ragas-core`, `deepeval-rag`, `nvidia-rag`, `retrieval-only`, `free`, `answer-vs-reference`, `ragas-nl-comparison`, `safety`, `conversational`, `agentic-rag`, `multimodal`, `ops`) and the target presets. |
| `rag run <evaluation>` | Run a saved RAG evaluation with chosen metrics: `--metrics a,b` (ids, aliases, Ragas names, `recall@5`) or `--preset`, `--judge`, `--judges a,b --aggregate majority\|mean\|min`, `--swap`, `--repeat n`, `--short-circuit`, `--share-claims`, `--allow-images` (pictures of the sample go to the judge as data; off by default), `--when "context-recall=faithfulness < 0.8"` / `--unless …` (a decision tree: the metric runs only when another metric of the sample gave such a result), `--compat ragas`, `--repeat-target n`, `--two-phase`, `--max-cost usd`, `--max-calls n`, `--limit n`, `--target`. `--estimate` (with `--probe`) prints the judge calls, tokens and cost range and exits without a call. Gates: the evaluation's own `gates` (its Gates field) and `--min faithfulness=0.8` (repeat; the mean must reach it; a `--min` for the same metric replaces the saved mark). `--baseline <run>` compares metric by metric (`--max-regression`). Reports: `--junit f`, `--html f`, `--report-json f`, `--markdown f` (the metrics table, for a pull-request comment). Exit 1 on a failed gate or a regression, 2 on a configuration error. |
| `rag rescore <run>` | Score a finished run again with `--metrics`/`--preset`/`--judge`/`--judges`/`--swap`/`--repeat`: its stored answers and contexts are used and the RAG system is not called; a new run is recorded. `--estimate` is exact (the cache hits are counted). `--min`, `--junit`, `--html`. |
| `rag compare <run> -b <baseline>` | The two runs metric by metric: means, the difference over the samples both scored, a 95% interval (seeded paired bootstrap) and whether it is real. Exit 1 on a regression. `--min-delta`. |
| `rag probes list|add [sets…]` | The [seeded safety probe sets](../ai-testing/rag.md#r3-safety): list them and which are in the workspace, or write them to `datasets/probes-<set>.jsonl` (a file that exists is kept, so your own lines stay). Run one with `rag run … --preset safety`. |
| `rag cache clear` | Empty the judge cache (verdicts stored by the content hash of the prompt). |
| `rag import <file>` | A dataset of another tool (Ragas, DeepEval, NVIDIA retriever data, promptfoo tests, or BEIR queries with `--qrels` and `--corpus`; JSON, JSONL, CSV, YAML; only data is read) as TestPion records (`question`, `reference`, `reference_contexts`, `reference_ids`, `tags`). `--from ragas\|deepeval\|nvidia\|promptfoo\|beir\|testpion` (default: found by the columns), `-o` writes JSON Lines, `--format json` an array. Notes on what was left out go to stderr. |
| `rag export <dataset> --to ragas\|deepeval` | A dataset file, or a saved evaluation by name, as Ragas or DeepEval records. `--run <runId>` adds the answer and retrieved contexts each record got in that run, `--names ragas` names the score columns as Ragas does so Ragas can run on the same file. |

`eval run` of a RAG evaluation checks the target and the judge before it sends the first question, and takes `--judge <provider/model>` and
`--max-judge-cost <usd>`. Without a usable judge it exits `2` and lists what to configure; the verdicts are cached, so a second run costs nothing.

## `eval sample`, `eval estimate`, `eval check`

`eval sample` makes the evaluation *Sample: support intents* (ten messages, the offline demo model, one check) and runs it: `--no-run` only makes it, `--json` prints the run. `eval estimate <name>` says what a run would cost (`--limit`, `--max-cost`, `--json`). `eval check <name>` tries one check on one case (`--type` with `--expected`, `--path`, `--criteria`, or `--check '{json}'`; `--case n`; `--dry-run` sends nothing; a paid model needs `--yes`). See [Evaluations](/ai-testing/evaluations#what-a-run-costs-and-the-spend-cap).

## `eval generate-cases`, `eval trust`

`eval generate-cases <name>` writes test cases for a saved prompt evaluation with the configured AI model. `--from` is `prompt` (the default), `spec` (with `--spec specs/<file>`), `collection` (with `--collection <name|id>` and optionally `--folder`), `documents` (with `--documents <paths…>` and `--url`, the engine of `rag generate-dataset`) or `history` (with `--history-limit`). `--count` is 1 to 30; `--hint` says what to focus on; `--provider demo` uses the offline demo model; `--dry-run` shows what would be sent and the estimate and sends nothing. Every case is verified and the result is one proposal; `--apply` adds the ticked cases to the evaluation (`testpion ai undo <id>` takes them back). `eval trust <run|last>` lists ten answers of a run for you to grade with the reviewer's verdict hidden (`--grade <resultId> --as pass|fail|clear` records yours; `--check` picks the check; `--count` changes how many), and once all are graded says how often the AI reviewer agreed. Both take `--json`. See [Evaluations](/ai-testing/evaluations#generate-test-cases-with-ai).

`eval run` stops at a spend cap (`--max-cost <usd>`: $1.00 for a paid model, none for the offline demo model, `0` for no cap), refuses a run estimated over $0.50 or 100 calls until `--yes`, and takes `--baseline last-good`, the last run of the evaluation that passed (the first run has none and becomes it). `ci <provider> --evaluation <name>` writes the pipeline for it.

## `eval summary`, `eval why`, `eval diff`, `eval variants`

`eval summary [run]` prints the report card of a run (an id, `last`, or an evaluation name; `--against <run>` compares with another run than the one before; `--json` has `headline`, `byCheck`, `failures`, `passLine`, `vsLast`, `trend` and `text`). `eval why <run> <case>` says why a failed case failed: the stored reason of an AI reviewer, else the AI task `eval-why` with your model (`--dry-run`, `--no-ai`, `--privacy`). `eval diff <run> <case>` shows the case's answer against the same case in the run before (`--against`). `eval run <name> --variants` runs the evaluation and each of its versions (set in the app's Compare) as runs of their own and prints the comparison; `eval variants <name>` prints it again from the latest runs (`--json`). A case is its key (`case-7`), its result id or its name. See [Evaluations](/ai-testing/evaluations#compare).

## `eval compare` and `eval matrix`

`eval compare <run> --baseline <run>` compares an evaluation run with a baseline run case by case and exits `1` when more cases regressed than `--max-regressions` (default `0`): for CI after `eval run`. A case regressed when it stopped passing or its mean score dropped by more than `--threshold` (default `0.05`, strictly more); improvements, missing and new cases are listed apart, and `--fail-on-missing` fails on a missing case too. Runs are ids, `last` or names (the newest finished run of that name). `--json` prints the report (counts, per-variant pass rate and mean score change, the lists, `passed`).

`eval matrix <runs…>` prints a page of the cases × variants matrix (`--baseline`, `--filter all|failed|regressed|improved|changed|missing`, `--tag`, `--sort case|score|delta|failures`, `--offset`, `--limit`, `--json`). See [Compare runs as a matrix](/ai-testing/evaluations#compare-runs-as-a-matrix).

```bash
testpion eval run "Intent v2" -q && testpion eval compare "Intent v2" --baseline "Intent v1" --threshold 0.05
```

## `jwt`

Decode a JSON Web Token: header, claims, when it was issued and when it expires. The signature is not verified. A `Bearer ` prefix is fine; `-` reads the token from standard input.

```bash
testpion jwt eyJhbGciOiJIUzI1NiJ9...
curl -s https://auth.example.com/token | jq -r .access_token | testpion jwt -
testpion jwt "$TOKEN" --json
```

## `export` and `export-environment`

Convert a collection to a Postman v2.1 collection, or write an environment in Postman's environment format. See [Export](/api-testing/collections#export) for what the Postman format can hold.

```bash
testpion export "Veterinary API" -o vet.postman_collection.json
testpion export my.collection.json -f postman > out.json    # convert a file
testpion export-environment Staging -o staging.postman_environment.json
```

| Option | Description |
|---|---|
| `-w, --workspace` | Workspace name or directory (default: nearest `workspace.json`). |
| `-f, --format` | `postman` (default), `testpion`, `openapi`, `bruno`, `http`, `asyncapi`, `insomnia` (v5 YAML), `insomnia-v4` (JSON), `opencollection` (Bruno's YAML folder; `--out <folder>`) or `opencollection-file` (`export` only). The workspace's environments go with Insomnia and OpenCollection (secret values never). |
| `-o, --out <file>` | Write to a file instead of standard output. |

Parts that Postman can't represent are listed on standard error as `not exported: …`. Secret environment values are never written.

## `export` as a TestPion bundle

`testpion export` also writes a [bundle](/getting-started/export-import): any items of the workspace in one `.testpion.zip` (or `.testpion.json`) that `testpion import` and the app's Import… read back. It is a bundle when you give `kind:id` items, `--section`, `--all`, `--uses` or `--format bundle`; a collection name or id alone exports in the formats above, as before.

```bash
testpion export collection:clinic --uses --out clinic.testpion.zip -w my-workspace
testpion export spec:specs/pets.yaml dataset:users.csv mcp-server:petstore --out pets.testpion.zip
testpion export --section mcp-server --out servers.testpion.json
testpion export --all --out everything.testpion.zip --json
```

The items are `kind:id` (the registry's kinds and aliases: `collection:<id>`, `environment:<id>`, `spec:specs/<path>`, `dataset:<name>`, `test:<path>`, `mcp-server:<id>`, `mcp-mock:mocks/<file>`, `proto:protos/<file>`, `script-package:<name>`, `prompt:<id>`, `load-test:<id>`, `evaluation:<id>`, `monitor:<id>`, `grpc-call:<id>`, `ws-connection:<id>`, `provider:<id>`), an ItemRef from `--json` output, or a collection's name.

| Option | Description |
|---|---|
| `--section <kind>` | Every item of one kind. |
| `--all` | The whole workspace (AI providers only with `--providers`). |
| `--uses` | Add everything the items use: for a collection its environments, API definitions, datasets, protos, mocks, MCP servers, script packages, saved calls, monitors, load tests and the test and flow files that refer to it. What is named but not in the workspace is listed as `missing`. |
| `--datasets embed\|reference\|auto` | `auto` (default) includes a dataset up to 10 MB and sends a bigger one by reference. |
| `--title <text>` | The bundle's title (and its default file name). |
| `-o, --out <file>` | The file to write; `.zip` or `.json` picks the form (default `<title>.testpion.zip` or `.json` in the current folder). |
| `--json` | `{ path, format, size, title, counts, items: [{ kind, id, name }], replaced: [{ kind, item, field, variable }], requires, missing, notes }`. |

Secret values are never written: each is replaced by a `{{variable}}` (listed in `replaced` and `requires.secrets`).

## `bundle`

```bash
testpion bundle inspect clinic.testpion.zip --json
```

`bundle inspect <file>` reads a bundle without a workspace: its title and maker, the items by kind, the secrets to fill in, what to review before running (scripts, programs an MCP server starts, production environments) and what was left out. `--max-size <mb>` refuses a larger file.

## `workspace export`

A whole workspace as one [bundle](/getting-started/export-import) (the file `testpion export --all` writes): everything a workspace defines, which `testpion import` merges into a workspace and **Import** in the app opens as a new workspace. See [Export the whole workspace](/api-testing/collections#export-the-whole-workspace) for what it holds.

```bash
testpion workspace export "Veterinary API (example)"     # writes "Veterinary API (example).testpion.zip"
testpion workspace export ./vet -o vet.testpion.zip --json
```

```text
Exported to Veterinary API (example).testpion.zip
Exported 24 items: 1 collection, 2 environments, 16 test files, 3 API definitions, 2 datasets.
Replaced 1 secret with variables: {{clientSecret}}. Set them in the other workspace.
```

| Option | Description |
|---|---|
| `<nameOrPath>` | The workspace's name or folder. |
| `-o, --output <file>` | The file to write (default: `<workspace name>.testpion.zip`, or `.testpion.json` for a small bundle of text, in the current folder). |
| `--format <zip\|json>` | The file form (default: a zip when the bundle has a binary file, is over 5 MB or has over 200 entries). |
| `--legacy` | Write the one-file workspace export of 0.53 and earlier (`<name>.testpion.json`) for a TestPion that cannot read bundles; removed in a later release. |
| `--json` | `{ path, format, size, counts, collections, environments, tests, files, replaced: [{ kind, item, field, variable }], notes, lines }`: each secret replaced by a `{{variable}}` (never its value) and each dataset left out by reference (over 10 MB). |
| `--dry-run` | Write nothing; list the file it would write. |

## `import-report` and `import-undo`

```bash
testpion import-report -w my-workspace                 # the imports that still have a report (the last 30)
testpion import-report imp-1a2b3c -w my-workspace --markdown
testpion import-undo imp-1a2b3c -w my-workspace         # collections, environments, API definitions to Recently deleted; flow files removed
testpion import-undo imp-1a2b3c -w my-workspace --force # even if an imported collection was edited since
```

`import-undo` changes nothing and exits 2 while an imported collection or flow file was edited after the import (it names them). `testpion trash restore` brings back what it moved.

## `import`

A TestPion bundle (`.testpion.zip`, `.testpion.json`, or a workspace export of earlier versions) is detected by its content and merged into the workspace with a preview and conflict choices; any other file or link is imported as below.

```bash
testpion import clinic.testpion.zip -w my-workspace --preview --json        # what would happen; nothing is written
testpion import clinic.testpion.zip -w my-workspace --on-conflict keep-both  # the default; replace and skip are the others
testpion import --undo imp-1a2b3c4d5e6f -w my-workspace                      # take the import back
testpion import --list -w my-workspace                                       # imports that can be undone
testpion import openapi.yaml -w my-workspace
testpion import openapi-v2.yaml -w my-workspace --replace-spec   # replace the document of the same name (default: keep both)
testpion import ./bruno/clinic-api -w my-workspace      # a Bruno collection folder (bruno.json + .bru files)
testpion export "Clinic API" -w my-workspace --format bruno --out ./bruno/clinic-api   # and back
testpion import 'http://127.0.0.1:4010/soap/patients?wsdl' -w my-workspace   # a SOAP service's WSDL
# a request copied from browser devtools (cURL for bash or cmd, fetch, PowerShell), from a file or stdin
testpion import copied-request.txt -w my-workspace --collection "Checkout API" --folder "Cart" --json
pbpaste | testpion import - -w my-workspace
testpion import adopt-pet.arazzo.yaml -w my-workspace --json   # Arazzo: one flow file per workflow under tests/arazzo/
```

| Option | Description |
|---|---|
| `-w, --workspace` | Workspace name or directory (required). |
| `--collection <name>` | For a copied request: the collection to add it to, created if needed (default **Imported**). |
| `--folder <path>` | For a copied request: folder path inside the collection, such as `"Auth / Tokens"`. |
| `--name <name>` | For a copied request: its name (default: the method and path, e.g. `POST /v1/owners`). |
| `--no-contract-checks` | For an OpenAPI / Swagger document: don't add `openapi` contract checks to the imported requests (the document is still kept in `specs/`). |
| `--replace-spec` | For an OpenAPI, AsyncAPI or GraphQL schema document whose path in `specs/` holds a different document: replace it (the old one goes to the trash, `testpion trash list`). By default both are kept and the new one is saved as `name-2` (`specs/petstore-2.openapi.yaml`), with a note. |
| `--preview` | A bundle: print what importing would do (per item: `create`, `identical`, `conflict` with the name Keep both would give it, `invalid` with why), what to review and what to fill in. Nothing is written. |
| `--on-conflict keep-both\|replace\|skip` | A bundle: what happens to an item that is already here (default `keep-both`: the incoming one is renamed). `replace` can be undone with `--undo`. |
| `--only <kinds>` | A bundle: import only these kinds or `kind:id` items (comma separated). |
| `--decisions <file>` | A bundle: a JSON file of `"kind:id": "keep-both" \| "replace" \| "skip"` for single items. |
| `--undo <importId>` | Take back a bundle import: what it made is removed, what it replaced is restored; a file edited since is kept and named. |
| `--list` | The bundle imports that can be undone. |
| `--max-size <mb>` | A bundle: refuse a larger file. |
| `--keep-pm` | For a Postman or Insomnia file: keep `pm.*` in scripts. By default they are converted to TestPion's `tp.*` and the output says `Converted N scripts to tp.* (--keep-pm keeps pm.*)`; for other tools (Bruno's `bru.*` …) it says only `Converted N scripts to tp.*`, since `--keep-pm` changes nothing there (`pm.*` runs either way; `testpion export -f postman` turns `tp.*` back into `pm.*`). |
| `--lift-tests` | Turn simple tests (a status, a response time, a header, a JSON field, a body text) of the scripts into assertions. The preview says how many can be. |
| `--new-copy` | A source imported before updates the collection it made (item by item: replace what changed in the source, add what is new, leave what you edited), and so does this command by default; `--new-copy` adds a second collection instead. |
| `--update-decisions <file>` | An update: a JSON file of `"<item key>": "replace" \| "new" \| "skip"` (the keys `--preview` prints) overriding what the update would do for single items. |
| `--fetch-sources` | For an Arazzo document: download the OpenAPI source descriptions given as http(s) links. By default they are looked up next to the Arazzo file and in the workspace (`specs/`); an `operationId` whose document is not found becomes a skipped step to fill in. |
| `--preview` | Say what importing would create and what would not come over (the compatibility report), and write nothing. For a bundle: what importing would do per item. With `--json`: `{ preview: true, inputs: [{ input, plan }], skipped, totals }`. |
| `--apply` | Import several files, a folder or a ZIP (they are previewed by default); one plain file is imported at once. |
| `--report <file>` | Write the compatibility report: `.json`, or `.md` for Markdown. |
| `--postman-api-key <key>` | A Postman API key for `postman:collection/<id>`, `postman:environment/<id>`, `postman:workspace/<id>` and api.getpostman.com links (or the `POSTMAN_API_KEY` variable). Sent only to api.getpostman.com. |
| `--json` | Print the result as JSON, for scripts and AI agents (includes `specPath` and `contractChecks` for OpenAPI imports, `flows` — `[{ path, workflowId, steps }]` — for Arazzo imports, `notes` (what did not map one to one, for every import: unsupported auth, template tags, values needed, a spec saved as `name-2` …), `report` (the compatibility report: counts, `summary` fully / changed / not imported, `groups`, and every finding with its item path), `importId` (what `import-undo` and `import-report` take) and `scripts` — `{ converted, unchanged: [{ where, reason }], warnings }` — for Postman, Insomnia and Bruno imports). Without `--json`, the output lists the first 20 notes under *Check after import (N notes)*. |

What did not map one to one is listed after the result, naming the request (all of them under `notes` with `--json`; [Import fidelity](/getting-started/import-fidelity) lists what each importer maps):

```text
Imported postman: collection "Hawk sample (Postman)"
Check after import (1 note):
  "Health with Hawk": Postman auth "hawk" is not supported, so it was set to No auth (not inherited) with a disabled X-Imported-Auth-Hawk header as a reminder: set it up by hand
```

An Arazzo document's workflows become flow files: operations become method and URL (`{{baseUrl}}` + path), `$inputs.x` becomes `{{x}}`, `$steps.s.outputs.o` becomes `{{s_o}}` with an `extract` on step `s`, success criteria become checks, a retry action `retries`. See [Arazzo workflows](/test-runner/integration-testing#arazzo-workflows-import-and-export) for the whole mapping and `testpion flow export` for the way back.

Secrets in a copied request (the `Authorization` header and other sensitive headers, auth credentials, cookies, and sensitive query or body fields) are not written to the workspace. They are replaced by `{{variables}}`, and the output lists them (`placeholders` with `--json`) so you can add them as secret environment variables.

## `flow generate`

```bash
testpion flow generate --collection "Veterinary API" --folder Patients -w my-workspace
testpion flow generate --collection veterinary-api --folder fld-patients --privacy metadata --dry-run
testpion flow generate --collection "Veterinary API" --folder Patients --hint "also test pagination" --apply --json
testpion flow generate --collection "Veterinary API" --folder Patients --no-ai
```

Your model writes an integration flow from the saved requests of a collection or one folder: steps that use those requests by id (a step naming one that is not there is dropped), create → read → update → delete, values extracted and passed on, status and key-field checks, one or two error cases, and its assumptions. It starts from the flow TestPion builds without AI, and it is verified before it is shown: lint (cycles, unknown `dependsOn`), every `{{variable}}` extracted by a step it waits for, a run on a mock of the collection. Nothing is written without `--apply` (or `testpion ai apply <id>`). See [Let AI write the flow](/test-runner/integration-testing#let-ai-write-the-flow).

| Option | Description |
|---|---|
| `--collection <nameOrId>` | The collection (required). |
| `--folder <nameOrId>` | One folder: its name, its path (`Orders/Refunds`) or its id. |
| `--hint <text>` | An extra instruction (*also test pagination*). |
| `--privacy <level>` | `full` (redacted, default), `metadata` (methods, URLs, shapes and names; no body values), `names`. |
| `--path <file>` | The flow file under `tests/` (default `tests/flows/<collection>-<folder>.yaml`, a free name). |
| `--provider <id>`, `--model <name>` | The model (default: `TESTPION_AI_PROVIDER` / `TESTPION_AI_MODEL[_LARGE]`, then the app settings). |
| `--no-ai` | Only the deterministic draft (no model is called). Without a model set up this is what you get, with a note. |
| `--dry-run` | Send nothing: print what would be sent (messages, sections, tokens, cost, what was masked). |
| `--apply` | Write the flow when its verification did not fail (else it stays a proposal). |
| `-e, --environment <name>` | Environment whose variable names (never values) the flow may use. |
| `--json` | `{ proposal, model, usage, costUsd?, repairs, problems, applied? }`; without a model `{ proposal, model: "none (deterministic draft)", fallback }`; with `--apply` on a flow whose verification failed, `applied: null` and `why`. `--dry-run`: the task result with its `preview`. |

A file that already exists is not replaced: the default name gets a number (`veterinary-api-patients-2.yaml`). Exit code `2` for an unknown collection or folder, a path outside `tests/`, Local only refusing the provider or a cap refusing the call.

## `generate gaps` and `generate tests`

```bash
testpion generate gaps --spec specs/veterinary-api.yaml
testpion generate tests --spec specs/veterinary-api.yaml --category negative,boundary --dry-run
testpion generate tests --spec specs/veterinary-api.yaml --no-ai --apply
```

`generate gaps` says what the workspace's tests and collections never prove about an API definition (operations never called, documented statuses never asserted, no negative / boundary / security test, no contract check, parameters never sent). It needs no model: `--json` gives `{ report, draft }`. `generate tests` proposes tests for those gaps — TestPion's own cases built from the document plus, with a model, its ideas, all validated against the document — and the coverage before → after. Nothing is written without `--apply` (or `testpion ai apply <id>`). See [Tests from a spec](/ai-testing/ai-features#tests-from-a-spec).

| Option | Description |
|---|---|
| `--spec <file>` | The API definition in the workspace (required). |
| `--ai` / `--gaps-only` | Accepted for clarity: the model's ideas (when one is set up) and only what the gaps need are the defaults; `--no-ai` and `--no-gaps-only` turn them off. |
| `--category <list>` | `positive`, `negative`, `boundary`, `security`, comma separated (default all). |
| `--operation <list>` | Only these: `"POST /patients"` or an operationId. |
| `--no-gaps-only` | Every category for every operation, not only what the gaps need. |
| `--include-delete` | Also DELETE operations. |
| `--hint`, `--privacy`, `--path`, `--provider`, `--model`, `-e` | As for [`flow generate`](#flow-generate). `--path` puts all tests in one file under `tests/`. |
| `--no-ai` | Only the deterministic cases. Without a model set up this is what you get, with a note. |
| `--dry-run`, `--apply` | Send nothing and print what would be sent; write the files whose verification did not fail. |
| `--json` | `{ proposal, model, usage, costUsd?, repairs, problems, applied? }`. |

## `tidy --ai`

```bash
testpion tidy "HAR import" --ai --source har
testpion tidy "HAR import" --ai --flow --apply
```

`testpion tidy <collection> --ai` proposes the clean-up of an import as separate, verified changes: names and folders, a host and a repeated token as variables, ids chained from the response that returns them (`tp.*` scripts), tracking, static and duplicate requests dropped, optionally a flow (`--flow`). Every remaining request sends exactly what it sent before. Options: `--source <format>`, `--hint`, `--privacy`, `--provider`, `--model`, `--no-model` (only what TestPion finds itself), `--dry-run` (send nothing), `--apply` (the ticked changes; `testpion ai undo <id>` reverts), `-e`. `--dry-run` without `--ai` reports what `--remove-*` would remove. See [Tidy an import](/ai-testing/ai-features#tidy-an-import).

## `security generate` and `security run`

```bash
testpion security generate --collection "Veterinary API" --identities owner=tokenA,other=tokenB -e staging
testpion security generate --collection "Veterinary API" --folder Patients --include-write --apply
testpion security run security/veterinary-api.yaml -e staging
```

`generate` proposes OWASP API probes (BOLA, broken authentication, mass assignment, admin functions) as one test file; the model chooses what to probe, TestPion writes the steps and every verdict is a check computed from the responses. `--identities` names the variables that hold the two users' credentials (names only); GET requests only unless `--include-write` / `--include-delete`; `--probes`, `--rate` (requests a second, default 4), `--max` (default 40); `--no-ai`, `--dry-run`, `--apply`, `--json` as `generate tests`. `run` runs a generated file one step at a time and prints a verdict per step (finding, pass, inconclusive), exit code 1 on a finding. Both refuse an environment marked as production unless `--allow-production`.

## `openapi-drift`

```bash
testpion openapi-drift --spec specs/veterinary-api.yaml --limit 200
testpion openapi-drift --spec specs/veterinary-api.yaml --har captures/day.har --ai
testpion openapi-drift --spec specs/veterinary-api.yaml --run last --propose --apply
```

Compares an OpenAPI document with real traffic (`--har <file>`, `--run <id>`, else History with `--limit`, `--host`, `--request`) and reports the drift without a model. `--ai` has the configured model explain each finding and propose the fix (a spec patch made from what was observed, a contract check), verified against the same traffic; `--propose` offers TestPion's own patches; `--apply` writes the ticked ones (`testpion ai undo <id>` restores the file); `--dry-run`, `--privacy`, `--hint`, `--json`.

## `ai script`

```bash
testpion ai script --describe "send a fresh nonce in an X-Nonce header" --phase pre
testpion ai script --request request:veterinary-api:req-list --describe "save the first order id" --apply
testpion ai script --script login.js --error "TypeError: …" --describe "fix it"
```

Writes a `tp.*` script (never `pm.*`) and runs it once in the sandbox before offering it; the proposal says what it did. `--request` makes the saved request the context (and the target of `--apply`), `--phase pre|post`, `--mode append`. Checks tasks also take `--prefer-stable` on `testpion ai run`.

## `flow from-har`

```bash
testpion flow from-har session.har -w my-workspace
testpion flow from-har session.har -o tests/recorded/checkout.yaml -e Staging --json -w my-workspace
```

A HAR file (saved by the HTTP Debugger, a browser's developer tools, Fiddler …) as a flow file: one step per request in time order, each origin as `{{baseUrl}}`, values that came from an earlier response (tokens, ids, cursors) as `{{variables}}` with an `extract` and a `dependsOn`, the recorded status checked; static assets, preflights and analytics left out; secrets as variables to set. See [Record a flow](/test-runner/integration-testing#record-a-flow).

| Option | Description |
|---|---|
| `-o, --out <file>` | The flow file inside `tests/` (default: `tests/recorded/<name>.yaml`, a free name). |
| `--name <name>` | The flow's name (default: the HAR file's name). |
| `-e, --environment <name>` | Use this environment's variables that hold an origin or a secret that was sent, by name. |
| `--keep-noise` | Keep static assets, preflights and analytics requests. |
| `--noise-host <host...>` | More hosts to leave out as telemetry. |
| `--dry-run` | Print the YAML; write nothing. |
| `--json` | `{ file, steps, links, variables, secrets, dropped, notes, text }`. |

## `flow report`

```bash
testpion flow report rest/checkout.yaml -w my-workspace
testpion flow report rest/checkout.yaml --run run-ab12 --html checkout-timeline.html
testpion flow report rest/checkout.yaml --json
```

A run of a flow (the latest that included the file, or `--run`) as a timeline: each step's start and end, how long it waited and for which step, the steps that ran at the same time, the **critical path** (the chain of steps that decided the total time) and the slowest steps. See [Run timeline and critical path](/test-runner/integration-testing#run-timeline-and-critical-path).

| Option | Description |
|---|---|
| `--run <runId>` | The run (default: the latest run of the file; see `testpion flow runs`). |
| `--html <out>` | Write the timeline as one self-contained HTML file (inline SVG and CSS, no scripts, nothing from the network). |
| `--json` | `{ file, runId, run, timeline: { totalMs, bars: [{ id, name, status, start, end, lane, waitMs, blockedBy, critical }], lanes, criticalPath, criticalBusyMs, waitMs, slowest } }`. |

## `flow export`


```bash
testpion flow export arazzo/adoptpet.yaml --arazzo -o adopt-pet.arazzo.yaml -w my-workspace
testpion flow export checkout.yaml --spec specs/shop.openapi.yaml --json -w my-workspace
```

| Option | Description |
|---|---|
| `--arazzo` | The format: Arazzo 1.0 (the only one, and the default). |
| `--spec <file>` | The OpenAPI document (a workspace file) the requests are matched against. Default: the sources an Arazzo import noted at the top of the file, else the workspace spec in `specs/` that describes the most requests. |
| `--workflow-id <id>` | The `workflowId` (default: the one an import noted, else the file name). |
| `-o, --out <file>` | Write the document (`.yaml`, or `.json`); without it the YAML is printed. |
| `--json` | Print `{ file, out, document, notes, sources }`. |

What Arazzo cannot say (checks other than status, body and header ones, `if`, `forEach`, scripts, non-HTTP steps, a request no OpenAPI operation describes) is kept under `x-testpion-*` keys and listed as notes (on stderr without `--json`).

## `serve flows`

```bash
testpion flow edit orders/new-order.yaml --webhook /hooks/new-order --webhook-secret '{{ORDER_HOOK_SECRET}}' -w my-api
testpion serve flows -w my-api -e Staging                 # http://127.0.0.1:4020 until Ctrl+C
testpion serve flows -w my-api --port 0 --jsonl           # any free port; JSON lines for scripts
curl -X POST http://127.0.0.1:4020/hooks/new-order -H 'content-type: application/json' -H 'x-testpion-secret: <secret>' -d '{"customerId":"c-42"}'
```

Serves every flow with a `webhook:` block: a POST of a JSON body to its path runs the flow with the fields as its inputs and answers `{ ok, output, steps: [{ name, status, ms }], runId }` (`422` with `failedStep` when a step failed; `400` bad JSON or a missing input, `401` wrong secret, `404` unknown path, `405` other methods, `413` a body over 1 MB, `429` too many runs, `504` too slow). GET with a query works too. New and changed flows are picked up without a restart. See [Deploy a flow](/test-runner/integration-testing#deploy-a-flow).

| Option | Description |
|---|---|
| `-p, --port <port>` | Port (default `4020`; `0` picks a free one). |
| `--host <host>` | Address (default `127.0.0.1`, this machine only; `0.0.0.0` serves the network). |
| `-e, --environment <name>` | The environment every run uses. |
| `--max-concurrent <n>` | Runs at once before callers get `429` (default 4). |
| `--timeout <sec>` | A run longer than this is cancelled (`504`; default 120). |
| `--allow-production` | Let the flows change data in an environment marked as production. |
| `--jsonl` | One line `{ "type": "listening", "data": { url, port, hooks } }`, then one `{ "type": "call", "data": { path, method, status, file, runId, durationMs, error } }` per call (every line also has `schema_version` and `command`). `--json` means the same here. |

`testpion flow edit <file> --webhook [path]` adds or moves a flow's webhook (default path `/hooks/<file>`), `--webhook-secret <secret>` sets what callers send (`""` removes it) and `--no-webhook` removes the block; the `setWebhook` op (`{"op":"setWebhook","webhook":{"path":"/hooks/x","secret":"{{S}}"}}`, `null` removes it) does the same in `--op`.

## `scripts convert`

```bash
testpion scripts convert --to tp -w my-workspace --dry-run --json   # what would change
testpion scripts convert --to tp -w my-workspace --collection "Checkout API"
```

Rewrites collection, folder and request scripts written for Postman to TestPion's `tp.*` (or back to Postman's name with `--to pm`). Both names always run in TestPion; only code changes, not strings or comments, and scripts that declare their own `tp` are skipped and listed.

From another tool's script API:

```bash
testpion scripts convert --from bruno -w my-workspace --collection "Checkout" --lift-tests    # bru.*, req, res → tp.*; simple tests → assertions
testpion scripts convert --from thunder --file legacy.js --json                               # one script: the converted code, the findings
testpion scripts convert --from hoppscotch --file pre.js --report findings.json
```

`--from postman|insomnia|bruno|thunder|hoppscotch` converts to `tp.*` by the script's syntax tree (strings, comments and formatting are kept, a variable of your own named like the tool's object is left alone). A call with no equivalent gets a `// TODO(import)` line and a finding (`--report file` writes them); `--file` converts one script file (`-` reads standard input) and prints the result. `req.setTimeout(ms)` with a number moves to the request's settings when it is a collection that is converted by an import. [The tables](/migrate/) list every mapping.

## `kinds`

Every kind of item a workspace holds (the item-kind registry the app's menus are built from) and what each one offers. Without a kind, one line per kind with the capabilities it has; with one (an id or an alias: `mcp-server`, `library:grpc`, `test-file`), every capability: `yes`, `no (why it never applies)` or `planned for 0.5x`.

```bash
testpion kinds
testpion kinds spec
testpion kinds --json            # { kinds: [{ id, label, ref, library, aliases, storage, folders, opens, capabilities, can, facets, nodes }], workspace }
```

`--all` adds the kinds registered ahead of their release (RAG targets, custom metrics). The MCP tool `list_kinds` answers the same.

`nodes` is the menu of every row the kind has in the app (the item's row, its section header, its folders; a request's also the protocol group's and Favorites'), as the app builds it: `{ node, creates, groups: [{ group, actions: [{ id, label, shortcut?, submenu? }] }] }`, the groups in the order create · open · tree · run · share · tools · git · edit · danger, `label` the key of the app's vocabulary (`rename`, `moveToFolder`, `delete` …), `shortcut` the key that runs it on a focused row (<kbd>Enter</kbd> open, <kbd>F2</kbd> rename, <kbd>Del</kbd> delete, <kbd>*</kbd> expand all), `creates` whether the node offers New … items. The same table is in [Finding your way around](/getting-started/finding-your-way#menus).

## `item`

```bash
testpion item delete environment:staging-old -w my-workspace         # to Recently deleted; prints the trash id
testpion item delete 'spec:specs/petstore.yaml' -w my-workspace --json   # { trashId, ref, kind, id, name }
testpion item delete '{"kind":"mcp-server","serverId":"weather"}' -w .
testpion item restore 'environment/1760700000000--staging-old.json' -w my-workspace
```

Deletes any item to Recently deleted by its ref — the short form `kind:id` (`collection:<id>`, `environment:<id>`, `dataset:<name>`, `spec:specs/<path>`, `mcp-server:<id>`), a `testpion://open` link or the JSON of a `ref` field — and puts one back by the trash id `item delete` printed (or `trash list` lists). One function for every kind with the `trash` capability (`testpion kinds`): the same as the app's Delete… with Undo and the MCP tools `delete_item` / `restore_item`. A kind without it (a test file, a request) is refused with the reason; requests and folders of a collection are edited in the app or with MCP `delete_request`. `restore` gives an item whose id or name is taken again a new id and "(restored)" after its name; a dataset or API definition whose name is taken goes back as `name-restored.ext`.

## `open`

```bash
testpion open run:run-8f2c1a -w .                          # the run's results in the app
testpion open request:payments:create-invoice -w .         # kind:id, the kind's ids in order
testpion open 'testpion://open?kind=test&path=smoke/login.yaml'
testpion open history:h-abc --json                         # {ref, url, resolution}: checked, nothing opened
```

Brings TestPion to one item: the OS opens the `testpion://open` link, which starts the app or brings the running one forward on that item. The ref is the `ref` field of `--json` output and MCP tool results (`{"kind": …, …ids}`), its link, or the short form `kind:id`; the kinds are listed in [Finding your way around](/getting-started/finding-your-way#for-ai-agents-ref). It is looked up in the workspace (`-w`, or the nearest one) first: an item that is gone is reported with what is still there, exit code 2. `--print` prints the link, `--json` prints the ref, the link and the lookup without opening anything, `--no-check` skips the lookup.

## `history`

```bash
testpion history list -w my-workspace --request "List patients" --json   # newest first
testpion history stats -w my-workspace --request "List patients" --json  # median, p95, slowest, failed
testpion history diff h-abc h-def -w my-workspace --json                  # older id first
testpion history activity -w my-workspace --days 30 --json              # per-day requests, failures, runs
testpion history test "Authentication / Basic auth" -w my-workspace     # one test across the latest runs; flags flaky ones
testpion history flaky -w my-workspace                                  # every test that flips between runs (exit 1 if any)
testpion history results run-abc -w my-workspace --status failed -n 100  # the results of a run, a page at a time
testpion history scores -w my-workspace -q "Intent"                     # mean score per evaluator, run by run
testpion history mcp-tools -w my-workspace --server weather            # MCP tool calls per tool: count, failures, median / p95
testpion history llm -w my-workspace                                    # AI quality prompts per model: tokens, estimated cost, median time
```

`history list` shows recent responses of requests sent in the app (`--collection`, `--request`, `--failed`, `--kind`, `-q/--query`, `-n/--limit`, `--cursor`: see [Paging](#paging)); with `--json` each has its `ref` (`testpion open` opens it). `--kind capture` lists the HTTP Debugger's capture sessions: each Save to collection, Create flow and Save session, with `capture` (the result, `capture.ref` that opens it, the number of exchanges, `sources`: proxy or reverse, the hosts, `from` / `to`). `history stats` summarises the response times of a request's recent responses (`-n/--limit`, default 50): count, failed (no status or 400+), fastest, mean, median, p95 and slowest. `history diff` compares two of them: the status, timing, header changes (volatile ones such as `date` are flagged) and a field-by-field JSON body diff, or a line diff for text. Values of sensitive fields and headers are masked. `history activity` is the Home dashboard as data: per local day, requests sent and how many failed (4xx/5xx, transport errors, non-OK gRPC codes, MCP tool errors), the median response time, test runs and failed tests; plus requests per type and the slowest requests on average (`-d/--days`, default 14, up to 90).

`history flaky` lists the flaky tests most flips first (`-n/--runs`: how many of the latest runs, default 30; `-l/--limit`, `--cursor`: [Paging](#paging)); `history results <runId>` lists a finished run's results with `--status` (`failed` means failed or error), `-q/--query` and the same paging.

## `monitor`

```bash
testpion monitor add "API health" --collection "My API" --folder Smoke --every 15m -e Staging -w my-workspace
testpion monitor add "Checkout flow" --test-file flows/checkout.yaml --every 15m -e Staging -w my-workspace   # a test file / flow instead of a collection
testpion monitor add "API health" --collection "My API" --every 5m --max-p95 800 -w my-workspace   # also fail when p95 > 800 ms
testpion monitor add "API health" --collection "My API" --every 1h --min-cert-days 21 -w my-workspace   # and when a certificate expires within 21 days
testpion monitor run --due -w my-workspace      # for cron; exit 1 if a run failed
testpion monitor uptime "API health" -w my-workspace --days 90   # uptime per day, like a status page
testpion monitor requests "API health" -w my-workspace          # each request over the latest runs: median / p95, failures
testpion monitor start -w my-workspace          # keep running them until Ctrl+C
```

`list`, `results`, `uptime` and `add` take `--json`. See [Monitors](/test-runner/monitors).

## `ci`

```bash
testpion ci github -w . --suite regression -e Staging -o .github/workflows/testpion.yml
testpion ci gitlab -w api-tests --collection "My API" --folder Smoke --workspace-dir api-tests
testpion ci github -w . --run last -o .github/workflows/testpion.yml   # what the latest run ran (files and filter, or collection and folders), in its environment
testpion ci jenkins -w . --tests rest graphql --json
```

Writes a pipeline for GitHub Actions, GitLab CI, Azure Pipelines or Jenkins that installs the CLI (pinned to this version), runs the suite, collection or tests, publishes `junit.xml` and keeps the reports. Without `-o` it prints the file; the CI secrets to create are listed on stderr (and under `secrets` with `--json`). See [CI/CD](/test-runner/ci-cd#generate-a-pipeline).

| Option | Description |
|---|---|
| `--suite`, `--collection` (+ `--folder`), `--tests <paths...>` | What the pipeline runs (one of them). |
| `--run <runId\|last>` | Instead: what this finished run ran (its files and filters, or its collection and folders), in its environment. `last` is the newest finished run of test files or a collection (a run still going, a stopped run, a monitor's run or an evaluation is passed by). In the app: a run's ⋯ ▸ **Run in CI…**. |
| `--data [file]` | One flow file (`--tests <file>`): run it once per data row (a dataset; without a value, the file's own `data:`); the rows land in `test-results/data-run.json` (the JSON envelope, rows in `.data`). |
| `--env-matrix <names...>` | One flow file: run it in each environment and compare (`test-results/env-matrix.json`). |
| `--timeline-html` | One flow file: keep the run as `test-results/timeline.html`, also when it fails. |
| `-e, --environment` | The environment to run with. |
| `--allow-production` | Data-changing requests may go to an environment marked as production: adds `--allow-production` to the pipeline's run line. |
| `--start <command>`, `--wait-for <url>`, `--wait-seconds <n>` | Start the system under test first and wait for its health URL. |
| `--openapi <file>` | Pull requests fail on breaking changes to this OpenAPI document. |
| `--workspace-dir <path>`, `-o, --out <file>`, `--json` | The workspace folder in the repository; where to write the file; `{ path, content, secrets, command }` in the envelope. |

A pipeline whose environment is marked as production runs its reads only; `ci --allow-production` puts `--allow-production` on the run line it writes, so its data-changing steps run too (the app's CI dialog has a checkbox for it, and the `ci_config` MCP tool takes `allowProduction`).

## `env`

```bash
testpion env list -w my-workspace --json          # environments in display order, variable names only
testpion env diff Staging Production -w my-workspace --values   # what differs (exit 1 if anything does)
testpion env diff Staging Production --request "List patients" -w my-workspace   # send it to both, diff the responses
testpion env matrix -w my-workspace                         # every variable in every environment: set, empty, missing or off
testpion env order Development Staging Production -w my-workspace
```

`env order` sets the order of the environment picker. Environments you don't name keep their order after the named ones. Both commands take `--json`.

## `mcp-server`

Serves a workspace to AI agents over MCP on stdio: browsing (`list_collections`, `list_requests`, `get_request`, `search_workspace`, `resolve_ref`, `item_info` …), sending and running (`send_request`, `grpc_call`, `realtime_exchange`, `run_collection`, `run_tests`, `load_test` …), flows (`flow_graph`, `flow_add_step`, `flow_runs`, `flow_data_run` …), evaluations, git, the HTTP Debugger and more. Every tool keeps one contract: tools that delete or overwrite need `confirm: true`, lists page with `limit` / `cursor`, big results are concise unless `response_format: "detailed"`. See [Use TestPion from AI agents](/ai-testing/mcp-server) for every tool.

```bash
testpion mcp-server -w my-workspace
testpion mcp-server --read-only
testpion mcp-server --profile minimal      # only the common jobs' tools; search_tools finds the rest
```

| Option | Description |
|---|---|
| `-w, --workspace` | Workspace name or directory (default: nearest `workspace.json`). |
| `--read-only` | Only the browsing tools; no requests are sent. |
| `--profile full\|minimal` | Which tools are listed: every tool (`full`, the default) or the common jobs (`minimal`, for agents that load every listed tool into their context); `search_tools` finds the others, and any tool can be called. |
| `--allow-production` | Allow sending to environments marked as production. Each sending tool call must also pass `allowProduction: true`. |
| `--block-private-networks` | Refuse requests to localhost, private networks and cloud metadata addresses, and don't start local (stdio) MCP servers. For shared or hosted use; see [Network policy](/security/privacy#network-policy-shared-and-hosted-servers). |
| `--allow-host <host...>` | With `--block-private-networks`: hosts that stay reachable. |

A test file or suite with an `expose:` block is served as a tool of its own, named after `expose.tool`, with its `inputs` as arguments; `testpion flows` lists them (see [Your flows as tools](/ai-testing/mcp-server#your-flows-as-tools)).

:::
