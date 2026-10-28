/**
 * The Debugger's "Capture all traffic" and "See inside HTTPS" flows, apart from the window so they can be tested with
 * stand-ins for the RPC and the dialogs. `readHttps` is the ONE place that turns HTTPS decryption on: the button, the
 * HTTPS menu and the banner all call it, so the question about the certificate is the same everywhere.
 */

/** The answer of `debug.certificate`: `trusted` is undefined and `known` false when this computer cannot tell. */
export interface CertificateAnswer {
  trusted?: boolean;
  known?: boolean;
  instructions?: string;
  path?: string;
}

export type HttpsPlan = 'decrypt' | 'manual' | 'ask';

/** Trusted: just decrypt. Cannot tell (Linux, a failed check): show the manual steps once, never install. Not trusted: ask. */
export function httpsPlan(info: CertificateAnswer): HttpsPlan {
  if (info.trusted === true) return 'decrypt';
  if (info.known === false || info.trusted === undefined) return 'manual';
  return 'ask';
}

export interface FlowDeps<S> {
  call<T>(method: string, params?: unknown): Promise<T>;
  confirm(o: { title: string; message: string; detail?: string; confirmLabel: string; cancelLabel: string }): Promise<boolean>;
  toast(message: string): void;
  fail(error: unknown): void;
  setStatus(s: S): void;
  platform?: string;
}

export const HTTPS_KEEP_TUNNELS = 'Keep HTTPS as tunnels';

export function createCaptureFlow<S>(d: FlowDeps<S>) {
  // once per window session: the manual steps are shown the first time and not again
  let manualShown = false;

  /** Switch the system proxy; false when it could not be done (then nothing else should follow). */
  async function systemProxy(on: boolean): Promise<boolean> {
    try {
      d.setStatus(await d.call<S>('debug.systemProxy', { on }));
      const dotted = on && d.platform && d.platform !== 'win32' ? ' A site on localhost: open it as localhost. (with a dot).' : '';
      d.toast(on ? `System proxy set: programs that honour it send through TestPion.${dotted}` : 'System proxy restored');
      return true;
    } catch (e) {
      d.fail(e);
      return false;
    }
  }

  /** See inside HTTPS: make sure this computer trusts the TestPion certificate (asked once), then turn decryption on. */
  async function readHttps(): Promise<boolean> {
    try {
      const info = await d.call<CertificateAnswer>('debug.certificate');
      const plan = httpsPlan(info);
      if (plan === 'ask') {
        const ok = await d.confirm({
          title: 'See inside HTTPS?',
          message: 'To show the requests inside HTTPS (your API calls), TestPion’s certificate has to be trusted on this computer.',
          detail: 'Your operating system asks you to confirm. Without it, HTTPS shows only as tunnels, by host. Close and reopen your browser afterwards.',
          confirmLabel: 'Install and decrypt',
          cancelLabel: HTTPS_KEEP_TUNNELS,
        });
        if (!ok) return false;
        await d.call('debug.certificate', { action: 'install' });
        d.toast('Certificate installed: close and reopen your browser so it trusts it');
      } else if (plan === 'manual' && !manualShown) {
        manualShown = true;
        const ok = await d.confirm({
          title: 'See inside HTTPS?',
          message: 'TestPion cannot tell whether this computer trusts its certificate, so it will not install it for you.',
          detail: `${info.instructions ?? 'Trust the TestPion root certificate in your system or browser (HTTPS ▸ Root certificate… shows the steps).'}\n\nDecryption works for programs that trust it. Close and reopen your browser afterwards.`,
          confirmLabel: 'Turn on decryption',
          cancelLabel: HTTPS_KEEP_TUNNELS,
        });
        if (!ok) return false;
      }
      d.setStatus(await d.call<S>('debug.decrypt', { on: true }));
      return true;
    } catch (e) {
      d.fail(e);
      return false;
    }
  }

  /** The one click: the proxy, the system proxy, then HTTPS. A system proxy that fails stops here (nothing is captured, so no certificate is asked for). */
  async function captureAll(): Promise<boolean> {
    if (!(await systemProxy(true))) return false;
    await readHttps();
    return true;
  }

  return { systemProxy, readHttps, captureAll };
}
