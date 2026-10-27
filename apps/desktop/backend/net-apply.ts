/** Apply a session's proxy and certificate settings to its NetConfig (the proxy password comes from the secret store and is redacted from logs). */
import type { Backend } from './backend.js';

export function applyNetSettings(be: Backend): void {
  const p = be.settings.proxy ?? { mode: 'env' as const };
  const password = p.mode === 'custom' && p.username ? be.secrets.get('proxy.password') : undefined;
  if (password) be.logger.redactor.addSecret(password);
  try {
    be.net.setProxy({ ...p, password });
  } catch (e) {
    be.logger.warn(`Proxy settings ignored: ${(e as Error).message}`);
    be.net.setProxy({ mode: 'env' });
  }
  try {
    be.net.setTrust(be.settings.tls ?? {});
  } catch (e) {
    be.logger.warn(`Certificate settings ignored: ${(e as Error).message}`);
    be.net.setTrust({});
  }
}
