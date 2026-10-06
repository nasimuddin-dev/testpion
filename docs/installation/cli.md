---
title: Install the CLI
description: Install the testpion command-line runner to run TestPion tests locally and in CI/CD.
---

# Install the CLI

The `testpion` CLI runs the same tests as the desktop app, using the same engine. Use it on CI servers and in scripts.

## Requirements

- Node.js 22.13 or newer (24+ recommended).

## Install from npm

From version 0.44.0 the CLI is published on npm as [`testpion`](https://www.npmjs.com/package/testpion): one package with the engine bundled in.

```bash
npm install -g testpion
testpion --help
```

Or run it without installing, which suits CI jobs and one-off runs:

```bash
npx testpion run-collection collection.postman_collection.json -e staging.json
```

Pin a version in CI (`npx testpion@0.44.0 …`) so a new release doesn't change a pipeline unannounced. In a Node.js project, `npm install --save-dev testpion` keeps the version in `package.json`.

## Install from source

For an unreleased change, or to work on TestPion itself:

```bash
git clone https://github.com/nasimuddin-dev/testpion.git
cd testpion
npm ci
npm run build -w @testpion/core -w @testpion/cli
npm link -w @testpion/cli
testpion --help
```

In CI you can skip `npm link` and run `node packages/cli/bin/testpion.js` directly. `npm run pack:cli` builds the npm package itself (`dist/npm/testpion-<version>.tgz`), which installs with `npm install -g <the .tgz file>`.

## Run tests

```bash
testpion test ./tests                                   # nearest workspace.json is used
testpion run -w ./my-workspace -e Staging --suite regression
```

Exit codes: `0` success · `1` test failure · `2` configuration error · `3` execution error.

See the [CLI reference](/cli/reference) and [CI/CD integration](/test-runner/ci-cd).
