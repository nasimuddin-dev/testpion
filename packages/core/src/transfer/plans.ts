/**
 * Previewed bundles waiting to be applied: a host (the desktop app's backend, the MCP server) reads a bundle once,
 * shows the preview and keeps the parsed bundle under a plan id, so the apply that follows uses exactly what was shown
 * (the file is not read twice, and an agent cannot apply something it has not previewed). A plan belongs to the
 * workspace it was made for and lives 30 minutes; one preview can be applied with different choices until it is
 * forgotten.
 */
import { randomBytes } from 'node:crypto';
import { ApsError } from '../errors.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import type { ParsedBundle } from './format.js';

const TTL_MS = 30 * 60 * 1000;
const MAX_PLANS = 8;
const plans = new Map<string, { bundle: ParsedBundle; root: string; at: number }>();

export function rememberBundle(store: WorkspaceStore, bundle: ParsedBundle): string {
  const now = Date.now();
  for (const [id, p] of plans) if (now - p.at > TTL_MS) plans.delete(id);
  while (plans.size >= MAX_PLANS) plans.delete(plans.keys().next().value as string);
  const id = `plan-${randomBytes(6).toString('hex')}`;
  plans.set(id, { bundle, root: store.root, at: now });
  return id;
}

/** The bundle a plan id stands for. */
export function recallBundle(store: WorkspaceStore, planId: string): ParsedBundle {
  const p = plans.get(String(planId ?? ''));
  if (!p || Date.now() - p.at > TTL_MS || p.root !== store.root) {
    throw new ApsError('ValidationError', `No import plan "${String(planId).slice(0, 40)}" (it expired, or it is for another workspace)`, { suggestions: ['Preview the bundle again to get a new plan id'] });
  }
  return p.bundle;
}

export function forgetPlan(planId: string): void {
  plans.delete(planId);
}
