# Changelog

## 0.45.0 — 2026-10-07

### AI testing, friendlier
A provider whose API key has no value stops **before** anything is sent: *No API key for OpenAI*, why, and where to add it; **Add the key** opens the provider with its key field ready, and the providers list marks the ones that still need one. A provider's errors say what to do by status (a key not accepted, no access to the model, no credit left or rate-limited, an unknown model, a problem on their side). A price set for a model also prices its dated versions (`gpt-4o-mini` covers `gpt-4o-mini-2024-07-18`); **Set a price…** under an unpriced cost opens the price table with the row ready. The `first-token` (`ttft`) check limits the time to the first token.

**RAG checks judged claim by claim.** With a `judge:`, `groundedness` (alias `faithfulness`), `context-precision` and `context-recall` no longer ask the model for one number: the judge splits the answer, the reference or the documents into items and gives each a verdict with its evidence; the score is computed from the verdicts, and the result lists what did not hold first (claims not supported, documents not useful, facts missing). New: `answer-correctness` (the answer's facts against the reference, F1) and `context-entity-recall` (the reference's names, numbers and dates found in the context; no model).

### Results a person reviews
The results of a run (tests and evaluations) open their first failure by themselves; filter chips count **Failed**, **Passed**, **Skipped** and **To review**; each row shows its lowest check score; ↑ ↓ (or J K) move through the results. **👍 / 👎 and a note** on any result record your verdict beside the run (`runs/<id>/reviews.json`): a 👎 on a passing result says the checks missed something, a 👍 on a failing one that a check is too strict. `testpion history review`, and the `run_reviews` / `review_result` tools for agents (an agent's review is marked as such). In the Playground, **Add to dataset** keeps the inputs and the answer (as `expected`) as an evaluation case in a JSONL dataset (`testpion datasets --add`, `add_dataset_row`). The model comparison marks the fastest and the cheapest, says under a picker when a provider still needs a key, and shows a failed model's error once with **Add the key**.

### An integration suite from an API definition or a collection
**Generate tests ▸ Integration flows** (a definition's Preview), **Export ▸ Integration flows** (a collection), `testpion integration-suite <spec | collection>` and the `generate_flows` tool write one flow per resource the API creates: create it, read it back, update it, see it listed, delete it and see it gone, each step depending on the one before, the created id flowing between them, names given a random part so the flow runs again; the login operation first, saving `{{accessToken}}`; plus `tests/<api>-integration.suite.yaml`. The result names the environment variables to set.

### For AI agents
`testpion mcp-server --profile minimal` lists only the tools of the common jobs (for agents that load every listed tool into their context); the new **`search_tools`** finds a tool by what you want to do, and any tool it names can be called. `testpion agent-info` prints, as one JSON object, what an agent needs here: the workspace, the commands and their exit codes, the environment variables, the MCP setup and the docs. `lint-tests` takes paths the way `testpion test` does.

### First steps and empty views
Home shows a **Get started** checklist (send a request, create or import a collection, add an environment, run a test), ticked from what the workspace holds and gone once done. Collections, Traces and History say what they are for and offer the first action when empty.

### HTTP Debugger: choose what to capture
The port box is gone from the header (**Capture ▸ Proxy port…** keeps it). **Capture** asks what to watch — **a browser** (Chrome, Edge, Firefox or Brave through the proxy; only that window), **a terminal** (only what runs in it), **a phone**, or **everything on this computer** (the system proxy, named as such, restored on stop) — and starts the proxy itself; **Start capturing** alone starts it for a program you point at it yourself. Nothing is captured until you choose, and the view says so. The workbench is calmer: the dock's bottom tab strip is gone (the rail switches panels, and can show each tool's name), the HTTPS notice appears only once tunnels show up and the **HTTPS** menu's lock says the state, the filters fit one row with the search box first, the number columns say their unit, the Summary leaves out what it does not know, and the request / response pane is a one-line hint until a row is picked.

### Under the hood
The RAG heuristics tokenize the context once per check (not once per sentence), compiled schemas are cached by object, the mock provider compiles each rule once, a dataset append never reads the file, and the Evaluations, AI Lab, assistant and results views stop re-rendering on every keystroke or streamed token. Dataset helpers, the code-block extractor and the "needs a key" rule live in one place each.

## 0.44.0 — 2026-10-07

### HTTP Debugger
A new view, **Debugger** (under Testing, and a tile on Home): the traffic of other programs through TestPion's own proxy. **Start capturing**, point a program at the address it shows (`HTTP_PROXY=…` in a terminal, `--proxy-server=…` for Chrome, or the system proxy setting), and every request is listed as it happens with the program that sent it, status, type, size and timing; HTTPS appears as a tunnel by host until you decrypt it (below). Filter by host, method, status class, text or bookmarked; click a row for the request and the response whole (headers, bodies, timing); **Open** it as a request tab, **Resend** it, copy it as cURL, bookmark or delete it; **Statistics** by host, type and program with the largest and slowest; export the session as HAR. Secrets in URLs, headers and bodies are redacted before they reach the screen, a file or an agent.

The **Capture** menu points programs at the proxy for you: open Chrome, Edge, Firefox or Brave through it (a profile of their own), open a terminal with `HTTP_PROXY` set, switch the **system proxy** to TestPion and back (restored when you stop and when the app quits), or copy the lines for bash, PowerShell, cmd and curl. The inspectors: Response, Request, Headers, **Raw** (as it went over the wire), **Hex**, **Auth** (a Basic user, a Bearer JWT's claims and expiry, cookie names; never the secret) and Timing; **Ask AI** explains an exchange. **Sessions**: save and reopen captures as HAR files in the workspace's `debugger/` folder (never committed), AutoSave every minute while capturing, import any tool's HAR. Statistics open with requests over time and the status mix. The filter searches bodies with **In bodies**; ↑ ↓ Enter Delete Ctrl+F Ctrl+E work in the grid.

**Rules** change the traffic on the way: **capture only** (only what they match is listed), **filter out** (hidden), **highlight** (a colour by host, URL, program, status, time or size; errors, slow and large stand out from the start), **modify** (headers set or removed, a body replaced, a delay), **reply** (a canned response, the server never sees it), **redirect** (another host or scheme) and **breakpoints** (the request or the response pauses in a dialog for editing, then goes on or is aborted). Globs or regular expressions match; presets add the usual ones (a header, CORS, no cache, slow network, offline, a canned 200, redirect to localhost, a breakpoint) for the selected host, and a row's **Rule** menu adds **Reply with this response from now on**. Rules live in profiles saved in the workspace (`debugger/rules.json`, committed, shared through git); a test box says what the rules would do to a URL; filter presets; **Compare** two exchanges side by side. For agents: `debugger_rules`; for the terminal: `testpion debug --rules debugger/rules.json`.

**HTTPS decryption**: a root certificate made on this computer (fingerprint, trust in one click, remove, export, renew) lets the Debugger read the HTTPS of programs that trust it; hosts can stay encrypted; a program that does not trust it shows as a failed tunnel with the reason. **WebSocket** connections show every frame both ways, **Server-Sent Events** every event, live. **Fiddler .saz** sessions open. A **Convert** panel decodes and encodes URL-encoding, Base64, hex, HTML, timestamps, JWTs and JSON. `testpion debug --decrypt` and `debugger_capture { decrypt: true }` do the same from the terminal and for agents. Agents get `debugger_capture`, `debugger_exchanges`, `debugger_exchange`, `debugger_session`, `debugger_rules` and `debugger_stats`; the terminal gets `testpion debug [-p port] [--lan] [-o session.har] [--rules file] [--decrypt] [--json]`.

**HTTP/2 and gRPC**: programs that speak HTTP/2 are read as HTTP/2 (streams on a **Connections** tab, grouped by connection); **gRPC** calls are captured even without TLS (gRPC clients tunnel plaintext HTTP/2 through a proxy), with their status from the trailers and every message both ways as JSON, decoded with the workspace's `.proto` files or field by field. **A phone or another computer**: the Capture menu shows this computer's addresses with QR codes; the page they open has the proxy settings and, when HTTPS is decrypted, the root certificate to install. `testpion debug -w .` decodes gRPC with the workspace's protos.

**The workbench** (laid out like HTTP Debugger Pro): a **tool rail** (Submitter, Filter, Highlight, Auto-Reply, Modify, Timeline F5, Summary, Structure F6, Performance, Convert, Export/Import); a dense **grid** (#, Offset, Duration, Method, Version, URL, Status, Type, Size, Speed, Application, Domain, IP Address, User, PID on demand) sorted by any column, columns chosen, several rows selected with Ctrl/Shift; **Request Details** and **Response Details** side by side with Header / Content / Raw / JSON tabs; a **dock** of panels: **Filter** (Filter Out and **Capture Only** rules, each with its hits), **Highlight** and the **Highlight Rule** editor (a condition on a column, colours per theme, bold, whole row), **Auto-Reply**, **Modify**, **Timeline** (sending / waiting / receiving, several requests on one axis), **Summary**, **Structure** (domains and paths), **Performance** and **Convert**; a right-click menu that turns a row's program, URL, domain, method or IP into a rule; **Incoming requests** from TestPion's mock servers; All Applications / All Domains / All Types filters, an HTTPS-inspection banner and totals in the footer. Every exchange records the program's process id, the server's address and the send time. A long capture stays quick: the list holds the whole 5,000-exchange session and gets only what changed (a new request is one row, not the list again). A request in **Incoming** opens in the same panes with what the mock answered; saved sessions (HAR) keep the new columns; **Save content** writes a body to a file; the docs have a screenshot of it all.

While the proxy runs, the **status bar** says so wherever you are: the port, how many rules change traffic, and whether the system proxy points at TestPion (in the warning colour when something changes traffic); a click opens the Debugger.

### Kafka
**Kafka** joins WebSocket, Socket.IO, MQTT and SSE in the realtime editor: brokers (`kafka://host:9092`, SASL and TLS), topics to read (new messages or from the beginning, with a consumer group), and **Produce** with a key, a partition and message headers. Each message shows its topic, partition@offset, key and headers. Saved Kafka connections run in collections and test files (`mode: kafka`), `testpion kafka <brokers>` reads and produces from the terminal, and agents use `realtime_exchange`. The example workspace has a Kafka demo (`clinic.events`) and `tests/kafka/clinic-events.yaml`.

### AsyncAPI import
An AsyncAPI 2 or 3 document imports as a collection of **connections**, one per channel: Kafka topics to produce to (with the example message, its key and headers) and to read, MQTT topics to publish to and subscribe to (with their QoS), WebSocket paths and Socket.IO events. Every message of a channel is kept to send again, built from its example or its schema; the servers become an environment.

**Export ▸ AsyncAPI 3.0** (`testpion export -f asyncapi`) goes the other way: a collection's connections become a document, with their saved messages as examples.

A realtime test can check what it received against the document: the `asyncapi` check fails a message that matches none of its channel's messages, and says what is wrong.

### .http files
`.http` / `.rest` files from VS Code's REST Client and the JetBrains HTTP Client import as collections: file variables, request names, chained tokens (`{{login.response.body.$.token}}`) and JetBrains response handlers, which run as written. **Export ▸ .http file** (`testpion export -f http`) writes a collection back for those tools.

### Generate test data
**Generate…** in the Collection Runner makes rows of realistic data from an API operation's request body or a JSON schema (emails, names, cities, prices, dates, enum values, numbers in range), saves them in `datasets/` and runs with them. `testpion generate-data` and `generate_dataset` do the same.

### Data from PostgreSQL and MySQL
A data-driven test file or a collection run can take its rows from **PostgreSQL** or **MySQL / MariaDB**: a `postgres://` or `mysql://` URL, or `env:NAME` for an OS variable that holds it, with a query. The query must be one SELECT and runs in a read-only transaction. In the Collection Runner, **Database…** takes the URL (`{{variables}}` resolve, so the password can stay a secret variable) and lists the tables. `testpion run-collection -d postgres://… --iteration-query "SELECT …"` and the `run_collection` tool take the same.

### Git, continued
- **Compare** a change in the Git view: a request, folder, collection settings or environment side by side with the last commit, part by part.
- **Conflicts side by side:** Compare… on a conflicted file shows base, mine and theirs per part, with **Mine / Theirs** per conflict; every other change from both sides stays. Agents get `git_conflicts` and `git_resolve`; the terminal `testpion git conflicts` and `git resolve --pick`.
- Environments merge variable by variable and library files item by item, like collections.
- Rename the current branch, delete a branch, and **History in git…** for a whole collection or an environment, with **Restore this version**.
- Open request tabs follow the disk after a pull or a branch switch; a tab with unsaved edits asks **Keep mine / Take the new version**.

### API definitions: Preview and Lint
An API definition's **Preview** reads like its docs: operations by tag with their parameters, request body and responses, schemas as short type outlines, and **Open as request**. `testpion openapi-ops` lists them in a terminal; agents use `openapi_outline`.

An API definition has a **Lint** tab: broken `$ref`s, path parameters that are undeclared or not required, duplicate operationIds, undefined security schemes, operations without responses, examples that don't match their schema, missing operationIds or success responses and more, each marked in the editor as you type. A row shows the place; **How to fix (AI)** asks the assistant for the changes. `testpion openapi-lint` checks files, folders or the workspace's `specs/` for CI (exit 1 on errors, `--fail-on warning`), and agents use `openapi_lint`.

AsyncAPI documents are listed under API definitions too, with a Preview of their channels and **Generate tests** (a realtime test per channel).

**Generate tests** on the Preview writes a first suite: a test file per tag with each operation's example (its documented status, the OpenAPI contract, latency) and one invalid request that must get a 4xx. `testpion tests-from-spec` and `generate_tests` do the same.

### Fuzz an API
An API definition's **Fuzz** tab sends each operation its valid example, then requests that break one rule of the schema at a time: a required field left out, a wrong type, a value outside its enum, range, length or format, a body that isn't JSON. It finds **server errors** (a 5xx on bad input), **invalid input accepted** (validation the API is missing) and statuses the document doesn't list; **Explain and fix (AI)** says where to look. **Save as tests** keeps each finding as a regression test that expects a 4xx. `testpion fuzz` does it in CI (exit 1 on server errors, `--save-tests`) and agents use `api_fuzz`. Local and private-network hosts only unless you allow others; never with a production environment; DELETE only when you include it.

### GraphQL subscriptions in tests
A test file or a collection run with a `subscription` subscribes, waits for the first event (or `events:` of them, at most `wait:` ms) and checks it like a query's response: `$.data…` for the first event, `$.events` and `$.count` for all. A subscription that gets no event fails with the reason.

### Secrets from 1Password, Vault, AWS, Azure and Google Cloud
An environment variable can hold a reference instead of a secret: `op://Clinic/API/credential`, `vault://secret/clinic#apiKey`, `aws-sm://prod/clinic#apiKey`, `azure-kv://clinic-kv/api-key` or `gcp-sm://my-project/api-key`. TestPion reads it with the manager's own command-line tool, signed in as you, when a request needs it; the reference is safe to commit and the value is never written anywhere. The first time, the app shows the exact commands and asks before running them. `testpion secrets <environment>` checks the references in CI.

### Docs
A new page, **What's new: how to use it**, walks through each of these step by step.

### The CLI on npm
`npx testpion` and `npm install -g testpion`: one package with the engine bundled in, published with each release.

### Big collections
- **Find and replace** across a collection's requests (URLs, params, headers, bodies, auth, scripts, names): every change listed before it is saved, Undo after. `testpion replace`, `replace_in_collection`.
- **Move collection variables to environments**: a collection variable wins over every environment, so base URLs kept in an imported collection can't differ per environment. Move them, then set each environment's value. Offered right where you see it, in a variable's **Where it's set**. `testpion vars move`.
- **Tidy up**: duplicate requests, hosts typed into URLs, the same Authorization header on many requests (made the collection's auth), empty folders and unused variables, with the fixes to tick and Undo; a host goes straight to Replace. `testpion tidy`, `collection_tidy`.
- **Only GET** in the Collection Runner for a smoke run that changes nothing, and a filter for long request lists; `run-collection --method GET`.
- The collection header's occasional tools are one **Tools** menu (Find and replace, Tidy up, Move variables, Security review); Export lists `.http` and AsyncAPI.
- The collection **Overview** lists the requests that were sent with their health; the rest are chips (*Not sent yet*, *Without checks*) instead of a label repeated on every row.

### The editors know what they edit
- **Test files (YAML):** keys complete with a line of help, for the test's type (an http test offers `url`, `headers`, `auth`; a GraphQL one `query`, `variables`), the checks' keys with every check type, and `dependsOn` with the ids in the file; hovering a key explains it; mistakes get a marker a moment after you type: an unknown `type`, an unknown check type, a key the runner does not read (with the key you probably meant), a `dependsOn` nobody defines. The same checks run as **`testpion lint-tests`** (exit 1 on errors, `--json`) and the **`lint_tests`** tool for agents.
- **JSON bodies:** completed and checked against the API definition the request belongs to (`specs/`): the fields, which are required, wrong types, unknown fields; a line above the body says which operation the schema comes from.
- **Scripts:** `console`, the timers and the old Postman globals are declared (no "unknown" squiggle); `{{braces}}` in a script are never flagged as missing variables (a visualizer template uses them); the Ctrl+Space snippets insert `tp.*`.
- A body typed as Text that is really JSON or XML offers the right editor.

### Secret guard you can act on
Before a commit, the secrets a commit would publish are a list to act on, grouped by where they are: each one **opens** where it is, **Fix** moves the typed value to a secret variable of the active environment (its value in the OS secret store) and leaves a `{{reference}}` in the request, **Fix all** does every one, and a request can be removed from there.

### Polish from your screenshots
- Icons on every button, link and menu row an icon fits, the same picture for the same action in every view (Save, Delete, Run, Import, Edit, Commit, Compare …).
- The collection explorer's type labels (GET, POST, MCP, gRPC …) are one pill of one width with the same small gap before the name; DELETE and OPTIONS read DEL and OPT.
- Home has tiles for **Debug HTTP traffic** and **Load test an API**.
- Every dialog button has an icon (Create +, Cancel ×, Delete, Save, Open, Run …) and a dialog shows what it is about (New environment: a key); the native update prompt is the app's own window.
- The environment picker is the app's own menu with a colour dot on the left of every environment (red ring for production), *No environment* and *Manage environments…*.
- With more tabs than fit, ‹ › buttons scroll the strip, and the leftmost tab is always whole (it looked hidden behind the sidebar); the wheel scrolls it sideways.
- The variable popover's buttons wrap instead of pushing Save outside the panel.
- Test files read `checks:` as well as `assertions:` (a file written with `checks:` used to run with no checks).
- A variable's popover has **Where it's set** (it was *All*): the value the request uses and why, scope by scope.
- A collection's name in its settings is text, renamed in place with a double-click, like a request's.
- A `{{variable}}` defined nowhere says so: **All** opens the variables overview on it with **Add to** the active environment. New WebSocket tabs start with an empty URL instead of `{{wsUrl}}`.
- AI Lab opens on **Providers** (nothing else works without one).
- `tp.*` everywhere TestPion speaks for itself; `pm.*` stays for Postman compatibility.

### Under the hood
- Room under the code-size limits: the history MCP tools, the backend's call parameters, the `testpion history` commands, the tree's data operations and the MCP view's panels are modules of their own (behaviour unchanged). `npm run screenshots` works again.
- **Kafka**: adding or removing a topic while connected no longer reads the other topics again (their messages came twice); a topic added again reads its history (from the beginning) or only what comes next; and **new messages** no longer skips one produced right after you subscribe.
- **The app no longer freezes behind an error box**: an exception nobody caught in the main process (the HTTP Debugger's WebSocket self-test wrote after closing) showed a native error box that stopped the backend, the proxy and the window until it was closed. The self-test is fixed, and such an exception is now logged and the app goes on.
- The Debugger's grid gets a program found after its request was listed; Capture only / Filter out on a program wait briefly for it; rule patterns are checked when saved and tested on a capped text; the arrow keys follow the grid's sort; a save is never undone by an older list; the collection variables pane keeps unsaved edits.
- **Faster with big workspaces**: opening a request no longer re-renders the whole explorer (at 3,000 requests: 3,000 rows rendered per open → 2), a save reads back only the saved collection (`col.get`), and the views that counted or listed collections share one list instead of each reading every collection on every change (the collection variables pane no longer loses unsaved edits when something else is saved).
- The Debugger's header shows the proxy address once with Copy; an empty Port box means 8899. The collection **Tools** menu's dialogs (Find and replace, Tidy up, Move variables, Security review) open again.
- `@testpion/shared`: one copy of the code the window and the engine both need (JWT decoding, formatting, URL and query handling, CSV, templates); the window's hand-copied engine types are now the engine's own.

## 0.43.0 — 2026-10-02

### Faster with big workspaces
Measured with a 2,817-request Postman import and a 500-request collection with every folder open:
- **Opening a request:** 252 → 45 ms. **Switching tabs:** 103 → 33 ms. **Typing in the explorer's filter:** 57 → 17 ms per key (worst case 169 → 23 ms). Every row of the tree carried a whole menu; now a menu exists only while it is open, and a tab switch re-renders two rows instead of all of them.
- Hidden GraphQL, gRPC, WebSocket and MCP tabs keep their state and connections but no live code editor, so many open tabs no longer slow every keystroke.
- The response header fits any width: values never break mid-number, and the actions fold into a **⋯** menu when the panel is narrow.

### What a shared workspace may do
Workspaces now travel through git, imports and teammates, so two things that reach outside the app ask first:
- A **stdio MCP server is a program** the workspace starts on your computer. The first **Connect** shows the exact command line: **Run once**, or **Always for this workspace** (remembered per computer, never committed). Mock and HTTP servers never ask.
- `{{$env.NAME}}` reads only the OS environment variables you list in **Settings ▸ Privacy** (none by default): a request that reads another one says so, with a link to the setting. The CLI reads all of them, as CI expects.

### Agents
- New MCP tools: `update_request`, `move_request`, `delete_request`, `create_collection`, `create_folder`, `set_collection_variable` (secrets typed in become `{{variables}}`; secret-looking variable names are refused), and `list_mcp_servers`, `mcp_server_tools`, `mcp_call_tool` to test the workspace's own MCP servers.
- `testpion mcp --server <name> -w . [--call <tool> --args '{…}'] [--json]`: a saved server from the terminal and CI.

### Integration testing in CI/CD
- `testpion ci … --start "<command>" --wait-for <health URL>`: the generated GitHub Actions, GitLab, Azure and Jenkins pipelines start the system under test and wait for it before the tests; `testpion wait-for <url>` for any pipeline.
- The repository is a reusable **GitHub Action** (`uses: nasimuddin-dev/testpion@v0.43.0`): workspace, suite / collection / tests, environment, start, wait-for; reports as an artifact.
- Example: `tests/rest/patient-lifecycle.yaml` (create, read, list, wrong token, delete, gone, delete again) and the **Integration** suite; a new guide, *Test Runner ▸ Integration testing*.

### Fixes
- Errors from the backend lost their kind, suggestions and details on the way to the desktop window; they arrive whole now.
- Git: branch names, revisions and remote URLs from the app, the CLI and agents are validated before they reach git.

### Under the hood
- The code base's boundaries (engine, CLI, backend, renderer) and file-size ceilings are kept by a test; MCP tools live in modules by subject; a CPU-profiling plan for the UI (`npm run e2e -- --only _profile` after a `TESTPION_PROFILE=1` build).

## 0.42.1 — 2026-10-02

- **No more false "changed outside TestPion" messages:** opening a file (a test file, for example) showed that message on Windows, because Windows reports a file being read as a change. The app now compares the files' content, so only a real change from outside (a `git pull`, another editor) is reported; a rewrite with the same content is not.
- `testpion git resolve <file> --ours|--theirs` and the Git view's **Keep mine** / **Take theirs** keep every other change from both sides of a collection (in 0.42.0 already; now in the CLI reference too).

## 0.42.0 — 2026-10-02

### Git
Keep a workspace in a git repository and work with your team on it, from the app, the CLI or an AI agent. See **Keep your workspace in git** in the docs.

- **Git view** (the rail, or the status bar): what changed **by meaning** (*Payments ▸ Create invoice: URL, headers (0 → 1)*, *environment Staging: added baseUrl*), the line diff per file, stage, discard, **commit**, history, **branches**, **fetch / pull / push**.
- **Initialize repository**, **Connect to a remote…**, and **Clone** in the workspace switcher (a workspace in a sub-folder of the repository is found). Sign-in is your git's: SSH keys or the credential manager.
- **Write message:** the AI assistant writes the commit message from the changes (never from secret values).
- **Secret guard:** a commit with a token, password or key typed into the workspace is stopped with the list of where; `testpion git check` and a pre-commit hook (`testpion git hook install`) do the same for plain git.
- **No conflicts for different requests:** collection files merge request by request (a git merge driver, set up for you; it works for `git pull` in a terminal too). The same request changed on both sides: **Keep mine** / **Take theirs** decides only those requests; every other change from both sides stays (`testpion git resolve` in a terminal). Tested against a real GitHub repository.
- **History in git…** on a request: the commits that changed it, and **Restore this version**.
- **Status bar** shows the branch, commits to push / pull and changed files; changed requests carry **M / A / D** marks in the explorer.
- **Pull request** button: opens GitHub, GitLab, Bitbucket or Azure DevOps with the branch, and the changes as the description.
- **Git-friendly files:** collection files no longer hold a save counter and time, keys keep a fixed order, and new workspaces get a `.gitignore` (results, traces, the local database stay out) and `.gitattributes`. **Make ready for git** in the workspace menu does it for an existing one.
- **Changes from outside** (a `git pull` in a terminal, a branch switch, another editor) show up in the app by themselves, with a message.
- **CLI:** `testpion git setup|status|changes|diff|commit|log|branch|switch|pull|push` (all with `--json`) and `testpion diff <from> [to] --markdown` for a pull-request comment in CI; recipes for GitHub Actions and GitLab CI in the docs.
- **MCP tools for agents:** `git_status`, `git_diff`, `git_log`, `git_propose_commit` (stages and proposes a message; a person commits it in the Git view).

### Fixes
- MCP server settings: a value typed before its name no longer vanishes; `{{` suggestions there say where the variables come from, and Environments ▸ Collection variables gets **Copy to environment**.
- Opening a favorite (or a request from a tab) no longer unfolds and scrolls the tree.
- **Collapse all** on a folder now collapses it.

### Quality
- The UI regression suite (31 plans) covers git end to end against a local remote: initialize, the secret guard, commit, push, a change by meaning with its marks, a teammate's change pulled in, and a request's history.

## 0.41.2 — 2026-10-02

- **Favorites show:** a starred request gets a star in the tree and appears in a **Favorites** section at the top of the explorer, from where it opens (Add to favorites saved it, but nothing showed it).
- **Expand all / Collapse all** in a collection's and a folder's menu.
- **Tabs:** the active tab is always fully shown (after Open in tab it could be left half hidden at the left edge).

## 0.41.1 — 2026-10-02

- **Collection variables in the Environments view:** a new tab lists every collection's variables (an imported Postman collection keeps its variables there) and edits them, next to Environments, Workspace and Global variables.
- **Workspace and Global variables** say what they are for, and when empty point to the collection variables.

## 0.41.0 — 2026-10-02

### Variables
- **Double-click any `{{variable}}`** (the URL bar, params, headers, auth fields, the body and other code editors, test files) to see its value and where it comes from, edit it in the active environment, or copy it. One popover for the whole app.
- **See every variable at once:** the eye button next to the environment selector lists everything the request on screen can use: its collection's variables, the active environment's, the workspace's and the globals, in the order they win, with overridden ones marked and a filter for large collections.
- A collection variable's popover now leads to the collection's variables (it went to Environments, which don't list them); **All** opens the full list.

### Fixes
- **Close all tabs** from a WebSocket tab's menu left the WebSocket tab open. The cause: a click inside any menu also reached the tab or row behind it (so choosing an item could also open the row, and Enter / Delete in a menu reached the row's keys). Fixed for every menu.
- Closing several tabs moves once, to a tab that is still open; a just-closed tab can no longer come back.
- AI assistant: New conversation during an answer no longer adds a stray "(stopped)", and on a task it runs the task again.
- Tests view: deleting a folder with several open files no longer leaves a deleted file on screen.
- **Insomnia imports:** pre-request and after-response scripts now run (Insomnia's `insomnia.*` API becomes `pm.*`); they used to come over as comments.

### Quality
- The UI regression suite (23 plans) now imports sample Postman, Insomnia and Bruno collections through the Import dialog and runs them, pre-request and post-response scripts included.

## 0.40.0 — 2026-10-01

### AI assistant
- **A conversation.** Follow-up questions remember what was asked and answered; **New conversation** starts over.
- **It knows what you're looking at.** A question asked with a request open (HTTP, GraphQL, gRPC, WebSocket/MQTT or an MCP server) carries it and its latest result, shown above the field and removable. Secrets are hidden before anything is sent.
- **Ctrl/⌘+J** opens it (press again, or Esc, to close). Before you type, it suggests questions that fit the screen, such as *Why did this request fail?*
- **Answers stream in**, **Stop** ends one early, and they're formatted with a **Copy** button on each code block.
- **Apply an answer where you asked for it:** Add to the checks (suggested assertions), Use this query (GraphQL), Use these arguments (MCP), Save as a test file (coverage gaps).

### Examples for every protocol
- New **Public REST APIs (playground)** collection: logins that return tokens, whole create-read-update-delete flows, API keys, status codes, slow responses, images and open data (DummyJSON, Restful-Booker, Postman Echo, ReqRes, Fake Store, Open-Meteo, PokéAPI, …).
- More GraphQL (Star Wars, GraphQLZero with mutations, AniList, Pokémon), SOAP (calculator, country info), gRPC over TLS (every field type, metadata, errors, streaming), MQTT brokers (HiveMQ, EMQX), SSE streams, and MCP servers (Microsoft Learn, Context7, Cloudflare and Astro docs, GitMCP, Hugging Face, the Everything reference server).
- **Your Examples workspace gets them too:** at start the app adds what's new and tells you once. It never changes, overwrites or brings back anything in your copy.

### Uniform menus
- Collection, folder and request menus share one grouping: create · run · configure · copy · organize · delete.
- MCP servers and API definitions have a kind badge in the explorer (MCP, green when connected; API), like every request.
- **Test files open in their own tabs**, like requests (each keeps its own edits).
- Test files show what they test in the same badge (HTTP, GQL, gRPC, WS, MCP, AI, SUITE …).
- Collections you folded stay folded: closing or switching tabs no longer expands them again (opening something from search or history still shows where it is).
- Home counts a collection's saved gRPC calls and connections.

### Quality
- An end-to-end UI regression suite (19 plans in the real app) runs before every release and against the installed app after it.

## 0.39.2 — 2026-10-01

- **Windows taskbar**: the installed app shows the TestPion icon again (it could show Electron's after TestPion had been run from source on the same computer).

## 0.39.1 — 2026-10-01

- **Rename in place**: after Rename in a menu, the name field keeps the keyboard (a menu closing late could take the focus, so typing went elsewhere).

## 0.39.0 — 2026-10-01

Highlights: rename in place everywhere, a response layout for every editor, a much faster filter on big workspaces, and keyboard navigation in every list.

- **Rename in place**: F2 (or Rename in a menu, or a double-click on a tab) turns a name into a text field; Enter or clicking away saves, Esc cancels, a blank name is refused. Collections, folders, requests, gRPC calls, connections, MCP servers, environments (the active one stays active), tabs (a saved item is renamed where it is saved), monitors, load tests, saved prompts, evaluations and saved examples. Test files keep their path dialog, which F2 now opens.
- **Response layout**: Auto puts the response beside the request when there is room, the same in the HTTP, GraphQL, gRPC and MCP editors (they used to differ); or choose Side by side / Response below with the button at the right of the tabs, in Settings ▸ Appearance or the command palette. Each layout keeps its own size, and switching keeps what you typed.
- **Faster filter**: on a 5,000-request workspace each keystroke in the explorer's filter went from up to a second of frozen window to 30–50 ms; at most 300 matching rows are drawn, with Show more matches for the rest.
- **Tabs that don't fit** stay reachable: » lists them with how many are hidden, and the chosen one scrolls into view.
- **Keyboard**: ↑ ↓, Home / End, → and ← work in every tree and list (Monitors, Load, AI Lab, Evaluations, Tests, Environments, the explorer).
- **One button per row**: the + is merged into ⋯, whose menu starts with what + did; collection rows show it on hover, focus or right-click like every other row.
- **Tab names**: new tabs are New HTTP / GraphQL / gRPC / WebSocket / Socket.IO / MQTT request or New MCP server (a WebSocket tab showed its URL); gRPC and WebSocket tabs remember their saved item across restarts.
- **Feedback by email**: Send feedback has an Email button (to the maintainer) besides GitHub, Copy and Save.

## 0.38.0 — 2026-10-01

Highlights: send feedback and report problems from the app, and steadier tabs.

- **Send feedback or report a problem**: Help ▸ Send Feedback, the **Feedback** button in the status bar, or the command palette. Choose Problem, Idea, Design or Question; include the versions and platform and the app's recent errors only if you want (home folders and secret-looking values are masked; requests, responses, collections and environments are never included). You see the whole report before anything leaves your computer: **Open on GitHub** opens a pre-filled issue for you to post, or **Copy** / **Save as file**.
- **Problems are captured**: unexpected errors of the window go to the app log (status bar ▸ Logs), and a view that stops with an error offers **Report this problem** with the error filled in. `testpion feedback` builds the same report from a terminal or an agent.
- **Tabs**: closing a view's last tab moves to the nearest open tab only right after the close; this used to fire while a tab was opening too, which could leave a blank editor without New request, or select the wrong tab. A view whose selected tab is gone selects its first tab.
- **No open requests** is identical in every view (New request and Describe with AI); folders of saved gRPC calls and connections look like every other folder.

## 0.37.0 — 2026-10-01

Highlights: AI agents can use TestPion with nothing but the app installed, and get much more from it.

- **The app is an MCP server**: `TestPion --mcp-server -w <workspace>` serves a workspace to AI agents over stdio, with the secrets saved in the app and no window (`--read-only`, `--allow-production` as for the CLI). The app can stay open at the same time.
- **Settings ▸ AI agents (MCP)**: copy-ready setup for Claude Code, Claude Desktop, Cursor / Windsurf, VS Code (Copilot) and Codex, filled in for the open workspace, with read-only and production switches. **Test connection** starts the server the way your agent will and shows what it offers. Also in the command palette (*Connect an AI agent*).
- **AGENTS.md**: **Write AGENTS.md** (or `testpion agents-md`) adds a TestPion section to the workspace's AGENTS.md, which coding agents read first: how to use the workspace over MCP and the CLI, the check types and the test file format. Your own text stays; no paths of your machine are written.
- **MCP server**: every tool has a title and behaviour hints (read-only, destructive, idempotent, reaches the network), so agents can run the read-only ones without asking; results come as structured content too. New **resources** (a guide, the workspace, what needs attention, each collection's docs, a saved request) and **prompts** (`investigate_failures`, `write_tests`, `debug_request`, `api_health_report`, `import_and_test`).
- **Agents can write tests**: `testpion_guide` (check types and the test file format), `set_request_checks` (checks on a saved request; unknown types are refused) and `write_test_file` (checked before it is saved; never overwrites without `overwrite: true`).
- **No open requests** shows in every request view when its tabs are closed (it was blank for GraphQL, gRPC, WebSocket, MCP and API definitions), with the view's own New first (e.g. **Add MCP server**); closing the last tab of one editor while others are open shows the nearest tab.
- Bigger icons on the left rail.

## 0.36.0 — 2026-10-01

Highlights: the new TestPion logo, one look for every sidebar and menu, a JWT inspector, and workspace Export in the switcher.

- **New logo**: the TP test-tube mark is the app icon (installer, Start menu and desktop shortcuts, taskbar, every size), the window icon and sits beside the wordmark in the top bar; the website logo and favicons use it too.
- **The top bar is the title bar** (Windows, Linux): the logo and wordmark sit where the grey system title was, the window buttons are drawn over the bar's right end in the theme's colours, and File / Edit / View / Window / Help are behind the **☰** button. The window fits the screen and opens maximised on smaller ones (a laptop at 125 %).
- **One look everywhere**: every sidebar list (Collections, MCP servers, API definitions, Tests, Environments, Monitors, Load tests, saved prompts, evaluations, gRPC, WebSocket, MCP) has the same header (title, count, **+** and **⋯**), the same folder rows, the same row buttons and a right-click menu on every row. Detail pages (a monitor, a load test, a provider, an environment) have one header style: the main actions, the rest under **⋯**.
- **Folders for MCP servers and API definitions** in the explorer: **⋯ ▸ New folder**, **Move to folder** on a server or definition, rename or delete a folder (its items stay).
- **New HTTP request** is the name everywhere (menus, buttons, the empty collection); an empty collection offers it as a button, and every collection row has a **+** for it.
- **Tests**: the file tree has a menu on every row (Open, Run, Rename, Duplicate, Delete; Run or delete a folder); **+** offers every kind of test (*New HTTP test* …).
- **Environments**: Make active, Duplicate and Delete from a row's menu; AI Lab providers: Duplicate and Remove (saved at once) from the list.
- **JWT**: a **JWT** tab on responses that hold a token (claims, issued, expires in …), a `jwt` check (expiry margin, claims), `testpion jwt <token>` and the `decode_jwt` MCP tool. The demo token endpoint returns an `id_token`.
- **Workspace switcher**: **Export** next to **Import** (native save dialog; cancelling does nothing; the message says where it was saved), and **Import** uses the native file dialog. Importing a workspace export keeps exactly its environments and names a repeated import *… (imported) 2*.
- Sidebar panes show their names when there is room; Monitors no longer says *paused* twice; the monitor page uses the full width.

## 0.35.0 — 2026-10-01

Highlights: request health that follows your checks, certificate reminders, traces you can filter.

- **Request health** now follows each request's own checks: a request that expects a 404 and gets one is fine; without checks, the status decides as before. The Collections explorer shows how many requests are failing next to each collection.
- **Certificates**: when the app starts it reminds you, once a day, of recorded certificates that expire within 7 days.
- **Monitors**: the list shows each monitor's uptime over 7 days; a run that failed for its certificate is labelled *Attention* (not *Too slow*) in the app, the CLI and alerts, and Home no longer shows "0 failed" for it. **Run now** on a failing monitor in *Needs attention*.
- **Needs attention**: **Copy** puts the list on the clipboard as Markdown; `testpion attention --markdown` prints it for CI.
- **Traces**: an **Errors** filter; the timing phases of a request are coloured in the waterfall (connection set-up lighter, download green).

## 0.34.0 — 2026-10-01

Highlights: latest results in test files, collection health on Home, WebSocket timing.

- **Test files**: the preview shows each test's latest result and when it ran; click it to open that run.
- **Home**: the Collections card shows how many requests are failing now in each collection (a green dot when every sent request passes); **Check now** on a certificate connects and reads it again; **What first?** asks the AI assistant to triage what needs attention.
- **WebSocket**: the *Connected* message says how long the connection took: DNS, TCP, TLS and the upgrade.
- **Docs**: latest results, test history and scores by run.

## 0.33.0 — 2026-10-01

Highlights: what needs attention, timing everywhere, AI help for monitors.

- **Needs attention** on Home: failing monitors, certificates that expire within 30 days, the latest failed run, saved requests whose latest response failed and flaky tests, most severe first (click one to open it). Also first in the workspace report, `testpion attention` (exit 1 on a high-severity item) and the `what_needs_attention` MCP tool, which the MCP server now suggests as a first call.
- **Timing**: History shows where an entry's time went (DNS, TCP, TLS, server, download); the collection Overview adds it up for the collection (also the `collection_timing` MCP tool); load history keeps the server p95 and the share of new connections per run.
- **Collection Overview**: each request's latest results as a strip in Request health.
- **Monitors**: **Explain with AI** when a monitor is failing, from its results, reasons and per-request numbers.
- **Docs**: the home page has monitors and certificates, charts and AI agents.
- **Performance**: the flaky-test scan is reused until a new run is added.

## 0.32.0 — 2026-10-01

Highlights: flaky tests across the workspace, scores by run, a variables matrix, per-request monitor numbers.

- **Flaky tests**: the Tests overview lists tests whose result keeps changing across the latest 30 runs (or that pass only after retries), each with its latest results; `testpion history flaky` (exit 1 when there are any) and the `flaky_tests` MCP tool.
- **Evaluations**: **Scores by run**, one chart per evaluator with its mean score in each run; `testpion history scores` and the `score_trend` MCP tool. The runs list now updates when a run finishes (it kept showing 0 of 0 before).
- **Environments**: a **Matrix** of every variable across every environment (set, empty, missing or off, secrets marked, never values); `testpion env matrix` and the `environment_matrix` MCP tool.
- **Monitors**: **Requests** shows each request over the latest runs, slowest first, with p95 and failures; `testpion monitor requests` and the `monitor_requests` MCP tool.
- **Tests and Evaluations**: **Overview of all runs** returns from a run to the overview.
- **README**: the new timing, certificate, usage and history features.

## 0.31.0 — 2026-10-01

Highlights: usage of MCP tools and AI models, timing in traces, direct certificate checks.

- **MCP**: a **Usage** tab per server: calls and failures per tool as bars, with median and p95 time and when each was last used. Also `testpion history mcp-tools` and the `mcp_tool_usage` MCP tool.
- **AI Lab**: a **Usage** tab: prompts run, input and output tokens, estimated cost, tokens per model, median time and time to first token. Also `testpion history llm` and the `llm_usage` MCP tool.
- **Traces**: DNS lookup, TCP connect, TLS handshake, waiting and download are child spans of each HTTP and GraphQL request, in the Trace tab and in OpenTelemetry exports.
- **Certificates**: `testpion certificates --check host …` and the `check_certificate` MCP tool connect to a host and report days left, whether it is trusted here (and why not) and the TLS protocol.
- **History**: a bar of the outcomes of the entries shown (2xx, 3xx, 4xx, 5xx, errors).
- **Command palette**: AI usage and MCP tool usage.
- **Docs**: screenshots of the response timeline, MCP usage and AI usage; the AI Lab screenshot shows a run again.

## 0.30.0 — 2026-10-01

Highlights: certificates across the workspace, test history, server time in load tests.

- **Certificates**: every HTTPS response records its host's certificate. Home lists those that expire first; `testpion certificates --warn 21` prints them (exit 1 when one expires within 21 days); agents use `list_certificates`. The security review flags hosts whose certificate expires within 30 days.
- **Monitors**: a **Certificate warning** (or `--min-cert-days`) fails a run when a host it calls has fewer days left, and the monitor shows the days left.
- **Test history**: a result's **History** tab shows the same test in the latest runs (pass / fail, time per run, failed checks), flagged *flaky?* when the result keeps flipping. Also `testpion history test "<name>"` and the `test_history` MCP tool.
- **Load tests**: server time (time to first byte, p50 / p95), and connections opened vs reused with the average set-up time, in the app and `testpion load`.
- **AI assistant**: **Explain with AI** in the Timeline (where the time went) and in a test's History (flaky or broken, and why).
- **HAR export**: real DNS, connect, SSL, wait and receive timings.

## 0.29.0 — 2026-10-01

Highlights: where request time goes (DNS, TCP, TLS, server, download), certificate expiry checks, uptime by day.

- **Request timing**: the Timeline is a waterfall of DNS lookup, TCP connect and TLS handshake (on a new connection), waiting for the first byte and download, with the server's address, TLS version and cipher, or *Reused connection*. `testpion send <url> -i` prints the phases; `--json` and the `send_request` MCP tool return them as `timing`.
- **Certificates**: the Timeline shows the server's certificate (subject, issuer, valid until, days left), and the new **Certificate valid for (days)** check (`type: certificate`, `min: 14`) fails before it expires: give it to a monitored request to be alerted in time.
- **Run charts**: *Where the time went* adds up the phases of a run's HTTP and GraphQL requests, with new and reused connections; also in the HTML report and the `run_breakdown` MCP tool.
- **Monitors**: *Uptime by day* over 30 days, like a status page (hover a day for its runs and slowest p95); `testpion monitor uptime` and the `monitor_uptime` MCP tool; the workspace report shows each monitor's 30 days too.
- **Collection runner**: when no run is open, the pass rate and duration of earlier runs of the collection (click one to open it).

## 0.28.0 — 2026-10-01

Highlights: compare two history entries, response p95 for monitors, `testpion doctor`.

- **History**: Ctrl/Cmd+click a second entry to compare the two responses side by side.
- **Monitors**: a *Response p95* chart with the limit drawn on it, and the editor shows the p95 of recent runs next to the response time limit.
- **Evaluations**: an overview of earlier runs (pass rate and duration, click one to open it) and pass / fail bars in the runs list.
- **Search**: monitors, saved load tests and saved evaluations, opened in their views.
- **Diagnostics**: `testpion doctor` checks Node.js, SQLite, the app folder, secrets, proxy and certificates and the workspace files (`--json`, exit 1 on an error); **Settings ▸ About ▸ Copy diagnostics** copies versions and storage backends for a bug report with your home folder masked.
- **Docs**: screenshots of the Home activity dashboard and a run's Charts tab.

## 0.27.0 — 2026-10-01

Highlights: storage clean-up, flaky tests, unused variables.

- **Settings ▸ Storage**: how much the open workspace keeps besides its definitions (runs, traces, response bodies, history, the index) with a bar per part, and clean-up: delete runs older than N days, clear the history. Also `testpion storage --delete-runs-older-than 30`.
- **Flaky tests**: tests that passed only after a retry are listed in a run's Charts tab and in the HTML report.
- **Unused variables**: under an environment's variables, the ones nothing in the workspace reads; `testpion vars unused` and the `unused_variables` MCP tool.
- **Collection Overview**: a strip of the collection's recent runs with the last result and a link to it.
- **Load history**: click a run to compare the others with it (change in requests per second and p95).
- **Mock server**: hits per route and a summary of requests served from examples, forwarded or unmatched.
- **For agents and scripts**: the `run_breakdown` MCP tool (a run's latency ranges, slowest and flaky tests, failing checks, scores) and `testpion load-history`.
- **Accessibility**: every field of the key / value tables (variables, headers, parameters) has a name for screen readers; the UI test plan now checks all main views for unnamed controls.
- **Fixes**: the workspace report and `load-history` show local times.

## 0.26.0 — 2026-10-01

Highlights: snapshot checks, variable flow, a shareable workspace report.

- **Snapshot checks**: keep a copy of a response and check later responses against it: by *shape* (the same fields and types, values may change) or by *values*, ignoring paths such as `$.id` or `$..updatedAt`. **Snapshot** above a JSON response adds one, the response tree's menu adds one for any object or array, and **Update snapshot** next to a failed check takes the new response when the API changed on purpose. In test files: `type: snapshot`.
- **Variable flow** (collection Overview): which request or script sets each variable and which requests use it, in run order, flagging *used before it is set*, *never set* and *set, never used*. Also `testpion variable-flow` (exits 1 on problems) and the `variable_flow` MCP tool.
- **Workspace report**: **Share report** on Home (or `testpion workspace-report`) saves one HTML file with requests and tests per day, each collection's health, the monitors and the latest runs; names, counts and timings only.
- **History**: a *Failed* filter (also `testpion history list --failed`), and the `recent_failures` MCP tool for agents. GraphQL requests now count in collection health.
- **Streams**: WebSocket, Socket.IO and MQTT logs show messages and bytes in each direction with a messages-per-second sparkline and a direction filter; gRPC streams and Server-Sent Events show when their messages arrived.
- **Fixes**: the status bar says "MCP connected" (it counts MCP servers).

## 0.25.0 — 2026-10-01

Highlights: compare any two runs, response-time limits for monitors, workspace datasets everywhere.

- **Compare runs**: the Baselines dialog of a finished run can compare it with an earlier run (not only a saved baseline): new failures, fixed tests, slower tests and the change of pass rate, latency, tokens and scores. AI agents use the new `compare_runs` MCP tool.
- **Monitor response-time limit**: a monitor can fail a run whose p95 response time is over a limit, even when every check passes; it shows *Too slow* with the reason and alerts like any failure (`testpion monitor add … --max-p95 800`).
- **Workspace datasets**: Evaluations load a file from the workspace's `datasets/` folder (next to *Load file…*); `testpion datasets` and the `list_datasets` MCP tool list them (SQLite databases with their tables). `testpion load` runs in a workspace join its load history.
- **Charts**: keyboard access (Tab to a chart, arrows to move, Enter to open); the charts now share one set of components (lines, columns, bars, tiles).
- **Tests**: filter the runs list by name or environment, or show only failed runs.
- **Fixes**: CSV fields with line breaks are one record again (engine, preview and counts); evaluation runs no longer leave `inline-*` copies in `datasets/`; transport errors and non-OK gRPC codes show as red badges everywhere.

## 0.24.0 — 2026-10-01

Highlights: Amazon Bedrock, a Table and Chart view for JSON responses, load test history and more charts.

- **Amazon Bedrock provider**: every Bedrock model through the Converse API (system prompt, parameters, tool use, usage), signed with AWS Signature V4 (`accessKeyId:secretAccessKey[:sessionToken]`) or a Bedrock API key; a region field; model listing; Titan and Cohere embeddings.
- **Table view** for JSON responses that are, or hold, a list of objects (up to three levels deep, GraphQL too): sortable columns, a row filter, **Copy CSV**, a **Chart** (a bar per row for a numeric column) and **Save as dataset**, which writes `datasets/<name>.csv` in the workspace.
- **Workspace datasets in the Collection Runner**: files in `datasets/` are listed next to *Select file*, so data-driven runs work without a native file picker (browser and cloud too).
- **Load test history**: every finished load test is kept (`runs/load/history.jsonl`); *Earlier load tests* shows p95 and throughput trends and the runs with error rate and pass rules, per saved load test. AI agents read it with the new `load_history` MCP tool, and `load_test` runs are recorded too.
- **Evaluation scores**: run Charts and the HTML report show how each evaluator's scores spread from 0 to 1, with the mean.
- **API coverage by tag**: how many operations of each OpenAPI tag were called, least covered first.
- **Fixes**: the Home dashboard keeps its chosen period when you come back; metric tiles no longer squeeze when there are only a few; "1 check" wording in reports; RAG / Agent labels in run charts.

## 0.23.0 — 2026-10-01

Highlights: SQLite databases as datasets, WSDL 2.0 imports, a collection Overview and more charts.

- **SQLite datasets**: a `.db` / `.sqlite` file with a read-only `query` feeds tests (`dataset: { path, query, params }`), collection runs (`run-collection -d app.db --iteration-query "SELECT …"`) and the Collection Runner, which lists the database's tables and starts with the first one that has rows. The database is opened read-only and only one SELECT is accepted.
- **WSDL 2.0 imports**: `<description>` documents with SOAP 1.2 (or 1.1) endpoints, `wsoap:action`, operations inherited through `extends` and sample envelopes from the schema. HTTP bindings are skipped.
- **Collection Overview** tab: requests, how many have checks and docs, how many are failing now, requests by method and a *Request health* list (latest status, median time, failures, last sent). Also `testpion requests "My API" --health` and the `collection_health` MCP tool.
- **Runs overview** in Tests: pass rate and duration of the last 40 runs (click to open one), and a pass/fail bar on every run in the list.
- **More visuals**: the latest 20 results as a strip next to each monitor (Monitors list and Home), a relative duration bar on History and Traces rows, and bars in the AI Lab model comparison (latency, first token, tokens, cost).
- **MCP**: `run_collection` takes a data file from the workspace (`data`, `query`) and `iterations`.
- **Fixes**: a model that fails in the AI Lab comparison shows its error once; "1 traces" / "1 spans" wording.

## 0.22.0 — 2026-10-01

Highlights: charts across the app — a Home activity dashboard, a Charts tab on every run, better load-test charts and a richer HTML report.

- **Home activity dashboard**: requests sent, request success, median response and tests passed for the last 7, 14 or 30 days, then per-day charts (requests succeeded and failed, median response time, tests passed and failed) with hover details, requests by type and the slowest requests. The same numbers for scripts and agents: `testpion history activity --json` and the `workspace_activity` MCP tool.
- **Run charts**: a finished test, collection or monitor run has a *Charts* tab next to its results: tests per response-time range (passed and failed), results per type, the five slowest tests (click one to find it) and the checks that failed most.
- **Load test charts**: requests per second, p95 latency, errors per second and virtual users now have axes and a crosshair shared by all four charts; hover for every value at that second. Status codes are a proportional bar with counts and shares.
- **HTML report**: a pass/fail bar, a response-time histogram, the slowest tests and the checks that failed most (static SVG, fine as a CI artifact).
- **Fixes**: a load test whose URL uses an unset variable now says which variable is missing (it used to report a "remote host {{baseurl}}"); the monitor availability legend says "the last run" for a single run.

## 0.21.0 — 2026-10-01

Highlights: monitors open in tabs and show charts.

- **Monitors in tabs**: opening a monitor (list, menu, link) gives it its own tab, like requests; open several and run them side by side (each tab keeps its own runs and running state, and runs started together go in parallel). Middle-click or ✕ closes a tab; its right-click menu has *Run now*, *Close tab*, *Close other tabs* and *Close all tabs*. Open tabs are remembered.
- **Monitor charts**: *Availability* (one block per run, oldest left, like a status page, with uptime over the last 24 hours and 7 days), *Run time* (a line over the last runs with each point coloured by its result and the median dashed) and *Requests per run* (passed and failed stacked). Hover any chart for that run's result, requests, time and date. A *Median response* tile joins the summary.

## 0.20.4 — 2026-09-30

- **Monitors in folders**: the monitor list works like every other saved list: a new-folder button and **+** in its header, folders (drag or *Move to folder…*), a filter, and menus to rename, duplicate, move or delete a monitor or folder, plus *Edit*, *Run now* and *Pause / Resume*. Monitors saved elsewhere (the CLI, an AI agent) appear straight away.

## 0.20.3 — 2026-09-30

- **Monitors are created and edited inline**: *New monitor* and *Edit* open in the main area with **Create monitor / Save** and **Cancel** in its header, like MCP servers and API definitions, instead of a dialog. The API definition's *Coverage* and *Compare versions* tabs get the same header.

## 0.20.2 — 2026-09-30

- **Fixed: requests said `User-Agent: TestPion/0.5`** whatever the version; they now send the running version (found by testing the installed app screen by screen).

## 0.20.1 — 2026-09-30

- **F2 and Delete on every sidebar row**: MCP servers, gRPC calls and connections (in a collection or not) rename with F2 and delete with Delete, asking first, like requests and folders.

## 0.20.0 — 2026-09-30

Highlights: the sidebar reveals what you open and works from the keyboard; Insomnia imports bring gRPC and WebSocket requests; monitors can watch gRPC calls and connections; one shared collection list makes large workspaces lighter.

- **Copy from the sidebar**: a gRPC call's menu has *Copy as grpcurl* and a connection's *Copy URL* (`{{variables}}` resolved), like *Copy as cURL* on requests.
- **Monitors can watch gRPC calls and connections**: *What to run* lists the collection's gRPC calls and connections after its requests, so a monitor can check just those.
- **One collection list for the whole app**: the sidebar, the REST editor and the breadcrumbs share one copy of the workspace's collections, fetched once after a burst of changes, instead of each fetching every collection after every save.
- **Insomnia imports bring gRPC and WebSocket requests**: from an Insomnia 4 export, gRPC requests (with their `.proto` files, metadata and TLS) and WebSocket requests (headers, first message) become the imported collection's gRPC calls and connections, in their folders.
- **MCP `get_request` shows gRPC calls and connections too** (target, method, message and metadata; URL, mode and message), masked like requests.
- **Collections with the same name are told apart**: the sidebar shows each one's id beside the name (e.g. a collection imported twice), so you can keep one and delete the other.
- **Arrow keys in the sidebar**: ↑ ↓ move between rows, → expands and ← collapses a collection, category, folder or section, like a file tree (with Enter, F2 and Delete).
- **The sidebar reveals what you open**: opening a request from a tab, search, history or a link expands its collection, category and folders (even ones folded by hand) and scrolls it into view, highlighted.

## 0.19.0 — 2026-09-30

Highlights: a breadcrumb above every editor, faster editors with large collections, Collapse all, and folder menus with Duplicate.

- **Folders**: right-click a folder for its menu (it only opened from **⋯**), and **Duplicate** copies a folder with everything in it (new ids throughout).
- **Collapse all** button beside the sidebar's filter folds every collection and folder.
- **Faster editors with large collections**: the request editors no longer render their old built-in sidebars, which the Collections sidebar replaced but which were still built, hidden, with a whole collection tree that re-rendered on every change.
- **Breadcrumb above the request, in every editor**: *Collection › Folder › Request* shows where the open REST or GraphQL request, gRPC call or connection is saved (click the collection for its settings, runner and docs), with *unsaved changes* when there are any; a request that isn't in a collection says so, with **Save**. It follows renames and moves made in the sidebar.

## 0.18.0 — 2026-09-30

Highlights: fixes for duplicated collections, expanding in the sidebar and Import from menus; Import and Export buttons in the sidebar; duplicate, rename and delete collections from their menu; drag gRPC calls and connections between collections; `testpion collections` / `requests`; notifications when runs finish.

- **Fixed: a collection could appear twice, and expanding one expanded the other.** Saving a collection whose file name differs from its id (two of the examples' collections) wrote a second file with the same id instead of updating the first. Collections are now found and saved in their own file; two files that already share an id are listed, opened and saved separately; and importing a collection the workspace already has adds a copy instead of replacing it.
- **Fixed: some sidebar items didn't collapse on the first click** (a category, or the collection holding the open request, which start expanded).
- **Fixed: Import from a menu did nothing**: a dialog opened from a menu item closed again straight away (for every menu in the app). Export in the sidebar menu only switched views.
- **Import and Export in the sidebar header**: **Import** opens the import dialog right there; **Export** asks what (a collection or the whole workspace) and the format (TestPion, Postman, OpenAPI, Bruno folder). **Refresh** is beside them.
- **Desktop notification when a run finishes in the background**: a test, collection or evaluation run that ends while TestPion isn't in front shows how it went (passed, failed, errors, time); clicking it opens the run. *Settings ▸ General* turns it off. The `run.finished` event now carries the counts.
- **CLI: `testpion collections` and `testpion requests <collection>`** list a workspace's collections and what each holds (requests, gRPC calls, connections), as text or `--json`, the same as the MCP tools.
- **AI agents see the whole collection**: the MCP tools `list_collections` (counts of gRPC calls and connections) and `list_requests` (each gRPC call's target and method, each connection's URL and mode) include a collection's gRPC calls and connections, which `run_collection` runs.
- **Drag gRPC calls and connections onto a collection**: from another collection or from *Not in a collection*, drop one on a collection in the sidebar to move it there, like requests.
- **Rename, Duplicate and Delete on a collection's menu** (right-click or **⋯** in the sidebar). Duplicate copies everything the collection holds, its gRPC calls and connections included, with new ids throughout and a free name (*copy*, *copy 2* …); Delete moves it to Recently deleted and closes its tabs. Also as the `col.duplicate` RPC method.

## 0.17.0 — 2026-09-30

Highlights: a collection now really holds every kind of request: running it runs its gRPC calls and connections, and exporting it shares them. Plus menus on category rows and keyboard shortcuts in the sidebar.

- **Sharing a collection shares all of it**: exporting a collection in TestPion's format (app or `testpion export -f testpion`) includes its gRPC calls and connections, and importing the file restores them in the imported collection (clashing ids get new ones; nothing is replaced). A Postman export, which can't hold them, says how many it left out.
- **Keyboard in the sidebar**: F2 renames and Delete deletes the focused request or folder (with Undo), Enter opens it; listed in Keyboard Shortcuts.
- **Category rows have a menu**: right-click (or **⋯** on) *REST*, *SOAP*, *GraphQL*, *gRPC* or *WebSocket & MQTT* under a collection for *New … request*, *Run collection* and *Collapse / Expand*, like every other row in the sidebar.
- **Running a collection runs everything it holds**: its gRPC calls and WebSocket / Socket.IO / MQTT connections now run after its requests, in the Collection Runner (listed with the requests, each can be unticked), `testpion run-collection`, monitors and the `run_collection` MCP tool. A gRPC call passes when the server answers OK, using the call's saved `.proto` files or its server-reflection descriptor; a connection passes when the server accepts it, and its saved message, Socket.IO event or MQTT publish is sent. gRPC tests in test files can also carry `.proto` files inline (`protoFiles`) or a `descriptorSet`.

## 0.16.2 — 2026-09-30

The follow-up to the 0.16.1 review: the items that were left open and could be fixed.

- **Sending a request is faster**: workspace files (environments, the collection, servers, providers) were opened and read again for every request sent and every list shown, which costs milliseconds per file on Windows. Their text is now reused while a file's modification time and size are unchanged (changes made outside the app, by git or an editor, are still picked up). Preparing a request went from about 35 ms to under 1 ms, and from about 130 ms to 13 ms with a 5 MB collection; listing collections is about 8 times faster.
- **Very large collections in the sidebar**: a collection or folder with more than 300 items shows the first 300 and a **Show 300 more** row (the filter still searches everything, and the open request is always shown), and rows that are scrolled out of view are skipped by layout and paint. Opening a 3,000-request collection no longer builds 3,000 rows at once.
- **Hardened installers**: the packaged app sets Electron fuses, so the installed program can't be started as a plain Node.js runtime, doesn't read `NODE_OPTIONS`, ignores `--inspect` and only loads the app from its archive.
- **Command palette**: *Record traffic*, *Find variable usages*, *Compare OpenAPI versions* and *API coverage* had no icon; every command now has one.
- **Docs**: the development guide explains the hardening and what is needed to code-sign the installers.

## 0.16.1 — 2026-09-30

A security and performance review of the code; these are its fixes.

- **Security**
  - **Saving a response body** (`http.saveBody`) checked its path with a plain prefix test, which `payloads/../…` passed: any file could be read through it. The path is now resolved and must be inside the workspace's `payloads/` folder.
  - **Run ids** (`runs.summary`, reports, re-running failed tests, the `run_*` MCP tools) were joined into a path unchecked; an id like `../..` is now refused.
  - **Show in folder** (`app.openPath`) opened any path it was given, and opening a program runs it. It now opens folders of known workspaces only.
  - **MCP mock files** had to be "inside the workspace" by a prefix test that a sibling folder (`workspace-other/`) passed; fixed.
  - **Bruno export** of a collection named `..` wrote one folder above the chosen one; the folder name is now sanitised.
  - **RPC**: only the backend's own methods can be called (`constructor`, `toString` … are refused), and the desktop app answers calls from its own page's top frame only, never an embedded frame.
  - **Content security policy**: the packaged app no longer allows connections to the development servers (`localhost:5173`, `127.0.0.1:5174`).
  - **Clear history really clears**: deleting or clearing history now deletes the saved response bodies too (they stayed on disk).
- **Performance and growth**
  - **Disk use is bounded**: when history (20,000 entries) and traces (50,000) are trimmed, their files (response bodies, trace JSON) are deleted with them; before, only the index rows went and the files accumulated for ever.
  - **Faster runs**: trimming ran a full scan after every single history entry and trace; it now runs once per 200 inserts, with prepared statements reused.
  - **Typing stays fast with many tabs**: editor drafts were serialised and written to storage on every keystroke (all open REST tabs each time); they are now written 0.4 s after the last change, and when the window is hidden or closed.
  - **Sidebar**: a burst of saves (an import, a run) reloads the lists once instead of once per save.

## 0.16.0 — 2026-09-30

Highlights: click a `{{variable}}` to see, copy, edit or add its value; a faster, leaner editor after a refactoring pass.

- **Faster, leaner editor** (refactoring, no change in behaviour):
  - Fields that highlight `{{variables}}` share one short-lived cache of variable lookups (also used by the code editors' completion and hover), so a request with many headers or params, or switching environment, asks the backend once per distinct question instead of once per field.
  - The Collections sidebar counts each collection's REST, SOAP and GraphQL requests in a single pass, cached per collection, and indexes gRPC calls and connections by collection, instead of walking every tree several times per render.
  - The REST view no longer runs the measurements of its old tab strip (replaced by the shared one) on every tab change and resize; that strip's dead code is gone.
  - Duplicated code merged: Ctrl+S is one shared hook in every editor (REST and Tests too), leaving an editor when its last tab closes is one function, and the sidebar edits saved gRPC calls and connections through one helper.
  - Unused imports and variables removed, and the desktop app's TypeScript settings now reject new ones (`noUnusedLocals`, `noUnusedParameters`).

- **Click a {{variable}} to see its value**: clicking a variable in the URL bar or any field that highlights variables (headers, params, auth …) opens a popover with its value and where it comes from (environment, collection, global …). Copy it, edit it when it comes from the active environment (Enter or Save), or, for a variable that isn't defined, add it to the active environment right there. Secret values stay masked (type a new one to replace it); variables set by a collection or request are shown read-only with where to change them.

## 0.15.0 — 2026-09-30

Highlights: MCP servers and API definitions open in their own tabs like every request, and Ctrl+S saves whatever tab is on screen.

- **One tab per MCP server**: clicking servers in the sidebar opens each in its own tab (clicking one again selects its tab), and the tab menu's close items (Close other / to the right / all) close MCP tabs too. Discarding a new server or removing one closes its tab.
- **API definitions open in a tab**: clicking an OpenAPI document under *API definitions* opens it like a request, with its title, version and OpenAPI version, and three tabs: **Definition** (the document, editable, Save / Ctrl+S), **Coverage** (the API coverage report, inline) and **Compare versions** (this document against another one, a link or a file). The command palette still offers both as dialogs.
- **Right-click menus for every sidebar item**: gRPC calls and WebSocket / MQTT connections get *Open in tab, Rename, Duplicate, Move to ▸ (collection), Remove from the collection, Delete*; MCP servers *Open in tab, Connect / Disconnect, Settings, Rename, Duplicate, Delete*; API definitions *Open in tab, API coverage, Compare versions*. Right-click works on them like on REST requests, and menus can now have submenus.
- **Ctrl+S everywhere**: Ctrl+S saves the tab on screen in every editor: REST, GraphQL, gRPC and WebSocket (new; asks for a name the first time), MCP servers and API definitions. With several tabs of one editor open, only the one on screen is saved.

## 0.14.1 — 2026-09-30

- **Resizable Collections sidebar**: drag its right edge to make it wider or narrower (200–640 px); the width is remembered, double-click the edge resets it, and the arrow keys resize it when the edge has focus.
- **Not in a collection ▸ Put them in collections**: one click moves gRPC calls and WebSocket / MQTT connections saved before collections could hold them into a **gRPC** and a **WebSocket & MQTT** collection (existing collections of those names are reused).

## 0.14.0 — 2026-09-30

Highlights: MCP servers are edited inline like every other request, and every tab has the same menu.

- **Deleting closes its tabs**: deleting a request, a folder or a whole collection closes the tabs showing them, and so does deleting a saved gRPC call or WebSocket connection.
- **MCP servers are edited like any request**: adding one opens a *New server* tab instead of a dialog. The top bar holds the transport and the command line (arguments split, quotes kept), URL or mock file, with **Connect** and **Save** (Ctrl+S); a new **Settings** tab has every field (working directory, environment variables, headers) and **Edit JSON**. Connect saves first; Ping, Save as mock and Remove are in the **⋯** menu.
- **The same menu on every tab**: GraphQL, gRPC, WebSocket and MCP tabs now have **Pin tab**, **Rename…**, **Duplicate tab** and **Save as test file…** like REST tabs (one shared menu for every tab; what doesn't apply is greyed out). Pinned tabs come first in the strip and stay open on *Close other / all tabs*; a duplicate is an unsaved copy in a new tab.

## 0.13.0 — 2026-09-30

Highlights: the **Collections sidebar** now reads workspace → collections → categories (REST, SOAP, GraphQL, gRPC, WebSocket & MQTT); several GraphQL, gRPC and WebSocket tabs; a **Payload** tab in traces; tab menus on every tab.

- **Collections sidebar: workspace → collections → categories**: the sidebar lists the workspace's collections directly; expanding one shows what it holds by category, **REST**, **SOAP**, **GraphQL**, **gRPC** and **WebSocket & MQTT**, each with its count, its folders and a **+** that creates that kind of request in the collection (the collection's menu has them too). SOAP requests are recognised by their XML envelope or SOAPAction header. gRPC calls and WebSocket / Socket.IO / MQTT connections can now belong to a collection (a new gRPC or WebSocket request started from a collection is saved into it); ones saved before are listed under **Not in a collection**, and their menu moves them into one. MCP servers and API definitions stay below the collections, as they belong to the whole workspace. The examples workspace gains **gRPC (grpcb.in)** and **WebSocket & MQTT** collections.

- **Several GraphQL, gRPC and WebSocket tabs**: each tab is its own document, with its own draft, response and connection. **New ▸ GraphQL / gRPC / WebSocket** opens a new tab instead of showing the existing one, opening a saved item gives it its own tab (or selects the tab that already shows it), and closing a tab discards that document's draft. **New ▸ MCP server** opens *Add server*.
- **Right-click menu on every tab**: GraphQL, gRPC, WebSocket and MCP tabs now have Close tab, Close other tabs, Close tabs to the right and Close all tabs. On REST tabs these now close tabs of every kind, not only REST ones.
- **Payload tab in traces**: the first tab of a span shows the request and response bodies on their own: JSON as a tree or raw text, with content type, size and copy. Requests sent from the editor now keep the response body in their trace (redacted, up to 48 KB).
- **Monitors open on double-click**: a single click selects a monitor and shows its runs; double-click (or the pencil) opens its settings.
- **Explorer header**: Import, Export (collections or the whole workspace) and Refresh now sit in a **⋯** menu beside **+**.
- **UI polish**: tab rows no longer show a scrollbar under the tabs; the REST editor lost a duplicate request-name field (rename from the tab); the rail keeps its labels on windows down to 680 px tall; the Tests view explains what to do when no file is open; saved load tests no longer repeat their target under the name; the Evaluations dataset toolbar wraps instead of clipping **Load file…**.
- **Evaluations**: a dataset saved as "JSON" but written one record per line is read as JSONL, so its case count and runs are right (it showed "0 cases").

## 0.12.0 — 2026-09-30

Highlights: a clearer **Collections sidebar**, organised by what you work with (collections, gRPC, WebSocket & MQTT, MCP servers, API definitions), with a create button in every section.

- **A clearer Collections sidebar**:
  - The panel is titled with your workspace name. Its sections follow what you work with: **Collections** (HTTP and GraphQL), **gRPC**, **WebSocket & MQTT**, **MCP servers** (with a connected dot) and **API definitions** (API coverage, compare versions).
  - Each section has an icon, a count and a **+** that creates that kind of item. Saved items are grouped by folder, and empty sections say what goes there and offer a button to start.
  - Environments, monitors, AI prompts, evaluations and load tests are no longer repeated here: they live on their own rail items (the environment picker stays in the top bar).

## 0.11.1 — 2026-09-30

- **New request is the same everywhere**: the button on the empty editor, the tab strip's **+** and the explorer's **New** menu all offer HTTP, GraphQL, gRPC, WebSocket / Socket.IO / MQTT and MCP (the empty editor used to create an HTTP request straight away).

## 0.11.0 — 2026-09-30

Highlights: a simpler layout. There's **one sidebar at a time** and a **shorter rail**: requests of every kind live under Collections. **One tab strip** holds REST, GraphQL, gRPC, WebSocket and MCP side by side, as in Postman, and GraphQL's schema is a toggle on the right.

- **One sidebar at a time, and a shorter rail**:
  - REST, GraphQL, gRPC, WebSocket and MCP are no longer separate rail items. **Collections** opens them all, with the Collections explorer as their only sidebar; clicking it again (or Ctrl+B) hides the sidebar.
  - Tests, Monitors, Load, AI Lab, Evaluations, Environments and History keep their own single sidebar.
  - The explorer's **New** menu creates every kind of request, and it highlights the open request.
  - GraphQL's schema explorer is a **Schema** toggle on the right of the editor, and its toolbar shrinks to icons on narrow windows.
  - **One tab strip for every request type**, as in Postman. REST's tabs and a tab for each GraphQL, gRPC, WebSocket or MCP document sit side by side. Pin, rename, unsaved dot, middle-click to close and right-click menus all work. **+** opens any kind of request, and a list shows every open tab. Open tabs come back after a restart, and editors with a tab stay loaded, so live connections stay open.

## 0.10.1 — 2026-09-30

Highlights: **Back and Forward** navigation (top bar, Alt+← / Alt+→, mouse buttons) that reopens what you had open, and clicking a monitor opens its settings.

- **Back and Forward** next to the workspace switcher, like a browser. They go to the views you visited and reopen the request, saved item, environment or monitor you had open. The tooltips name where they lead, a drop-down lists recent places, and they work with Alt+← / Alt+→ and the mouse's back and forward buttons.
- **Monitors**: clicking a monitor in the list (or in the Collections explorer) opens its settings, like the edit button.

## 0.10.0 — 2026-09-30

Highlights: the **Collections explorer**, everything saved in the workspace in one panel next to every view (Ctrl+B); **Postman-style request settings**; saved **evaluations** and **load tests** that run by name from the CLI and MCP (`testpion eval run`, `testpion load --saved`); **Export** beside Import; body types keep their content when you switch; and an update prompt that still appears if the window can't show it.

- **Collections explorer**: the Collections button, now right under Home, shows or hides a panel with everything saved in the workspace, next to every view (Ctrl+B). Its collapsible sections are collections (the full tree: run, move, edit folders, settings), saved gRPC requests, WebSocket connections, MCP servers, AI prompts, evaluations and load tests, environments (click to activate), API specs (coverage, compare versions) and monitors. One filter covers them all, and clicking an item opens it in its editor. It refreshes when anything is saved, in any view. While it's open, the views' own saved lists step aside.
- **Update prompt you can't miss**: if the window can't show the update question (it failed to render, or crashed), TestPion asks with a native dialog instead.
- **`testpion load --saved <name>`** runs a load test saved in the app (options typed on the command line win), and `{{variables}}` in a load-test URL now resolve from the workspace and `-e` environment.
- **Export beside Import**: the Collections sidebar has an Export menu (the selected collection as TestPion JSON, Postman v2.1, OpenAPI 3.1 or a Bruno folder, or the whole workspace), and the REST sidebar has an export button next to import.
- **Fix: switching the body type no longer loses what you typed**: each type (JSON/XML/Text/HTML text, form fields, the binary file) is kept while the request is open, so going to None or a form and back brings it back, as in Postman.
- **Run saved evaluations anywhere**: `testpion eval list` and `testpion eval run <name>` (reports, baselines, exit 1 on failures) and the `list_evaluations` / `run_evaluation` MCP tools for AI agents. The app, the CLI and the MCP server build the tests the same way.
- **Request settings like Postman's**: a clearer Settings tab (one row per setting with an explanation) and new options: follow the original HTTP method on redirects, keep the Authorization header on cross-host redirects, remove the Referer header on redirect, encode the URL automatically (on by default), disable the cookie jar, allowed TLS versions and cipher suites. They're saved with the request and apply in runs, monitors and the CLI.

## 0.9.1 — 2026-09-30

Highlights: fixes a **blank window on start** (after opening a GraphQL request from the TestPion Examples); **one sidebar layout in every view** (saved items, Environments, History or Runs); **saved evaluations and load tests** you can run again from their folders; and **API coverage** of an OpenAPI document by your tests (app, `testpion coverage --min`, MCP `api_coverage`).

- **Fix: blank window on start** after opening a GraphQL request whose variables are saved as a JSON object (e.g. in the TestPion Examples workspace). The app remembers the last view, so it failed on every start. The variables now open as JSON text, editors accept any saved value, and a problem in one view no longer blanks the window: it shows the error with **Try again** and **Reset this view**.
- **Fix: the test suite no longer writes to your real settings** (it added temporary workspaces to the list). Leftover entries from the temp folder are forgotten automatically.
- **API coverage**: which operations of an OpenAPI document, and which of their documented response codes, the tests and requests exercised. It also shows operations that were never called, codes the document doesn't describe, and requests to paths it doesn't have. Open **API coverage** from a finished run or the command palette. **Suggest tests with AI** drafts tests for the gaps, and the report exports as Markdown. In CI, `testpion coverage specs/api.yaml --min 80` fails the build below a threshold (`--json`, `--markdown`, `--history`). AI agents use the `api_coverage` MCP tool. HTTP test results now record their status code.
- **One sidebar layout everywhere**: every view now has the REST sidebar: its saved items (collections, saved requests, connections, servers, prompts, test files …), **Environments**, and **History** (that view's requests) or **Runs**. Tabs show labels when the sidebar is wide enough and icons with tooltips otherwise.
- **Saved evaluations and load tests**: save an evaluation or a load test, group them in folders, and run one again from its menu whenever you need (`library/evaluations.json`, `library/load-tests.json`). The Evaluations sidebar lists their runs.
- **Monitors** sidebar matches the other saved lists (filter, New monitor button, empty state with a start button).
- **Example OpenAPI document** for the veterinary demo API (`specs/veterinary-api.yaml`).
- **Open folder** in the workspace menu explains what it's for (a workspace kept elsewhere, e.g. in a git repository) and says clearly when the chosen folder isn't a workspace.

## 0.9.0 — 2026-09-30

Highlights: **MQTT** alongside WebSocket and Socket.IO; **HTTP/2**; **WSDL/SOAP**, **Bruno** folder import and export, HTTPie and grpcurl paste; **async scripts** (`await pm.sendRequest`, async `pm.test`), **script packages** (`pm.require`) and more Postman modules (ajv, chai, cheerio, xml2js, csv-parse); **MCP client features** (elicitation, sampling, roots, completions, resource subscriptions); **load-test thresholds** and **gRPC load tests**; **watch mode**, **re-run failed tests** and **OpenTelemetry export** in the CLI; tests run from AI agents over MCP (`list_tests`, `run_tests`, `save_test`), **Explain with AI** for failed tests; and a tidier UI: grouped navigation, collections in the GraphQL view, filterable saved lists and a clearer Tests sidebar.

- **Tests view sidebar**: a labelled **New** menu for test templates (REST, GraphQL, gRPC, WebSocket, MQTT, MCP, AI, suite) in place of the small + picker, and a filter box for test files.
- **Collections in the GraphQL view**: a Collections / Schema switch in the sidebar shows the same collection tree as REST (new collections and folders, **New GraphQL request** in any folder, drag and drop, run, move), **Save** (now also Ctrl+S) asks for the collection and folder, and HTTP requests in the tree open in REST.
- **Clearer saved lists**: the WebSocket, gRPC, AI Lab and MCP sidebars have a filter box like the REST collection tree (matching folders open), and when empty they show **Save current …** and **New folder** buttons.
- **Navigation regrouped**: the left rail is now grouped as Requests (REST, GraphQL, gRPC, WebSocket, MCP), Testing (Tests, Monitors, Load), AI (AI Lab, Evaluations) and Workspace (Collections, Environments, History, Traces); tooltips say what each covers (WebSocket includes Socket.IO and MQTT), and on short windows the rail becomes a compact icon bar with no scrolling.
- **Explain a failed test with AI**: a failed result in a test or collection run has **Explain with AI**, which says why the checks failed and whether to change the test or the API.
- **Run tests from AI agents**: the MCP server's `list_tests` and `run_tests` tools (filters, `rerunFailed`), so agents can run the tests they save with `save_test`.
- **More modules for scripts**: `require('ajv')` (JSON Schema validation, as in many Postman tests), `chai`, `xml2js`, `csv-parse/lib/sync`, `atob` and `btoa`, like Postman's sandbox.
- **gRPC load tests**: load-test a unary or server-streaming gRPC method (the Load view's **gRPC method** target, `testpion load <server> --grpc <method>`, and `grpc` in the `load_test` MCP tool): one connection per test, methods from server reflection or proto files, results by gRPC status.
- **Re-run failed tests**: **Re-run failed** on a finished test or collection run (for collections, the failed requests once), and `testpion test --rerun-failed [runId]` / `testpion run-collection --rerun-failed` (default: the last run), run only the tests or requests that failed or errored.
- **Paste an HTTPie command**: `http` / `https` / `xh` commands paste into the REST view (and import with `testpion import -`) like cURL: JSON fields, raw JSON, query parameters, headers, files, forms and auth.
- **`pm.test` async and skip**: tests can be async functions or use Postman's `done` callback (never calling it fails the test), and `pm.test.skip` lists a test without running it.
- **Export to Bruno**: **Export ▸ Bruno collection folder…** and `testpion export --format bruno --out <folder>` write a collection (with the workspace's environments, secret values never) as the folder Bruno keeps in git; it imports back unchanged.
- **Examples**: the Examples workspace has a SOAP collection imported from a public WSDL and an MQTT test and saved connection for the public Mosquitto broker.
- **Paste a grpcurl command** into the gRPC view's server field to fill in the call (server, TLS, method, message, metadata, time limit).
- **Save as test**: turn the request in the REST (tab menu), GraphQL, gRPC or WebSocket / Socket.IO / MQTT view into a YAML test file under `tests/`, with its checks and scripts ({{variables}} kept), ready for the Tests view, `testpion test` and CI. AI agents use the `save_test` MCP tool.
- **Load test thresholds**: pass/fail rules like k6's (`p95<500`, `errors<1%`, `rps>=50`, `p99[Get patient]<800`) with `testpion load --threshold` (exit 1 when one fails, for CI), **Pass if** in the Load view, and `thresholds` in the `load_test` MCP tool.
- **MCP completions and resource subscriptions**: the inspector suggests values for prompt arguments and resource-template parameters from the server (`completion/complete`), gives each template parameter its own field, and can subscribe to a resource to re-read it whenever the server says it changed.
- **cheerio in scripts**: `cheerio.load(html)` (or `require('cheerio')`) with CSS selectors and the usual methods (`text`, `attr`, `find`, `children`, `parent`, `each`, `map`, `eq`, `filter` …), as in Postman's sandbox; the HTML is parsed outside the sandbox. Postman scripts that scrape HTML now run.
- **`pm.execution.location`** in scripts (collection, folders and request), and `pm.info.requestName` is the request's own name in collection runs, as in Postman.
- **MCP elicitation, sampling and roots**: the MCP inspector answers servers that ask the client for input (a form from the requested schema, Accept / Decline / Cancel), for an LLM completion (review the request, write or draft the reply with the AI assistant) or for its roots (the workspace folder). `type: mcp` tests answer with `elicitation:`, `sampling:` and `roots:`, and record what the server asked.
- Errors with numeric codes (JSON-RPC / MCP) no longer break error reporting.
- **`await` in scripts**: scripts run as async functions, so `const res = await pm.sendRequest(…)` works (the promise form of `pm.sendRequest`), and **`pm.vault`** (`await pm.vault.get("key")`, `{{vault:key}}`) reads TestPion's secret variables. Postman scripts that use them no longer get import warnings.
- **Script packages (`pm.require`)**: shared script modules like Postman's package library, kept in the workspace's `packages/` folder and edited in **Scripts ▸ Packages…**. Packages can require each other and the built-in modules; imports only warn about packages the workspace doesn't have; workspace exports include them.
- **OpenTelemetry export**: send traces to Jaeger, Grafana Tempo, Honeycomb or any OTLP/HTTP collector: `--otlp <url>` (or the standard `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS`) on `testpion test`, `run` and `run-collection`, **Send to OpenTelemetry** in the Traces view, and the `export_traces` MCP tool. Traces are redacted; a new docs page covers traces.
- **GraphQL code snippets**: the GraphQL view's **Code** button shows the call as cURL, fetch, Python, Go and the other snippet languages.
- **Watch mode**: `testpion test --watch`, `testpion run --watch` and `testpion run-collection --watch` run again whenever a test, collection, environment or data file changes (the run's own results don't count).
- **HTTP/2**: requests over https use HTTP/2 when the server supports it, the response shows an **HTTP/2** badge (`httpVersion` in results), and the request setting **HTTP/1.1 only** turns it off. HTTP/2 responses get their standard status text (`200 OK`).
- **WSDL import (SOAP)**: a WSDL 1.1 document (file or `?wsdl` link) becomes a collection of SOAP 1.1 / 1.2 requests with `SOAPAction` headers and sample envelopes built from the XML Schema (document/literal and RPC, base types, enumerations), following `xsd:import` / `wsdl:import` documents on the same site or next to the file. The demo servers have a SOAP patient service (`http://127.0.0.1:4010/soap/patients?wsdl`).
- **Build GraphQL operations from the schema**: **Build** on a root field of the schema explorer writes a complete operation (typed variables with placeholder values, a selection of fields two levels deep, fragments for unions). Also `testpion graphql-op` and the `graphql_operation` MCP tool.
- **Bruno collection folders**: import the folder Bruno keeps in git (`bruno.json`, `collection.bru`, `folder.bru`, request `.bru` files and `environments/`) with **Bruno folder…** in the Import dialog or `testpion import <folder>`, or a single `.bru` file. Bruno scripts now run as they are (the sandbox has Bruno's `bru`, `req`, `res` and `test` API), Bruno assertions become tests, `vars:post-response` values are taken from the response, and collection and folder headers and scripts come along.
- **MQTT**: the WebSocket view has an MQTT mode (MQTT 3.1.1 and 5 over mqtt://, mqtts://, ws:// and wss://): subscriptions with wildcards and QoS, publish with QoS and retain, username and password (only a `{{variable}}` reference is saved), saved connections and messages. Also `type: mqtt` tests, `testpion mqtt`, `mode: mqtt` in the `realtime_exchange` MCP tool, and an MQTT broker in the demo servers (`mqtt://127.0.0.1:4016`).
- **Confirm before changing production**: with a production environment active, sending a POST, PUT, PATCH, DELETE or other non-read request from the REST view asks first (with a "don't ask again" choice that lasts until restart).
- **Copy a gRPC call as grpcurl**: the gRPC view's **grpcurl** button copies the call as a ready-to-run command (plaintext or TLS, proto files or reflection, metadata and message).
- **Set environment variables from the terminal and from AI agents:** `testpion env set Staging baseUrl=https://… [--create]`, `env unset`, `env get`, and the MCP tool `set_environment_variable`. Only plain values: secret variables are still set in the app (or as `TESTPION_SECRET_*` in CI).
- **Retries for flaky endpoints.** A request's Settings can retry it up to 5 times after a network error, timeout, 429 or 5xx, with exponential backoff that honours `Retry-After` (POST and PATCH only when the connection failed). It applies to sends, runs, monitors and the CLI, and the response shows how many attempts it took.
- **`testpion send`**: send one saved request by name (with its scripts, auth and checks) or a URL, and print the response like `curl` (`-i` for headers, `--json`, `--fail`).
- **Monitor alerts by webhook.** A monitor can post to a Slack, Teams or Discord incoming webhook (or any URL) when it starts failing and when it recovers, from the app, `testpion monitor start` or cron runs. The URL can be a secret `{{variable}}`.
- **GraphQL subscriptions.** A `subscription` operation in the GraphQL view gets **Subscribe**: TestPion connects over WebSocket (`graphql-transport-ws` or the older `graphql-ws`, whichever the server speaks), sends your auth with the handshake or in `connection_init`, and lists the events live. Also `testpion graphql-subscribe` and the MCP tool `graphql_subscribe`.
- **Ask the AI assistant about the new results:** **Explain with AI** in Compare OpenAPI versions (which clients break and how to stay compatible), **How to fix (AI)** in a collection's security review, and **Analyze with AI** after a load test. Secret values are never sent.
- **API security checks.** **Security** in a collection's toolbar (and `testpion lint "My API" --fail-on high`, MCP `security_review`) finds secrets typed into requests instead of secret variables, secrets in query strings, plain http to other hosts, credentials over http and turned-off TLS checks. It also lists `{{variables}}` that nothing defines in the active environment, and ones set only by a later request's script. The new **Security headers** check tests responses for HSTS, `nosniff`, clickjacking protection, CORS with credentials and exposed server versions.
- **Partial mocking.** A mock server can forward requests that match no example to the real API (**Forward the rest to** in the Mock tab, `testpion mock --fallback <url>`), so only the endpoints you saved examples for are mocked.
- **Record traffic into a collection.** **Record traffic** (Collections view, command palette, or `testpion record https://api.example.com -w my-workspace`) runs a small reverse proxy on localhost: point an app at it, use the app, and every request and response is listed. Save them as a collection, with responses as examples and tokens replaced by variables, then replay, test or mock them. Browser apps work (CORS, redirects and cookies are handled).
- **Saved WebSocket messages.** A WebSocket or Socket.IO connection can keep named messages (with their event for Socket.IO): **Save message** above the editor, pick one to send it again. They are saved with the connection.
- **Generate an OpenAPI document from a collection.** **Export ▸ OpenAPI 3.1** (and `testpion export "My API" --format openapi`) describes the collection's HTTP requests: paths with path parameters, query and header parameters, request bodies and saved examples with inferred schemas, folders as tags and auth as security schemes. AI agents get it from the MCP tool `collection_openapi`.
- **Find where a variable is used, and rename it everywhere.** **Usages** in the Environments view (or the command palette) lists every place a variable is used or defined, in requests, scripts, environments, collection and folder variables and test files, and renames it in one go. Secret values move with it. Also `testpion vars usages|rename` and the MCP tools `variable_usages` / `rename_variable`.
- **Load-test a whole collection.** The Load view's new **Collection** target (and `testpion load --collection "My API" --warm-up`) has every virtual user send a collection's (or folder's) requests in order, with its auth, per-user cookies and variables, and shows p50/p95/p99 and errors per request. An optional warm-up runs it once with scripts first, so a login token set by a script is used under load. AI agents get the MCP tool `load_test` (local hosts only, capped at 50 users for 60 seconds).
- **Export history as HAR.** The History view's **HAR** button (and `testpion history export-har`) writes the HTTP and GraphQL requests you sent, with responses, as a HAR file for browser devtools and other tools. Secrets are masked.
- Fixed: importing a Postman **v2.0** collection lost its authorization (v2.0 stores auth settings as objects, v2.1 as lists), and headers written as one text failed to import.
- **Mock servers fill dynamic variables.** `{{$guid}}`, `{{$randomFullName}}`, `{{$isoTimestamp}}` … in a saved example's body or headers get a new value on every response, as in Postman's mocks. MCP mocks take them too, next to `{{args.x}}`.
- **Catch breaking API changes.** `testpion openapi-diff old.yaml new.yaml` compares two OpenAPI / Swagger versions and lists what can break clients (removed operations or success responses, new required parameters or body fields, type changes, removed or now-optional response fields, narrowed enums) and the other changes. `--fail-on-breaking` makes it a CI check, and **Run in CI** (`testpion ci --openapi api/openapi.yaml`) adds that check on pull requests to the generated GitHub, GitLab, Azure or Jenkins pipeline; `--json` and the MCP tool `openapi_diff` give the same to scripts and AI agents, and the app has **Compare OpenAPI versions** in the command palette.
- Fixed: `pm.environment.name` in scripts returned `"environment"`; it is now the active environment's name (also `pm.info.environmentName`).
- Scripts: `pm.request.url` is now a Postman-style URL object (`getPath()`, `getQueryString()`, `getRemote()`, `query.get/add/upsert/remove` …, keeping `{{variables}}` as written), and assigning a string to it replaces the URL.
- **Scripts for GraphQL requests.** The GraphQL view has a **Scripts** tab (pre-request and post-response), and in collection runs the collection's and folders' scripts now run for GraphQL requests too; before, a collection script that set a token or header was skipped for them. Postman GraphQL requests keep their scripts on import and export. Also fixed: saving a GraphQL request dropped its favorite mark.
- Scripts: typing a quote in `pm.environment.get('`, `pm.variables.set('`, `pm.globals.has('` … suggests the variable names of that scope, with their values (secrets hidden).
- **Mock an OpenAPI API at once.** Importing an OpenAPI / Swagger document now saves an example for each documented response (from its example, a named example or the schema), so the collection can be mocked straight away. `testpion mock`, `docs` and `export` also take a file or an http(s) link, e.g. `testpion mock https://petstore3.swagger.io/api/v3/openapi.json`.
- **More code snippets:** Python httpx, Java 11+ HttpClient, Kotlin (OkHttp) and Dart (http). Fixed: the Python snippet changed `true` / `false` / `null` inside JSON strings (a body like `{"note": "is true"}` became `"is True"`).
- **Save a response field to a variable.** Click a key in a JSON response (REST or GraphQL) and choose **Save to variable…**: the request's test script gets a `pm.environment.set(...)` line for it (so it's refreshed after every send) and the variable is set right away, ready for `{{name}}` in the next request.
- **OAuth 2.0: refresh tokens, Basic client auth, your own callback URL.** An expired authorization-code token is renewed with its refresh token instead of opening the browser again. **Client authentication** can send the client id and secret as a Basic header (Postman's option, imported and exported too), **Callback URL** takes the exact redirect registered with the provider (e.g. `http://localhost:8080/callback`), and **Forget tokens** clears the cache. Also fixed: running the browser flow twice could hang, because the browser reused a connection to the previous callback listener.
- **Imports flag scripts that won't run.** Importing a Postman collection whose scripts use `cheerio`, `pm.vault`, `pm.require` or an unavailable `require()` module now lists those requests with a suggestion (in the app, `testpion import` and the MCP tool), instead of failing later at run time.
- **More Postman scripts run as they are.** `xml2Json()` for XML and SOAP responses, `setTimeout` / `setInterval` (callbacks run after the script in delay order), `pm.response.size()`, `pm.expect.fail()`, and the legacy `postman.getResponseHeader`, `getResponseCookie`, `clearEnvironmentVariable` and `clearGlobalVariable`.
- Fixed: a script error showed only a stack trace pointing into TestPion's own code. It now shows the message and the line in your script (`Error: boom` / `at line 3:18`).
- **Import from a link.** The Import dialog has a link box: an OpenAPI URL, a file on GitHub / GitLab / Bitbucket (the page link works) or a Postman collection's API link is downloaded and imported. `testpion import <url>` does the same, and AI agents can use the new MCP tool `import_definition`. Also fixed: a `.env.staging` file chosen with **Choose file…** now becomes the *staging* environment.
- **Newman command lines work.** `testpion run-collection` now also takes Newman's `-g/--globals`, `--env-var`, `--global-var`, `--export-environment`, `--export-globals` (with the values scripts set; secret values left empty), `-k/--insecure`, `--suppress-exit-code`, `--timeout-request`, `--reporters` and `--reporter-junit-export`. Postman globals files import too.
- Importing (or running) a JSON file that has a syntax error now says so, with the line and column, instead of "Unrecognised import format".
- **lodash and moment in scripts.** As in Postman, scripts can use `_` (for example `_.get(json, 'items[0].id')`) or `require('lodash')`, and `moment` (for example `moment().add(1, 'day').format('YYYY-MM-DD')`; times are UTC). Each is loaded only for scripts that use it.
- Fixed: `pm.response.to.have.jsonSchema(schema)` in scripts always passed. It now validates the response (with Ajv, as the Schema check does) and the failure says what didn't match. `pm.expect(value).to.have.jsonSchema(schema)` and `tv4.validate(data, schema)` (older Postman scripts) work too.
- **Postman's dynamic variables.** `{{$randomFirstName}}`, `{{$randomCity}}`, `{{$randomUUID}}`, `{{$randomLoremSentence}}`, `{{$randomDateFuture}}` and about 70 more now give fresh fake values, so imported Postman collections send what they sent there instead of the literal text. Type `{{$` in any field or editor to pick one. `pm.variables.replaceIn()` in scripts fills them too.
- **Use your own Claude API key.** **Settings ▸ AI assistant** now works like Markpion: turn the assistant on, paste your Anthropic API key and **Save key** (TestPion checks it with Anthropic, then keeps it in the OS secret store, never in settings or workspace files), and pick Claude Opus 5.5, Sonnet 5.5 or Haiku 4.5. The key powers the assistant and appears in AI Lab and evaluations as **Claude (your API key)** (`claude-app`); CI can pass it as `TESTPION_SECRET_APP_ANTHROPIC_APIKEY`. A workspace provider (e.g. local Ollama) can still be chosen instead.
- **.env files.** Import a `.env` file as an environment (secret-looking keys become secret variables, with values in the OS secret store), and export an environment as `.env` from the Envs view.
- Fixed: in the MCP view, assertions (and the raw JSON arguments) were shared by all tools of a server, so picking another tool kept showing the previous tool's checks. Each tool now has its own.
- **Rename from the request tab.** Right-click a request tab and choose **Rename…**, or double-click it. A saved request is renamed in its collection too.
- **Filter responses with JSONPath.** The Pretty view of a JSON response (REST and GraphQL) has a JSONPath box: `$.items[*].name` shows just those values, with the number of matches.
- **Undo deleting a request or folder.** The message after deleting one in the collection tree has an **Undo** button.
- **Move requests and folders.** Drag them in the collection tree (onto a request to place before it, onto a folder to put inside, onto a collection name for its top level, across collections too), or use **Move to…** in their menu. Open tabs follow them.
- Fixed: **Duplicate** did nothing for a request inside a folder.
- **Home shows what's working.** When a workspace has monitors or test runs, Home adds a **Monitors** card (last result of each, paused ones marked) and a **Recent test runs** card (passed / failed, opens the run).
- **Compare a request across environments.** A new button next to **Send** sends the request with two environments and shows what differs: status, time, headers and every changed JSON field. From the terminal, `testpion env diff <a> <b> --request <name>`; for AI agents, `compare_request_across_environments`.
- **Checks from the response.** Click a key in a JSON response to copy its JSONPath or add a check on it to the request's Tests: equals its current value, exists, has its type, or (for arrays) its length / not empty. Works in the REST and GraphQL views.
- **Recently deleted.** Deleted collections and environments stay restorable for 30 days (a git-ignored `trash/` folder in the workspace): **Recently deleted** in the Collections and Envs lists, or `testpion trash list|restore|empty`. A restored environment keeps its secret values; a restored item never replaces one with the same name.
- **Keyboard shortcuts list.** Press `?` (outside a text field), use **Help ▸ Keyboard Shortcuts** or the command palette to see every shortcut, with the right modifier key for your platform.
- **Icons on every menu.** The application menu (File, Edit, View, Window, Help) has an icon on every item, in the same style as the rest of the app, and follows the light or dark system theme. The command palette shows an icon for each command. Right-clicking a text field (the URL bar, any input) now opens an Undo / Redo / Cut / Copy / Paste / Select All menu.
- **Trusted certificates.** **Settings ▸ Certificates** lets HTTPS trust the operating system's certificate store (for corporate TLS inspection) and extra CA certificates (PEM, with name, issuer and expiry shown). The CLI takes `TESTPION_USE_SYSTEM_CA=1` and `TESTPION_CA_FILE`. Settings now refuse a malformed certificate or proxy URL instead of saving it.
- **Fixes from a first-run pass over the examples.**
  - WebSocket messages and Socket.IO events now resolve `{{variables}}` (including `{{$guid}}` and the like) before they are sent. They used to go out literally.
  - A saved gRPC request without `.proto` files describes its service through server reflection as soon as it is opened, so **Invoke** works straight away. Descriptors from the previously open request no longer carry over, and reflecting no longer marks the request as edited.
  - AI Lab no longer marks a prompt's own input variables (`{{message}}`) as unknown, and suggests them in autocomplete.
  - The Collection Runner's "5 requests × 1 iteration" line no longer wraps one word per line.
- **Proxy settings.** **Settings ▸ Proxy**: use `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` (the default), a custom proxy with a bypass list and optional credentials (the password is kept in the secret store), or no proxy. It covers requests, `pm.sendRequest`, OAuth token calls, AI providers, MCP over HTTP, datasets, and WebSocket and Socket.IO connections; a request's own proxy still wins. The CLI now honours the proxy environment variables (`TESTPION_NO_PROXY=1` turns that off).
- **Import from Insomnia, Bruno and Hoppscotch.** Insomnia exports (v4 JSON, v5 YAML) with their environments, Bruno collection exports with environments, and Hoppscotch collections: folders, requests, bodies, headers, parameters, auth (bearer, basic, digest, API key, OAuth 1/2, AWS) and variables (`{{ _.x }}` and `<<x>>` become `{{x}}`). Their scripts come over as comments. Imports no longer replace an environment you already have (Postman environments included): a clash is added as *Name (imported)*.
- **Compare environments.** **Compare** in the Envs view shows two environments side by side: variables missing on one side, different values, disabled variables and secrets set on one side only (secret values are never shown). `testpion env diff` does the same from the terminal (exit 1 when they differ, handy in CI), and AI agents get `compare_environments`.
- **Publish collection docs as HTML.** The collection **Docs** tab has **Export HTML**: one self-contained web page with a searchable sidebar, copy buttons and light/dark themes, ready to host or share (`testpion docs --html` from the terminal). HTML in descriptions is shown as text, links are limited to http(s), and secrets are masked.
- **Run in CI.** TestPion writes the pipeline file that runs a suite, a collection (or some folders) or all tests on every push: GitHub Actions, GitLab CI, Azure Pipelines or Jenkins. It installs the TestPion CLI pinned to your version, publishes JUnit results, keeps the reports, and lists the CI secrets to create (never their values). Open it from the Tests view, a collection's menu (**Run in CI…**) or the command palette; from the terminal it is `testpion ci`, and AI agents get `ci_config`.
- Docs: the CI/CD page no longer says `npx testpion` (the CLI isn't on npm); it shows how pipelines install it.
- **WebSocket and Socket.IO tests.** A test with `type: websocket` (or `socketio`) connects, sends messages or emits events in order, listens, and checks what came back: `$.received[0]`, JSON fields of replies, `contains` on the text, `status: 101`. A connection that fails is an error with the reason. The examples workspace tests two public echo servers.
- **Examples workspace, ready on first launch.** New installations open **TestPion Examples**: REST (httpbin, JSONPlaceholder with scripts and chaining, Swagger Petstore with an OpenAPI contract check), GraphQL (Countries, Rick and Morty), gRPC through server reflection (grpcb.in), WebSocket echo servers, a live Server-Sent Events stream (Wikimedia), MCP servers over HTTP (Petstore MCP, DeepWiki) and an offline MCP mock, AI prompts, an evaluation, safety, RAG and an agent test on an offline demo model, two test suites and a paused monitor. All of it uses free public APIs; nothing to set up. Existing users can open it from **Help ▸ Open Examples Workspace** or the Home page. It is also in the repository (`examples/public-workspace`) for the CLI.
- MCP mocks fill `{{args.name}}` inside `json` responses too (a string that is only a placeholder keeps the argument's type).
- **Monitors.** Run a collection, or some of its folders, on a schedule (every minute to every 7 days) and get a notification when it starts failing or recovers. The new **Monitors** view shows each monitor's last result, success rate, run times, next run and every run (open it in Tests). Start one from the view, a collection or folder menu (**Monitor on a schedule…**) or **File ▸ New ▸ Monitor**. Monitors are saved in the workspace and run while the app is open; `testpion monitor start` runs them on a server and `testpion monitor run --due` from cron. AI agents get `list_monitors`, `monitor_results` and `run_monitor`.
- **Response-time trend.** A saved request's response **History** tab starts with a chart of its recent response times (median, p95 and slowest), with failed responses marked in red. Hover a point for its time, status and when it was sent; click it to open that response. The same numbers are available from `testpion history stats --json` and the `response_time_stats` MCP tool.
- **File menu.** New ▸ (HTTP request, GraphQL query, gRPC request, WebSocket / Socket.IO connection, MCP server, collection, environment, workspace), Open Workspace Folder, Import (Ctrl+O), Export ▸ (collection as Postman v2.1, current environment, workspace), Save (Ctrl+S) and Settings (Ctrl+,), next to the tab commands. The same commands are in the command palette.
- **Search finds saved items.** Global search (Ctrl+Shift+F) also finds saved WebSocket connections, gRPC requests and AI prompts (by name, folder, URL, method or prompt text) and opens them.
- **Warning for secrets typed into saved items.** Saving a WebSocket connection, gRPC request or AI prompt with a credential typed in (an `Authorization` header, a token in the auth payload …) instead of a `{{variable}}` now says which field it is, since saved items are workspace files that may be shared.
- **OAuth 1.0 auth.** OAuth 1.0a (HMAC-SHA1, HMAC-SHA256, PLAINTEXT) signs each request when it is sent, with the parameters in the Authorization header or the query string; round-trips through Postman collections.
- **Socket.IO.** The WebSocket view has a **Socket.IO** mode: connect to a namespace (with path, auth payload and headers), see every event by name, emit events with JSON arguments and wait for acknowledgements. The demo servers include a Socket.IO namespace (`http://127.0.0.1:4015/chat`). From the terminal, `testpion ws <url>` sends messages or emits events and prints the replies; AI agents get the `realtime_exchange` MCP tool.
- **gRPC: saved requests and history.** The gRPC view has a **Saved requests** list with folders, and every call appears in History (filter *grpc*, double-click to open it again).
- **Editor help everywhere.** Code editors now autocomplete `{{variables}}` (with their value and scope, secrets hidden), show defined variables in blue and unknown ones in red with a wavy underline, and explain a variable on hover. Scripts get ready-made `pm.*` / `tp.*` snippets (tests for status, JSON fields, headers, body text, JSON Schema and response time; setting variables; `pm.sendRequest` …). JSON editors with a schema complete and validate as you type: MCP tool arguments (raw JSON) from the tool's input schema, gRPC messages from the proto message type. Header, param and form values in tables highlight and autocomplete `{{variables}}` too, and header values suggest common values.
- **gRPC certificates.** Custom CA certificates and client certificates for mutual TLS (app: gRPC **Settings**; the private key is never saved with the draft, use a secret `{{variable}}`), also for server reflection. TLS to an IP address works.

## 0.8.0 — 2026-09-29

- **Folders for MCP servers, WebSocket connections and AI prompts.** Like the REST collections: the MCP server list, the new **Saved connections** list in the WebSocket view and the new **Saved prompts** list in the AI Lab Playground group items in folders (new folder, rename, move to folder, drag and drop, duplicate, delete, right-click menus). WebSocket connections (URL, subprotocols, headers, message) and AI prompts (model, parameters, prompt, variables, structured output, evaluators) can now be saved and reopened; they're stored in the workspace's `library/` folder. New docs page: WebSocket.
- **UI fixes from a hands-on pass (MCP and AI first).** MCP: executing a tool with required arguments left empty now says which ones (with *Execute anyway* to test the server's validation); a single result or resource fills the panel instead of a small fixed box; prompts show their messages as a conversation (JSON one click away) and an empty state before the first call. AI Lab and Evaluations keep their results, tabs and selected run when you switch tabs or views; empty Top P / Max tokens / Seed fields say what they mean; the evaluation settings no longer overflow a narrow pane. Raw text views wrap long lines at the width of the view. Smaller fixes: the environment colour picker lines up with the name, the WebSocket subprotocols field is readable, and Home mentions gRPC and WebSocket.
- **MCP results stay put, with display options.** A tool's result (and arguments, assertions, the resource you read and prompt output) is kept while the app runs: switching the Tools / Resources / Prompts tabs, another tool, another server or another view no longer empties it, and each tool keeps its own last result. Tool output can be shown **Pretty** (JSON as a tree), **Raw** (searchable text) or as rendered **Markdown**, copied, or saved to a file.
- **Fixed: WebSocket connection errors were empty.** A failed connection now says why: the server's name doesn't resolve (as with the retired `echo.websocket.events`), nothing listens on the port, the server answered with HTTP (e.g. 401 or 404) instead of opening a WebSocket, or `wss://` was used for a server without TLS. The reason and suggestions stay in the message list, not only in a toast.
- **gRPC.** A new **gRPC** view calls services described by `.proto` files (imports and Google's well-known types resolve): unary, server-streaming, client-streaming and bidirectional methods, with example messages, metadata, TLS (`grpcs://`) and deadlines. Streamed responses appear live, and **Stop** keeps the messages received so far. The demo servers include a gRPC service (`127.0.0.1:4014`). Servers that offer gRPC server reflection work without `.proto` files (**Use server reflection**, or leave the protos out in tests, the CLI and MCP). gRPC calls can also be tests (`type: grpc`, with a `grpc-status` check and JSONPath assertions on the response), are available from the CLI (`testpion grpc`) and to AI agents (the `grpc_call` MCP tool).
- **OpenAPI contract testing.** A new `openapi` check verifies a response against the API's OpenAPI 3 or Swagger 2 document: the operation is found from the request (server base paths, path templates), and the status, content type and body schema (`$ref`, `nullable`, enums, formats) must match what is documented, with every violation listed. Available in the app (**Matches OpenAPI contract**), in test files and from the CLI. Importing an OpenAPI document now keeps it in `specs/` and adds this check to every request, so running the imported collection tests the API against its contract.
- **Server-Sent Events, event by event.** `text/event-stream` responses (live feeds, streaming LLM APIs) are shown live as a table of events (time, type, id, data), with a detail view (JSON as a tree) and a filter. The stream stays open past the request timeout, **Stop** keeps the events received so far, and the MCP `send_request` tool returns the parsed events to AI agents.
- **AWS Signature and Digest auth.** Two new auth types, as in Postman. *AWS Signature* (Version 4) signs requests to API Gateway, S3, Lambda function URLs or any AWS API when they are sent, with optional session tokens for temporary credentials. *Digest* answers the server's challenge (MD5 or SHA-256). Both import from Postman collections and from cURL (`--aws-sigv4`, `--digest`), export back to Postman, and keep their secrets redacted.

## 0.7.0 — 2026-09-29

- **Faster startup.** The code editor (Monaco, several MB) now loads the first time an editor is shown, and in the background right after startup, instead of before the first screen: the startup bundle went from 1.8 MB to 0.3 MB.
- **Sturdier RPC for the browser version (and the planned online version).** The web bridge rejects malformed or oversized (over 64 MB) requests with a clear error instead of stopping, keeps non-ASCII text intact in large requests, compares its access token in constant time, and every error from the desktop app and the bridge keeps its kind and suggestions.
- **Internal: easier to extend.** The desktop backend's RPC methods and the CLI's commands are split into one module per area (`apps/desktop/backend/handlers/`, `packages/cli/src/commands/`), with a first test of the backend's RPC surface.
- **Updates found while the app stays open.** The desktop app now also checks for a new release every 6 hours while it runs, not only at startup, so people who keep it open for days still get fixes. A version you postponed with **Later** isn't offered again until the next start.
- **MCP mock server.** Fake MCP servers for testing AI agents and MCP clients without the real server or its side effects: tools with canned responses (matched on arguments, with `{{args.x}}` templates), resources and prompts in a `*.mcp-mock.yaml` file. Record one from a real server with **Save as mock** in the MCP view (tools, resources, prompts and the calls you made, secrets redacted), use it in the app as a server with the **Mock** transport, or serve it to agents with `testpion mock-mcp <file>` (stdio, or `--http`).
- **Colours from the logo, and a visible text cursor.** The interface now uses the logo's palette: navy-tinted surfaces, its electric blue as the accent, the blue → violet gradient for primary actions and its magenta for AI. The text cursor in every text box (the URL bar included) is the logo's blue on the light theme and cyan on the dark theme; before, it could be hard or impossible to see. Code editors use the same colours.
- **Visualizer charts.** `pm.visualizer` templates can now run scripts, like in Postman: load Chart.js (or another library) from cdn.jsdelivr.net, cdnjs or unpkg and read the data with `pm.getData()` / `tp.getData()`. Visualizations run on an isolated origin (`tpviz://`) in a sandboxed frame with no network access, so they can't reach the app or send data anywhere.
- **GraphQL mock server.** Answers any valid query against a schema with fake, correctly typed and deterministic data (plausible emails, names, URLs, dates, prices …), with real validation errors and introspection. Start it from the GraphQL view (**Mock**, after **Introspect**) or with `testpion mock-graphql --schema schema.graphql` / `--endpoint <url>`; fix values per type with overrides.
- **Tidier Tests, Load, Traces and Evaluations screens.** Metric cards sit in an even grid (compact in run results) with readable score names (*Context precision* instead of *score · context-precision*); run results show coloured pass / fail pills and more of each test name; the report **Export** menu has icons; trace durations and the trace header no longer wrap; the Evaluations **Run** button is no longer cut off.
- **Network policy for shared and hosted use.** `TESTPION_BLOCK_PRIVATE_NETWORKS=1` (or `testpion mcp-server --block-private-networks`) makes every outbound connection (requests and their redirects, `pm.sendRequest`, GraphQL, WebSocket, MCP over HTTP, AI providers, remote datasets) refuse localhost, private networks and cloud metadata addresses, checked after DNS resolution and at connect time; `TESTPION_ALLOW_PROCESSES=0` stops local MCP servers from starting. Off by default on the desktop.
- **Works without native file dialogs** (the browser version today, the planned online version later). Import, *Save response*, report export and viewing, workspace export and Collection Runner data files use the browser's file picker and downloads when the app has no native dialogs; *Open folder* asks for the folder's path. The desktop app still uses its native dialogs.
- **Cookies for WebSocket and MCP.** WebSocket handshakes send the workspace cookie jar's cookies (so a session from a login request works), and MCP servers over Streamable HTTP or SSE send and receive cookies through the jar.
- **Mock servers match on the request body.** Among examples of the same request, the one saved with the same body (JSON in any key order, a JSON subset, or form fields in any order) wins, so one endpoint can answer *Success* or *Wrong password*. Postman's `x-mock-match-request-body: true` and `x-mock-match-request-headers: a, b` headers make matching strict.
- **Convert a collection's scripts between `pm.*` and `tp.*`.** Right-click a collection (or **⋯**): **Convert scripts to tp.\*** / **to pm.\***, with a preview of how many scripts change. CLI: `testpion scripts convert --to tp|pm [--collection] [--dry-run] --json`.
- **Response history and compare.** Saved requests get a **History** tab in the response panel: earlier responses, newest first. View any of them, or compare two to see exactly what changed: status and time, header changes (ignoring headers such as `date` that change every time) and a field-by-field body diff with JSON paths (`$.items[2]` added, `$.total` 2 → 3), or a line diff for text. For agents and scripts: `testpion history list|diff --json` and the MCP tools `request_history` and `compare_responses` (sensitive values masked).

## 0.6.3 — 2026-09-29

- **Fixed: the HTTP method couldn't be changed** in the desktop app (the native drop-down didn't open properly). The method is now picked from TestPion's own menu, with each method's colour, and **Custom…** for other methods.
- **Copy a request from the collection tree.** The request menu (right-click or **⋯**) has **Copy URL**, **Copy as cURL (bash)**, **cURL (cmd)**, **PowerShell**, **fetch** and **More code snippets…**, with variables resolved from the active environment. Right-click now opens the menu on any request.
- **One design for every dialog.** All confirmations use TestPion's dialog instead of the operating system's plain boxes: a tone icon (info, question, warning, danger, success), a clear message and detail, and buttons that say what they do (**Delete collection**, **Discard changes** …). The update progress box uses the same design.
- **Icons on every menu item**, and menu labels line up.
- **`tp.*` scripts.** Scripts can use `tp` (TestPion's name) or `pm` (Postman's) for the script API; they are the same object, so either works, even mixed in one script. Snippets and the editor's hints use `tp`, and autocomplete knows both. Postman imports keep `pm.*`; exports to Postman convert `tp.*` to `pm.*` so Postman and Newman can run them (only code is changed, not strings or comments).

## 0.6.2 — 2026-09-29

- **The TestPion logo everywhere, no more "T".** The app, taskbar, title-bar and desktop-shortcut icon, the macOS and Linux icons and the website favicon now show the TestPion name ("Test" over "Pion", with the sparkle). The Windows installer shows the TestPion wordmark in its header and on the welcome and finish pages.
- **Close all request tabs from the File menu.** New **File** menu items: **New Request Tab** (Ctrl/Cmd+T), **Close Tab** (Ctrl/Cmd+W), **Close Other Tabs** and **Close All Tabs** (Ctrl/Cmd+Shift+W), also in the command palette and a new **⋯** menu at the right end of the tab bar. Pinned tabs are kept. On macOS, Close Window moves to Cmd+Option+W.
- **New Design page** in the documentation: principles, brand, colours, layout, components, the core architecture and the life of a request, with diagrams.

## 0.6.1 — 2026-09-29

- **Fixed: updates failing with `net::ERR_CONNECTION_RESET`.** The updater tried a "differential" download (many byte ranges of the new installer in one request), which GitHub's release download servers now reject. It now always downloads the whole installer (still verified with its SHA-512 checksum), retries twice when the connection drops, and if it still fails offers **Try Again** or **Download from Website** instead of a bare error.
- **Fixed: garbled release notes in the update dialog.** The notes arrive as HTML; the dialog showed tag fragments such as `<li<strong`. It now lists the headline of each change.
- **The TestPion wordmark replaces the T** in the app's top bar, the website's nav bar and the website's home page. The square T remains only as the app icon and favicon.

**If you're on 0.5.1 and the update fails:** download `TestPion-0.6.1-windows-x64-setup.exe` from the download page and run it; it installs over your current version and keeps your workspaces, settings and secrets.

## 0.6.0 — 2026-09-29

- **FluxPion is now TestPion.** New name for the app, the `testpion` CLI (`fluxpion`, `protopion` and `protolens` still work as aliases), the `@testpion/*` packages, a new logo (a gradient **T** with the sparkle) and wordmark, the documentation site (https://nasimuddin-dev.github.io/testpion/) and the GitHub repository (nasimuddin-dev/testpion). Nothing to do when upgrading: the app updates in place and keeps its settings and saved secrets, the data folder `~/.fluxpion` moves to `~/.testpion`, `FLUXPION_*` variables still work, and FluxPion workspace exports still import.
- **Update checks are easier to diagnose.** Every update check and failure, and the updater's own messages, are written to the application log (Logs panel), and *Check for Updates* shows the actual reason when a check fails. Auto-update itself was working: there had been no release since 0.5.1, so there was nothing newer to install.
- **Friendlier workspace switcher.** Search, each workspace's folder, a *current* marker, and a **⋯** / right-click menu per workspace: Open, Rename, Duplicate, Show in folder, Export and Delete. Rename, duplicate and export work for any workspace, not only the open one. New *Workspaces* docs page.
- **Fixed: deleting a workspace.** The old flow silently did nothing when the typed name didn't match exactly, and it left out the open workspace. A delete dialog now shows the folder and what it holds, accepts the name in any case, deletes the open workspace after switching to another, retries when Windows locks a file, and only unregisters folders you opened yourself (their files stay). CLI: `testpion workspace list --json`, `workspace rename`, `workspace delete --yes`.
- **AI-agent access to the new features.** The `testpion mcp-server` has three new tools: `parse_request_snippet` (cURL / fetch / PowerShell → request), `save_request` (save a snippet or request into a collection and folder) and `reorder_environments`. `send_request` accepts a `snippet`, and run results now include script logs and the `pm.visualizer` rendering. On the command line, `testpion import` accepts a copied request from a file or stdin, `testpion env list` / `env order` read and set the environment order, and these commands take `--json`. The Import dialog accepts pasted cURL / fetch / PowerShell too. Everywhere, secrets in a copied request are replaced by `{{variables}}` and listed, never written to workspace files.
- **Postman Visualizer (`pm.visualizer.set`).** A test script can render the response as HTML with a Handlebars template; the response body then opens on **Visualize**. Templates are rendered by the engine, sanitised and shown in a sandboxed frame (no scripts). The example **List patients** request shows the patients as a table, and the Snippets list has a starter template.
- **MCP and WebSocket in the Console.** The Console now also logs MCP server connections, tool calls (arguments and result), resource reads and prompts, and WebSocket connects (handshake headers), sent messages and closes (duration and sent/received counts), all redacted like HTTP requests.
- **Fixed: request tabs no longer need a horizontal scrollbar.** When there are more tabs than fit, the tab bar shows the pinned and most recently used tabs, and a **+N** dropdown lists the rest (like Postman and VS Code), with **Close N hidden tabs**. Tabs have an equal width and the active tab is marked with the brand colour.
- **Friendlier design.** A new look built on the current shadcn/ui style (React 19, Tailwind CSS v4, Radix UI): OKLCH colour tokens with the TestPion blue → violet brand as the accent, layered surfaces (top bar and navigation rail, sidebars, work area and popovers are now visually distinct), a clearer active item in the navigation rail, coloured method pills (GET, POST …) in the request tree, tabs, history and runner, gradient primary buttons and tab indicators, rounded pill badges, softer menus and dialogs, and friendlier empty states. The Home view has a greeting, the active environment, colour-coded quick actions and uses the full window width. Both dark and light themes are updated.
- **Paste a request from the browser.** Copy a request in the browser devtools Network tab with **Copy as cURL (bash)**, **Copy as cURL (cmd)**, **Copy as fetch**, **Copy as fetch (Node.js)** or **Copy as PowerShell**, and paste it into the URL bar or anywhere in the REST view: TestPion builds the request (method, URL, params, headers, cookies, body and auth). Pasting outside the URL bar fills an unchanged new tab or opens a new one named after the method and path. cURL commands copied for Windows `cmd` (with `^` escapes) now import correctly too.
- **Reorder environments.** Drag environments (or press Alt+Up/Down) in the Environments view to set their order; the environment picker, Home view and sidebars follow it. The order is stored in each environment file.
- **Fixed:** workspace search (Ctrl/Cmd+Shift+F) now opens right under the top-bar search box instead of floating in the middle of the window.
- **Fixed:** in the dark theme, the environment picker's dropdown list (and other native dropdowns) showed light text on a white background.

## 0.5.1 — 2026-09-27

- **New FluxPion logo and icon.** The app icon (Windows, macOS and Linux, all sizes), the in-app logo, the website logo and favicons, the README banner and the link preview image now use the FluxPion brand: the gradient **F** with a sparkle, and the *Connect every protocol* wordmark. `npm run icons -w @fluxpion/desktop` regenerates every size from `build/logo.svg` and `build/wordmark.webp`.

## 0.5.0 — 2026-09-27

- **ProtoPion is now FluxPion.** New name for the app, the `fluxpion` CLI (`protopion` and `protolens` still work as aliases), the `@fluxpion/*` packages, the documentation site (https://nasimuddin-dev.github.io/fluxpion/) and the GitHub repository (nasimuddin-dev/fluxpion). Nothing to do when upgrading: the app updates in place and keeps its settings and saved secrets, the data folder (`~/.protopion` or `~/.protolens`) moves to `~/.fluxpion`, `PROTOPION_*` / `PROTOLENS_*` variables still work, and workspace exports from ProtoPion and Protolens still import. On macOS, secrets saved in the Keychain may need to be entered again.

## 0.4.0 — 2026-09-27

- **Protolens is now ProtoPion.** New name for the app, the `protopion` CLI (`protolens` still works as an alias), the `@protopion/*` packages, the documentation site (https://nasimuddin-dev.github.io/protopion/) and the GitHub repository (nasimuddin-dev/protopion). Nothing to do when upgrading: the app updates in place and keeps its settings and saved secrets, the data folder `~/.protolens` moves to `~/.protopion`, `PROTOLENS_HOME` and `PROTOLENS_SECRET_*` variables still work, and workspace exports from Protolens still import. On macOS, secrets saved in the Keychain may need to be entered again.

## 0.3.1 — 2026-09-27

- **Fix:** importing a Postman collection from the workspace menu failed with "Not an FluxPion workspace export". The menu item is now **Import…**: a workspace export still opens as a new workspace, and Postman collections and environments, OpenAPI and HAR files are imported into the open workspace. The file picker also accepts `.yaml`, `.yml` and `.har`.

## 0.3.0 — 2026-09-27

- **Favorite requests.** Choose **Add to favorites** in a REST or GraphQL request's ⋯ menu. The star next to **Filter requests** shows only favorites, with their folders kept for context. Favorites are saved in the collection.
- **Collection tree:** requests with saved examples get a chevron that lists the examples (status and name) under the request; clicking one opens the request.
- **Console:** GraphQL operations sent from the GraphQL view appear in the Console, badged **GraphQL**, with the redacted query, variables, response and failures. `pm.sendRequest` calls made by runs (test runner, Collection Runner) are listed under their request and recorded as `sentRequests` in the run results.
- **Faster start-up:** tool views load on demand instead of all at launch.
- **Fix:** the last request tab could not be closed; closing it replaced it with a new "Untitled request". Closing every tab now leaves an empty editor with **New request** and **Describe with AI**, which is also kept after a restart.

## 0.2.0 — 2026-09-27

Postman parity: most of Postman's day-to-day features, plus AI help and an MCP server for AI agents. Workspaces from 0.1.0 open unchanged.

- **Folder scripts and variables.** **Edit folder** (in a folder's ⋯ menu) sets pre-request and post-response scripts, variables and auth for every request inside. Scripts run collection → outer folders → folder → request, in tabs, the Collection Runner and the CLI. Inner folder variables win, and request and data variables win over folder variables. Folder scripts and variables round-trip through Postman v2.1.
- **`pm.sendRequest`.** Scripts can send HTTP requests (URL or Postman request object, raw or URL-encoded bodies) and use the response in a callback, including chained requests. Requests share the run's cookie jar, respect timeouts and cancellation, are limited to 20 per script, and are listed in the Console. Monaco typings and a snippet are included.
- **AI help in the request builder.** **Describe a request** turns plain words into a request in a new tab, using variable names but never values. **Generate tests** appends AI-written `pm.test` checks, labelled as AI-generated, to the Post-response script. **Explain** on 4xx/5xx responses opens the assistant with the likely cause and fix. Model output is parsed and validated, and nothing runs until you choose to.
- **For AI agents.** `fluxpion mcp-server` serves a workspace to AI agents (Claude Code, IDE assistants …) over MCP with seven tools: list collections, requests and environments, read a request or the collection docs, send a request (saved or ad hoc) and run a collection. Output is redacted, variable values are never listed, production environments need `--allow-production`, and `--read-only` removes sending. The docs site publishes `llms.txt`.
- **Postman-like sidebar.** The REST view's sidebar has Collections, Environments (click to activate, edit, create) and History (grouped by day, click to open) panes, and friendlier empty states.
- **Home and environment quick look.** A new **Home** view, which the app opens on the first time, has quick actions (new request, GraphQL, import, new collection, MCP, AI, assistant, docs), recent requests, collections (with run) and environments (click to activate), plus keyboard shortcuts. An eye button next to the environment selector shows the active environment's and the global variables with initial and current values, secrets masked.
- **Tabs and history.** Request tabs have a right-click menu: pin (pinned tabs stay first and survive bulk closes), duplicate, close, close others, close to the right and close all, with one confirmation for unsaved changes. History is grouped by day (Today, Yesterday, weekday, date), and double-clicking an entry reopens it.
- **Console.** A Postman-style console in the bottom panel (status bar **Console** or Ctrl+Alt+C). It lists every request (from tabs and runs) with status, time and size, shows script `console.log` output under each request, and expands to request and response headers and bodies. It has All / Errors / With logs filters and search. Everything is redacted, including values echoed back by the server, and nothing is written to disk.
- **Export to Postman v2.1.** Collections export as Postman v2.1 (folders, requests, params, path variables, headers, all body types, bearer/basic/API key/OAuth 2.0 auth, scripts, variables, descriptions, examples and settings), and environments as Postman environments (secret values never included). Status assertions become `pm.test`s, and anything Postman can't hold is listed. Available from the Export menus and as `fluxpion export` / `fluxpion export-environment`. The Postman importer now also reads collection-level scripts, path variables, OAuth 2.0, GraphQL and file bodies, and the redirect/TLS settings, so export and import round-trip.
- **Examples (saved responses).** Save a response as a named example of a request with **Save as example**. Browse, rename and delete examples in the request's new **Examples** tab. Examples are stored in the collection file with sensitive headers, JSON fields and secret values masked. Postman imports bring saved responses in as examples, and request descriptions too.
- **Documentation.** Each request has a **Docs** tab for Markdown with a live preview. The collection's **Docs** tab (formerly *Overview*) renders the whole collection as one page: description, table of contents, and every request's URL, auth, parameters, headers, body and examples, with sensitive values masked. **Export Markdown** saves the page, and `fluxpion docs <collection>` writes the same from the CLI. Markdown is sanitised before it is shown.
- **Mock servers.** A collection's **Mock** tab serves its saved examples on localhost. It matches method and path (`:id` / variable segments, literal paths first, flexible ids), picks examples with `x-mock-response-name` / `x-mock-response-code`, adds CORS headers, logs requests live and follows example changes. The same is available from the CLI as `fluxpion mock <collection>`, which also accepts Postman collection files.
- **Cookie jar and cookie manager.** Each workspace has a cookie jar. Cookies from `Set-Cookie` responses are stored, including those set during redirects (login flows), and sent with later matching requests, following RFC 6265 domain, path, `Secure` and expiry rules. A request's own Cookies tab still wins for the same name. A **Cookies** dialog (cookie button next to Send) lists cookies by domain and lets you add, edit, delete and clear them. The jar is kept on this machine only, encrypted with the OS credential store, and is never written to workspace files. Scripts get `pm.cookies.jar()` (`get`, `getAll`, `set`, `unset`, `clear`), and `pm.cookies` now includes jar cookies in runs too. The HTTP and GraphQL requests of a run share one jar.
- **`fluxpion run-collection`** (Newman equivalent). Runs a workspace collection, or a FluxPion or Postman v2.1 collection file, with Newman's option names: `-e` (environment name or Postman environment file), `-d`/`--iteration-data`, `-n`/`--iteration-count`, `--delay-request`, `--folder`, `--bail`, plus reporters, baselines and traces. `--cookie-jar` and `--export-cookie-jar` load and save cookies as JSON, and Newman's cookie jar files are accepted. Fixed a Windows crash of the CLI at exit.
- **Collection Runner.** Runs a collection or folder in order, with iterations, CSV/JSON data files (`pm.iterationData`), a delay, a request checklist, "Keep variable values" and "Stop on first failure". Supports `pm.execution.setNextRequest`, `postman.setNextRequest` and `pm.execution.skipRequest()`. Collection-level scripts run before each request's scripts.
- **Postman `pm.*` scripting API** in the sandbox: `pm.test`, chai-style `pm.expect`, `pm.response`, `pm.request`, variable scopes, `pm.iterationData`, `pm.info`, `pm.cookies`, CryptoJS, `btoa`/`atob` and the legacy `tests[]` / `postman.*` globals. Pre-request scripts can change the outgoing request. Values set by scripts are kept as local "current values" (sensitive ones encrypted), never in workspace files. A Scripts panel with snippets and `pm` typings.
- **Request builder.** Paste a cURL command into the URL bar to import it. Code snippets in 15 languages and tools, with secrets masked by default. Path variables (`/users/:id`), a query string that stays in sync with the Params table, bulk edit for key/value tables, variable autocomplete and a Beautify button for JSON and XML bodies.
- **UI.** The desktop app was redesigned on Radix UI and Tailwind (accessible dialogs, menus, tooltips and toasts, refreshed light and dark themes). Name prompts use an in-app dialog, which fixes saving requests when a workspace has no collections.

## 0.1.0 — 2026-09-26

First implementation of the FluxPion SRS (Phases 0–8, local-first):

- Core engine (`@fluxpion/core`): HTTP, GraphQL, MCP (stdio, Streamable HTTP, SSE) and WebSocket adapters; OpenAI-compatible, Azure OpenAI, Anthropic, Gemini, Ollama and mock providers; agent loop; variables with scope precedence; QuickJS script sandbox; assertion and evaluator engine (deterministic, heuristic, semantic, LLM-as-judge, RAG, agent, safety); tracer; streaming runner with retries, dependencies and checkpoints; reports; regression baselines; load testing; workspace storage with migrations, SQLite metadata and encrypted secrets; OpenAPI, Postman and HAR importers.
- Desktop app (Electron + React): REST, GraphQL, WebSocket, MCP, AI Lab, Evaluations, Tests, Load, Traces, Collections, History, Environments and Settings views; command palette; global search; AI assistant.
- CLI (`fluxpion`): `test`, `run`, `load`, `import`, `workspace`, `mcp` and `report` commands, with CI exit codes and JUnit, JSON, HTML and Markdown output.
- Installers: Windows (installer and portable), macOS (Apple Silicon and Intel `.dmg`) and Linux (AppImage, `.deb`, `.rpm`), built by the release workflow.
- Website and documentation at https://nasimuddin-dev.github.io/fluxpion/, with download page, installation guides, features, FAQ and roadmap.
- Example workspace, demo servers and a benchmark.
