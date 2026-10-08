import { existsSync } from 'node:fs';
import { ApsError } from '../errors.js';
import { ENGINE_VERSION } from '../version.js';
import { envNameForSecret, secretKeys } from '../storage/secrets.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { findCollection } from '../storage/env-edit.js';

/**
 * CI configuration for running a workspace's tests in a pipeline (Postman's "Run in CI"): GitHub Actions,
 * GitLab CI, Azure Pipelines or Jenkins. The pipeline installs the TestPion CLI from its repository at
 * this version's tag, runs a suite / collection / test folder, publishes JUnit results and keeps the
 * reports. Secret values never appear: the config names the CI secrets to create.
 */
export type CiProvider = 'github' | 'gitlab' | 'azure' | 'jenkins';
export const CI_PROVIDERS: CiProvider[] = ['github', 'gitlab', 'azure', 'jenkins'];

export interface CiTarget {
  /** Run a suite (tests/<name>.suite.yaml). */
  suite?: string;
  /** Run a collection (name or id), optionally some folders. */
  collection?: string;
  folders?: string[];
  /** Run test files or folders under tests/ (default: all tests). */
  tests?: string[];
}

export interface CiConfigOptions extends CiTarget {
  provider: CiProvider;
  environment?: string;
  /** The workspace folder relative to the repository root (default "."). */
  workspaceDir?: string;
  /** TestPion version to install (a git tag of the TestPion repository); default this version. */
  version?: string;
  /** An OpenAPI document in the repository: pull requests fail when it has breaking changes against the target branch. */
  openapi?: string;
  /** Integration tests: a command that starts the system under test in the background before the tests (e.g. `npm start`, `docker compose up -d`). */
  start?: string;
  /** With `start`: a URL polled until it answers 2xx/3xx (the health check), with a time limit in seconds (default 90). */
  waitFor?: string;
  waitSeconds?: number;
}

export interface CiSecret {
  /** Environment variable the CLI reads. */
  name: string;
  /** What it holds. */
  description: string;
}

export interface CiConfig {
  provider: CiProvider;
  /** Where the file goes in the repository. */
  path: string;
  content: string;
  /** CI secrets to create (values are never included). */
  secrets: CiSecret[];
  command: string;
}

const REPO = 'https://github.com/nasimuddin-dev/testpion.git';
const q = (s: string) => (/^[\w./@:-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, '\\$1')}"`);

/** Secrets the run needs: secret variables of the environment and the workspace, and API keys of the workspace's providers. */
export function ciSecrets(store: WorkspaceStore, environment?: string, opts: { providers?: boolean } = {}): CiSecret[] {
  const out: CiSecret[] = [];
  const env = environment ? store.getEnvironment(environment) : undefined;
  if (environment && !env) throw new ApsError('ValidationError', `No environment "${environment}"`, { suggestions: [] });
  for (const v of env?.variables ?? []) if ((v as { secret?: boolean }).secret) out.push({ name: envNameForSecret(secretKeys.envVar(env!.id, v.key)), description: `${env!.name} › ${v.key}` });
  for (const v of store.workspace.variables) if ((v as { secret?: boolean }).secret) out.push({ name: envNameForSecret(secretKeys.workspaceVar(store.id, v.key)), description: `workspace › ${v.key}` });
  // collection runs don't call AI providers; test files may
  if (opts.providers !== false) for (const p of store.getProviders()) if (p.apiKey?.includes('$secret.')) out.push({ name: envNameForSecret(secretKeys.provider(p.id)), description: `${p.name} API key (only if tests use it)` });
  return out;
}

/** The CLI command the pipeline runs (with `testpion` = the installed CLI). */
export function ciCommand(o: CiConfigOptions, cli = 'testpion'): string {
  const ws = o.workspaceDir?.trim() || '.';
  const env = o.environment ? ` -e ${q(o.environment)}` : '';
  const out = ' -r console junit html -o test-results';
  if ([o.suite, o.collection, o.tests?.length].filter(Boolean).length > 1) throw new ApsError('ValidationError', 'Choose one of a suite, a collection or test paths', { suggestions: [] });
  if (o.collection) return `${cli} run-collection ${q(o.collection)} -w ${q(ws)}${env}${(o.folders ?? []).map((f) => ` --folder ${q(f)}`).join('')}${out}`;
  if (o.suite) return `${cli} run -w ${q(ws)} --suite ${q(o.suite)}${env}${out}`;
  const paths = (o.tests?.length ? o.tests : ['.']).map((p) => q(`${ws === '.' ? '' : `${ws}/`}tests/${p === '.' ? '' : p}`.replace(/\/$/, '') || 'tests'));
  return `${cli} test ${paths.join(' ')} -w ${q(ws)}${env}${out}`;
}

