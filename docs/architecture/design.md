---
title: "Design"
description: "The TestPion design: principles, brand, colour, layout, components, the core architecture and the life of a request, shown visually."
---

# Design

This page shows how TestPion is designed, from the brand and the interface down to the engine. It is the reference for anyone (human or AI) adding a feature: new work should look and behave like what is described here.

## Principles

<div class="ds-grid ds-grid-3">
  <div class="ds-card"><div class="ds-card-title">Local-first</div>Everything runs on your machine. Workspaces are plain files you can commit; nothing is sent anywhere unless a request you make sends it.</div>
  <div class="ds-card"><div class="ds-card-title">One engine</div>The desktop app, the CLI and the MCP server call the same core engine, so a test behaves the same in the app, in CI and for an AI agent.</div>
  <div class="ds-card"><div class="ds-card-title">AI-first</div>Every feature is usable by AI agents (CLI with <code>--json</code>, MCP tools, <code>llms.txt</code>) and reviewable by people. AI output is always labelled and shown before it runs.</div>
  <div class="ds-card"><div class="ds-card-title">Safe by default</div>Secrets live in the OS credential store, are redacted from logs, traces, the console and exports, and are never written to workspace files.</div>
  <div class="ds-card"><div class="ds-card-title">Friendly</div>Clear surfaces, colour that carries meaning (methods, status), plain-language messages, and a next step in every empty state and error.</div>
  <div class="ds-card"><div class="ds-card-title">Cloud-ready</div>A hosted, multi-user version is planned. The UI only talks to the engine through RPC, the engine is host-agnostic behind storage and secret interfaces, and anything that sends requests or runs code must be safe on a shared server.</div>
  <div class="ds-card"><div class="ds-card-title">Postman-familiar</div>Collections, environments, <code>tp.*</code> scripts, the runner and the console work the way Postman users expect, and import and export losslessly.</div>
</div>

## Brand

<div class="ds-brand">
  <img src="/images/testpion-wordmark.png" alt="The TestPion wordmark: gradient Test, white Pion, a four-point sparkle, and the tagline Connect every protocol" />
</div>

<div class="ds-grid ds-grid-3">
  <div class="ds-card">
    <div class="ds-card-title">Wordmark</div>
    <div class="ds-logo-dark"><img src="/wordmark-nav.png" alt="TestPion wordmark" style="height:34px" /></div>
    The logo everywhere a name is shown: the app's top bar, the website, the README. "Test" uses the brand gradient, "Pion" is white, and the sparkle sits top right.
  </div>
  <div class="ds-card">
    <div class="ds-card-title">App icon</div>
    <div class="ds-logo-dark"><img src="/icon-192.png" alt="TestPion app icon" style="height:64px" /></div>
    The same logo, stacked to fit a square: the app, taskbar, title bar, installer and dock icon, and the favicon.
  </div>
  <div class="ds-card">
    <div class="ds-card-title">Brand gradient</div>
    <div class="ds-gradient"></div>
    <code>#1FF0FF → #1E88FF → #8B5CFF → #F04FE0</code> in the wordmark; the interface uses the calmer <code>#2F7BFF → #8B5CFF</code> for primary buttons and active indicators.
  </div>
</div>

