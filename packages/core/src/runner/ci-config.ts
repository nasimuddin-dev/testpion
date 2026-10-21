import { existsSync } from 'node:fs';
import { ApsError } from '../errors.js';
import { ENGINE_VERSION } from '../version.js';
import { envNameForSecret, secretKeys } from '../storage/secrets.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { findCollection } from '../storage/env-edit.js';
import { findSavedEvaluation } from './saved-evaluations.js';

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
  /** With tests: only tests whose name or id matches this regular expression (`-g`). */
  grep?: string;
  /** With tests: only tests with one of these tags (`-t`). */
  tags?: string[];
  /** One flow file: run it once per row of this data file (a dataset path; '' for the file's own data:). */
  data?: string;
  /** One flow file: run it in each of these environments and compare step by step. */
  envMatrix?: string[];
  /** Data-changing requests may go to an environment marked as production. */
  allowProduction?: boolean;
  /** Run a saved RAG evaluation (`testpion rag run`): its metrics, gates and a JUnit / HTML report; the judge key is a CI secret. */
  ragEvaluation?: string;
  /** With a RAG evaluation: a metric preset replacing its metrics, the judge (provider/model), gates ("faithfulness=0.8"), a baseline run, the most the judge may cost. */
  ragPreset?: string;
  ragJudge?: string;
  ragMin?: string[];
  ragBaseline?: string;
  ragMaxCost?: number;
  /** With a RAG evaluation: `ragas` reads the Ragas metric names with Ragas's options; the system is called this many times per question (2 to 10). */
  ragCompat?: string;
  ragRepeatTarget?: number;
  /** GitHub: post the run's metrics table as a comment on the pull request (the table is the run's markdown report). */
  ragComment?: boolean;
  /**
   * A NIGHTLY RAG job instead of a per-push one: a cron expression (UTC, "0 3 * * *"). GitHub gets `schedule:`, Azure
   * `schedules:`, Jenkins `triggers { cron }`; GitLab schedules are made in the project's CI/CD > Schedules (the file runs on them).
   */
  ragNightly?: string;
  /** Nightly: score this many records per run, a different set each UTC day (`--limit n --rotate`), so a month covers the dataset. */
  ragSample?: number;
  /** Nightly: compare with the previous night's results kept as the pipeline's artifact (GitHub, GitLab, Azure; Jenkins needs the Copy Artifact plugin) and fail on a drop. */
  ragRegression?: boolean;
  /** With a regression gate: the smallest drop that fails (default 0.05). */
  ragMaxDrop?: number;
  /** One flow file: keep its run as an HTML timeline (test-results/timeline.html), also when the run fails. */
  timelineHtml?: boolean;
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
  /** The same run on this computer (the installed CLI, this workspace's folder): to try it before pushing. */
  localCommand?: string;
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
  if ([o.suite, o.collection, o.tests?.length, o.ragEvaluation].filter(Boolean).length > 1) throw new ApsError('ValidationError', 'Choose one of a suite, a collection, test paths or a RAG evaluation', { suggestions: [] });
  if (o.ragEvaluation)
    return `${cli} rag run ${q(o.ragEvaluation)} -w ${q(ws)}${env}${o.ragPreset ? ` --preset ${q(o.ragPreset)}` : ''}${o.ragJudge ? ` --judge ${q(o.ragJudge)}` : ''}${(o.ragMin ?? []).map((m) => ` --min ${q(m)}`).join('')}${o.ragBaseline ? ` --baseline ${q(o.ragBaseline)}` : ''}${o.ragMaxCost !== undefined ? ` --max-cost ${o.ragMaxCost}` : ''}${o.ragCompat ? ` --compat ${q(o.ragCompat)}` : ''}${o.ragRepeatTarget ? ` --repeat-target ${Math.round(o.ragRepeatTarget)}` : ''}${o.ragSample ? ` --limit ${Math.round(o.ragSample)} --rotate` : ''}${o.ragRegression ? ` --baseline-results previous/results.jsonl${o.ragMaxDrop !== undefined ? ` --max-regression ${o.ragMaxDrop}` : ''}` : ''} -o test-results --junit test-results/junit.xml --html test-results/report.html${o.ragComment ? ' --markdown test-results/rag-metrics.md' : ''}`;
  const prod = o.allowProduction ? ' --allow-production' : '';
  const flowOptions = o.data !== undefined || !!o.envMatrix?.length || !!o.timelineHtml;
  if (flowOptions && (o.suite || o.collection || o.tests?.length !== 1)) throw new ApsError('ValidationError', 'Data, an environment matrix and a timeline run one flow file: give exactly one test file', { suggestions: [] });
  if (o.data !== undefined && o.envMatrix?.length) throw new ApsError('ValidationError', 'Choose data rows or an environment matrix, not both', { suggestions: [] });
  if (o.collection) return `${cli} run-collection ${q(o.collection)} -w ${q(ws)}${env}${(o.folders ?? []).map((f) => ` --folder ${q(f)}`).join('')}${out}${prod}`;
  if (o.suite) return `${cli} run -w ${q(ws)} --suite ${q(o.suite)}${env}${out}${prod}`;
  const rels = (o.tests?.length ? o.tests : ['.']).map((p) => p.replace(/\\/g, '/').replace(/^tests\//, ''));
  const paths = rels.map((rel) => q(`${ws === '.' ? '' : `${ws}/`}tests/${rel === '.' ? '' : rel}`.replace(/\/$/, '') || 'tests'));
  // a flow at scale prints its rows / matrix (kept as JSON with the results: the CLI's envelope, the rows / matrix in
  // its `data`); a plain run writes the reports
  const scale = o.data !== undefined ? ` --data${o.data ? ` ${q(o.data)}` : ''}${env}` : o.envMatrix?.length ? ` --env-matrix ${o.envMatrix.map(q).join(' ')}` : '';
  const filter = `${o.grep ? ` -g ${q(o.grep)}` : ''}${o.tags?.length ? ` -t ${q(o.tags.join(','))}` : ''}`;
  const run = scale
    ? `${cli} test ${paths[0]} -w ${q(ws)}${scale}${prod} --json > test-results/${o.data !== undefined ? 'data-run' : 'env-matrix'}.json`
    : `${cli} test ${paths.join(' ')} -w ${q(ws)}${env}${filter}${out}${prod}`;
  if (!o.timelineHtml) return scale ? `mkdir -p test-results && ${run}` : run;
  // the timeline is written whatever the run's result, and the run's exit code is the step's
  return `${scale ? 'mkdir -p test-results && ' : ''}${run} || code=$?; ${cli} flow report ${q(rels[0]!)} -w ${q(ws)} --html test-results/timeline.html; exit \${code:-0}`;
}

export function ciConfig(store: WorkspaceStore, o: CiConfigOptions): CiConfig {
  if (!CI_PROVIDERS.includes(o.provider)) throw new ApsError('ValidationError', `CI provider must be one of ${CI_PROVIDERS.join(', ')}`, { suggestions: [] });
  if (o.suite && !existsSync(store.path('tests', `${o.suite}.suite.yaml`))) throw new ApsError('ValidationError', `No suite "${o.suite}" (tests/${o.suite}.suite.yaml)`, { suggestions: [] });
  if (o.collection) {
    if (!findCollection(store, o.collection)) throw new ApsError('ValidationError', `No collection "${o.collection}"`, { suggestions: [] });
  }
  // test files or folders (one flow, a few files): inside tests/, and there
  for (const t of o.tests ?? []) {
    const rel = t.replace(/\\/g, '/').replace(/^tests\//, '').replace(/\/+$/, '');
    if (rel === '.' || rel === '') continue;
    if (/^\/|^[A-Za-z]:|(^|\/)\.\.(\/|$)/.test(rel)) throw new ApsError('ValidationError', `"${t}" is not a path inside tests/`, { suggestions: [] });
    if (!existsSync(store.path('tests', rel))) throw new ApsError('ValidationError', `No test file or folder "tests/${rel}"`, { suggestions: [] });
  }
  if ((o.ragNightly || o.ragSample || o.ragRegression) && !o.ragEvaluation) throw new ApsError('ValidationError', 'A nightly job, a sample and a regression gate belong to a RAG evaluation', { suggestions: [] });
  if (o.ragNightly !== undefined && !/^\s*\S+(\s+\S+){4}\s*$/.test(o.ragNightly)) throw new ApsError('ValidationError', `"${o.ragNightly}" is not a cron expression of 5 fields (minute hour day month weekday, UTC), e.g. "0 3 * * *"`, { suggestions: [] });
  if (o.ragSample !== undefined && !(o.ragSample >= 1)) throw new ApsError('ValidationError', 'The sample is a number of records (1 or more)', { suggestions: [] });
  if (o.ragEvaluation) {
    try {
      findSavedEvaluation(store, o.ragEvaluation);
    } catch {
      throw new ApsError('ValidationError', `No saved evaluation "${o.ragEvaluation}"`, { suggestions: [] });
    }
  }
  const version = o.version ?? ENGINE_VERSION;
  const tag = version.startsWith('v') ? version : `v${version}`;
  const secrets = ciSecrets(store, o.environment, { providers: !o.collection });
  const command = ciCommand(o, 'node "$TESTPION_CLI"');
  // forward slashes: the same path works in bash, PowerShell and cmd
  const localCommand = ciCommand({ ...o, workspaceDir: store.root.replace(/\\/g, '/') }, 'testpion');
  const install = `git clone --depth 1 --branch ${tag} ${REPO} "$TESTPION_HOME_DIR" && cd "$TESTPION_HOME_DIR" && npm ci --no-audit --no-fund && npm run build -w @testpion/shared -w @testpion/core -w @testpion/cli`;
  const files = (o.tests ?? []).map((t) => t.replace(/\\/g, '/').replace(/^tests\//, '')).filter((t) => t && t !== '.');
  const name = o.ragEvaluation ? `RAG evaluation ${o.ragEvaluation}` : o.suite ? `suite ${o.suite}` : o.collection ? `collection ${o.collection}` : files.length ? `tests ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` and ${files.length - 3} more` : ''}` : 'tests';
  // integration tests: start the system under test, wait until it answers, then run; it is stopped when the job ends
  const start = o.start?.trim() ? `(${o.start.trim()}) &` : undefined;
  const wait = o.waitFor?.trim() ? `node "$TESTPION_CLI" wait-for ${q(o.waitFor.trim())} --timeout ${Math.max(5, Math.round(o.waitSeconds ?? 90))}` : undefined;
  const startLines = [start, wait].filter((x): x is string => !!x);
  // pull requests: compare the OpenAPI document with the target branch's (skipped when the branch doesn't have it yet)
  const spec = o.openapi?.trim() ? q(o.openapi.trim().replace(/^\.\//, '')) : undefined;
  const diffAgainst = (ref: string, tmp: string) =>
    `git fetch --depth 1 origin ${ref} && if git show FETCH_HEAD:${spec} > ${tmp}; then node "$TESTPION_CLI" openapi-diff ${tmp} ${spec} --fail-on-breaking; else echo "No ${spec} on the target branch yet"; fi`;
  const cron = o.ragNightly?.trim();
  const regress = !!(o.ragEvaluation && o.ragRegression);
  switch (o.provider) {
    case 'github':
      return {
        provider: o.provider,
        path: '.github/workflows/testpion.yml',
        secrets,
        command,
        localCommand,
        content: `# Runs the TestPion ${name} on every push and pull request (generated by TestPion ${ENGINE_VERSION}).
name: API tests

on:
${
  cron
    ? `  schedule:
    - cron: '${cron}'   # UTC
  workflow_dispatch:`
    : `  push:
  pull_request:
  workflow_dispatch:`
}

${o.ragEvaluation && o.ragComment ? 'permissions:\n  contents: read\n  pull-requests: write\n\n' : ''}jobs:
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
}${
  regress
    ? `      - name: Fetch the previous run's results (the baseline)
        continue-on-error: true
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          id=$(gh run list --workflow "$GITHUB_WORKFLOW" --branch "$GITHUB_REF_NAME" --status success --limit 1 --json databaseId --jq '.[0].databaseId')
          if [ -n "$id" ]; then gh run download "$id" --name testpion-results --dir previous || true; fi
`
    : ''
}      - name: Run ${name}
        run: ${command}
${
  o.ragEvaluation && o.ragComment
    ? `      - name: Comment the metrics on the pull request
        if: always() && github.event_name == 'pull_request' && hashFiles('test-results/rag-metrics.md') != ''
        env:
          GH_TOKEN: \${{ github.token }}
        run: gh pr comment \${{ github.event.pull_request.number }} --body-file test-results/rag-metrics.md
`
    : ''
}      - name: Upload reports
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
        localCommand,
        content: `# Runs the TestPion ${name} (generated by TestPion ${ENGINE_VERSION}).
# Secrets: add ${secrets.length ? secrets.map((s) => s.name).join(', ') : 'none needed'} under Settings > CI/CD > Variables (masked).
${cron ? `# Nightly: GitLab runs it on a pipeline schedule. Create one under Build > Pipeline schedules with the cron ${cron} (UTC).\n` : ''}api-tests:
${cron ? '  rules:\n    - if: $CI_PIPELINE_SOURCE == "schedule"\n    - if: $CI_PIPELINE_SOURCE == "web"\n' : ''}  image: node:24
  variables:
    TESTPION_HOME_DIR: /tmp/testpion
    TESTPION_CLI: /tmp/testpion/packages/cli/bin/testpion.js
  script:
    - (${install})
${spec ? `    - if [ -n "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME" ]; then ${diffAgainst('"$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"', '/tmp/openapi.base')}; fi\n` : ''}${startLines.map((l) => `    - ${l}\n`).join('')}${regress ? `    - 'mkdir -p previous && (curl --fail --silent --location --header "JOB-TOKEN: $CI_JOB_TOKEN" -o previous.zip "$CI_API_V4_URL/projects/$CI_PROJECT_ID/jobs/artifacts/$CI_DEFAULT_BRANCH/download?job=api-tests" && unzip -q -o previous.zip -d previous-unzipped && cp previous-unzipped/test-results/results.jsonl previous/) || echo "No earlier results yet"'\n` : ''}    - ${command}
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
        localCommand,
        content: `# Runs the TestPion ${name} (generated by TestPion ${ENGINE_VERSION}).
# Secrets: add ${secrets.length ? secrets.map((s) => s.name).join(', ') : 'none needed'} as secret pipeline variables.
${
  cron
    ? `trigger: none

schedules:
  - cron: '${cron}'   # UTC
    displayName: Nightly
    branches:
      include: [main]
    always: true`
    : `trigger:
  - main`
}

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
}${
  regress
    ? `  - task: DownloadPipelineArtifact@2
    displayName: Fetch the previous run's results (the baseline)
    continueOnError: true
    inputs:
      buildType: specific
      project: $(System.TeamProject)
      definition: $(System.DefinitionId)
      buildVersionToDownload: latestFromBranch
      branchName: refs/heads/main
      artifactName: testpion-results
      targetPath: previous
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
        localCommand,
        content: `// Runs the TestPion ${name} (generated by TestPion ${ENGINE_VERSION}). Needs Node.js 24 on the agent.
pipeline {
  agent any
${cron ? `  triggers { cron('${cron.replace(/'/g, "\\'")}') }   // the Jenkins server's time zone\n` : ''}${regress ? "  // Regression gate: copy 'previous/results.jsonl' from the last successful build with the Copy Artifact plugin before the API tests stage; without it the run has no baseline.\n" : ''}  environment {
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
