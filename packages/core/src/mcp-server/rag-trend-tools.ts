import type { AppSettings } from '../model/types.js';
import type { SecretStore } from '../storage/secrets.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import type { Tool } from './tool.js';

/** MCP tool of the metric trend across the runs of an evaluation (`rag_trend`). */
export function ragTrendTools(_d: { store: WorkspaceStore; secrets: SecretStore; settings: AppSettings; checkEnvironment(name: unknown): string | undefined }): Tool[] {
  return [];
}
