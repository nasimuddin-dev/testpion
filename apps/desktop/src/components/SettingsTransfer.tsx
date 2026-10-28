import { useMemo } from 'react';
import { call } from '../api';
import { pickTextFile } from '../lib/files';
import { confirmAction, toastError, useApp } from '../store';
import { plural } from '../lib/format';
import { Button } from './ui';
import { OutputActions } from './output/OutputFrame';
import type { OutputSpec } from './output/output-core';
import { outputFileName } from '@testpion/shared';

/**
 * Settings ▸ About: take the settings along (Export is the shared download control: the file `testpion settings get --json` prints), bring
 * them back (Import checks every value as `testpion settings set` does), or put them back to their defaults (`testpion settings reset`).
 * No secret is in the file: keys and passwords live in the secret store.
 */
export function SettingsTransfer({ unsaved }: { unsaved: boolean }) {
  const spec = useMemo<OutputSpec>(
    () => ({
      id: 'settings.export',
      what: 'settings',
      name: outputFileName({ name: 'testpion-settings', ext: '' }),
      formats: [{ format: 'json', label: 'Settings (JSON)', default: true, build: async () => JSON.stringify(await call('settings.export'), null, 2) + '\n' }],
    }),
    [],
  );
  const refresh = async () => useApp.getState().set({ settings: await call('settings.get') });
  const importFile = async () => {
    try {
      const file = await pickTextFile('.json,application/json');
      if (!file) return;
      let doc: unknown;
      try {
        doc = JSON.parse(file.text);
      } catch {
        return useApp.getState().toast(`${file.name} is not a settings file (it is not JSON)`, 'error');
      }
      // security settings (proxy, TLS, environment variables, redaction) are shown old -> new and confirmed before anything is applied
      const check = await call<{ security: Array<{ key: string; before: string; after: string }> }>('settings.import', { doc, dryRun: true });
      if (
        check.security.length &&
        !(await confirmAction({
          title: 'Import security settings?',
          message: 'This file changes settings that decide where requests and their secrets go, or what is hidden. Old value, then the new one:',
          detail: check.security.map((c) => `${c.key}: ${c.before} → ${c.after}`).join('\n'),
          confirmLabel: 'Import',
          danger: true,
        }))
      )
        return;
      const r = await call<{ changed: unknown[]; skipped: string[] }>('settings.import', { doc, confirmSecurity: true });
      await refresh();
      useApp
        .getState()
        .toast(
          r.changed.length
            ? `Imported ${plural(r.changed.length, 'setting')}${r.skipped.length ? `; ${plural(r.skipped.length, 'setting')} this version does not know were skipped` : ''}`
            : 'Nothing to change: these settings are already set',
          'success',
        );
    } catch (e) {
      toastError(e);
    }
  };
  const reset = async () => {
    if (
      !(await confirmAction({
        title: 'Reset the settings?',
        message: 'Every setting goes back to its default. Your workspaces, collections and secrets are not touched.',
        confirmLabel: 'Reset settings',
        danger: true,
      }))
    )
      return;
    try {
      const r = await call<{ reset: string[] }>('settings.reset', {});
      await refresh();
      useApp.getState().toast(r.reset.length ? `Reset ${plural(r.reset.length, 'setting')} to the default` : 'Everything was already at its default', 'success');
    } catch (e) {
      toastError(e);
    }
  };
  const why = unsaved ? 'Save the settings you changed first' : undefined;
  return (
    <div className="flex items-center gap-2 flex-wrap" data-settings-transfer="">
      <span className="inline-flex align-middle" data-output="settings.export" title="The settings as a JSON file, to keep or to copy to another computer. It holds no secrets.">
        <OutputActions spec={spec} />
      </span>
      <Button size="sm" onClick={() => void importFile()} disabled={unsaved} reason={why} icon={null}>
        Import settings…
      </Button>
      <Button size="sm" variant="danger" onClick={() => void reset()} disabled={unsaved} reason={why} icon={null}>
        Reset settings…
      </Button>
      <span className="text-xs text-muted">From a terminal: testpion settings get | set | reset</span>
    </div>
  );
}
