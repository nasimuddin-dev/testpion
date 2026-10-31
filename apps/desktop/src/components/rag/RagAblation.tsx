import { useState } from 'react';
import type { Ablation, AblationInfo } from '@testpion/core';
import { call } from '../../api';
import { useRpc } from '../../lib/use-rpc';
import { confirmAction, toastError } from '../../store';
import { Badge, Button, Spinner } from '../ui';

/**
 * "Which document mattered?" (R-11): asks the bot again with the documents it retrieved and without each one, and names the documents
 * whose absence changes the answer. It calls the bot (n + 1 times), so it says so first. It is only offered when the bot's request takes
 * the documents as input; otherwise the button says what to add.
 */
export function RagAblation({ runId, resultId }: { runId: string; resultId: string }) {
  const info = useRpc<AblationInfo>('rag.ablationInfo', { runId, resultId });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Ablation>();
  const ask = async () => {
    if (!info) return;
    const ok = await confirmAction({
      title: 'Ask the bot again?',
      message: `This asks your bot ${info.calls} times: once with every document it retrieved, and once without each of ${info.documents}.${info.skipped ? ` ${info.skipped} more documents are left out.` : ''} Only the question and the documents of this sample are sent to it. No AI reviewer is used.`,
      confirmLabel: `Ask ${info.calls} times`,
    });
    if (!ok) return;
    setBusy(true);
    try {
      setResult(await call<Ablation>('rag.ablate', { runId, resultId }));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  if (!info) return null;
  return (
    <div className="mt-1 text-xs" data-rag-ablation>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void ask()} disabled={!info.possible || busy} reason={info.reason} title="Ask the bot again without each retrieved document, to see which ones the answer depends on" data-rag-ablate>
          Which document mattered?
        </Button>
        {busy && <Spinner />}
      </div>
      {result && (
        <div className="mt-1 grid gap-1" data-rag-ablation-result>
          <p>{result.text}</p>
          <ul className="grid gap-0.5">
            {result.documents.map((d) => (
              <li key={d.id} className="flex items-center gap-2" data-rag-ablation-doc={d.id} data-load-bearing={d.loadBearing ? 'true' : 'false'}>
                <Badge tone={d.loadBearing ? 'warn' : 'default'}>{d.loadBearing ? 'load-bearing' : 'no change'}</Badge>
                <span className="mono">{d.id}</span>
                <span className="text-muted">{Math.round(d.alike * 100)}% alike without it</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
