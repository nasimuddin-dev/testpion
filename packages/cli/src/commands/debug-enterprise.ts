/**
 * The HTTP Debugger for corporate networks and sharing, from the terminal (planning/fiddler-gap-backlog.md):
 *   debugger export <file>        a session as a Fiddler SAZ (--saz), a masked share bundle (--bundle) or a HAR (--har)   (FG-22, FG-24)
 *   debugger farx <file.farx>     Fiddler AutoResponder rules, mapped best effort into a rules file                        (FG-22)
 *   debugger diff <before> <after>  what changed between two captures: added, removed, status or timing changed          (FG-23)
 *   debugger open <bundle>        what a share bundle holds: its notes, environment, rules and exchanges                  (FG-24)
 *   debugger gateway              try a corporate gateway (upstream proxy) with a URL                                     (FG-9)
 *   debugger launch <program>     start a program with the proxy variables and switches its runtime reads                  (FG-14)
 * `debugger capture` takes the gateway flags (--upstream, --no-upstream-for, --ca-file, --client-cert).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command, Option } from 'commander';
import {
  Redactor,
  cleanGateway,
  createShareBundle,
  describeDiff,
  describeFarxImport,
  describeGateway,
  defaultRules,
  diffSessions,
  exchangesFromFile,
  exchangesToHar,
  exchangesToSaz,
  kindOf,
  LAUNCH_KINDS,
  planLaunch,
  probeGateway,
  resolveGateway,
  rulesFromFarx,
  startLaunch,
  strictHarRedactor,
  ENGINE_VERSION,
  type DebuggerRule,
  type DebuggerRulesFile,
  type Gateway,
  type LaunchKind,
} from '@testpion/core';
import { EXIT, CliError, dim, green, printJson, withWorkspace, WORKSPACE_OPTION, JSON_RESULT_OPTION } from '../shared.js';

/** The gateway flags of `debugger capture` and `debugger gateway`, defined once. */
export function addGatewayOptions(cmd: Command): Command {
  return cmd
    .option('--upstream <url>', 'forward everything through this gateway (an upstream proxy), http://host:port; the password comes from TESTPION_UPSTREAM_PASSWORD, not from the command line')
    .option('--upstream-user <name>', 'the gateway user name (with TESTPION_UPSTREAM_PASSWORD)')
    .option('--upstream-system', 'forward through the proxy the environment names (HTTP_PROXY, HTTPS_PROXY, NO_PROXY)')
    .option('--no-upstream-for <hosts>', 'hosts that go direct, comma separated like NO_PROXY: ".corp.example, 10.0.0.1, <local>" (loopback always does)')
    .option('--ca-file <pem...>', 'PEM file(s) of certificate authorities to trust besides the usual ones (a corporate root)')
    .option('--client-cert <host=cert.pem:key.pem...>', 'a client certificate for servers that ask for one (mutual TLS), for hosts matching the glob; the key passphrase comes from TESTPION_CLIENT_KEY_PASSPHRASE');
}

export interface GatewayFlags {
  upstream?: string;
  upstreamUser?: string;
  upstreamSystem?: boolean;
  /** commander turns `--no-upstream-for <hosts>` into upstreamFor (true by default, the hosts when given). */
  upstreamFor?: string | boolean;
  caFile?: string[];
  clientCert?: string[];
}

/** The gateway the flags ask for (undefined: connect directly). A wrong flag is a CONFIG_ERROR that says which. */
export function gatewayFromFlags(o: GatewayFlags, env: NodeJS.ProcessEnv = process.env): { gateway?: Gateway; summary?: string } {
  const certs = (o.clientCert ?? []).map((spec, i) => {
    const m = /^(.+?)=(.+?):(.+)$/.exec(spec.replace(/^([A-Za-z]):/, '$1\u0000'));
    if (!m) throw new CliError(`--client-cert wants host=cert.pem:key.pem, not "${spec}"`, EXIT.CONFIG_ERROR);
    return { id: `cli${i + 1}`, host: m[1]!, certFile: m[2]!.replace('\u0000', ':'), keyFile: m[3]!.replace('\u0000', ':') };
  });
  const mode = o.upstream ? 'manual' : o.upstreamSystem ? 'system' : 'none';
  if (mode === 'none' && !certs.length && !o.caFile?.length) return {};
  const password = env.TESTPION_UPSTREAM_PASSWORD;
  try {
    const config = cleanGateway({ mode, url: o.upstream, bypass: typeof o.upstreamFor === 'string' ? o.upstreamFor : undefined, username: o.upstreamUser, caFiles: o.caFile, clientCerts: certs });
    if (config.username && !password) throw new CliError('--upstream-user needs the password in TESTPION_UPSTREAM_PASSWORD', EXIT.CONFIG_ERROR);
    const gateway = resolveGateway(config, {
      secret: (n) => (n === 'debugger.gateway.password' ? password : env.TESTPION_CLIENT_KEY_PASSPHRASE),
      systemProxyFor: (url) => (url.startsWith('https:') ? (env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy) : (env.HTTP_PROXY ?? env.http_proxy)),
    });
    return { gateway, summary: describeGateway(config, { password: !!password }) };
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError((e as Error).message, EXIT.CONFIG_ERROR);
  }
}

