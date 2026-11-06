import { call } from '../../api';
import { plural } from '../../lib/format';
import { attempt } from '../../store';
import type { RulesState } from '../DebuggerRules';
import { Button, Callout } from '../ui';

/**
 * The rules file is shared through git: rules that change traffic (reply, redirect, remap, modify, fault, script…) that
 * came from elsewhere do not act on this computer until allowed. One notice, in the Rules tab and in each rule panel.
 */
export function RulesApproval({ state, onChange }: { state?: RulesState; onChange(s: RulesState): void }) {
  if (!state?.needsApproval) return null;
  return (
    <Callout
      tone="warn"
      data-rules-need-approval=""
      action={
        <Button size="sm" onClick={() => void attempt(async () => onChange(await call<RulesState>('debug.approveRules')))}>
          Allow on this computer
        </Button>
      }
    >
      {state.waiting ? `${plural(state.waiting, 'rule')} that change${state.waiting === 1 ? 's' : ''} traffic` : 'Rules that change traffic'} came with a pull or a clone, or were changed outside this
      app: they do not act on this computer until you allow them. Check where they send and what they change first. Filters and highlights work without it.
    </Callout>
  );
}
