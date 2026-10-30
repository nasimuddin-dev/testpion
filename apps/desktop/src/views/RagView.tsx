import { useEffect, useState } from 'react';
import { useSticky } from '../lib/sticky';
import { useIntent } from '../hooks';
import { RagTabs, type RagTab } from '../components/rag/RagTabs';
import { Rag } from './ai/Rag';
import { RagStart } from './rag/RagStart';

/**
 * RAG bots (R-1): its own rail item for bots that answer from documents (RAG testing), with the work in order as
 * tabs: Start, Bots, Questions, Metrics, then Checks (the evaluations of type rag, shown by the evaluations view under the
 * same strip). Links that used to open AI quality's "RAG bots" tab land here.
 */
export function RagView() {
  // kept while the app runs, so switching views does not lose the place
  const [tab, setTab] = useSticky<Exclude<RagTab, 'checks'>>('rag:tab', 'start');
  /** A bot to open (a link to it, a search hit). */
  const [openTarget, setOpenTarget] = useState<{ id: string; at: number }>();
  /** Open the connect dialog for a new bot (the Start card, the palette). */
  const [connectAt, setConnectAt] = useState<number>();
  useIntent('rag', (p) => {
    if (p?.tab && p.tab !== 'checks') setTab(p.tab as Exclude<RagTab, 'checks'>);
    if (p?.ragTargetId) {
      setTab('bots');
      setOpenTarget({ id: String(p.ragTargetId), at: Date.now() });
    }
    if (p?.connect) {
      setTab('bots');
      setConnectAt(Date.now());
    }
  });
  // a place saved by an older version that this strip does not have
  useEffect(() => {
    if (!['start', 'bots', 'questions', 'metrics'].includes(tab)) setTab('start');
  }, [tab, setTab]);
  return (
    <div className="h-full flex flex-col" data-rag-view>
      <RagTabs active={tab} />
      <div className="flex-1 min-h-0">{tab === 'start' ? <RagStart onTab={setTab} onConnect={() => (setTab('bots'), setConnectAt(Date.now()))} /> : <Rag side={tab} openTarget={openTarget} connectAt={connectAt} />}</div>
    </div>
  );
}
