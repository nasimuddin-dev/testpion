/**
 * RPC handlers: the Debugger for corporate networks and sharing (planning/fiddler-gap-backlog.md): the gateway, custom CA files and
 * client certificates (FG-9), SAZ export and Fiddler rules import (FG-22), comparing two captures (FG-23), the share bundle (FG-24),
 * large-session mode (FG-28) and starting a program through the proxy (FG-14). The window, `testpion debugger …` and the
 * `debugger_*` tools all end in the same core functions; these only hold the state of the running app.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  ApsError,
  atomicWriteAsync,
  GATEWAY_PASSWORD_SECRET,
  SessionSpool,
  captureSessionFileName,
  CAPTURE_SESSIONS_DIR,
  cleanGateway,
  clientCertSecret,
  createShareBundle,
  describeDiff,
  describeFarxImport,
  describeGateway,
  diffSessions,
  exchangesFromHar,
  exchangesToHar,
  exchangesToSaz,
  gatewayProblems,
  kindOf,
  looksLikeShareBundle,
  LAUNCH_KINDS,
  openShareBundle,
  planLaunch,
  probeGateway,
  resolveGateway,
  rulesFromFarx,
  startLaunch,
  strictHarRedactor,
  type DebuggerExchange,
  type DebuggerRule,
  type GatewayConfig,
  type LaunchKind,
} from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';
import type { DebuggerState } from './debugger-state.js';
import { rulesOf, saveRules } from './debugger-rules.js';

const FILE = 'connections.json';
const dirOf = (be: Backend) => join(be.host.appDir, 'debugger');

interface Connections {
  gateway: GatewayConfig;
  largeSession?: boolean;
}

function readConnections(be: Backend): Connections {
  try {
    const raw = JSON.parse(readFileSync(join(dirOf(be), FILE), 'utf8')) as Partial<Connections>;
    return { gateway: cleanGateway(raw.gateway), largeSession: raw.largeSession === true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') be.logger.warn(`Debugger connections could not be read (starting with direct connections): ${(e as Error).message}`);
    return { gateway: { mode: 'none' } };
  }
}

async function writeConnections(be: Backend, c: Connections): Promise<void> {
  mkdirSync(dirOf(be), { recursive: true, mode: 0o700 });
  await atomicWriteAsync(join(dirOf(be), FILE), `${JSON.stringify(c, null, 2)}\n`);
}

/** Resolve the saved gateway (files read, secrets looked up) onto the state, where the proxy reads it. A configuration that cannot work is an error that says why. */
function applyGateway(be: Backend, state: DebuggerState, config: GatewayConfig): void {
  const password = config.mode === 'manual' && config.username ? be.secrets.get(GATEWAY_PASSWORD_SECRET) : undefined;
  if (password) be.logger.redactor.addSecret(password);
  for (const c of config.clientCerts ?? []) {
    const pass = be.secrets.get(clientCertSecret(c.id));
    if (pass) be.logger.redactor.addSecret(pass);
  }
  const gw = resolveGateway(config, { secret: (n) => be.secrets.get(n), systemProxyFor: (u) => be.net.proxyUriFor(u) });
  state.gatewayConfig = config;
  state.gateway = config.mode === 'none' && !config.caFiles?.length && !config.clientCerts?.length ? undefined : gw;
  state.gatewaySummary = state.gateway ? describeGateway(config, { password: !!password }) : undefined;
}

/** Spool or no spool for large-session mode. */
function applySpool(be: Backend, state: DebuggerState, on: boolean): void {
  if (on && !state.spoolOn) {
    const dir = dirOf(be);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const f of readdirSync(dir)) if (/^spool-\d+\.jsonl$/.test(f) && f !== `spool-${process.pid}.jsonl`) rmSync(join(dir, f), { force: true }); // a crashed run's
    state.session.setSpool(new SessionSpool(join(dir, `spool-${process.pid}.jsonl`), be.logger.redactor));
  } else if (!on && state.spoolOn) state.session.setSpool(undefined);
  state.spoolOn = on;
}

