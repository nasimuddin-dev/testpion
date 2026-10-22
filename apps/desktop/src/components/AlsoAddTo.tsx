import { useState } from 'react';
import { CopyPlus } from 'lucide-react';
import { call } from '../api';
import { selectEnvironments, toastError, useApp } from '../store';
import { plural } from '../lib/format';
import { Badge, Button, cx, Modal } from './ui';

/** Where a new variable also goes, and with what: the other environments' names, and whether they get the same value. */
export interface AlsoAdd {
  to: string[];
  copy: boolean;
}

/** The other readable environments (by name), the active one left out. */
function useOtherEnvironments(exclude?: string) {
  return useApp(selectEnvironments).filter((e) => !e.problem && e.name !== exclude);
}

/**
 * WF-14 "Also add to the other environments", one control wherever a variable is added to an environment: its variable
 * popover, the Environments view (new variables of a saved environment). Ticks per environment (production marked) and
 * "Copy the value" (else empty, to fill in per environment). Nothing ticked: nothing else changes.
 */
export function AlsoAddTo({ exclude, value, onChange, className }: { exclude?: string; value: AlsoAdd; onChange(v: AlsoAdd): void; className?: string }) {
  const others = useOtherEnvironments(exclude);
  if (!others.length) return null;
  const toggle = (name: string) => onChange({ ...value, to: value.to.includes(name) ? value.to.filter((x) => x !== name) : [...value.to, name] });
  return (
    <div className={cx('grid gap-1 text-xs', className)} data-also-add>
      <div className="text-muted">Also add to</div>
      <div className="flex flex-wrap gap-1">
        {others.map((e) => (
          <label
            key={e.id}
            className={cx('inline-flex items-center gap-1 h-6 px-1.5 rounded-md border cursor-pointer', value.to.includes(e.name) ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover')}
          >
            <input type="checkbox" className="sr-only" checked={value.to.includes(e.name)} onChange={() => toggle(e.name)} />
            <span className="truncate max-w-32">{e.name}</span>
            {e.isProduction && <Badge tone="bad">prod</Badge>}
          </label>
        ))}
      </div>
      {value.to.length > 0 && (
        <label className="inline-flex items-center gap-1.5 text-muted cursor-pointer">
          <input type="checkbox" checked={value.copy} onChange={(e) => onChange({ ...value, copy: e.target.checked })} />
          Copy the value (else empty, to fill in there)
        </label>
      )}
    </div>
  );
}

/** Variables just added to one environment, offered to the others where they are missing (the Environments view). */
export function AlsoAddDialog({ from, keys, onClose }: { from: string; keys: string[]; onClose(): void }) {
  const fromName = useApp((s) => s.workspace?.environments.find((e) => e.id === from || e.name === from)?.name) ?? from;
  const [v, setV] = useState<AlsoAdd>({ to: [], copy: false });
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      const r = await call<Array<{ environment: string; added: string[] }>>('vars.addToEnvironments', { from, keys, to: v.to, copy: v.copy });
      const n = r.filter((x) => x.added.length).length;
      useApp.getState().toast(
        n
          ? `Added to ${plural(n, 'environment')}: ${r
              .filter((x) => x.added.length)
              .map((x) => x.environment)
              .join(', ')}`
          : 'They have them already',
        'success',
      );
      await useApp.getState().refreshWorkspace();
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`New in ${fromName}: ${keys.length === 1 ? keys[0] : plural(keys.length, 'variable')}`}
      onClose={onClose}
      onSubmit={() => void add()}
      width={460}
      footer={
        <>
          <Button onClick={onClose}>Not now</Button>
          <Button variant="primary" icon={<CopyPlus size={13} />} loading={busy} disabled={!v.to.length} reason="Tick at least one place to add it to" onClick={() => void add()}>
            Add
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted mb-2">
        The other environments don't have {keys.length === 1 ? 'it' : 'them'} yet: add {keys.length === 1 ? 'it' : 'them'} there too, so requests resolve in every environment.
      </p>
      <AlsoAddTo exclude={fromName} value={v} onChange={setV} />
    </Modal>
  );
}
