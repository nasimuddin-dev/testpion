import { asError, call, on } from '../api';
import { confirmAction, useApp } from '../store';

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
  try {
    const r = await call<PrefetchResult>('secrets.allow', { environment, refs: refs.map((x) => x.ref) });
    if (r.failed.length) useApp.getState().toast(`${r.failed[0]!.error}${r.failed.length > 1 ? ` (+${r.failed.length - 1} more)` : ''}`, 'error');
    else useApp.getState().toast(`Read ${r.fetched.length === 1 ? 'the secret' : `${r.fetched.length} secrets`} from ${tools}: send again to use ${r.fetched.length === 1 ? 'it' : 'them'}`, 'success');
  } catch (e) {
    useApp.getState().toast(asError(e).message, 'error');
  }
  return true;
}

/**
 * An environment whose variables point at a secret manager (op://, vault://, aws-sm:// …) that this workspace may not
 * read on this computer yet: say so once, with a way to allow it (the backend reads allowed ones before each request).
 */
export function watchSecretRefs(): () => void {
  return on<{ environment: string; refs: Blocked[] }>('secrets.blocked', ({ environment, refs }) => {
    const tools = [...new Set(refs.map((r) => r.label))].join(', ');
    useApp
      .getState()
      .toast(`${environment} reads ${refs.length === 1 ? 'a secret' : `${refs.length} secrets`} from ${tools}, not yet allowed on this computer`, 'warning', {
        label: 'Allow…',
        onClick: () => void allowSecretRefs(environment, refs),
      });
  });
}
