# Review of today's HTTP Debugger changes (35df5d44..208dd40c), 2026-10-27

My own read of the eleven commits made today for the Debugger (menus, quick filters, inspector tabs, Capture all traffic, localhost, certificate trust). Nothing here is fixed. The five whole-codebase reviews are in `review-2026-10-27-{security,scalability,performance,robustness,ux}.md`.

Severity: P0 = wrong result, data loss or a dead end; P1 = misleading or wasteful; P2 = hygiene.

## Correctness

| Sev | File:line | What happens | Fix | Guard test |
|---|---|---|---|---|
| P0 | `apps/desktop/src/components/debugger/quick-filter.ts:28`, `useExchangeList.ts:50` | Two **Capture only** chips are ANDed in the window (`quick.every`), while the engine lists a request that matches **any** capture-only rule (`rules.ts:411-416`, OR). Two clicks hide rows the engine would list; after a reload (chips gone, rules stay) the list changes. | Group chips by kind: `only` chips OR together, `ignore` chips each exclude. | Unit: two `keep` chips keep the union; e2e: two Capture only clicks, reload, same rows. |
| P0 | `DebuggerGrid.tsx:270-274` | For Filter out, the menu label is rewritten to `Domain != x` and that label becomes the stored rule **name** (`Filter out Domain != x`, visible in the Rules panel and the screenshot). The rule matches `Domain = x`; the name reads as the opposite. | Keep `=` in the stored name (`Filter out Domain = x`); show `!=` only where it describes the view (the chip). Or name it "Hide Domain = x". | Unit on the name built by `onQuickRule`; menus-doc. |
| P1 | `quick-filter.ts:20-26` vs `packages/core/src/debugger/rules.ts:219-233` | The window's matcher is not the engine's: the engine also matches `host` without its `:port`, accepts method lists (`GET, POST`), caps tested length and uses `safeTest`; the window matches the full host only, one method, uncapped `RegExp` on the URL. A rule from the editor (method list, `host` without port) applied as a chip hides different rows than the engine will. | Move `ruleMatches` (or a pure subset) to `@testpion/shared` and use it on both sides. | Unit: the same rule + exchange gives the same answer in both. |
| P1 | `DebuggerView.tsx:324-345` (`readHttps`) | `rootCertificateTrusted` returns `undefined` on Linux (unknown) and `false` on any `certutil`/`security` error; `info.trusted !== true` then shows the "See inside HTTPS?" dialog on **every** Capture all traffic click, and "Install and decrypt" runs the NSS/`certutil` install again each time. | Treat `undefined` as "cannot tell": show the instructions once, do not re-install; remember the answer per session. | Unit with a mocked `debug.certificate` returning `undefined`. |
| P1 | `DebuggerView.tsx:347-351` (`captureAll`) | `systemProxy(true)` runs inside `attempt()`, which swallows the error; `readHttps()` then still runs and may install a certificate although nothing is captured. | `const ok = await attempt(...); if (!ok) return;` | Unit/e2e with `debug.systemProxy` failing. |
| P1 | `packages/core/src/debugger/certificate.ts:187-189` | Install on Windows is delete-by-name then add. A failure between the two (UAC cancelled on the add) leaves **no** TestPion root trusted, worse than before. macOS/Linux never delete the stale root, so the by-hash check keeps saying "not trusted" there after an install that succeeded (two roots of the same name). | Add first, then delete the others by hash (`certutil -user -delstore Root <sha1>`); same on macOS (`security delete-certificate -Z`). | Unit with a scripted `run` recording the order. |
| P1 | `certificate.ts:49` (`trustListHas`) | `listing.replace(/[\s:]/g,'')` then `includes(sha1)`: a 40-hex substring match over the whole listing; another certificate whose hash happens to contain the digits of ours cannot happen (same length) but a listing that prints **SHA-256 only** (newer `certutil` locales/versions print `Cert Hash(sha256)` too; macOS `-Z` prints SHA-256 first) still passes because the SHA-1 line is also printed — fine today; brittle if a platform drops SHA-1. | Parse `Cert Hash(sha1):` / `SHA-1 hash:` lines explicitly; fall back to SHA-256. | Unit with both listing formats. |
| P1 | `DebuggerView.tsx:400-407` (`quickRule`) | Every Capture only / Filter out click both adds an engine rule **and** a chip; clicking the chip's × removes only the chip, so new traffic is still filtered by the rule while the hidden rows reappear — the list and the rule disagree until the user finds the rule in the panel. (Owner's decision pending: view-only vs rule.) | Either × also deletes the rule (with Undo), or the chip reads "rule stays on, new traffic still hidden". | e2e: click chip ×, send a matching request, assert the outcome you chose. |
| P1 | `DebuggerView.tsx:107-109`, `:840-860` (filter presets) | `ListFilter` now carries `quick` (chips with `Date.now()` ids and rule names) and `hideTunnels`; **Save this filter…** stores them, and loading a preset restores stale chips whose rules may be gone. | Strip `quick` from presets (or store the match only). | Unit: save → load round trip has no `quick`. |
| P2 | `DebuggerGrid.tsx:299`, `ExchangePanes.tsx:89-93` | "Keep this host encrypted" is offered on every tunnel row, including when decryption is off (every row is a tunnel then) — the action does nothing visible. | Show it only when `status.decrypt` is on, or when the row's error is the certificate error. | Snapshot of the row menu with decrypt off. |
| P2 | `ExchangeExtras.tsx:128` | `/…\|certificate/.test(m) && /trust\|certificate/.test(m)` — the second test is implied by the first; any message containing "certificate" matches. | One regex. | — |
| P2 | `ExchangeExtras.tsx:74` (`splitSetCookie`) | A `Set-Cookie` value containing `, name=` inside a quoted or base64 value (e.g. `a=x,b=`) splits wrongly; rare, display only. | Split on `\n` only when the proxy joins with `\n`; otherwise keep. | Unit with the edge value. |

