import { ArrowRightLeft } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { call } from '../api';
import { toastError, useApp } from '../store';
import type { Collection } from '../types';
import { Badge, Button, Modal } from './ui';
import { useEnvironments } from '../lib/environments-store';
import { plural } from '../lib/format';

interface Preview {
  moved: string[];
  environments: Array<{ id: string; name: string; added: string[]; kept: string[] }>;
}

/**
 * Move collection variables into environments, so each environment can set its own value (a collection variable wins
 * over every environment). The environments get the collection's values (one that already has a variable keeps its
 * own), and the collection loses them.
 */
export function MoveVariablesDialog({ collection, initial, onClose, onDone }: { collection: Collection; initial?: string[]; onClose(): void; onDone(): void }) {
  const envs = useEnvironments();
  const [keys, setKeys] = useState<Set<string>>(new Set(initial ?? []));
  const [targets, setTargets] = useState<Set<string>>(() => new Set(envs.map((x) => x.id)));
  const [preview, setPreview] = useState<Preview>();
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  // every environment is a target once the list is there (the dialog may open before it was fetched)
  const seeded = useRef(envs.length > 0);
  useEffect(() => {
    if (seeded.current || !envs.length) return;
    seeded.current = true;
    setTargets(new Set(envs.map((x) => x.id)));
  }, [envs]);
  const opts = useMemo(() => ({ collectionId: collection.id, keys: [...keys], environments: [...targets] }), [collection.id, keys, targets]);
  useEffect(() => {
    if (!keys.size || !targets.size) return setPreview(undefined);
    void call<Preview>('vars.moveToEnvironments', { ...opts, dryRun: true }).then(setPreview, () => setPreview(undefined));
  }, [opts]);
  const vars = (collection.variables ?? []).filter((v) => !filter || v.key.toLowerCase().includes(filter.toLowerCase()));
  const toggle = (set: Set<string>, v: string, put: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    put(next);
  };
  const move = async () => {
    setBusy(true);
    try {
      await call('vars.moveToEnvironments', opts);
      useApp
        .getState()
        .toast(`${plural(keys.size, 'variable')} moved to ${plural(targets.size, 'environment')}: set their values per environment now`, 'success');
      onDone();
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Move variables to environments"
      onClose={onClose}
      width={720}
      footer={
        <Button variant="primary" icon={<ArrowRightLeft size={13} />} disabled={!keys.size || !targets.size || busy} onClick={() => void move()}>
          Move {keys.size || ''}
        </Button>
      }
    >
      <div className="grid gap-3 text-sm" data-move-variables>
        <p className="text-muted">
          A collection variable wins over every environment, so its value is the same in Development and Production. Moved to the environments, each one can set its own value. An environment that
          already has the variable keeps its value.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1 min-h-0">
            <div className="flex items-center gap-2 text-xs text-muted">
              Variables of {collection.name}
              <button className="ml-auto hover:text-fg" onClick={() => setKeys(new Set(vars.map((v) => v.key)))}>
                Select shown
              </button>
              <button className="hover:text-fg" onClick={() => setKeys(new Set())}>
                None
              </button>
            </div>
            <input className="field h-7 text-xs" placeholder="Filter" aria-label="Filter variables" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <div className="border border-line rounded-md max-h-64 overflow-auto">
              {vars.map((v) => (
                <label key={v.key} className="flex items-center gap-2 px-2 h-7 text-xs cursor-pointer hover:bg-hover">
                  <input type="checkbox" checked={keys.has(v.key)} onChange={() => toggle(keys, v.key, setKeys)} />
                  <span className="mono truncate">{v.key}</span>
                  <span className="mono text-muted truncate ml-auto max-w-[45%]">{(v as { secret?: boolean }).secret ? '••••••' : v.value}</span>
                </label>
              ))}
              {!vars.length && <p className="p-2 text-xs text-muted">No variables.</p>}
            </div>
          </div>
          <div className="grid gap-1 content-start">
            <div className="text-xs text-muted">To these environments</div>
            <div className="border border-line rounded-md">
              {envs.map((e) => (
                <label key={e.id} className="flex items-center gap-2 px-2 h-7 text-xs cursor-pointer hover:bg-hover">
                  <input type="checkbox" checked={targets.has(e.id)} onChange={() => toggle(targets, e.id, setTargets)} />
                  <span className="truncate">{e.name}</span>
                  {e.isProduction && <Badge tone="bad">prod</Badge>}
                </label>
              ))}
              {!envs.length && <p className="p-2 text-xs text-muted">No environments yet: create one in Environments first.</p>}
            </div>
            {preview && (
              <ul className="text-xs grid gap-1 mt-2" data-move-preview>
                {preview.environments.map((e) => (
                  <li key={e.id}>
                    <span className="font-medium">{e.name}</span>: {e.added.length} added
                    {e.kept.length ? `, ${e.kept.length} kept (it has them already: ${e.kept.slice(0, 3).join(', ')}${e.kept.length > 3 ? ' …' : ''})` : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
