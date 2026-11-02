import { matchEnvironment } from '@testpion/shared';
import { useApp } from '../store';

/**
 * WF-06: a thin frame in the production colour around the window while the active environment is marked as production
 * (its own colour when it has one), so it is never forgotten. It takes no clicks and no space.
 */
export function ProductionFrame() {
  const color = useApp((s) => {
    const env = s.environment ? matchEnvironment(s.workspace?.environments ?? [], s.environment) : undefined;
    return env?.isProduction ? (env.color ?? 'var(--bad)') : undefined;
  });
  if (!color) return null;
  return <div aria-hidden data-testid="production-frame" className="fixed inset-0 pointer-events-none z-[60] border-2" style={{ borderColor: color }} />;
}