## Consistency and UX (the owner's rules: one place per action, plain words)

| Sev | File:line | Issue | Fix |
|---|---|---|---|
| P1 | `DebuggerView.tsx:868-880` | **Save session** and **Clear** in the filter strip duplicate **Session ▸ Save session…**, **Session ▸ Clear the session**, the row menu's **Clear** and the tool rail's export menu: one action in four places. The owner asked for "common use" items in that space, but the project rule is one place per action. | Keep the strip buttons (they are the most visible) and make the Session menu items the same `MenuItem`s rendered from one list, or drop the menu copies. |
| P1 | `DebuggerView.tsx:556-575` | Two start buttons side by side: **Start capturing** (secondary) and **Capture all traffic** (primary). The subtitle explains the difference only before the first start; the difference (proxy only vs proxy + system proxy + HTTPS) is not visible on the buttons. | One primary split button: "Capture all traffic ▾" with "Only a program I point at the proxy" in the menu; or a one-line hint under them. |
| P1 | `DockRules.tsx:98-103` | **Reset hits** (↺) and **Clear all** (🗑) are two look-alike icon buttons next to each other; the bin removes every rule of the list, a big action behind a small icon with only a tooltip. | A labelled ghost button "Remove all", or put it in the Add ▾ menu with a separator. |
| P1 | `ExchangePanes.tsx:179-181` | **Overview** sits on the **request** side's tab strip, but it describes the whole exchange (status, timings, rules); and "Overview" already names the collection Overview. | Make it the first tab of the lower pane header (above both sides) or name it "Summary" (the dock already has a Summary panel — merge with it). |
| P2 | `DebuggerView.tsx:820-830` (chip) | The chip is a `<button>` whose text is the rule label and an × icon; screen readers hear "Domain != x" with no verb. | `aria-label="Show the rows hidden by: …"`. |
| P2 | `DebuggerView.tsx:333-338` | Dialog detail says "Close and reopen your browser afterwards" before the install happened; and it is shown even when decryption is already on and the root is trusted (no: guarded) — wording fine, but "Only tunnels" as a cancel label hides that it also leaves decryption **off** for the session. | "Keep HTTPS as tunnels". |

## Coverage and docs

| Sev | Where | Gap |
|---|---|---|
| P1 | `CHANGELOG.md` | No Unreleased entry for today's Debugger work (Capture all traffic, localhost, inspector tabs, quick filters, menus that fit, certificate by hash). |
| P1 | `docs/public/llms.txt` | No lines for the new Debugger surfaces; the `debug.certificate`/`debug.systemProxy` RPCs have no CLI/MCP counterpart (`testpion debugger …` cannot start capture-all or read an exchange's params/cookies) — against the AI-first rule. |
| P1 | `docs/public/images/debugger*.jpg` | Regenerated at 35df5d44, before today's UI changes: the toolbar, strip and tabs in the screenshots are stale. |
| P2 | `tests/unit/capture-loopback.test.ts` | Asserts a constant equals a string: no behaviour tested. Replace with a test of the PowerShell line built by `setSystemProxy` (inject `run`). |
| P2 | `tests/unit/root-trust-by-hash.test.ts` | Generates two RSA-2048 keys per run (seconds); use a fixed PEM fixture. |
| P2 | e2e | No plan covers: Clear filters, Clear all rules + Undo, the filtered empty state's Show all, Keep this host encrypted, the inspector tabs (Params/Cookies/Overview/Error), Hide tunnels. |

## Checked and fine

- `decrypt.enabled(host)` gets the bare hostname (`proxy.ts:1005-1024`), so `keepEncrypted` stripping `:port` is right; `hostMatches` is a case-insensitive glob.
- `Menu.tsx` height cap: `--radix-popper-available-height` + `collisionPadding` is the Radix-supported way; sub-menus are portaled, so `overflow-y-auto` on the content does not clip them.
- `WIN_PROXY_OVERRIDE = '<-loopback>'` is restored from the snapshot on stop (`restoreSystemProxy` writes the saved `override`), and the read-only check on the owner's machine after Stop showed `ProxyEnable=0`.
- `TESTPION_FAKE_SYSTEM_PROXY` seam is a module-level string with a `bounded:` note; the two-sessions global-state scan passes.
- `ExchangeExtras.paramsOf` uses `requestContentType` on lean rows and the header on whole exchanges; `decodeURIComponent` failures fall back to the raw text.
- The row-menu grouping ("Change this traffic") keeps `menus-uniform`, `debugger`, `debugger-workbench`, `debugger-menu-fits`, `debugger-capture-all`, `rag-capture`, `flow-record` green (run one at a time today).
