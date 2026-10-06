// Builds the `testpion` npm package: the CLI with its engine (packages/cli, core and shared) bundled into one file,
// third-party modules as ordinary dependencies. `npx testpion` and `npm install -g testpion` then work without a clone.
//
//   node scripts/pack-cli.mjs            -> dist/npm/testpion/ (the package folder)
//   node scripts/pack-cli.mjs --tarball  -> also dist/npm/testpion-<version>.tgz (what `npm publish` uploads)
//   node scripts/pack-cli.mjs --json     -> a summary for agents and CI
//
// The release workflow runs it with --tarball and publishes the tarball when the repository has an NPM_TOKEN secret.
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outRoot = outIdx >= 0 ? resolve(args[outIdx + 1]) : join(root, 'dist', 'npm');
const pkgDir = join(outRoot, 'testpion');
const read = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));

const rootPkg = read('package.json');
const sources = ['packages/shared/package.json', 'packages/core/package.json', 'packages/cli/package.json'].map(read);
// every third-party module the engine may load, with the version range its package asks for
const ranges = {};
for (const p of sources) for (const [name, range] of Object.entries(p.dependencies ?? {})) if (!name.startsWith('@testpion/')) ranges[name] = range;

rmSync(pkgDir, { recursive: true, force: true });
mkdirSync(join(pkgDir, 'dist'), { recursive: true });
mkdirSync(join(pkgDir, 'bin'), { recursive: true });

const result = await build({
  entryPoints: [join(root, 'packages/cli/src/index.ts')],
  outfile: join(pkgDir, 'dist', 'testpion.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
  metafile: true,
  // the engine's own code is bundled from source; everything else stays a dependency
  alias: { '@testpion/core': join(root, 'packages/core/src/index.ts'), '@testpion/shared': join(root, 'packages/shared/src/index.ts') },
  external: Object.keys(ranges).flatMap((n) => [n, `${n}/*`]),
  // CommonJS dependencies that call require() need it in an ES module bundle
  banner: { js: "import { createRequire as __tpCreateRequire } from 'node:module'; const require = __tpCreateRequire(import.meta.url);" },
});

// the dependencies the bundle actually imports (static or dynamic), not the whole list
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
const used = new Set();
for (const out of Object.values(result.metafile.outputs))
  for (const imp of out.imports ?? []) {
    if (!imp.external || builtins.has(imp.path) || imp.path.startsWith('node:')) continue;
    const name = imp.path.startsWith('@') ? imp.path.split('/').slice(0, 2).join('/') : imp.path.split('/')[0];
    if (!ranges[name]) throw new Error(`The bundle imports ${imp.path}, which no package lists as a dependency`);
    used.add(name);
  }
const dependencies = Object.fromEntries([...used].sort().map((n) => [n, ranges[n]]));

const cli = sources[2];
const pkg = {
  name: 'testpion',
  version: rootPkg.version,
  description: 'TestPion on the command line: run API, protocol and AI tests, Postman / Newman-compatible collections, load tests and an MCP server for AI agents.',
  keywords: ['api-testing', 'testing', 'rest', 'graphql', 'grpc', 'websocket', 'mqtt', 'kafka', 'postman', 'newman', 'mcp', 'ci'],
  homepage: 'https://nasimuddin-dev.github.io/testpion/',
  repository: { type: 'git', url: 'git+https://github.com/nasimuddin-dev/testpion.git', directory: 'packages/cli' },
  bugs: { url: 'https://github.com/nasimuddin-dev/testpion/issues' },
  license: cli.license ?? 'MIT',
  type: 'module',
  bin: { testpion: './bin/testpion.js' },
  files: ['bin', 'dist', 'README.md', 'LICENSE'],
  engines: rootPkg.engines,
  dependencies,
};
writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
writeFileSync(join(pkgDir, 'bin', 'testpion.js'), readFileSync(join(root, 'packages/cli/bin/testpion.js'), 'utf8').replace("'../dist/index.js'", "'../dist/testpion.js'"));
cpSync(join(root, 'LICENSE'), join(pkgDir, 'LICENSE'));
writeFileSync(
  join(pkgDir, 'README.md'),
  `# TestPion CLI

Run [TestPion](https://nasimuddin-dev.github.io/testpion/) workspaces from a terminal or a CI pipeline: REST, GraphQL, gRPC,
WebSocket, Socket.IO, MQTT, Kafka, SSE and MCP tests, AI evaluations, load tests, and Postman collections the way Newman runs them.

\`\`\`bash
npx testpion --help
npm install -g testpion
\`\`\`

Common commands:

\`\`\`bash
testpion run tests/                      # the workspace's test files
testpion run-collection "My API" -e Staging --reporters cli,junit
testpion run-collection collection.postman_collection.json -d data.csv
testpion mcp-server                      # tools for AI agents (Claude, Cursor, VS Code)
\`\`\`

Every command takes \`--json\` for machine-readable output. Node.js ${rootPkg.engines.node} is required.

- [CLI reference](https://nasimuddin-dev.github.io/testpion/cli/reference)
- [CI / CD](https://nasimuddin-dev.github.io/testpion/test-runner/ci-cd)
- [The desktop app](https://nasimuddin-dev.github.io/testpion/download)
`,
);

let tarball;
if (args.includes('--tarball')) {
  // npm is a .cmd script on Windows, which needs a shell: one command line, the folder quoted
  const out = execSync(`npm pack --json --pack-destination "${outRoot}"`, { cwd: pkgDir, encoding: 'utf8' });
  tarball = join(outRoot, JSON.parse(out)[0].filename);
}

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
const summary = { name: pkg.name, version: pkg.version, folder: pkgDir, tarball, bundleBytes: bytes, dependencies };
if (args.includes('--json')) console.log(JSON.stringify(summary, null, 2));
else console.log(`testpion ${pkg.version}: ${pkgDir}${tarball ? `\n  ${tarball}` : ''}\n  bundle ${(bytes / 1024).toFixed(0)} KB, ${used.size} dependencies`);
