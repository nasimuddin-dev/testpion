import { Database, FlaskConical, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { call } from '../../api';
import { useApp } from '../../store';
import { useLibrary } from '../../lib/library';
import type { RagTarget } from '@testpion/shared';
import type { RagTargetInfo } from '@testpion/core';
import { FolderList } from '../../components/FolderList';
import { RagConnectDialog } from '../../components/rag/RagConnectDialog';
import { CustomMetricsList, MetricEditor } from '../../components/rag/CustomMetrics';
import { RagDataIntro, RagDatasetsList } from '../../components/rag/RagDataPanel';
import { ProbeSets } from '../../components/rag/ProbeSets';
import { Badge, Button, Empty } from '../../components/ui';

/**
 * The Bots, Questions and Metrics tabs of Bots with sources (R-1): the bots under test (a request of any protocol and the
 * mapping of its response), the datasets of questions, and your own metrics. Connect a bot, open or change one, and go to
 * Checks to run questions through it. Evaluations of type rag pick a bot here.
 */
export function Rag({ side, openTarget, connectAt }: { side: 'bots' | 'questions' | 'metrics'; openTarget?: { id: string; at: number }; /** Open the connect dialog for a new bot (changes with every request). */ connectAt?: number }) {
  const targets = useLibrary<RagTarget>('rag-targets');
  const [dialog, setDialog] = useState<{ id?: string }>();
  const [selected, setSelected] = useState<string>();
  const [metric, setMetric] = useState<{ id?: string }>();
  const [info, setInfo] = useState<RagTargetInfo[]>([]);
  useEffect(() => {
    void call<RagTargetInfo[]>('rag.targets').then(setInfo, () => setInfo([]));
  }, [targets.lib]);
  // a link to a bot (a ref, a search hit) opens it
  useEffect(() => {
    if (openTarget) setDialog({ id: openTarget.id });
  }, [openTarget]);
  useEffect(() => {
    if (connectAt) setDialog({});
  }, [connectAt]);
  const items = useMemo(
    () =>
      targets.lib.items.map((i) => {
        const p = info.find((x) => x.id === i.id);
        return {
          id: i.id,
          name: i.name,
          folder: i.folder,
          icon: <Database size={12} className="text-muted" />,
          subtitle: p ? `${p.protocol} · ${p.mapped}` : i.data.protocol,
          badge: p?.problems.length ? <Badge tone="bad" title={p.problems.join('\n')}>fix</Badge> : undefined,
        };
      }),
    [targets.lib.items, info],
  );
  const openChecks = () => useApp.getState().openIntent('evaluations', { host: 'rag' });
  return (
    <div className="h-full flex min-h-0" data-rag-tab={side}>
      <div className="w-80 border-r border-line flex flex-col min-h-0">
        {side === 'questions' ? (
          <RagDatasetsList />
        ) : side === 'metrics' ? (
          <CustomMetricsList selected={metric?.id} onSelect={(id) => setMetric({ id })} onNew={() => setMetric({})} />
        ) : (
          <FolderList
            id="rag-targets"
            kind="rag-target"
            title="Bots"
            itemNoun="bot"
            addLabel="Connect a bot"
            folders={targets.lib.folders}
            selected={selected}
            onSelect={setSelected}
            onOpen={(id) => setDialog({ id })}
            onAdd={() => setDialog({})}
            ops={targets.ops}
            items={items}
            empty={
              <Empty title="No bots yet" actions={[{ label: 'Connect a bot', icon: <Plus size={13} />, onClick: () => setDialog({}) }]}>
                A bot is a request to the system you test (HTTP, a streamed answer, WebSocket, gRPC or an MCP tool) and a map of where its answer and retrieved documents are in the response.
              </Empty>
            }
          />
        )}
      </div>
      <div className="flex-1 min-w-0 overflow-auto p-6 text-sm">
        {side === 'questions' ? (
          <RagDataIntro />
        ) : side === 'metrics' ? (
          <>
            <h2 className="text-lg font-semibold mb-1">Your own measure of a good answer</h2>
            <p className="text-muted max-w-2xl mb-4">
              A file in the workspace (metrics/*.yaml) that scores an answer by your rule: a criterion an AI reviewer decides, a checklist, deterministic rules, a formula over other measures, or a script. Check it against examples here, then pick it in an
              evaluation like any other measure.
            </p>
            <Button variant="primary" icon={<Plus size={13} />} onClick={() => setMetric({})}>
              New measure
            </Button>
          </>
        ) : (
          <>
            <h2 className="text-lg font-semibold mb-1">Connect the bot you test</h2>
            <p className="text-muted max-w-2xl mb-4">
              Ask it one question, click its answer and the documents it retrieved in the response, and save the bot. Then an evaluation sends every question of a dataset to it and checks each statement of the answer against what was retrieved.
            </p>
            <div className="flex gap-2 mb-6">
              <Button variant="primary" icon={<Plus size={13} />} onClick={() => setDialog({})} data-rag-connect-open>
                Connect a bot
              </Button>
              <Button icon={<FlaskConical size={13} />} onClick={openChecks}>
                Open Checks
              </Button>
            </div>
            <ol className="list-decimal pl-5 text-muted flex flex-col gap-1 max-w-2xl">
              <li>Bots: request, probe, click-to-map, save.</li>
              <li>Checks: choose the bot, the questions (question, reference answer, right documents; Ragas and DeepEval files convert) and the measures.</li>
              <li>A measure decided by an AI reviewer needs a reviewer model: choose one for the evaluation, or set Settings ▸ AI assistant. It never falls back on a mock silently.</li>
              <li>Metrics: write your own measure, check it against examples, and use it in the picker like any other.</li>
            </ol>
            <ProbeSets />
          </>
        )}
      </div>
      {metric && <MetricEditor id={metric.id} onClose={() => setMetric(undefined)} onSaved={(id) => setMetric((m) => (m && !m.id ? { id } : m))} />}
      {dialog && <RagConnectDialog id={dialog.id} onClose={() => setDialog(undefined)} onSaved={(id) => (void targets.reload(), setSelected(id))} />}
    </div>
  );
}
