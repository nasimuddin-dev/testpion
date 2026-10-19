import { jsonPretty, outputFileName } from '@testpion/shared';
import type { OutputSpec } from './output-core';

/** What Settings ▸ About knows of the app, for a bug report: versions, platform, storage backends, the workspace (the home folder replaced with ~). */
export interface Diagnostics {
  appVersion?: string;
  version?: string;
  electron?: string;
  node?: string;
  platform: string;
  metaBackend?: string;
  secretBackend?: string;
  workspacePath?: string;
  theme: string;
  proxy: string;
}

export function diagnosticsText(d: Diagnostics): string {
  const home = (d.workspacePath ?? '').match(/^([A-Za-z]:\\Users\\[^\\]+|\/(?:home|Users)\/[^/]+)/)?.[1];
  return [
    `TestPion ${d.appVersion ?? '?'} (engine ${d.version ?? '?'})`,
    `Electron ${d.electron ?? '-'} · Node ${d.node ?? '-'} · ${d.platform}`,
    `Metadata store: ${d.metaBackend ?? '?'} · Secret storage: ${d.secretBackend ?? '?'}`,
    `Workspace: ${home ? (d.workspacePath ?? '').replace(home, '~') : (d.workspacePath ?? '-')}`,
    `Theme: ${d.theme} · Proxy: ${d.proxy}`,
  ].join('\n');
}

/** The diagnostics as text (the lines a bug report pastes) or as JSON. */
export function diagnosticsOutputSpec(d: Diagnostics): OutputSpec {
  return {
    id: 'settings.diagnostics',
    what: 'diagnostics',
    name: outputFileName({ name: 'testpion-diagnostics', ext: '' }),
    formats: [
      { key: 'text', format: 'text', label: 'Diagnostics (text)', default: true, build: () => `${diagnosticsText(d)}\n` },
      {
        key: 'json',
        format: 'json',
        label: 'Diagnostics (JSON)',
        build: () => jsonPretty({ app: d.appVersion, engine: d.version, electron: d.electron, node: d.node, platform: d.platform, metadataStore: d.metaBackend, secretStorage: d.secretBackend, workspace: diagnosticsText(d).split('\n')[3]?.replace(/^Workspace: /, ''), theme: d.theme, proxy: d.proxy }),
      },
    ],
  };
}
