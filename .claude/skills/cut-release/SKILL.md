---
name: cut-release
description: Cut a TestPion release (version bump, changelog, tests, UI regression, tag, GitHub Actions build, verify assets). Use when the owner asks for a release or a release build.
---

# Release

Releases are built by GitHub Actions from a `vX.Y.Z` tag (Windows setup and portable, macOS dmg ×2, Linux deb/rpm/AppImage,
update feeds and `SHA256SUMS.txt`; 11 assets). Commits go straight to `main` as the owner (the rulesets let the admin bypass; the push prints
"Bypassed rule violations", which is expected). Never loosen the rulesets; if a push is rejected for another reason
(secret detection, …) stop and tell the owner.

## Steps

1. **Tests, all green:**
   ```bash
   npm run typecheck
   npx vitest run tests/unit tests/integration
   ```
   The integration suite pins the MCP tool list (`tests/integration/workspace-run.test.ts`): a new tool goes there in the same commit.
2. **UI regression:** the ui-regression skill (`npm run build -w @testpion/desktop && npm run e2e -w @testpion/desktop`). Every plan must pass (flaky is allowed once; fix it if it repeats).
3. **Version and changelog:** write the entry body (user-facing, what changed and why it matters; no heading) to a scratch file, then
   ```bash
   python scripts/release.py 0.39.2 0.40.0 <entry.md>
   npm install --package-lock-only --ignore-scripts
   npm run build -w @testpion/core
   npm run screenshots -w @testpion/desktop
   ```
   (`screenshots` refreshes the docs images from the app.)
4. **Commit explicit paths only** (never `git commit -a`, never `git add .`: the owner keeps uncommitted edits in
   `docs/public/llms.txt` and `examples/veterinary-workspace/…`). Typically: the five `package.json`,
   `package-lock.json`, `packages/core/src/version.ts`, `CHANGELOG.md`, `docs/public/screenshots/*`. Message `Release vX.Y.Z`.
   Author: the GitHub no-reply address configured in the repo (never an office email).
5. **Tag and push:**
   ```bash
   git tag vX.Y.Z && git push origin main && git push origin vX.Y.Z
   git ls-remote origin refs/tags/vX.Y.Z
   ```
6. **Watch the build:** `gh run list --workflow release.yml -L 1`, then `gh run watch <id>` (or check every few minutes);
   when it succeeds, `gh release view vX.Y.Z --json assets --jq '.assets|length'` must be 11.
   The *Publish the CLI to npm* job publishes `testpion@X.Y.Z` when the repository has an `NPM_TOKEN` secret (it
   prints a notice and skips otherwise). Check with `npm view testpion version`. Before tagging, `npm run pack:cli`
   must succeed locally (the npm-package integration test covers it).
7. **Verify, install and run the UI regression against the installed app:** the install-and-verify skill.
8. Tell the owner the version, the highlights, and anything they must do (relaunch, …).
