/**
 * RPC handlers: the Debugger's Network speed switch (FG-1). One speed for all the traffic the proxy forwards, set from the
 * capture bar, the CLI (`debug capture --throttle`) or an agent (`debugger_rules` action speed); a restart is full speed.
 */
import { ApsError, NETWORK_SPEEDS, describeNetworkSpeed, parseNetworkSpeed } from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';
import type { DebuggerState } from './debugger-state.js';

export function debuggerSpeedHandlers(be: Backend, state: DebuggerState): Handlers {
  const view = () => ({ speed: state.speed ?? null, label: describeNetworkSpeed(state.speed), presets: NETWORK_SPEEDS.map(({ preset, label, downKbps, upKbps, latencyMs }) => ({ preset, label, downKbps, upKbps, latencyMs })) });
  return {
    'debug.speed': () => view(),
    /** Set the speed: a preset id, `off`, or `custom` with downKbps / upKbps / latencyMs. */
    'debug.setSpeed': ({ preset, downKbps, upKbps, latencyMs }: { preset?: string; downKbps?: number; upKbps?: number; latencyMs?: number }) => {
      try {
        state.speed = parseNetworkSpeed({ preset, downKbps, upKbps, latencyMs });
      } catch (e) {
        throw new ApsError('ValidationError', (e as Error).message);
      }
      be.host.emit('debug.speed', { speed: state.speed ?? null });
      return view();
    },
  };
}
