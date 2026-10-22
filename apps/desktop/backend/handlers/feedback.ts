/** RPC handlers: feedback and problem reports (Help ▸ Send feedback), and errors of the window kept in the app log. */
import { arch, release } from 'node:os';
import { writeFileSync } from 'node:fs';
import { collectDiagnostics, composeFeedback, diagnosticsZip, ENGINE_VERSION, FEEDBACK_KINDS, maskReportText, workspaceStorageAsync, type FeedbackInput } from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';

export function feedbackHandlers(be: Backend): Handlers {
  /** Versions and platform: no workspace names, paths or data. */
  const diagnostics = (client: { appVersion?: string; screen?: string; theme?: string } = {}) => [
    `TestPion ${client.appVersion ?? ENGINE_VERSION} (engine ${ENGINE_VERSION})`,
    `${process.platform} ${release()} ${arch()}${process.versions.electron ? ` · Electron ${process.versions.electron}` : ''} · Node ${process.versions.node}`,
    `Secret storage: ${be.secrets.kind} · Metadata store: ${be.store?.meta.backend ?? '-'}`,
    ...(client.screen ? [`Window: ${client.screen}${client.theme ? ` · theme ${client.theme}` : ''}`] : []),
  ];
  /** The app's latest errors (the Logs panel), masked. */
  const recentErrors = (limit = 10) =>
    be.logBuffer
      .filter((r) => r.level === 'ERROR')
      .slice(-limit)
      .map((r) => maskReportText(`${r.time.slice(11, 19)} [${r.scope}] ${r.message}${r.data && typeof r.data === 'object' && 'stack' in r.data ? `\n${String((r.data as { stack?: unknown }).stack).split('\n').slice(0, 4).join('\n')}` : ''}`));
  /** The diagnostics: versions, settings without secrets, the last 500 log records, the workspace's shape, the slowest calls (all masked). */
  const gather = async () => {
    let workspace: Record<string, unknown> | undefined;
    try {
      if (be.store) {
        const u = await workspaceStorageAsync(be.ws);
        workspace = { collections: be.ws.listCollections().length, environments: be.ws.listEnvironments().length, runs: u.runs, historyEntries: u.history, traces: u.traces, megabytes: Math.round(u.totalBytes / 1048576) };
      }
    } catch {
      /* a workspace that cannot be measured is itself in the problems */
    }
    return collectDiagnostics({
      electron: process.versions.electron,
      settings: be.settings,
      appDir: be.host.appDir,
      workspace,
      slowRpcs: be.slowRpcs,
      problems: be.problems,
      secretBackend: be.secrets.kind,
      metaBackend: be.store?.meta.backend,
    });
  };
  return {
    /** What the dialog may include, for the user to see before they send anything. */
    'feedback.context': (client: { appVersion?: string; screen?: string; theme?: string } = {}) => ({ kinds: FEEDBACK_KINDS, diagnostics: diagnostics(client), errors: recentErrors() }),
    /** The report (Markdown) and a link to a pre-filled GitHub issue; nothing is sent. */
    'feedback.compose': (i: FeedbackInput) => composeFeedback(i),
    /** Save the report as a Markdown file (to attach to an email, or send later). */
    'feedback.save': ({ title, body }: { title: string; body: string }) => {
      const text = `# ${title}\n\n${body}\n`;
      const name = `testpion-feedback-${new Date().toISOString().slice(0, 10)}.md`;
      return be.saveOrDownload(name, [{ name: 'Markdown', extensions: ['md'] }], (dest) => writeFileSync(dest, text), () => Buffer.from(text));
    },
    /** The diagnostics as data (an agent, the window). */
    'diagnostics.get': () => gather(),
    /** Save the diagnostics as a zip: attach it to a bug report; nothing is sent. */
    'diagnostics.bundle': async () => {
      const d = await gather();
      const zip = diagnosticsZip(d);
      return be.saveOrDownload(`testpion-diagnostics-${new Date().toISOString().slice(0, 10)}.zip`, [{ name: 'Zip', extensions: ['zip'] }], (dest) => writeFileSync(dest, zip), () => zip, { type: 'application/zip' });
    },
    /** An unexpected error in the window (a crash of a view, an unhandled promise): kept in the app log so a report can include it. */
    'app.clientError': ({ message, stack, where }: { message: string; stack?: string; where?: string }) => {
      be.appLog('error', `${where ? `[${where}] ` : ''}${String(message).slice(0, 500)}`, stack ? { stack: String(stack).slice(0, 2000) } : undefined);
      return true;
    },
  };
}
