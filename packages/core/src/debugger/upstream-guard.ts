import { Agent as HttpsAgent } from 'node:https';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isLocalOnlyAddress } from '../net/policy.js';

/**
 * A `lookup` for the connections made on behalf of a device on the network: the name is resolved once, by the connection
 * itself, and refused when it points at this computer (loopback, link-local). Checking first and connecting after would
 * resolve twice, and a name that answers differently the second time (DNS rebinding) would get through.
 */
export function guardedLookup(hostname: string, options: object, callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void): void {
  dnsLookup(hostname, options as never, ((err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => {
    if (err) return callback(err, address, family);
    const list = Array.isArray(address) ? address : [{ address, family: family ?? 4 }];
    if (list.some((a) => isLocalOnlyAddress(a.address))) return callback(Object.assign(new Error(`${hostname} points at this computer`), { code: 'EACCES' }) as NodeJS.ErrnoException, address, family);
    callback(null, address, family);
  }) as never);
}

/**
 * One https.Agent for the upstream requests of a trust configuration: with the CA list in every request's options (hundreds of
 * certificates) each request hashed it to find its agent. A new one is made only when the trusted CAs change. Devices on the
 * network get an agent of their own whose connections resolve through guardedLookup: a pooled socket opened for this computer's
 * own clients must not serve them.
 */
export function upstreamAgents(trustedCa: () => string[] | undefined, insecure: () => boolean) {
  const slots: Array<{ agent: HttpsAgent; ca: string[] | undefined } | undefined> = [undefined, undefined];
  const get = (remote: boolean) => {
    const slot = remote ? 1 : 0;
    const ca = trustedCa();
    let cur = slots[slot];
    if (!cur || cur.ca !== ca) {
      cur?.agent.destroy();
      cur = { agent: new HttpsAgent({ ca, rejectUnauthorized: !insecure(), keepAlive: true, ...(remote ? { lookup: guardedLookup } : {}) }), ca };
      slots[slot] = cur;
    }
    return { agent: cur.agent };
  };
  return Object.assign(get, { destroy: () => slots.forEach((c) => c?.agent.destroy()) });
}
