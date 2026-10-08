/** `testpion doctor`: is this machine (and the workspace) ready to run TestPion? */
import { accessSync, constants, existsSync } from 'node:fs';
import { Command } from 'commander';
import { WorkspaceManager, workspaceStorage, ENGINE_VERSION } from '@testpion/core';
import { EXIT, green, red, yellow, dim, bold, printJson, findWorkspaceUp, withWorkspace } from '../shared.js';

interface Check {
  name: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('check that this machine and the workspace are ready: Node.js, SQLite, the app folder, secrets, proxy and certificates, and the workspace files (exit 1 on an error)')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--json', 'print the checks as JSON')
    .action(async (o: { workspace?: string; json?: boolean }) => {
      const checks: Check[] = [];
      const add = (name: string, status: Check['status'], detail: string) => checks.push({ name, status, detail });

      const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
      add(
        'Node.js',
        major > 22 || (major === 22 && minor >= 5) ? 'ok' : major >= 20 ? 'warn' : 'error',
        `${process.versions.node}${major < 22 ? ' (22.5 or newer is needed for SQLite datasets and the fast history index)' : ''}`,
      );
      let sqlite = false;
      try {
        const gbm = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
        const emit = process.emitWarning;
        process.emitWarning = (() => undefined) as typeof process.emitWarning;
        try {
          sqlite = !!(gbm?.('node:sqlite') as { DatabaseSync?: unknown } | undefined)?.DatabaseSync;
        } finally {
          process.emitWarning = emit;
        }
      } catch {
        sqlite = false;
      }
      add('SQLite', sqlite ? 'ok' : 'warn', sqlite ? 'node:sqlite is available' : 'not available: history uses a slower JSON-lines file and SQLite datasets do not work');

      const mgr = new WorkspaceManager();
      try {
        accessSync(mgr.appDir, constants.W_OK);
        add('App folder', 'ok', `${mgr.appDir} is writable`);
      } catch {
        add('App folder', existsSync(mgr.appDir) ? 'error' : 'warn', existsSync(mgr.appDir) ? `${mgr.appDir} is not writable` : `${mgr.appDir} does not exist yet (created on first use)`);
      }
      const settings = mgr.loadSettings();
      const secretVars = Object.keys(process.env).filter((k) => k.startsWith('TESTPION_SECRET_'));
      add(
        'Secrets',
        'ok',
        secretVars.length
          ? `${secretVars.length} TESTPION_SECRET_* environment variable${secretVars.length === 1 ? '' : 's'}`
          : 'none in the environment (the CLI reads secrets from TESTPION_SECRET_* variables or {{$env.NAME}})',
      );

      const proxyEnv = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'].find((k) => process.env[k]);
      const proxyMode = settings.proxy?.mode ?? 'env';
      add('Proxy', 'ok', proxyMode === 'off' ? 'off' : proxyMode === 'custom' ? `custom: ${settings.proxy?.url ?? '(no URL)'}` : proxyEnv ? `from ${proxyEnv}` : 'none (direct connections)');
      if (process.env.NODE_EXTRA_CA_CERTS)
        add(
          'Certificates',
          existsSync(process.env.NODE_EXTRA_CA_CERTS) ? 'ok' : 'error',
          `NODE_EXTRA_CA_CERTS=${process.env.NODE_EXTRA_CA_CERTS}${existsSync(process.env.NODE_EXTRA_CA_CERTS) ? '' : ' (file not found)'}`,
        );
      if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') add('TLS', 'warn', 'NODE_TLS_REJECT_UNAUTHORIZED=0 turns certificate checks off for every request');

      const where = o.workspace ? undefined : findWorkspaceUp(process.cwd());
      if (o.workspace || where) {
        try {
          await withWorkspace(o.workspace, (store) => {
            const cols = store.listCollections();
            const broken = cols.filter((c) => (c as { problem?: string }).problem);
            add('Workspace', 'ok', `${store.workspace.name} (${store.root})`);
            add(
              'Collections',
              broken.length ? 'error' : 'ok',
              broken.length
                ? `${broken.length} of ${cols.length} cannot be read: ${broken.map((c) => `${c.name}: ${(c as { problem?: string }).problem}`).join('; ')}`
                : `${cols.length} collection${cols.length === 1 ? '' : 's'}`,
            );
            const envs = store.listEnvironments();
            add('Environments', 'ok', envs.length ? envs.map((e) => e.name + (e.isProduction ? ' (production)' : '')).join(', ') : 'none');
            add('History index', store.meta.backend === 'sqlite' ? 'ok' : 'warn', store.meta.backend === 'sqlite' ? 'SQLite' : 'JSON lines (slower; needs Node.js 22.5+ for SQLite)');
            const u = workspaceStorage(store);
            add(
              'Kept data',
              u.totalBytes > 2 * 1024 ** 3 ? 'warn' : 'ok',
              `${(u.totalBytes / 1048576).toFixed(1)} MB in ${u.runs} runs, ${u.history} history entries, ${u.traces} traces${u.totalBytes > 2 * 1024 ** 3 ? ' (clean up with testpion storage --delete-runs-older-than 30)' : ''}`,
            );
          });
        } catch (e) {
          add('Workspace', 'error', (e as Error).message);
        }
      } else add('Workspace', 'warn', 'none here: pass -w <name or folder>, or run in a workspace folder');

      const failed = checks.some((c) => c.status === 'error');
      if (o.json) printJson({ version: ENGINE_VERSION, ok: !failed, checks });
      else {
        console.log(bold(`TestPion ${ENGINE_VERSION} doctor`));
        for (const c of checks) console.log(`${c.status === 'ok' ? green('✓') : c.status === 'warn' ? yellow('!') : red('✗')} ${c.name.padEnd(14)} ${c.status === 'ok' ? dim(c.detail) : c.detail}`);
      }
      process.exitCode = failed ? EXIT.CONFIG_ERROR : EXIT.SUCCESS;
    });
}
