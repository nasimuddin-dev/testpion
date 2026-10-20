import type { AppSettings } from '../model/types.js';
import type { SecretStore } from '../storage/secrets.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import type { Tool } from './tool.js';

/** MCP tools of the capture of a dataset from traffic (`rag_capture_dataset`). */
export function ragCaptureTools(_d: { store: WorkspaceStore; secrets: SecretStore; settings: AppSettings; checkEnvironment(name: unknown): string | undefined }): Tool[] {
  return [];
}