<div class="ds-grid ds-grid-2">
  <div class="ds-card ds-do"><div class="ds-card-title">Do</div>
    <ul>
      <li>Keep the wordmark on navy (<code>#0C1440</code>) or a dark surface. On light pages, put it on a navy badge.</li>
      <li>Leave clear space of at least the height of the "P" around it.</li>
      <li>Generate every size from the sources with <code>npm run icons -w @testpion/desktop</code>.</li>
    </ul>
  </div>
  <div class="ds-card ds-dont"><div class="ds-card-title">Don't</div>
    <ul>
      <li>Recolour "Pion" or the gradient, or place the wordmark on a light background without the badge.</li>
      <li>Stretch it, add effects, or type the name as the logo in another font.</li>
      <li>Use the square app icon where there is room for the wordmark.</li>
    </ul>
  </div>
</div>

Sources: `apps/desktop/build/logo/testpion-NxN.png` (the square app icon, the TP test-tube mark, drawn at 32–1024 px; the original is `testpion-logo-original.png`), `apps/desktop/build/wordmark.svg` (wordmark with tagline) and `apps/desktop/build/wordmark-nav.svg` (wordmark without tagline).

## Colour

The interface uses design tokens (OKLCH, in `apps/desktop/src/styles.css`), with one set per theme. Components use the tokens, never raw colours, so both themes stay consistent.

The palette comes from the logo: neutrals are tinted with its navy, the accent is its electric blue, primary actions use its blue → violet gradient, and AI features use its magenta. The text cursor uses the logo's blue (light theme) or cyan (dark theme), so it is easy to find in every text box.

<div class="ds-theme-cols">
<div>
<div class="ds-theme-title">Dark theme</div>
<div class="ds-swatches">
  <div class="ds-sw"><span style="background:#060a1a"></span><b>chrome</b><code>#060A1A</code></div>
  <div class="ds-sw"><span style="background:#090f20"></span><b>panel</b><code>#090F20</code></div>
  <div class="ds-sw"><span style="background:#101629"></span><b>bg</b><code>#101629</code></div>
  <div class="ds-sw"><span style="background:#141a2f"></span><b>popover</b><code>#141A2F</code></div>
  <div class="ds-sw"><span style="background:#1b243e"></span><b>hover</b><code>#1B243E</code></div>
  <div class="ds-sw"><span style="background:#333c58"></span><b>line-strong</b><code>#333C58</code></div>
  <div class="ds-sw"><span style="background:#eef2fa"></span><b>fg</b><code>#EEF2FA</code></div>
  <div class="ds-sw"><span style="background:#9ba4be"></span><b>muted</b><code>#9BA4BE</code></div>
  <div class="ds-sw"><span style="background:#4697ff"></span><b>accent</b><code>#4697FF</code></div>
  <div class="ds-sw"><span style="background:#4ad496"></span><b>ok</b><code>#4AD496</code></div>
  <div class="ds-sw"><span style="background:#fabb41"></span><b>warn</b><code>#FABB41</code></div>
  <div class="ds-sw"><span style="background:#fa686a"></span><b>bad</b><code>#FA686A</code></div>
</div>
</div>
<div>
<div class="ds-theme-title">Light theme</div>
<div class="ds-swatches">
  <div class="ds-sw"><span style="background:#f1f3f9"></span><b>chrome</b><code>#F1F3F9</code></div>
  <div class="ds-sw"><span style="background:#f7f9fc"></span><b>panel</b><code>#F7F9FC</code></div>
  <div class="ds-sw"><span style="background:#ffffff"></span><b>bg</b><code>#FFFFFF</code></div>
  <div class="ds-sw"><span style="background:#ffffff"></span><b>popover</b><code>#FFFFFF</code></div>
  <div class="ds-sw"><span style="background:#e5eaf5"></span><b>hover</b><code>#E5EAF5</code></div>
  <div class="ds-sw"><span style="background:#ccd1dc"></span><b>line-strong</b><code>#CCD1DC</code></div>
  <div class="ds-sw"><span style="background:#0f142a"></span><b>fg</b><code>#0F142A</code></div>
  <div class="ds-sw"><span style="background:#5b6378"></span><b>muted</b><code>#5B6378</code></div>
  <div class="ds-sw"><span style="background:#186de7"></span><b>accent</b><code>#186DE7</code></div>
  <div class="ds-sw"><span style="background:#05893e"></span><b>ok</b><code>#05893E</code></div>
  <div class="ds-sw"><span style="background:#bb6900"></span><b>warn</b><code>#BB6900</code></div>
  <div class="ds-sw"><span style="background:#df202e"></span><b>bad</b><code>#DF202E</code></div>
</div>
</div>
</div>

**Colour carries meaning.** HTTP methods have fixed colours (shown on the dark theme), status badges use `ok` / `warn` / `bad`, and the accent marks what is active or primary.

<div class="ds-row ds-dark-strip">
  <span class="ds-method" style="color:#66da85">GET</span>
  <span class="ds-method" style="color:#ffa659">POST</span>
  <span class="ds-method" style="color:#6ab3fd">PUT</span>
  <span class="ds-method" style="color:#bf9bfc">PATCH</span>
  <span class="ds-method" style="color:#fd7273">DELETE</span>
  <span class="ds-badge" style="color:#4ad496">200 OK</span>
  <span class="ds-badge" style="color:#fabb41">302 Found</span>
  <span class="ds-badge" style="color:#fa686a">500 Error</span>
  <span class="ds-badge" style="color:#4697ff">current</span>
</div>

## Layout

The app is built from layered surfaces, so it is clear at a glance where you are: the **chrome** frames the window, **sidebars** hold navigation, the **work area** is brightest, and **popovers** float above everything.

<figure class="ds-figure">
<svg viewBox="0 0 960 520" role="img" aria-label="Diagram of the TestPion window: top bar, navigation rail, sidebar, tab bar, work area split into request and response, bottom console and status bar, with a popover" xmlns="http://www.w3.org/2000/svg" font-family="Inter, system-ui, sans-serif">
  <rect x="0" y="0" width="960" height="520" rx="14" fill="#060a1a"/>
  <!-- top bar -->
  <rect x="0" y="0" width="960" height="44" rx="14" fill="#060a1a"/>
  <image href="/wordmark-nav.png" x="14" y="10" width="96" height="24"/>
  <rect x="128" y="12" width="150" height="20" rx="6" fill="#141a2f"/><text x="138" y="26" fill="#9ba4be" font-size="11">Workspace ▾</text>
  <rect x="330" y="10" width="300" height="24" rx="12" fill="#0e0f14" stroke="#333c58"/><text x="346" y="26" fill="#9ba4be" font-size="11">Search requests, tests, tools…</text>
  <rect x="730" y="10" width="130" height="24" rx="12" fill="#0e0f14" stroke="#333c58"/><circle cx="744" cy="22" r="4" fill="#4ad496"/><text x="754" y="26" fill="#eef2fa" font-size="11">Development ▾</text>
  <text x="880" y="26" fill="#9ba4be" font-size="11">⌘K · AI</text>
  <!-- rail -->
  <rect x="0" y="44" width="72" height="448" fill="#060a1a"/>
  <rect x="14" y="60" width="44" height="30" rx="8" fill="#222a51"/><rect x="4" y="66" width="3" height="18" rx="2" fill="url(#g)"/>
  <text x="36" y="80" fill="#4697ff" font-size="10" text-anchor="middle">REST</text>
  <text x="36" y="120" fill="#9ba4be" font-size="10" text-anchor="middle">GraphQL</text>
  <text x="36" y="150" fill="#9ba4be" font-size="10" text-anchor="middle">MCP</text>
  <text x="36" y="180" fill="#9ba4be" font-size="10" text-anchor="middle">AI Lab</text>
  <text x="36" y="210" fill="#9ba4be" font-size="10" text-anchor="middle">Tests</text>
  <text x="36" y="240" fill="#9ba4be" font-size="10" text-anchor="middle">Traces</text>
  <!-- sidebar -->
  <rect x="72" y="44" width="200" height="448" fill="#090f20"/>
  <text x="86" y="68" fill="#eef2fa" font-size="11" font-weight="600">Collections · Envs · History</text>
  <text x="90" y="96" fill="#eef2fa" font-size="11">▾ Veterinary API</text>
  <text x="104" y="118" fill="#66da85" font-size="9" font-weight="700">GET</text><text x="130" y="118" fill="#eef2fa" font-size="11">List patients</text>
  <text x="104" y="140" fill="#ffa659" font-size="9" font-weight="700">POST</text><text x="134" y="140" fill="#eef2fa" font-size="11">Create patient</text>
  <!-- tab bar -->
  <rect x="272" y="44" width="688" height="30" fill="#090f20"/>
  <rect x="272" y="44" width="150" height="30" fill="#101629"/><rect x="272" y="44" width="150" height="2" fill="url(#g)"/>
  <text x="284" y="63" fill="#66da85" font-size="9" font-weight="700">GET</text><text x="308" y="63" fill="#eef2fa" font-size="11">List patients</text>
  <text x="438" y="63" fill="#9ba4be" font-size="11">POST Create…</text>
  <rect x="900" y="50" width="44" height="18" rx="5" fill="#101629" stroke="#333c58"/><text x="922" y="63" fill="#9ba4be" font-size="10" text-anchor="middle">+8 ▾</text>
  <!-- work area -->
  <rect x="272" y="74" width="688" height="330" fill="#101629"/>
  <rect x="288" y="88" width="70" height="26" rx="7" fill="#0e0f14" stroke="#333c58"/><text x="300" y="105" fill="#66da85" font-size="11" font-weight="700">GET</text>
  <rect x="366" y="88" width="470" height="26" rx="7" fill="#0e0f14" stroke="#333c58"/><text x="378" y="105" fill="#4697ff" font-size="11">&#123;&#123;baseUrl&#125;&#125;</text><text x="446" y="105" fill="#eef2fa" font-size="11">/patients</text>
  <rect x="846" y="88" width="98" height="26" rx="7" fill="url(#g)"/><text x="895" y="105" fill="#fff" font-size="11" font-weight="600" text-anchor="middle">Send</text>
  <text x="290" y="140" fill="#eef2fa" font-size="11">Params  Auth  Headers  Body  Scripts  Tests</text>
  <line x1="272" y1="230" x2="960" y2="230" stroke="#26272e"/>
  <rect x="288" y="244" width="54" height="18" rx="9" fill="#123a2a"/><text x="315" y="257" fill="#4ad496" font-size="10" text-anchor="middle">200 OK</text>
  <text x="352" y="257" fill="#9ba4be" font-size="11">65 ms · 138 B · 3 passed</text>
  <text x="290" y="290" fill="#eef2fa" font-size="11" font-family="JetBrains Mono, monospace">{ "items": [ … ], "total": 2 }</text>
  <!-- console -->
  <rect x="72" y="404" width="888" height="88" fill="#090f20"/>
  <text x="86" y="424" fill="#eef2fa" font-size="11" font-weight="600">Console</text>
  <text x="86" y="446" fill="#9ba4be" font-size="10" font-family="JetBrains Mono, monospace">12:03  GET  http://127.0.0.1:4010/patients  200  65 ms   (secrets redacted)</text>
  <!-- status bar -->
  <rect x="0" y="492" width="960" height="28" rx="0" fill="#060a1a"/>
  <text x="14" y="510" fill="#9ba4be" font-size="10">● Development   0 connected   Idle</text>
  <text x="946" y="510" fill="#9ba4be" font-size="10" text-anchor="end">secrets: OS store · Console · Logs</text>
  <!-- popover -->
  <rect x="600" y="150" width="230" height="110" rx="12" fill="#141a2f" stroke="#333c58"/>
  <text x="616" y="174" fill="#eef2fa" font-size="11" font-weight="600">Popover / menu / dialog</text>
  <rect x="612" y="184" width="206" height="22" rx="6" fill="#1b243e"/><text x="622" y="199" fill="#eef2fa" font-size="11">Rename…</text>
  <text x="622" y="222" fill="#eef2fa" font-size="11">Duplicate…</text>
  <text x="622" y="246" fill="#fa686a" font-size="11">Delete…</text>
  <defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#2f7bff"/><stop offset="1" stop-color="#8b5cff"/></linearGradient></defs>
</svg>
<figcaption>
  <span class="ds-key" style="background:#060a1a"></span> chrome: top bar, navigation rail, status bar ·
  <span class="ds-key" style="background:#090f20"></span> panel: sidebars, tab bar, console ·
  <span class="ds-key" style="background:#101629"></span> bg: the work area ·
  <span class="ds-key" style="background:#141a2f"></span> popover: menus and dialogs
</figcaption>
</figure>

- The **navigation rail** switches tools (REST, GraphQL, WebSocket, MCP, AI Lab, Evaluations, Tests, Load, Traces …). The active tool gets an accent tile and a gradient indicator.
- **Tabs** have a fixed width. When there are more than fit, the most recently used stay visible and the rest go into the **+N** list; nothing scrolls sideways.
- **Right-click works everywhere it helps**: tabs, workspaces, collection items. The same actions are in the **⋯** menu for keyboard and touch users.

## Typography

<div class="ds-type">
  <div><span class="ds-type-meta">Page title · Inter 600 · 28px</span><div style="font-size:28px;font-weight:600;letter-spacing:-0.02em">Veterinary API (example)</div></div>
  <div><span class="ds-type-meta">Section · Inter 600 · 15px</span><div style="font-size:15px;font-weight:600">Recent requests</div></div>
  <div><span class="ds-type-meta">Body · Inter 400 · 14px (0.9rem)</span><div style="font-size:14px">Build, test and debug REST, GraphQL, MCP and AI APIs. Everything stays on this computer.</div></div>
  <div><span class="ds-type-meta">Small · Inter 400 · 12.8px (0.8rem), muted</span><div style="font-size:12.8px;opacity:.7">Requests you send appear here.</div></div>
  <div><span class="ds-type-meta">Code · JetBrains Mono · 13px</span><div style="font-family:'JetBrains Mono',monospace;font-size:13px">tp.expect(tp.response.code).to.equal(200);</div></div>
</div>

Interface text is **Inter**; code, URLs, JSON and methods are **JetBrains Mono**. The small text sizes are slightly larger than Tailwind's defaults, because a dense tool is read for hours.

## Components

Shared primitives live in `apps/desktop/src/components/ui.tsx` (Radix UI + Tailwind CSS, in the shadcn/ui style). New screens are built from them.

<div class="ds-row ds-dark-strip">
  <span class="ds-btn ds-btn-primary">Send</span>
  <span class="ds-btn">Save</span>
  <span class="ds-btn ds-btn-soft">Import</span>
  <span class="ds-btn ds-btn-ghost">Cancel</span>
  <span class="ds-btn ds-btn-danger">Delete workspace</span>
</div>

| Component | Use it for |
|---|---|
| `Button` (primary, default, soft, ghost, danger) | Primary uses the brand gradient; one per area. Danger is only for destructive confirmations. |
| `Badge` | Status and counts: `ok`, `warn`, `bad`, `accent`, `judge` (AI evaluations). |
| `Tabs` | Sections of a view; the active tab has the gradient underline and counts in a pill. |
| `Menu` | Dropdown and right-click menus. Every item has an icon; destructive items are red and last, after a separator. The same menu opens from **⋯** and from a right-click. |
| Application menu | The native File / Edit / View / Window / Help menus and the text-field right-click menu use the same lucide icons, prerendered to PNG (`npm run menu-icons -w @testpion/desktop` after changing `scripts/make-menu-icons.cjs`): template images on macOS, a light or dark ink on Windows and Linux that follows the system theme. |
| Command palette | Every command shows its icon; *Go to* commands use the navigation icons, environments their colour. |
| `Modal` | Forms and custom dialogs. Say what will happen, and use a danger button for irreversible actions. |
| `confirmAction()`, `ask()`, `promptText()` | Every confirmation, question and text prompt (never the browser's `confirm` / `prompt`). A tone icon (info, question, warning, danger, success), a bold message, a muted detail, and buttons named for the action (**Delete collection**, not **OK**). |
| `Empty` | Every empty state: an accent icon, one sentence, and the next action. |
| `Split` (`sidebar`) | Resizable panes; the sidebar pane gets the panel surface. |
| `Tooltip`, `IconButton` | Every icon-only button has a label and a tooltip. |

## Core architecture

<figure class="ds-figure">
<svg viewBox="0 0 960 470" role="img" aria-label="Architecture: the desktop app, the CLI and the MCP server for AI agents all call the single core engine, which has protocols, scripting, variables, runner, checks, tracing and importers, on top of storage: workspace files, SQLite metadata and the secret store" xmlns="http://www.w3.org/2000/svg" font-family="Inter, system-ui, sans-serif">
  <defs>
    <linearGradient id="a" x1="0" x2="1"><stop offset="0" stop-color="#2f7bff"/><stop offset="1" stop-color="#8b5cff"/></linearGradient>
    <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#8b5cff"/></marker>
  </defs>
  <rect width="960" height="470" rx="14" fill="#0c1440"/>
  <!-- clients -->
  <g font-size="13" fill="#eef2fa">
    <rect x="40" y="30" width="260" height="92" rx="12" fill="#101629" stroke="#333c58"/>
    <text x="60" y="58" font-weight="700">Desktop app</text>
    <text x="60" y="80" fill="#9ba4be" font-size="11.5">Electron · React 19 · Tailwind v4</text>
    <text x="60" y="100" fill="#9ba4be" font-size="11.5">renderer ↔ backend over RPC (no network in UI)</text>
    <rect x="350" y="30" width="260" height="92" rx="12" fill="#101629" stroke="#333c58"/>
    <text x="370" y="58" font-weight="700">testpion CLI</text>
    <text x="370" y="80" fill="#9ba4be" font-size="11.5">test · run-collection · import · env …</text>
    <text x="370" y="100" fill="#9ba4be" font-size="11.5">--json output · CI exit codes</text>
    <rect x="660" y="30" width="260" height="92" rx="12" fill="#101629" stroke="#333c58"/>
    <text x="680" y="58" font-weight="700">MCP server → AI agents</text>
    <text x="680" y="80" fill="#9ba4be" font-size="11.5">send_request · run_collection</text>
    <text x="680" y="100" fill="#9ba4be" font-size="11.5">save_request · parse_request_snippet</text>
  </g>
  <line x1="170" y1="122" x2="400" y2="168" stroke="#8b5cff" stroke-width="2" marker-end="url(#arr)"/>
  <line x1="480" y1="122" x2="480" y2="166" stroke="#8b5cff" stroke-width="2" marker-end="url(#arr)"/>
  <line x1="790" y1="122" x2="560" y2="168" stroke="#8b5cff" stroke-width="2" marker-end="url(#arr)"/>
  <!-- core -->
  <rect x="40" y="170" width="880" height="170" rx="14" fill="#101a4a" stroke="url(#a)" stroke-width="2"/>
  <text x="60" y="198" fill="#eef2fa" font-size="14" font-weight="700">@testpion/core: the single execution engine</text>
  <g font-size="12" fill="#eef2fa">
    <rect x="60" y="212" width="200" height="54" rx="10" fill="#101629"/><text x="74" y="234" font-weight="600">Protocols</text><text x="74" y="253" fill="#9ba4be" font-size="11">HTTP · GraphQL · WebSocket · MCP</text>
    <rect x="272" y="212" width="200" height="54" rx="10" fill="#101629"/><text x="286" y="234" font-weight="600">Scripts (sandbox)</text><text x="286" y="253" fill="#9ba4be" font-size="11">tp.* in QuickJS/WASM</text>
    <rect x="484" y="212" width="200" height="54" rx="10" fill="#101629"/><text x="498" y="234" font-weight="600">Variables &amp; auth</text><text x="498" y="253" fill="#9ba4be" font-size="11">scopes · secrets · OAuth · JWT</text>
    <rect x="696" y="212" width="204" height="54" rx="10" fill="#101629"/><text x="710" y="234" font-weight="600">AI providers</text><text x="710" y="253" fill="#9ba4be" font-size="11">LLMs · agent loop · RAG</text>
    <rect x="60" y="276" width="200" height="54" rx="10" fill="#101629"/><text x="74" y="298" font-weight="600">Runner</text><text x="74" y="317" fill="#9ba4be" font-size="11">collections · suites · retries</text>
    <rect x="272" y="276" width="200" height="54" rx="10" fill="#101629"/><text x="286" y="298" font-weight="600">Checks &amp; evaluators</text><text x="286" y="317" fill="#9ba4be" font-size="11">assertions · LLM-as-judge</text>
    <rect x="484" y="276" width="200" height="54" rx="10" fill="#101629"/><text x="498" y="298" font-weight="600">Tracer &amp; redactor</text><text x="498" y="317" fill="#9ba4be" font-size="11">spans · secrets never leak</text>
    <rect x="696" y="276" width="204" height="54" rx="10" fill="#101629"/><text x="710" y="298" font-weight="600">Import / export</text><text x="710" y="317" fill="#9ba4be" font-size="11">Postman · OpenAPI · HAR · cURL</text>
  </g>
  <line x1="480" y1="340" x2="480" y2="372" stroke="#8b5cff" stroke-width="2" marker-end="url(#arr)"/>
  <!-- storage -->
  <g font-size="12" fill="#eef2fa">
    <rect x="40" y="376" width="280" height="68" rx="12" fill="#101629" stroke="#333c58"/><text x="60" y="402" font-weight="700">Workspace files</text><text x="60" y="424" fill="#9ba4be" font-size="11">collections · environments · tests (git-friendly)</text>
    <rect x="340" y="376" width="280" height="68" rx="12" fill="#101629" stroke="#333c58"/><text x="360" y="402" font-weight="700">SQLite metadata</text><text x="360" y="424" fill="#9ba4be" font-size="11">history · runs · traces index</text>
    <rect x="640" y="376" width="280" height="68" rx="12" fill="#101629" stroke="#333c58"/><text x="660" y="402" font-weight="700">Secret store</text><text x="660" y="424" fill="#9ba4be" font-size="11">DPAPI · Keychain · Secret Service</text>
  </g>
</svg>
<figcaption>Three front doors, one engine: the app, the CLI and AI agents get the same results.</figcaption>
</figure>

More detail: [Architecture overview](./overview.md) and [Execution engine](./execution-engine.md).

## The life of a request

<figure class="ds-figure">
<svg viewBox="0 0 960 250" role="img" aria-label="Request lifecycle: resolve variables, pre-request scripts, auth and cookies, send, post-response scripts and visualizer, checks, then trace, history and console, all redacted" xmlns="http://www.w3.org/2000/svg" font-family="Inter, system-ui, sans-serif">
  <defs><marker id="arr2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#8b5cff"/></marker>
  <linearGradient id="b" x1="0" x2="1"><stop offset="0" stop-color="#2f7bff"/><stop offset="1" stop-color="#8b5cff"/></linearGradient></defs>
  <rect width="960" height="250" rx="14" fill="#0c1440"/>
  <g font-size="12" fill="#eef2fa" text-anchor="middle">
    <rect x="20" y="40" width="120" height="84" rx="12" fill="#101629" stroke="#333c58"/><text x="80" y="72" font-weight="700">1 Resolve</text><text x="80" y="92" fill="#9ba4be" font-size="10.5">&#123;&#123;variables&#125;&#125;</text><text x="80" y="108" fill="#9ba4be" font-size="10.5">env · collection</text>
    <rect x="156" y="40" width="120" height="84" rx="12" fill="#101629" stroke="#333c58"/><text x="216" y="72" font-weight="700">2 Pre-request</text><text x="216" y="92" fill="#9ba4be" font-size="10.5">collection → folder</text><text x="216" y="108" fill="#9ba4be" font-size="10.5">→ request scripts</text>
    <rect x="292" y="40" width="120" height="84" rx="12" fill="#101629" stroke="#333c58"/><text x="352" y="72" font-weight="700">3 Auth</text><text x="352" y="92" fill="#9ba4be" font-size="10.5">inherited auth</text><text x="352" y="108" fill="#9ba4be" font-size="10.5">cookie jar</text>
    <rect x="428" y="40" width="120" height="84" rx="12" fill="url(#b)"/><text x="488" y="72" font-weight="700">4 Send</text><text x="488" y="92" font-size="10.5">stream body to disk</text><text x="488" y="108" font-size="10.5">timings</text>
    <rect x="564" y="40" width="120" height="84" rx="12" fill="#101629" stroke="#333c58"/><text x="624" y="72" font-weight="700">5 Post-response</text><text x="624" y="92" fill="#9ba4be" font-size="10.5">tp.test · visualizer</text><text x="624" y="108" fill="#9ba4be" font-size="10.5">set variables</text>
    <rect x="700" y="40" width="110" height="84" rx="12" fill="#101629" stroke="#333c58"/><text x="755" y="72" font-weight="700">6 Checks</text><text x="755" y="92" fill="#9ba4be" font-size="10.5">assertions</text><text x="755" y="108" fill="#9ba4be" font-size="10.5">evaluators</text>
    <rect x="826" y="40" width="114" height="84" rx="12" fill="#101629" stroke="#333c58"/><text x="883" y="72" font-weight="700">7 Record</text><text x="883" y="92" fill="#9ba4be" font-size="10.5">trace · history</text><text x="883" y="108" fill="#9ba4be" font-size="10.5">console</text>
  </g>
  <g stroke="#8b5cff" stroke-width="2" marker-end="url(#arr2)">
    <line x1="140" y1="82" x2="154" y2="82"/><line x1="276" y1="82" x2="290" y2="82"/><line x1="412" y1="82" x2="426" y2="82"/><line x1="548" y1="82" x2="562" y2="82"/><line x1="684" y1="82" x2="698" y2="82"/><line x1="810" y1="82" x2="824" y2="82"/>
  </g>
  <rect x="20" y="152" width="920" height="70" rx="12" fill="#101a4a" stroke="#333c58"/>
  <text x="40" y="180" fill="#eef2fa" font-size="12.5" font-weight="700">The redactor runs on everything that is recorded.</text>
  <text x="40" y="202" fill="#9ba4be" font-size="11.5">Sensitive headers and fields and known secret values become [REDACTED] in traces, history, the console, reports and MCP results.</text>
</svg>
</figure>

The same steps run for a request sent from a tab, by the Collection Runner, by `testpion run-collection` in CI, or by an AI agent through the MCP server.

## Cloud-ready design

TestPion runs on your desktop today, and the same code is meant to run as an online, multi-user service later. Rules for new features:

- **The UI talks to the engine only through RPC** (`call(...)`). No Node or Electron APIs in `apps/desktop/src`. Desktop-only features (menus, native dialogs, the updater) sit behind backend handlers and have a browser fallback, such as upload and download instead of file dialogs. The browser build (`dev.mjs --web`) must keep working.
- **RPC methods are grouped by domain.** Each domain has its own module in `apps/desktop/backend/handlers/` (`app`, `workspace`, `collections`, `requests`, `mcp`, `ai`, `testing`), named `<domain>.<action>` (`col.list`, `mcp.connect` …). The `Backend` class holds the shared state and services (workspace, secrets, logger, sessions) that the handlers use, and it refuses a method name defined twice. A new feature adds its methods to the right module, or a new one, so the RPC surface can be served by any host (Electron IPC, the web bridge, a future server).
- **The engine is host-agnostic.** Files, metadata and secrets go through the `WorkspaceStore`, `MetaStore` and `SecretStore` interfaces, so a server can plug in a database and object storage. Context such as the workspace and user is passed explicitly, not held in process-wide globals.
- **Data is multi-user ready:** stable ids, a `schemaVersion` on every file, and no assumption of one user per machine. Per-user secrets, sharing and permissions are considered when data is added.
- **Untrusted content gets its own origin.** Visualizations run on an isolated origin (`tpviz://` on the desktop, `/viz/<id>` on the bridge; a separate user-content domain in a hosted version) with its own strict security policy, never inside the app's origin.
- **Files go through RPC, not paths.** Picking a file sends its content; saving either uses the native dialog (desktop) or returns a download (`saveOrDownload` in the backend, `finishSave` / `pickTextFile` in `src/lib/files.ts`). `app.info.nativeDialogs` tells the UI which one applies.
- **Safe on a shared server.** Anything that sends requests, runs scripts or starts processes has limits, a sandbox, and guards for private networks and local processes that a hosted version can switch on.

## AI-first design

Every feature is designed for three audiences: the person using the app, the AI agent doing the work, and the person reviewing it.

| Surface | What it gives agents | Examples |
|---|---|---|
| **CLI** | Every workspace action, with `--json` output and CI exit codes | `testpion import - --json`, `testpion env list --json`, `testpion workspace delete --yes` |
| **MCP server** | The workspace as tools, redacted | `list_requests`, `send_request`, `run_collection`, `save_request` |
| **llms.txt** | A map of the docs and key facts, written for models | [/llms.txt](/llms.txt) |
| **Files** | Diff-friendly JSON and YAML to edit and review in git | `collections/*.json`, `tests/**/*.yaml` |
| **In the app** | AI actions that are labelled and shown before they run | Describe with AI, Generate tests, Explain an error |

Rules for new features:

- Add a CLI command (with `--json`) and, when it is safe, an MCP tool. Destructive actions stay with people (they need `--yes`, and are not exposed over MCP).
- Keep secrets out of everything an agent can read, and out of files.
- Label AI output, show it for review, and never run or save it on its own.
- Document the feature in these docs and, when agents need it, in `llms.txt`.
