import type { AppSettings } from '../model/types.js';
import type { SecretStore } from '../storage/secrets.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import type { Tool } from './tool.js';

/** MCP tools of test-set generation (`rag_generate_testset`). */
export function ragTestsetTools(_d: { store: WorkspaceStore; secrets: SecretStore; settings: AppSettings; checkEnvironment(name: unknown): string | undefined }): Tool[] {
  return [];
}
