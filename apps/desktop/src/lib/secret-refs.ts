import { call, on } from '../api';
import { confirmAction, useApp, attempt } from '../store';

interface Blocked {
  ref: string;
  label: string;
  commandLine: string;
}
interface PrefetchResult {
  fetched: string[];
  blocked: Blocked[];
  failed: Array<{ ref: string; error: string }>;
}

/** Allow an environment's secret manager references on this computer, after showing the exact commands, and read them. */
export async function allowSecretRefs(environment: string, refs: Blocked[]): Promise<boolean> {
  const tools = [...new Set(refs.map((r) => r.label))].join(', ');
  const ok = await confirmAction({
    title: `Read secrets from ${tools}?`,
    message: `${environment} keeps ${refs.length === 1 ? 'a secret' : `${refs.length} secrets`} in ${tools}. Reading ${refs.length === 1 ? 'it runs this command' : 'them runs these commands'} on this computer, signed in as you:`,
    detail: refs.map((r) => r.commandLine).join('\n'),
    confirmLabel: 'Allow on this computer',
  });
  if (!ok) return false;
  await attempt(async () => {
    const r = await call<PrefetchResult>('secrets.allow', { environment, refs: refs.map((x) => x.ref) });
    if (r.failed.length) useApp.getState().toast(`${r.failed[0]!.error}${r.failed.length > 1 ? ` (+${r.failed.length - 1} more)` : ''}`, 'error');
    else useApp.getState().toast(`Read ${r.fetched.length === 1 ? 'the secret' : `${r.fetched.length} secrets`} from ${tools}: send again to use ${r.fetched.length === 1 ? 'it' : 'them'}`, 'success');
  });
  return true;
}

/**
 * An environment whose variables point at a secret manager (op://, vault://, aws-sm:// …) that this workspace may not
 * read on this computer yet: say so once, with a way to allow it (the backend reads allowed ones before each request).
 */
export function watchSecretRefs(): () => void {
  const offScripts = watchScriptBlocks();
  const offRefs = on<{ environment: string; refs: Blocked[] }>('secrets.blocked', ({ environment, refs }) => {
    const tools = [...new Set(refs.map((r) => r.label))].join(', ');
    useApp
      .getState()
      .toast(`${environment} reads ${refs.length === 1 ? 'a secret' : `${refs.length} secrets`} from ${tools}, not yet allowed on this computer`, 'warning', {
        label: 'Allow…',
        onClick: () => void allowSecretRefs(environment, refs),
      });
  });
  return () => {
    offScripts();
    offRefs();
  };
}

/** A script of the workspace was refused something it needs (a host to send to, a secret to read): say so, with a way to allow it. */
async function allowScript(b: { kind: 'host'; host: string } | { kind: 'secrets'; keys: string[] }): Promise<void> {
  const ok =
    b.kind === 'host'
      ? await confirmAction({
          title: `Let scripts send requests to ${b.host}?`,
          message: `A script in this workspace tried to send a request to ${b.host}. Scripts can send any variable they can read, including secrets, to the host they choose. Allow it only if you know where this workspace comes from.`,
          confirmLabel: 'Allow this host',
        })
      : await confirmAction({
          title: 'Let scripts read secrets?',
          message: `Scripts in this workspace read secret variables (${b.keys.slice(0, 5).join(', ')}${b.keys.length > 5 ? ', …' : ''}). Until you allow it, scripts do not see the values; requests still use them. Allow it only if you know where this workspace comes from.`,
          confirmLabel: 'Allow on this computer',
        });
  if (!ok) return;
  await attempt(async () => {
    await call('scripts.allow', b.kind === 'host' ? { host: b.host } : { secrets: true });
    useApp.getState().toast('Allowed: send again', 'success');
  });
}

function watchScriptBlocks(): () => void {
  return on<{ kind: 'host'; host: string } | { kind: 'secrets'; keys: string[] }>('scripts.blocked', (b) => {
    useApp.getState().toast(b.kind === 'host' ? `A script tried to send a request to ${b.host}, not yet allowed in this workspace` : 'A script read secret variables, not yet allowed in this workspace', 'warning', {
      label: 'Allow…',
      onClick: () => void allowScript(b),
    });
  });
}
