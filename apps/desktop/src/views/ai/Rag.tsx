import { Database, FlaskConical, Layers, Plus, Ruler } from 'lucide-react';
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
import { Badge, Button, Empty, Segmented } from '../../components/ui';

/**
 * AI Lab ▸ RAG: the RAG systems under test (a request of any protocol and the mapping of its response). Connect one,
 * open or change one, and go to Evaluations to run a dataset through it. Evaluations of type RAG pick a target here.
 */
export function Rag({ openTarget }: { openTarget?: { id: string; at: number } }) {
  const targets = useLibrary<RagTarget>('rag-targets');
  const [dialog, setDialog] = useState<{ id?: string }>();
  const [selected, setSelected] = useState<string>();
  const [side, setSide] = useState<'targets' | 'metrics' | 'data'>('targets');
  const [metric, setMetric] = useState<{ id?: string }>();
  const [info, setInfo] = useState<RagTargetInfo[]>([]);
  useEffect(() => {
    void call<RagTargetInfo[]>('rag.targets').then(setInfo, () => setInfo([]));
  }, [targets.lib]);
  // a link to a target (a ref, a search hit) opens it
  useEffect(() => {
    if (openTarget) setDialog({ id: openTarget.id });
  }, [openTarget]);
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
  return (
    <div className="h-full flex min-h-0" data-rag-tab>
      <div className="w-80 border-r border-line flex flex-col min-h-0">
        <div className="px-2 py-1.5 border-b border-line">
          <Segmented
            label="Show"
            size="xs"
            value={side}
            onChange={setSide}
            options={[
              { value: 'targets', label: 'RAG targets', icon: <Database size={11} /> },
              { value: 'metrics', label: 'Metrics', icon: <Ruler size={11} />, title: 'Your own metrics: files in the workspace (metrics/*.yaml) that score an answer by your rule' },
              { value: 'data', label: 'Data', icon: <Layers size={11} />, title: 'Datasets: generate a test set from your documents, or build one from real calls' },
            ]}
          />
        </div>
        {side === 'data' ? (
          <RagDatasetsList />
        ) : side === 'metrics' ? (
          <CustomMetricsList selected={metric?.id} onSelect={(id) => setMetric({ id })} onNew={() => setMetric({})} />
        ) : (
        <FolderList
          id="rag-targets"
          kind="rag-target"
          title="RAG targets"
          itemNoun="target"
          addLabel="Connect a RAG system"
          folders={targets.lib.folders}
          selected={selected}
          onSelect={setSelected}
          onOpen={(id) => setDialog({ id })}
          onAdd={() => setDialog({})}
          ops={targets.ops}
          items={items}
          empty={
            <Empty title="No RAG systems yet" actions={[{ label: 'Connect a RAG system', icon: <Plus size={13} />, onClick: () => setDialog({}) }]}>
              A RAG target is a request to the system you test (HTTP, a streamed answer, WebSocket, gRPC or an MCP tool) and a map of where its answer and retrieved documents are in the response.
            </Empty>
          }
        />
        )}
      </div>
      <div className="flex-1 min-w-0 overflow-auto p-6 text-sm">
        {side === 'data' ? (
          <RagDataIntro />
        ) : (
          <>
        <h2 className="text-lg font-semibold mb-1">Test a RAG system</h2>
        <p className="text-muted max-w-2xl mb-4">
          Connect the system you run: ask it one question, click its answer and the documents it retrieved in the response, and save the target. Then an evaluation of type RAG sends every question of a dataset to it and scores the answers: against the reference answer, against the gold documents, and with a judge model
          that checks each claim against what was retrieved.
        </p>
        <div className="flex gap-2 mb-6">
          <Button variant="primary" icon={<Plus size={13} />} onClick={() => setDialog({})} data-rag-connect-open>
            Connect a RAG system
          </Button>
          <Button icon={<FlaskConical size={13} />} onClick={() => useApp.getState().setView('evaluations')}>
            Open Checks
          </Button>
        </div>
        <ol className="list-decimal pl-5 text-muted flex flex-col gap-1 max-w-2xl">
          <li>Connect: request, probe, click-to-map, save.</li>
          <li>Evaluations ▸ type RAG: choose the target, the dataset (question, reference answer, gold documents; Ragas and DeepEval files convert) and the metrics.</li>
          <li>A judged metric needs a judge model: choose one for the evaluation, or set Settings ▸ AI assistant. It never falls back on a mock silently.</li>
          <li>Metrics tab: write your own metric (a criterion a judge decides, a checklist, rules, a formula, a script), check it against examples, and use it in the picker like any other.</li>
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
