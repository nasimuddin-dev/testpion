import type { ActionDef } from '../node-menu-actions';
import { COLLECTION_ACTIONS } from './collection';
import { EXPLORER_ACTIONS } from './explorer';
import { LIST_ACTIONS } from './lists';

/** Every kind's own actions (each file one family of kinds); buildNodeMenu adds the shared groups from the capabilities. */
export const KIND_ACTIONS: readonly ActionDef[] = [...COLLECTION_ACTIONS, ...EXPLORER_ACTIONS, ...LIST_ACTIONS];