/** Called when the proxy starts: the saved connections apply (or refuse to, saying why). */
export function prepareConnections(be: Backend, state: DebuggerState): void {
  const saved = readConnections(be);
  try {
    applyGateway(be, state, saved.gateway);
  } catch (e) {
    state.gateway = undefined;
    throw new ApsError('ConfigurationError', `The Debugger's connection settings do not work: ${(e as Error).message}`, { suggestions: ['Open Capture ▸ Connections and fix them, or switch the gateway off.'] });
  }
  applySpool(be, state, saved.largeSession === true);
}

export function debuggerEnterpriseHandlers(be: Backend, state: DebuggerState): Handlers {
  const sessionPath = (name: string) => (name === 'autosave' ? join(dirOf(be), 'autosave.har') : be.ws.safePath(captureSessionFileName(name), be.ws.path(CAPTURE_SESSIONS_DIR)));
  /** The whole session on screen: the live capture with what spilled to disk, or a saved session's tab. */
  const everything = async (): Promise<DebuggerExchange[]> => {
    const shown = state.view?.() ?? state.exchanges;
    return shown === state.exchanges ? state.session.everything() : shown.slice();
  };
  const redactor = () => strictHarRedactor(be.logger.redactor);
  const gatewayView = () => {
    const c = state.gatewayConfig ?? readConnections(be).gateway;
    const problems = (() => {
      try {
        return gatewayProblems(c);
      } catch (e) {
        return [(e as Error).message];
      }
    })();
    return {
      config: { ...c, clientCerts: (c.clientCerts ?? []).map((k) => ({ ...k, passphraseSet: !!be.secrets.get(clientCertSecret(k.id)) })) },
      passwordSet: !!be.secrets.get(GATEWAY_PASSWORD_SECRET),
      summary: describeGateway(c, { password: !!be.secrets.get(GATEWAY_PASSWORD_SECRET) }),
      problems,
      /** The app's own network settings, shown beside the "system" choice so the person sees what it follows. */
      app: { mode: be.net.settings.mode, url: be.net.settings.mode === 'custom' ? be.net.settings.url : undefined },
      running: !!state.proxy,
    };
  };
  const readBytes = (p: { path?: string; base64?: string; text?: string }): Buffer => {
    const cap = be.host.importBytes ?? 256 * 1024 * 1024;
    if (p.base64 !== undefined) {
      if (p.base64.length * 0.75 > cap) throw new ApsError('ValidationError', `That file is larger than the ${Math.round(cap / 1024 / 1024)} MB the Debugger opens`);
      return Buffer.from(p.base64, 'base64');
    }
    if (p.text !== undefined) return Buffer.from(p.text, 'utf8');
    if (!p.path) throw new ApsError('ValidationError', 'Give a file (path, base64 or text)');
    return readFileSync(be.ws.safePath(p.path));
  };
  const saveFile = (name: string, ext: string, mime: string, build: () => Promise<Buffer>) =>
    be.saveOrDownload(name, [{ name: ext.toUpperCase(), extensions: [ext] }], async () => undefined, build, { type: mime });

  return {
    /* ---- FG-9: the gateway, extra authorities, client certificates */
    'debug.gateway': () => gatewayView(),
    /**
     * Save the connection settings. The proxy password and each key's passphrase go to the secret store (a null deletes one);
     * nothing secret is written to the settings file. A running proxy follows the change at once.
     */
    'debug.setGateway': async ({ config, password, passphrases }: { config: Record<string, unknown>; password?: string | null; passphrases?: Record<string, string | null> }) => {
      const clean = cleanGateway(config);
      if (password !== undefined) {
        if (password) await be.secrets.set(GATEWAY_PASSWORD_SECRET, password);
        else await be.secrets.delete(GATEWAY_PASSWORD_SECRET);
      }
      for (const [id, pass] of Object.entries(passphrases ?? {})) {
        if (!(clean.clientCerts ?? []).some((c) => c.id === id)) continue;
        if (pass) await be.secrets.set(clientCertSecret(id), pass);
        else await be.secrets.delete(clientCertSecret(id));
      }
      // a client certificate removed from the list takes its passphrase with it
      const before = readConnections(be).gateway;
      for (const c of before.clientCerts ?? []) if (!(clean.clientCerts ?? []).some((x) => x.id === c.id)) await be.secrets.delete(clientCertSecret(c.id));
      applyGateway(be, state, clean); // before it is saved: a file that cannot be read is told now
      await writeConnections(be, { ...readConnections(be), gateway: clean });
      be.host.emit('debug.state', { gateway: state.gatewaySummary ?? null });
      return gatewayView();
    },
    /** Try the gateway: open a tunnel (HTTPS) or ask for the head (HTTP) of a URL through it. */
    'debug.testGateway': async ({ url }: { url?: string } = {}) => {
      const saved = state.gatewayConfig ?? readConnections(be).gateway;
      const gw = resolveGateway(saved, { secret: (n) => be.secrets.get(n), systemProxyFor: (u) => be.net.proxyUriFor(u) });
      return probeGateway(gw, url?.trim() || 'https://example.com/');
    },

    /* ---- FG-22: SAZ out, Fiddler rules in */
    'debug.exportSaz': async ({ name }: { name?: string } = {}) => {
      const r = await saveFile(`${name || 'testpion-session'}.saz`, 'saz', 'application/octet-stream', async () => exchangesToSaz(await everything(), redactor()));
      return { ...r, exchanges: (await everything()).length };
    },
    /** Fiddler's AutoResponder rules (.farx): mapped best effort into the active profile; `dryRun` only reports. */
    'debug.importFarx': async (p: { path?: string; base64?: string; text?: string; dryRun?: boolean }) => {
      const r = rulesFromFarx(readBytes(p));
      if (!p.dryRun && r.rules.length) {
        const f = rulesOf(be, state);
        (f.profiles[f.active] ??= []).push(...r.rules);
        await saveRules(be, state);
      }
      return { summary: describeFarxImport(r), partial: true, applied: !p.dryRun && r.rules.length > 0, autoResponderEnabled: r.autoResponderEnabled, items: r.items };
    },

    /* ---- FG-23: compare two captures */
    /** This session (on screen) against a saved one: `with` is its name; `ignoreQuery` and `includeSize` loosen or widen the match. */
    'debug.diff': async ({ with: other, ignoreQuery, includeSize, includeTunnels }: { with: string; ignoreQuery?: boolean; includeSize?: boolean; includeTunnels?: boolean }) => {
      const file = sessionPath(String(other ?? ''));
      if (!existsSync(file)) throw new ApsError('ValidationError', `There is no saved session "${other}"`, { suggestions: ['Save the earlier run first (Session ▸ Save session), then compare.'] });
      let baseline: DebuggerExchange[];
      try {
        baseline = exchangesFromHar(JSON.parse(readFileSync(file, 'utf8')));
      } catch (e) {
        throw new ApsError('ValidationError', `${other} is not a HAR file: ${(e as Error).message}`);
      }
      const now = await everything();
      const d = diffSessions(baseline, now, { ignoreQuery, includeSize, includeTunnels });
      const red = be.logger.redactor;
      const cut = <T extends { url: string }>(list: T[]) => list.slice(0, 2000).map((x) => ({ ...x, url: red.redactUrl(x.url) }));
      return { summary: describeDiff(d), baseline: other, totals: d.totals, unchanged: d.unchanged, added: cut(d.added), removed: cut(d.removed), changed: cut(d.changed), truncated: d.added.length > 2000 || d.removed.length > 2000 || d.changed.length > 2000 };
    },

    /* ---- FG-24: the share and support bundle */
    'debug.shareBundle': async ({ name, notes, withRules }: { name?: string; notes?: string; withRules?: boolean }) => {
      if (!state.exchanges.length && !state.session.spilled) throw new ApsError('ValidationError', 'Nothing captured yet');
      const bundleName = (name || 'testpion-session').trim();
      const rules = withRules === false ? [] : (rulesOf(be, state).profiles[rulesOf(be, state).active] ?? []).filter((r: DebuggerRule) => r.enabled);
      const build = async () =>
        (
          await createShareBundle({
            name: bundleName,
            exchanges: await everything(),
            rules,
            notes,
            redactor: be.logger.redactor,
            state: {
              running: !!state.proxy,
              decrypt: !!state.decrypt,
              systemProxy: !!state.systemProxy,
              lan: !!state.lan,
              port: state.proxy?.port,
              networkSpeed: state.speed ? 'on' : undefined,
              gatewayConfig: state.gatewayConfig,
              passwordSet: !!be.secrets.get(GATEWAY_PASSWORD_SECRET),
            },
          })
        ).bytes;
      const r = await saveFile(`${bundleName}.tpbundle`, 'tpbundle', 'application/zip', build);
      return { ...r, masked: true, rules: rules.length };
    },
    /** Open a bundle into the Debugger (replacing the session, or adding with `append`); `withRules` also adds its rules, switched off, to the active profile. */
    'debug.openBundle': async (p: { path?: string; base64?: string; append?: boolean; withRules?: boolean; rulesOnly?: boolean }) => {
      const bytes = readBytes(p);
      if (!looksLikeShareBundle(bytes)) throw new ApsError('ValidationError', 'Not a TestPion bundle (.tpbundle)');
      const b = openShareBundle(bytes);
      if (!b.exchanges.length && !p.rulesOnly) throw new ApsError('ValidationError', 'That bundle has no exchanges');
      // the same path as opening a HAR: the grid, AutoSave and the list's changes see it
      const har = JSON.stringify(exchangesToHar(b.exchanges, be.logger.redactor));
      const opened = p.rulesOnly ? {} : ((await be.invoke('debug.openSession', { text: har, append: p.append })) as Record<string, unknown>);
      let rulesAdded = 0;
      if (p.withRules && b.rules.length) {
        const f = rulesOf(be, state);
        (f.profiles[f.active] ??= []).push(...b.rules.map((r) => ({ ...r, id: `${r.id}-b${Date.now().toString(36)}`, enabled: false })));
        await saveRules(be, state);
        rulesAdded = b.rules.length;
      }
      return { ...opened, bundle: { name: b.manifest.name, createdAt: b.manifest.createdAt, app: b.manifest.app.version, exchanges: b.exchanges.length, rules: b.rules.length, rulesAdded }, environment: b.environment, notes: b.notes };
    },

    /* ---- FG-28: large-session mode */
    'debug.largeSession': async ({ on }: { on?: boolean } = {}) => {
      if (on !== undefined) {
        applySpool(be, state, on);
        await writeConnections(be, { ...readConnections(be), largeSession: on });
        be.host.emit('debug.state', { spilled: state.session.spilled });
      }
      return { on: !!state.spoolOn, saved: readConnections(be).largeSession === true, spilled: state.session.spilled, inMemory: state.exchanges.length };
    },

    /* ---- FG-14: start a program through the proxy */
    'debug.launch': async ({ command, args, kind, cwd, preview }: { command: string; args?: string[]; kind?: string; cwd?: string; preview?: boolean }) => {
      if (!state.proxy) throw new ApsError('ConfigurationError', 'Start capturing first', { suggestions: ['Capture ▸ Start, then start the program through it.'] });
      if (kind && !LAUNCH_KINDS.includes(kind as LaunchKind)) throw new ApsError('ValidationError', `kind is one of ${LAUNCH_KINDS.join(', ')}`);
      const plan = planLaunch({ command, args, proxyUrl: state.proxy.url, kind: kind as LaunchKind | undefined, caPath: state.decrypt ? state.root?.path : undefined });
      const view = { kind: plan.kind, command: plan.command, args: plan.args, env: Object.keys(plan.env), notes: plan.notes, detected: kindOf(command) };
      if (preview) return { ...view, started: false };
      const r = await startLaunch(plan, { cwd: cwd ? be.ws.safePath(cwd) : undefined });
      be.logger.info(`Debugger: started ${plan.command} (${r.pid}) through ${state.proxy.url}`);
      return { ...view, started: true, pid: r.pid };
    },
  };
}
