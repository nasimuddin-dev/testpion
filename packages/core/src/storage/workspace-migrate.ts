import { SCHEMA_VERSION } from '../model/types.js';
import { ApsError } from '../errors.js';

/* ------------------------------------------------------------------ migrations */

export interface Migration {
  from: string;
  to: string;
  description: string;
  migrate(ws: Record<string, unknown>, root: string): Record<string, unknown>;
}

/**
 * Ordered workspace-format migrations. Each step upgrades exactly one version; `migrateWorkspace`
 * chains them. Never silently break existing workspaces: unknown future versions are rejected.
 */
const MIGRATIONS: Migration[] = [
  {
    from: '0.9',
    to: '1.0',
    description: 'Pre-release format: `variables` was an object map; convert to a key/value list.',
    migrate(ws) {
      const vars = ws.variables;
      if (vars && !Array.isArray(vars) && typeof vars === 'object')
        ws.variables = Object.entries(vars as Record<string, unknown>).map(([key, value]) => ({ key, value: String(value), enabled: true }));
      ws.schemaVersion = '1.0';
      return ws;
    },
  },
];

function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export function migrateWorkspace(ws: Record<string, unknown>, root = '', migrations = MIGRATIONS, target = SCHEMA_VERSION): { ws: Record<string, unknown>; applied: string[] } {
  let version = String(ws.schemaVersion ?? '0.9');
  const applied: string[] = [];
  if (cmpVersion(version, target) > 0)
    throw new ApsError('ConfigurationError', `Workspace format ${version} is newer than this version of TestPion supports (${target})`, {
      suggestions: ['Upgrade TestPion to open this workspace.'],
    });
  while (cmpVersion(version, target) < 0) {
    const m = migrations.find((x) => x.from === version);
    if (!m) throw new ApsError('ConfigurationError', `No migration path from workspace format ${version} to ${target}`);
    ws = m.migrate(ws, root);
    applied.push(`${m.from} → ${m.to}`);
    version = m.to;
  }
  return { ws, applied };
}
