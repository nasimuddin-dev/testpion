import { useEffect, useState } from 'react';
import { HardDrive, Trash2 } from 'lucide-react';
import { call } from '../api';
import { confirmAction, toastError, useApp } from '../store';
import { formatBytes, plural, timeAgo } from '../lib/format';
import { BarRow, ChartCard, StatTile } from './charts';
import { Button, Input } from './ui';

interface StorageUsage {
  parts: Array<{ name: string; label: string; bytes: number; files: number }>;
  totalBytes: number;
  runs: number;
  history: number;
  traces: number;
  oldestRun?: string;
}

/** What the open workspace keeps on disk besides its definitions, and clean-up actions. */
export function StoragePanel() {
  const [u, setU] = useState<StorageUsage>();
  const [days, setDays] = useState('30');
  const load = () => void call<StorageUsage>('storage.usage').then(setU, (e) => toastError(e));
  useEffect(load, []);
  if (!u) return <p className="text-sm text-muted">Measuring…</p>;
  const max = Math.max(1, ...u.parts.map((p) => p.bytes));
  const deleteOld = async () => {
    const n = Math.max(1, Number(days) || 30);
    if (!(await confirmAction({ title: 'Delete older runs', message: `Delete runs that started more than ${plural(n, 'day')} ago?`, detail: 'Their results and reports are removed; baselines and monitor history stay.', confirmLabel: 'Delete runs', danger: true }))) return;
    try {
      const r = await call<{ deleted: number; bytes: number }>('storage.deleteRunsBefore', { days: n });
      useApp.getState().toast(r.deleted ? `Deleted ${plural(r.deleted, 'run')} (${formatBytes(r.bytes)})` : 'No runs that old', 'success');
      load();
    } catch (e) {
      toastError(e);
    }
  };
  const clearHistory = async () => {
    if (!(await confirmAction({ title: 'Clear history', message: 'Delete the whole request history of this workspace?', detail: 'Saved response bodies go too. Collections, tests and runs are kept.', confirmLabel: 'Clear history', danger: true }))) return;
    await call('history.clear');
    useApp.getState().toast('History cleared', 'success');
    load();
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile label="Kept data" value={formatBytes(u.totalBytes)} sub="runs, traces, history" />
        <StatTile label="Runs" value={String(u.runs)} sub={u.oldestRun ? `oldest ${timeAgo(u.oldestRun)}` : 'none yet'} />
        <StatTile label="History" value={String(u.history)} sub="sent from the app" />
        <StatTile label="Traces" value={String(u.traces)} sub="one per execution" />
      </div>
      <ChartCard title="Disk use" aside="the open workspace">
        <div className="flex flex-col gap-1.5">
          {u.parts.map((p) => (
            <BarRow key={p.name} label={p.label} labelClass="w-48" segments={[{ value: p.bytes, color: 'var(--accent)' }]} of={max} right={formatBytes(p.bytes)} title={`${p.label}: ${formatBytes(p.bytes)} in ${plural(p.files, 'file')}`} />
          ))}
        </div>
      </ChartCard>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex items-center gap-2 text-sm">
          <HardDrive size={14} className="text-muted" />
          Delete runs older than
          <Input className="w-20 h-8" type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} aria-label="Days" />
          days
          <Button icon={<Trash2 size={13} />} onClick={() => void deleteOld()}>
            Delete
          </Button>
        </div>
        <Button variant="ghost" className="text-bad" icon={<Trash2 size={13} />} onClick={() => void clearHistory()}>
          Clear history
        </Button>
      </div>
      <p className="text-xs text-muted">
        History keeps the latest 20,000 responses and traces the latest 50,000; older ones are pruned automatically. Runs are kept until you delete them. AI agents and scripts: <span className="mono">testpion storage</span>.
      </p>
    </div>
  );
}
