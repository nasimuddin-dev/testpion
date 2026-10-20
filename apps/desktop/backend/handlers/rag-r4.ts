/**
 * RPC handlers of RAG R4, each family in its own module (calibration, capture from traffic, test-set generation,
 * evaluation authoring and trends); registered once from here so backend.ts (at its size ceiling) names them once.
 */
import type { Backend, Handlers } from '../backend.js';
import { ragAuthorHandlers } from './rag-author.js';
import { ragCalibrateHandlers } from './rag-calibrate.js';
import { ragCaptureHandlers } from './rag-capture.js';
import { ragTestsetHandlers } from './rag-testset.js';

export function ragR4Handlers(be: Backend): Handlers {
  return { ...ragTestsetHandlers(be), ...ragCaptureHandlers(be), ...ragCalibrateHandlers(be), ...ragAuthorHandlers(be) };
}
