import type { BundleKindId } from './format.js';

/** One item of a bundle by kind and id (a file kind's id is its workspace path). */
export interface BundleRef {
  kind: BundleKindId;
  id: string;
}
