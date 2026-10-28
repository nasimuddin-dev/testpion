import { Filter, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { call } from '../../api';
import { toastError } from '../../store';
import { plural } from '../../lib/format';
import { Button, Empty, FilterInput, Modal } from '../ui';

interface Program {
  name: string;
  pids: number[];
  connections: number;
}

/**
 * The process picker (Fiddler's crosshair): the programs running now that hold network connections. Picking one makes it
 * "Capture only" (a rule on the Application column), so only what it sends is listed.
 */
export function ProgramPicker({ onPick, onClose }: { onPick(name: string): void; onClose(): void }) {
  const [programs, setPrograms] = useState<Program[]>();
  const [text, setText] = useState('');
  const load = useCallback(() => {
    setPrograms(undefined);
    void call<{ programs: Program[] }>('debug.programs').then((r) => setPrograms(r.programs), (e) => (toastError(e), setPrograms([])));
  }, []);
  useEffect(load, [load]);
  const shown = useMemo(() => (programs ?? []).filter((p) => p.name.toLowerCase().includes(text.trim().toLowerCase())), [programs, text]);
  return (
    <Modal title="Pick a running program" onClose={onClose} width={520} footer={<Button onClick={onClose}>Close</Button>}>
      <div className="grid gap-2" data-program-picker>
        <p className="text-xs text-muted">Programs on this computer with network connections right now. Pick one to list only its traffic (a Capture only rule on the Application column).</p>
        <div className="flex gap-2">
          <FilterInput className="flex-1" placeholder="Filter programs" label="Filter programs" value={text} onChange={setText} />
          <Button size="sm" icon={<RefreshCw size={12} />} onClick={load} title="List the running programs again">
            Refresh
          </Button>
        </div>
        {programs === undefined ? (
          <div className="text-xs text-muted py-6 text-center">Looking at the running programs…</div>
        ) : !shown.length ? (
          <Empty title={programs.length ? 'No program matches' : 'No program with connections found'} actions={[{ label: 'Refresh', onClick: load }]}>
            {programs.length ? 'Change the filter text.' : 'Start the program you want to watch, then refresh the list.'}
          </Empty>
        ) : (
          <div className="max-h-72 overflow-auto border border-line rounded-md" role="list">
            {shown.map((p) => (
              <div key={p.name} role="listitem" className="flex items-center gap-2 px-2 h-8 border-b border-line/40 last:border-b-0 hover:bg-hover text-xs" data-program={p.name}>
                <span className="flex-1 truncate font-medium">{p.name}</span>
                <span className="text-muted tabular-nums">{plural(p.connections, 'connection')}</span>
                <Button
                  size="sm"
                  icon={<Filter size={12} />}
                  onClick={() => {
                    onPick(p.name);
                    onClose();
                  }}
                  title={`List only what ${p.name} sends`}
                >
                  Capture only
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
