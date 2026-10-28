/** RPC handlers: App info, settings, logs and the Postman-style console. */
import {
  ApsError,
  checkTypes,
  ENGINE_VERSION,
  type AppSettings,
  defaultSettings,
  normalizeUiPrefs,
  getProxySettings,
  describeCertificates,
  clearTokenCache,
  fetchOAuth2Token,
  type AuthConfig,
  FEEDBACK_EMAIL,
  samePath,
  exportSettings,
  importSettings,
  securityChangesOf,
  describeSecurityChanges,
  settingsDefaults,
} from '@testpion/core';
import { RPC_VERSION } from '@testpion/shared';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Backend, Handlers } from '../backend.js';

export function appHandlers(be: Backend): Handlers {
  return {
    'app.info': () => ({
      version: ENGINE_VERSION,
      /** The version of the RPC contract (parameters and answers of the methods): a window checks it when it connects. */
      rpcVersion: RPC_VERSION,
      /** Native open/save dialogs (desktop). Without them (browser bridge, cloud) the UI uploads and downloads. */
      nativeDialogs: !!be.host.saveDialog && !!be.host.openDialog,
      platform: process.platform,
      appDir: be.host.appDir,
      secretBackend: be.secrets.kind,
      metaBackend: be.store?.meta.backend,
      checkTypes: checkTypes(),
      node: process.versions.node,
      electron: process.versions.electron,
      /** What this host can do beyond the shared RPCs: `shell` (real shells in the Terminal panel) only in the desktop app. */
      capabilities: { shell: be.terminals.available, localFiles: !be.host.serverMode },
    }),
    /** Stop a call in flight by the id the caller gave it (internal: the window and the bridge cancel their own calls). */
    'rpc.cancel': ({ id }: { id: string }) => be.calls.cancel(id),
    'settings.get': () => be.settings,
    /** Settings ▸ About ▸ Export: the settings of the person's choice (the file `testpion settings get --json` prints), never a secret. */
    'settings.export': () => exportSettings(be.settings),
    /**
     * Settings ▸ About ▸ Import: an exported file, every value checked as `testpion settings set` checks it; says what changed and what this
     * version does not know. SECURITY settings it changes (proxy, TLS, `{{$env}}` access, redaction …) come back as `security` (old → new,
     * masked); they are applied only with `confirmSecurity: true`, which the window sends after showing them. `dryRun` changes nothing.
     */
    'settings.import': async ({ doc, dryRun, confirmSecurity }: { doc: unknown; dryRun?: boolean; confirmSecurity?: boolean }) => {
      const r = importSettings(be.settings, doc);
      const security = securityChangesOf(r.changed);
      if (dryRun) return { changed: r.changed, skipped: r.skipped, security, applied: false };
      if (security.length && confirmSecurity !== true)
        throw new ApsError('ValidationError', `This file changes security settings (${describeSecurityChanges(security)}). Nothing was imported: confirm them first.`, {
          suggestions: ['Check the proxy, TLS, environment-variable and redaction values, then import again and confirm.'],
          details: { security },
        });
      if (r.changed.length) await be.handlers['settings.save']!(r.next);
      return { changed: r.changed, skipped: r.skipped, security, applied: true };
    },
    /** Settings ▸ About ▸ Reset: the named settings (all, when none are named) back to their defaults. */
    'settings.reset': async ({ keys }: { keys?: string[] } = {}) => {
      const r = settingsDefaults(be.settings, keys?.length ? keys : 'all');
      if (r.reset.length) await be.handlers['settings.save']!(r.next);
      return { reset: r.reset };
    },
    /** Forget cached OAuth 2.0 tokens (Auth tab ▸ Forget tokens); returns how many there were. */
    'auth.clearTokens': () => clearTokenCache(),
    /** Auth tab ▸ Get token: run the OAuth 2.0 grant now and say whether it works, when the token ends and its scope (the token masked). */
    'auth.fetchToken': async ({ auth, environment, collectionId }: { auth: AuthConfig; environment?: string; collectionId?: string }) => {
      const ctx = be.context({ environment, collectionId });
      try {
        return await fetchOAuth2Token(ctx.vars.resolveDeep(auth), { redactor: ctx.redactor, openExternal: be.host.openExternal?.bind(be.host) }, { fresh: true });
      } finally {
        await ctx.dispose();
      }
    },
    'settings.save': (s: AppSettings) => {
      // refuse a malformed certificate instead of saving it and ignoring it
      if (s.tls?.extraCa) {
        try {
          describeCertificates(s.tls.extraCa);
        } catch (e) {
          throw new ApsError('ValidationError', `Extra CA certificates: ${(e as Error).message}`, { suggestions: [] });
        }
      }
      if (s.proxy?.mode === 'custom' && s.proxy.url) {
        try {
          const u = new URL(s.proxy.url);
          if (!/^https?:$/.test(u.protocol) || !u.hostname) throw new Error();
        } catch {
          throw new ApsError('ValidationError', `The proxy URL "${s.proxy.url}" is not a URL (e.g. http://proxy.example.com:8080)`, { suggestions: [] });
        }
      }
      // on a shared server `{{$env.NAME}}` would read the server's own environment (its cloud keys): the window cannot allow any
      be.settings = be.manager.saveSettings({ ...defaultSettings(), ...normalizeUiPrefs(s), telemetry: false, ...(be.host.serverMode ? { envVariables: [] } : {}) });
      be.logger.setLevel(be.settings.logLevel);
      be.logger.redactor.setFields(be.settings.redactFields);
      be.applyProxy();
      return be.settings;
    },
    /** The proxy password lives in the secret store, never in settings.json. */
    'settings.setProxyPassword': async ({ password }: { password: string }) => {
      if (password) await be.secrets.set('proxy.password', password);
      else await be.secrets.delete('proxy.password');
      be.applyProxy();
      return { saved: !!password };
    },
    /** What a PEM bundle holds (subject, issuer, expiry), to check extra CA certificates before saving them. */
    'settings.describeCertificates': ({ pem }: { pem: string }) => describeCertificates(pem),
    'settings.proxyInfo': () => {
      // proxy URLs from the environment can carry credentials: never send those to the UI
      const clean = (v?: string) => v?.replace(/\/\/[^/@]*@/, '//•••@');
      const e = process.env;
      return { ...getProxySettings(), passwordSet: !!be.secrets.get('proxy.password'), env: { HTTP_PROXY: clean(e.HTTP_PROXY ?? e.http_proxy), HTTPS_PROXY: clean(e.HTTPS_PROXY ?? e.https_proxy), NO_PROXY: e.NO_PROXY ?? e.no_proxy } };
    },
    'logs.recent': () => be.logBuffer,
    'console.recent': () => be.consoleBuffer,
    'console.clear': () => {
      be.consoleBuffer = [];
    },
    'app.openExternal': ({ url }: { url: string }) => {
      // web links, and the feedback email (mailto: to the maintainer only)
      if (!/^https?:\/\//.test(url) && !url.startsWith(`mailto:${FEEDBACK_EMAIL}?`)) throw new ApsError('ValidationError', 'Only http(s) URLs can be opened');
      return be.host.openExternal?.(url);
    },
    /** Show a workspace folder in the file manager. Only folders of known workspaces: opening a path runs it if it's a program. */
    'app.openPath': ({ path }: { path: string }) => {
      const known = [be.ws.root, ...be.manager.list().map((w) => w.path)];
      const target = resolve(String(path));
      // a known folder by any name (a link to it, its real path)
      if (!known.some((p) => samePath(p, target)) || !existsSync(target) || !statSync(target).isDirectory()) throw new ApsError('ValidationError', 'Only workspace folders can be opened');
      return be.host.openPath?.(target);
    },
  };
}
