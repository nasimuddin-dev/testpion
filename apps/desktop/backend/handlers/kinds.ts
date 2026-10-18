/** RPC handlers: the item-kind registry with the facts that depend on the open workspace (REG-5). */
import { describeKinds } from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';

export function kindHandlers(be: Backend): Handlers {
  return {
    /**
     * Every kind and what it offers (the window reads the static half from @testpion/shared directly: no round trip for
     * a menu); here with the open workspace's facts: whether it is a git repository, which libraries it has.
     */
    'kinds.list': ({ kind, all }: { kind?: string; all?: boolean } = {}) => describeKinds({ kind, all }, be.ws),
  };
}