export function ciConfig(store: WorkspaceStore, o: CiConfigOptions): CiConfig {
  if (!CI_PROVIDERS.includes(o.provider)) throw new ApsError('ValidationError', `CI provider must be one of ${CI_PROVIDERS.join(', ')}`, { suggestions: [] });
  if (o.suite && !existsSync(store.path('tests', `${o.suite}.suite.yaml`))) throw new ApsError('ValidationError', `No suite "${o.suite}" (tests/${o.suite}.suite.yaml)`, { suggestions: [] });
  if (o.collection) {
    if (!findCollection(store, o.collection)) throw new ApsError('ValidationError', `No collection "${o.collection}"`, { suggestions: [] });
  }
  const version = o.version ?? ENGINE_VERSION;
  const tag = version.startsWith('v') ? version : `v${version}`;
  const secrets = ciSecrets(store, o.environment, { providers: !o.collection });
  const command = ciCommand(o, 'node "$TESTPION_CLI"');
  const install = `git clone --depth 1 --branch ${tag} ${REPO} "$TESTPION_HOME_DIR" && cd "$TESTPION_HOME_DIR" && npm ci --no-audit --no-fund && npm run build -w @testpion/core -w @testpion/cli`;
  const name = o.suite ? `suite ${o.suite}` : o.collection ? `collection ${o.collection}` : 'tests';
  // integration tests: start the system under test, wait until it answers, then run; it is stopped when the job ends
  const start = o.start?.trim() ? `(${o.start.trim()}) &` : undefined;
  const wait = o.waitFor?.trim() ? `node "$TESTPION_CLI" wait-for ${q(o.waitFor.trim())} --timeout ${Math.max(5, Math.round(o.waitSeconds ?? 90))}` : undefined;
  const startLines = [start, wait].filter((x): x is string => !!x);
  // pull requests: compare the OpenAPI document with the target branch's (skipped when the branch doesn't have it yet)
  const spec = o.openapi?.trim() ? q(o.openapi.trim().replace(/^\.\//, '')) : undefined;
  const diffAgainst = (ref: string, tmp: string) =>
    `git fetch --depth 1 origin ${ref} && if git show FETCH_HEAD:${spec} > ${tmp}; then node "$TESTPION_CLI" openapi-diff ${tmp} ${spec} --fail-on-breaking; else echo "No ${spec} on the target branch yet"; fi`;
  switch (o.provider) {
    case 'github':
      return {
        provider: o.provider,
        path: '.github/workflows/testpion.yml',
        secrets,
        command,
        content: `# Runs the TestPion ${name} on every push and pull request (generated by TestPion ${ENGINE_VERSION}).
name: API tests

on:
  push:
  pull_request:
  workflow_dispatch:

jobs:
  testpion:
    runs-on: ubuntu-latest
    env:
      TESTPION_HOME_DIR: \${{ runner.temp }}/testpion
      TESTPION_CLI: \${{ runner.temp }}/testpion/packages/cli/bin/testpion.js
${secrets.map((s) => `      ${s.name}: \${{ secrets.${s.name} }}   # ${s.description}`).join('\n')}${secrets.length ? '\n' : ''}    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - name: Install the TestPion CLI (${tag})
        run: ${install}
${
  spec
    ? `      - name: Check ${spec} for breaking changes
        if: github.event_name == 'pull_request'
        run: ${diffAgainst('${{ github.base_ref }}', '"$RUNNER_TEMP/openapi.base"')}
`
    : ''
}${
  startLines.length
    ? `      - name: Start the system under test
        run: |
${startLines.map((l) => `          ${l}`).join('\n')}
`
    : ''
}      - name: Run ${name}
        run: ${command}
      - name: Upload reports
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: testpion-results
          path: test-results
`,
      };
    case 'gitlab':
      return {
        provider: o.provider,
        path: '.gitlab-ci.yml',
        secrets,
        command,
        content: `# Runs the TestPion ${name} (generated by TestPion ${ENGINE_VERSION}).
# Secrets: add ${secrets.length ? secrets.map((s) => s.name).join(', ') : 'none needed'} under Settings > CI/CD > Variables (masked).
api-tests:
  image: node:24
  variables:
    TESTPION_HOME_DIR: /tmp/testpion
    TESTPION_CLI: /tmp/testpion/packages/cli/bin/testpion.js
  script:
    - (${install})
${spec ? `    - if [ -n "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME" ]; then ${diffAgainst('"$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"', '/tmp/openapi.base')}; fi\n` : ''}${startLines.map((l) => `    - ${l}\n`).join('')}    - ${command}
  artifacts:
    when: always
    paths: [test-results]
    reports:
      junit: test-results/junit.xml
`,
      };
    case 'azure':
      return {
        provider: o.provider,
        path: 'azure-pipelines.yml',
        secrets,
        command,
        content: `# Runs the TestPion ${name} (generated by TestPion ${ENGINE_VERSION}).
# Secrets: add ${secrets.length ? secrets.map((s) => s.name).join(', ') : 'none needed'} as secret pipeline variables.
trigger:
  - main

pool:
  vmImage: ubuntu-latest

variables:
  TESTPION_HOME_DIR: $(Agent.TempDirectory)/testpion
  TESTPION_CLI: $(Agent.TempDirectory)/testpion/packages/cli/bin/testpion.js

steps:
  - task: NodeTool@0
    inputs:
      versionSpec: '24.x'
  - script: ${install}
    displayName: Install the TestPion CLI (${tag})
${
  spec
    ? `  - script: ${diffAgainst('$(System.PullRequest.TargetBranch)', '$(Agent.TempDirectory)/openapi.base')}
    displayName: Check ${spec} for breaking changes
    condition: eq(variables['Build.Reason'], 'PullRequest')
`
    : ''
}${
  startLines.length
    ? `  - script: |
${startLines.map((l) => `      ${l}`).join('\n')}
    displayName: Start the system under test
`
    : ''
}  - script: ${command}
    displayName: Run ${name}
${secrets.length ? `    env:\n${secrets.map((s) => `      ${s.name}: $(${s.name})`).join('\n')}\n` : ''}  - task: PublishTestResults@2
    condition: always()
    inputs:
      testResultsFormat: JUnit
      testResultsFiles: test-results/junit.xml
  - publish: test-results
    condition: always()
    artifact: testpion-results
`,
      };
    case 'jenkins':
      return {
        provider: o.provider,
        path: 'Jenkinsfile',
        secrets,
        command,
        content: `// Runs the TestPion ${name} (generated by TestPion ${ENGINE_VERSION}). Needs Node.js 24 on the agent.
pipeline {
  agent any
  environment {
    TESTPION_HOME_DIR = "\${WORKSPACE}/.testpion"
    TESTPION_CLI = "\${WORKSPACE}/.testpion/packages/cli/bin/testpion.js"
${secrets.map((s) => `    ${s.name} = credentials('${s.name}')   // ${s.description}`).join('\n')}
  }
  stages {
    stage('Install TestPion CLI') {
      steps { sh 'rm -rf "$TESTPION_HOME_DIR" && ${install.replace(/'/g, "\\'")}' }
    }
${
  spec
    ? `    stage('Breaking API changes') {
      when { changeRequest() }
      steps { sh '${diffAgainst('"$CHANGE_TARGET"', '"$WORKSPACE/.openapi.base"').replace(/'/g, "\\'")}' }
    }
`
    : ''
}${
  startLines.length
    ? `    stage('Start the system under test') {
      steps { sh '${startLines.join(' && ').replace(/'/g, "\\'")}' }
    }
`
    : ''
}    stage('API tests') {
      steps { sh '${command.replace(/'/g, "\\'")}' }
    }
  }
  post {
    always {
      junit 'test-results/junit.xml'
      archiveArtifacts artifacts: 'test-results/**', allowEmptyArchive: true
    }
  }
}
`,
      };
  }
}
