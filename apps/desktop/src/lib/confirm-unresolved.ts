import { isDataChangingMethod } from '@testpion/shared';
import { call } from '../api';
import { confirmAction, useApp } from '../store';
import { plural } from './format';
import type { HttpRequestSpec } from '../types';

/** What was already confirmed: a tab sends the same hole again without asking again (until the names change). */
const confirmed = new Map<string, string>();

/**
 * Before a POST, PUT, PATCH or DELETE goes out with a {{variable}} that has no value (a URL with `{{userId}}` left in it, a body
 * with a hole), say so and ask once, with the names. Resolves false when the person cancels. A read (GET, HEAD …) is never asked
 * about; Settings ▸ Requests turns the question off.
 */
export async function confirmUnresolvedSend(
  tabId: string,
  p: { request: HttpRequestSpec; environment?: string; collectionId?: string; requestId?: string; preRequestScript?: string },
): Promise<boolean> {
  if (useApp.getState().settings?.confirmUnresolvedSend === false) return true;
  if (!isDataChangingMethod(p.request.method)) return true;
  const found = await call<{ unresolved: string[] }>('http.unresolved', p).catch(() => undefined);
  const names = found?.unresolved ?? [];
  if (!names.length) return true;
  const key = names.join('|');
  if (confirmed.get(tabId) === key) return true;
  const ok = await confirmAction({
    title: `Send with ${plural(names.length, 'variable')} that ${names.length === 1 ? 'has' : 'have'} no value?`,
    message: `${p.request.method} ${p.request.url.length > 80 ? p.request.url.slice(0, 80) + '…' : p.request.url} would be sent with ${names.map((n) => `{{${n}}}`).join(', ')} left as typed. This request changes data.`,
    detail: 'Give the variables a value in the environment, or continue to send it as it is.',
    confirmLabel: 'Send anyway',
    cancelLabel: 'Cancel',
    tone: 'warning',
  });
  if (ok) confirmed.set(tabId, key);
  return ok;
}
