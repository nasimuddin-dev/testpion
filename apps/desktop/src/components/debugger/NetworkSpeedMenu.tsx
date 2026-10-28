import { Check, Gauge, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { call, on } from '../../api';
import { toastError, useApp } from '../../store';
import { Button, Field, Input, Menu, Modal, type MenuItem } from '../ui';

/** One network speed, as the engine keeps it (kilobits per second, down and up, and the latency added to every request). */
export interface NetworkSpeed {
  preset: string;
  downKbps: number;
  upKbps: number;
  latencyMs: number;
}
interface SpeedState {
  speed: NetworkSpeed | null;
  label: string;
  presets: Array<NetworkSpeed & { label: string }>;
}

/** The short name of a speed for the button: "3G", "Custom". */
export const speedName = (s: NetworkSpeed | null | undefined, presets: SpeedState['presets'] = []) => (!s ? 'Off' : s.preset === 'custom' ? 'Custom' : (presets.find((p) => p.preset === s.preset)?.label.replace(/ \(.*\)$/, '') ?? s.preset));

/**
 * The Network speed switch of the capture bar (FG-1): one speed for all the traffic the proxy forwards, Off by default. Pick a
 * ready-made speed or write your own; it paces the requests and responses and adds the latency, until it is set back to Off.
 */
export function NetworkSpeedMenu() {
  const [state, setState] = useState<SpeedState>();
  const [custom, setCustom] = useState<{ down: string; up: string; latency: string } | null>(null);
  const load = useCallback(() => void call<SpeedState>('debug.speed').then(setState, () => undefined), []);
  useEffect(() => {
    load();
    return on('debug.speed', load);
  }, [load]);
  const set = (params: Record<string, unknown>) =>
    call<SpeedState>('debug.setSpeed', params).then((s) => {
      setState(s);
      useApp.getState().toast(s.speed ? `Network speed: ${s.label}` : 'Network speed is off: full speed', 'success');
    }, toastError);
  const current = state?.speed;
  const items: MenuItem[] = [
    { label: `${current ? '  ' : '✓ '}Off (full speed)`, title: 'Let traffic through as fast as it goes', onSelect: () => void set({ preset: 'off' }) },
    ...(state?.presets ?? []).map<MenuItem>((p) => ({
      label: `${current?.preset === p.preset ? '✓ ' : '  '}${p.label}`,
      title: `${p.downKbps} kbit/s down, ${p.upKbps} kbit/s up, ${p.latencyMs} ms added to every request`,
      onSelect: () => void set({ preset: p.preset }),
    })),
    {
      label: `${current?.preset === 'custom' ? '✓ ' : '  '}Custom…`,
      separator: true,
      title: 'Choose the download and upload speed and the latency yourself',
      onSelect: () => setCustom({ down: String(current?.downKbps ?? 1000), up: String(current?.upKbps ?? 1000), latency: String(current?.latencyMs ?? 100) }),
    },
  ];
  const save = async () => {
    if (!custom) return;
    await set({ preset: 'custom', downKbps: Number(custom.down), upKbps: Number(custom.up), latencyMs: Number(custom.latency) || 0 });
    setCustom(null);
  };
  return (
    <>
      <Menu
        width={260}
        items={items}
        trigger={
          <Button size="sm" variant={current ? 'soft' : 'default'} icon={<Gauge size={13} />} title="Slow the traffic the proxy forwards to a phone or modem speed, to see how a program copes" data-network-speed>
            Network speed: {speedName(current, state?.presets)}
          </Button>
        }
      />
      {custom && (
        <Modal
          title="Custom network speed"
          onClose={() => setCustom(null)}
          onSubmit={() => void save()}
          width={420}
          footer={
            <>
              <Button icon={<X size={13} />} onClick={() => setCustom(null)}>
                Cancel
              </Button>
              <Button variant="primary" icon={<Check size={13} />} onClick={() => void save()}>
                Use this speed
              </Button>
            </>
          }
        >
          <div className="grid gap-3">
            <p className="text-xs text-muted">Kilobits per second: 1000 is 1 Mbit/s. The latency is added once to every request. Only traffic the proxy forwards as HTTP is slowed; an HTTPS tunnel that is not decrypted and WebSocket frames pass at full speed.</p>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Download (kbit/s)">
                <Input type="number" value={custom.down} onChange={(e) => setCustom({ ...custom, down: e.target.value })} data-speed-down />
              </Field>
              <Field label="Upload (kbit/s)">
                <Input type="number" value={custom.up} onChange={(e) => setCustom({ ...custom, up: e.target.value })} />
              </Field>
              <Field label="Latency (ms)">
                <Input type="number" value={custom.latency} onChange={(e) => setCustom({ ...custom, latency: e.target.value })} />
              </Field>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