const readRulesFile = (file: string): { rules: DebuggerRule[]; write(rules: DebuggerRule[]): void } => {
  let raw: DebuggerRulesFile | DebuggerRule[] | undefined;
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, 'utf8')) as DebuggerRulesFile | DebuggerRule[];
    } catch (e) {
      throw new CliError(`${file} is not valid JSON: ${(e as Error).message}`, EXIT.CONFIG_ERROR);
    }
  }
  if (Array.isArray(raw)) return { rules: raw, write: (r) => writeFileSync(file, JSON.stringify(r, null, 2) + '\n') };
  const f: DebuggerRulesFile = raw?.profiles ? raw : { active: 'Default', profiles: { Default: defaultRules() } };
  f.active = f.profiles[f.active] ? f.active : (Object.keys(f.profiles)[0] ?? 'Default');
  return {
    rules: f.profiles[f.active] ?? [],
    write: (r) => {
      f.profiles[f.active] = r;
      writeFileSync(file, JSON.stringify(f, null, 2) + '\n');
    },
  };
};

export function registerDebugEnterpriseCommands(program: Command): void {
  program
    .command('debug-export')
    .description('write a captured session (HAR, Fiddler SAZ or bundle) in another format, secrets masked: --saz for Fiddler, --bundle for a colleague or support (masked HAR, active rules, environment facts, notes), --har for HAR')
    .argument('<file>', 'the session: a .har, .saz or .tpbundle')
    .option('--saz <file>', 'write a Fiddler session archive')
    .option('--bundle <file>', 'write a share bundle (.tpbundle)')
    .option('--har <file>', 'write a HAR')
    .option('--notes <text>', 'with --bundle: a note for the person who opens it')
    .option('--rules <file.json>', 'with --bundle: the rules file whose enabled rules travel inside (default: none)')
    .option('--dry-run', 'change nothing: say what would be written')
    .option(...JSON_RESULT_OPTION)
    .action(async (file: string, o: { saz?: string; bundle?: string; har?: string; notes?: string; rules?: string; dryRun?: boolean; json?: boolean }) => {
      if (!o.saz && !o.bundle && !o.har) throw new CliError('Say what to write: --saz <file>, --bundle <file> or --har <file>', EXIT.CONFIG_ERROR);
      let opened: ReturnType<typeof exchangesFromFile>;
      try {
        opened = exchangesFromFile(resolve(file));
      } catch (e) {
        throw new CliError((e as Error).message, EXIT.CONFIG_ERROR);
      }
      const redactor = new Redactor();
      const strict = strictHarRedactor(redactor);
      const wrote: Array<{ format: string; file: string; bytes: number }> = [];
      const out = (format: string, to: string, data: Buffer | string) => {
        const bytes = Buffer.byteLength(data);
        if (!o.dryRun) writeFileSync(to, data);
        wrote.push({ format, file: to, bytes });
      };
      if (o.saz) out('saz', o.saz, await exchangesToSaz(opened.exchanges, strict));
      if (o.har) out('har', o.har, JSON.stringify(exchangesToHar(opened.exchanges, strict, ENGINE_VERSION), null, 2));
      if (o.bundle) {
        const rules = o.rules ? readRulesFile(o.rules).rules.filter((r) => r.enabled) : [];
        out('bundle', o.bundle, (await createShareBundle({ name: o.bundle.replace(/^.*[\\/]/, '').replace(/\.tpbundle$/i, ''), exchanges: opened.exchanges, rules, notes: o.notes, redactor })).bytes);
      }
      if (o.json) return printJson({ from: file, exchanges: opened.exchanges.length, masked: true, wrote, dryRun: !!o.dryRun });
      for (const w of wrote) console.log(`${green(o.dryRun ? 'Would write' : 'Wrote')} ${w.file} (${w.format}, ${w.bytes} bytes, ${opened.exchanges.length} exchanges, secrets masked)`);
    });

  program
    .command('debug-farx')
    .description("import Fiddler AutoResponder rules (.farx) into a rules file, best effort: every rule says whether it was imported, imported switched off (needs a file copied in) or skipped and why. The format is not published; nothing is exported in it")
    .argument('<file>', 'the .farx file')
    .option('--rules <file.json>', "the rules file (default: the workspace's debugger/rules.json)")
    .option('--dry-run', 'change nothing: report what would be imported')
    .option(...WORKSPACE_OPTION)
    .option(...JSON_RESULT_OPTION)
    .action(async (file: string, o: { rules?: string; workspace?: string; dryRun?: boolean; json?: boolean }) => {
      let r: ReturnType<typeof rulesFromFarx>;
      try {
        r = rulesFromFarx(readFileSync(resolve(file)));
      } catch (e) {
        throw new CliError((e as Error).message, EXIT.CONFIG_ERROR);
      }
      const target = o.rules ?? (await withWorkspace(o.workspace, (store) => store.path('debugger', 'rules.json')));
      if (!o.dryRun && r.rules.length) {
        const f = readRulesFile(target);
        f.write([...f.rules, ...r.rules]);
      }
      if (o.json) return printJson({ file: target, summary: describeFarxImport(r), partial: true, applied: !o.dryRun && r.rules.length > 0, autoResponderEnabled: r.autoResponderEnabled, items: r.items });
      console.log(`${green(o.dryRun ? 'Would import' : 'Imported')} (partial import) ${describeFarxImport(r)} -> ${target}`);
      for (const i of r.items.filter((x) => x.result !== 'imported')) console.log(`  ${i.result === 'off' ? 'off    ' : 'skipped'} ${i.match} ${dim(`${i.action}: ${i.note ?? ''}`)}`);
    });

  program
    .command('debug-diff')
    .description('compare two captures: requests added, removed, and those whose status or timing changed, matched by method and URL (the "green run vs red run" question). Exit 1 when they differ and --fail-on-diff is given')
    .argument('<before>', 'the earlier capture: a .har, .saz or .tpbundle')
    .argument('<after>', 'the later capture')
    .option('--ignore-query', 'match requests without their query string')
    .option('--include-size', 'also report a different response size')
    .option('--timing-ms <n>', 'a timing counts as changed from this many milliseconds (default 200)')
    .option('--fail-on-diff', 'exit 1 when anything was added, removed or changed')
    .option(...JSON_RESULT_OPTION)
    .action((before: string, after: string, o: { ignoreQuery?: boolean; includeSize?: boolean; timingMs?: string; failOnDiff?: boolean; json?: boolean }) => {
      let a: ReturnType<typeof exchangesFromFile>;
      let b: ReturnType<typeof exchangesFromFile>;
      try {
        a = exchangesFromFile(resolve(before));
        b = exchangesFromFile(resolve(after));
      } catch (e) {
        throw new CliError((e as Error).message, EXIT.CONFIG_ERROR);
      }
      const red = new Redactor();
      const d = diffSessions(a.exchanges, b.exchanges, { ignoreQuery: o.ignoreQuery, includeSize: o.includeSize, timingMs: o.timingMs ? Number(o.timingMs) : undefined });
      const url = (x: { url: string }) => ({ ...x, url: red.redactUrl(x.url) });
      const differs = d.added.length + d.removed.length + d.changed.length > 0;
      if (o.json) printJson({ summary: describeDiff(d), totals: d.totals, unchanged: d.unchanged, added: d.added.map(url), removed: d.removed.map(url), changed: d.changed.map(url) });
      else {
        console.log(describeDiff(d));
        for (const x of d.added) console.log(`${green('+')} ${x.method} ${red.redactUrl(x.url)} ${dim(String(x.b?.status ?? ''))}`);
        for (const x of d.removed) console.log(`- ${x.method} ${red.redactUrl(x.url)} ${dim(String(x.a?.status ?? ''))}`);
        for (const x of d.changed) console.log(`~ ${x.method} ${red.redactUrl(x.url)} ${dim(`${x.changes!.join(', ')}: ${x.a?.status ?? '-'} ${x.a?.ms ?? '-'} ms -> ${x.b?.status ?? '-'} ${x.b?.ms ?? '-'} ms`)}`);
      }
      if (o.failOnDiff && differs) process.exitCode = 1;
    });

  program
    .command('debug-open')
    .description('what a share bundle (.tpbundle) holds: who made it with which TestPion, the environment facts, its notes, the active rules, and the exchanges (use --out to write the session as a HAR)')
    .argument('<bundle>', 'the .tpbundle')
    .option('--out <file.har>', 'write the bundle\'s session as a HAR')
    .option(...JSON_RESULT_OPTION)
    .action((file: string, o: { out?: string; json?: boolean }) => {
      let opened: ReturnType<typeof exchangesFromFile>;
      try {
        opened = exchangesFromFile(resolve(file));
      } catch (e) {
        throw new CliError((e as Error).message, EXIT.CONFIG_ERROR);
      }
      if (opened.kind !== 'bundle' || !opened.bundle) throw new CliError(`${file} is not a TestPion bundle (.tpbundle)`, EXIT.CONFIG_ERROR);
      const b = opened.bundle;
      if (o.out) writeFileSync(o.out, JSON.stringify(exchangesToHar(b.exchanges, new Redactor(), ENGINE_VERSION), null, 2));
      if (o.json) return printJson({ manifest: b.manifest, environment: b.environment, notes: b.notes, rules: b.rules.map((r) => ({ id: r.id, name: r.name, kind: r.kind, enabled: r.enabled })), exchanges: b.exchanges.length, ...(o.out ? { wrote: o.out } : {}) });
      console.log(`${green(b.manifest.name)}  made ${b.manifest.createdAt} by TestPion ${b.manifest.app.version}: ${b.exchanges.length} exchanges, ${b.rules.length} rules (secrets masked)`);
      if (b.environment) console.log(dim(`${b.environment.app} on ${b.environment.platform} ${b.environment.osRelease}; ${b.environment.debugger.gateway ?? 'direct connections'}`));
      if (b.notes) console.log(`\n${b.notes}`);
    });

  addGatewayOptions(program.command('debug-gateway'))
    .description('try a corporate gateway (upstream proxy): open a tunnel (https) or ask for the head of a page (http) through it, and say what happened')
    .option('--url <url>', 'the address to reach through it', 'https://example.com/')
    .option(...JSON_RESULT_OPTION)
    .action(async (o: GatewayFlags & { url: string; json?: boolean }) => {
      const { gateway, summary } = gatewayFromFlags(o);
      if (!gateway) throw new CliError('Give a gateway: --upstream http://host:port, or --upstream-system', EXIT.CONFIG_ERROR);
      const r = await probeGateway(gateway, o.url);
      if (o.json) printJson({ gateway: summary, url: o.url, ...r });
      else console.log(`${r.ok ? green('OK') : 'FAILED'}  ${r.message} ${dim(`(${r.ms} ms)`)}`);
      if (!r.ok) process.exitCode = EXIT.EXECUTION_ERROR;
    });

  program
    .command('debug-launch')
    .description('start a program through the Debugger proxy with the variables and switches its runtime reads (HTTP_PROXY and the CA variables; JAVA_TOOL_OPTIONS for Java; --proxy-server and no HTTP/3 for a Chromium browser; a throw-away profile for Firefox; DOTNET_* for .NET). Start `debugger capture` first')
    .argument('<program>', 'the program to start')
    .argument('[args...]', 'its arguments')
    .option('--proxy <url>', 'the Debugger proxy', 'http://127.0.0.1:8899')
    .option('--ca <pem>', "the root certificate the program should trust (when `debugger capture --decrypt` is running)")
    .addOption(new Option('--kind <kind>', 'the runtime when the name does not say').choices([...LAUNCH_KINDS]))
    .option('--preview', 'only say what would be set')
    .option(...JSON_RESULT_OPTION)
    .allowUnknownOption()
    .action(async (program_: string, args: string[], o: { proxy: string; ca?: string; kind?: LaunchKind; preview?: boolean; json?: boolean }) => {
      let plan: ReturnType<typeof planLaunch>;
      try {
        plan = planLaunch({ command: program_, args, proxyUrl: o.proxy, caPath: o.ca, kind: o.kind });
      } catch (e) {
        throw new CliError((e as Error).message, EXIT.CONFIG_ERROR);
      }
      const view = { kind: plan.kind, detected: kindOf(program_), command: plan.command, args: plan.args, variables: Object.keys(plan.env), notes: plan.notes };
      if (o.preview) return o.json ? printJson({ ...view, started: false }) : console.log(`${plan.kind}: ${plan.command} ${plan.args.join(' ')}\n${Object.entries(plan.env).map(([k, v]) => `  ${k}=${v}`).join('\n')}\n${plan.notes.map((n) => dim(n)).join('\n')}`);
      let r: { pid: number };
      try {
        r = await startLaunch(plan);
      } catch (e) {
        throw new CliError((e as Error).message, EXIT.EXECUTION_ERROR);
      }
      if (o.json) return printJson({ ...view, started: true, pid: r.pid });
      console.log(`${green('Started')} ${plan.command} (pid ${r.pid}) through ${o.proxy}`);
      for (const n of plan.notes) console.log(dim(n));
    });
}
