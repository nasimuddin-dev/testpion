/** Types, drafts and layout constants shared by the REST view. */
import { type NormalizedError } from '../../api';
import { persisted } from '../../store';
import type { CheckConfig, CheckResult, HttpRequestSpec, HttpResponseData, SavedExample } from '../../types';
import { uid } from '../../lib/format';


export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/** A saved request as text, to tell whether it changed on disk since a tab was opened or saved. */
export function savedSnapshot(n: { name: string; request: unknown; preRequestScript?: string; testScript?: string; assertions?: unknown; description?: string }): string {
  return JSON.stringify([n.name, n.request, n.preRequestScript ?? '', n.testScript ?? '', n.assertions ?? [], n.description ?? '']);
}

export interface RestTab {
  id: string;
  name: string;
  request: HttpRequestSpec;
  preRequestScript?: string;
  testScript?: string;
  assertions: CheckConfig[];
  collectionId?: string;
  requestId?: string;
  /** Markdown documentation, saved with the request. */
  description?: string;
  /** Saved responses; persisted straight to the collection, so changing them does not make the tab dirty. */
  examples?: SavedExample[];
  dirty?: boolean;
  /**
   * The saved request this tab was opened or last saved from (a snapshot, see savedSnapshot): when the file changes on
   * disk (a pull, a branch switch, another editor), a tab without edits takes the new version and a tab with edits
   * asks whether to keep them, only if this request itself changed.
   */
  base?: string;
  /** Pinned tabs stay first and are not closed by "close others / all". */
  pinned?: boolean;
}

export interface SendResult {
  response?: HttpResponseData;
  error?: NormalizedError;
  checks?: CheckResult[];
  traceId?: string;
  scriptLogs?: string[];
  visualizer?: { html?: string; error?: string; vizId?: string };
  historyId?: string;
  unresolved?: string[];
  /** Variables that refer to each other in a loop ("a → b → a"): why some stayed unresolved. */
  cycles?: string[];
  /** `{{$env.NAME}}` the app's allow-list kept out (Settings ▸ Privacy). */
  blockedEnv?: string[];
  curl?: string;
  stream?: string;
}

export const blankRequest = (): RestTab => ({
  id: uid('tab-'),
  name: 'New HTTP request',
  request: { method: 'GET', url: '{{baseUrl}}/', params: [], headers: [], auth: { type: 'inherit' }, body: { type: 'none' } },
  assertions: [{ type: 'status', expected: 200 }],
});

export const drafts = persisted<{ tabs: RestTab[]; active?: string }>('rest', { tabs: [] });
