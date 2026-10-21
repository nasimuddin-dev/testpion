/**
 * The MCP tools of RAG R4 (test-set generation, capture from traffic, calibration, evaluation authoring, the metric trend),
 * each family in its own module; this file only joins them so the server's tool list names the step once.
 */
import type { AppSettings } from '../../model/types.js';
import type { SecretStore } from '../../storage/secrets.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import type { Tool } from '../tool.js';
import { ragAuthorTools } from './rag-author-tools.js';
import { ragCalibrateTools } from './rag-calibrate-tools.js';
import { ragCaptureTools } from './rag-capture-tools.js';
import { ragReferencesTools } from './rag-references-tools.js';
import { ragTestsetTools } from './rag-testset-tools.js';
import { ragTrendTools } from './rag-trend-tools.js';

export function ragR4Tools(d: { store: WorkspaceStore; secrets: SecretStore; settings: AppSettings; checkEnvironment(name: unknown): string | undefined }): Tool[] {
  return [...ragTestsetTools(d), ...ragCaptureTools(d), ...ragReferencesTools(d), ...ragCalibrateTools(d), ...ragAuthorTools(d), ...ragTrendTools(d)];
}
