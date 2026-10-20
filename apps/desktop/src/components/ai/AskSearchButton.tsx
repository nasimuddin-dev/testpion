import { Sparkles } from 'lucide-react';
import { IconButton } from '../ui';
import { startAskSearch } from './ask-search';
import { useAiEnabled } from '../../lib/use-ai-enabled';

/**
 * The "Ask…" button of a filter bar (History, Runs, Traces): one icon button, the same in each (a text button would be
 * clipped in the narrow Traces and Runs lists); `scope` is the sources of its view. Its tooltip says what it does.
 */
export function AskSearchButton({ scope, className }: { scope: readonly string[]; className?: string }) {
  const aiOn = useAiEnabled();
  if (!aiOn) return null;
  return (
    <IconButton
      label="Ask… in your own words, e.g. “failed payment calls last week over 2 s”: the AI turns it into a search you can see and edit"
      className={className}
      data-ask-button
      onClick={() => startAskSearch({ scope: [...scope] })}
    >
      <Sparkles size={15} />
    </IconButton>
  );
}
