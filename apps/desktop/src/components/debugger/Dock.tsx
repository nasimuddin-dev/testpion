import { X } from 'lucide-react';
import { useState } from 'react';
import { ConvertTool } from '../DebuggerTools';
import { PinnablePanel } from '../ui';
import type { Rule, RulesState } from '../DebuggerRules';
import { AutoReplyPanel, FilterPanel, HighlightPanel, HighlightRuleEditor, ModifyPanel } from './DockRules';
import { PerformancePanel, StructurePanel, SummaryPanel, TimelinePanel } from './DockInsights';
import type { DockPanel } from './ToolRail';
import type { Exchange } from './model';

const TITLES: Record<DockPanel, string> = {
  filter: 'Filter',
  highlight: 'Highlight',
  'highlight-rule': 'Highlight Rule',
  'auto-reply': 'Auto-Reply',
  modify: 'Modify',
  timeline: 'Timeline',
  summary: 'Summary',
  structure: 'Structure',
  performance: 'Performance',
  convert: 'Convert',
};

/**
 * The Debugger's dock on the right: one panel at a time (the tool rail or these tabs choose it), the same tabs at
 * the bottom as in HTTP Debugger Pro. The rule panels edit the active profile; the others read the selection or the list.
 * A pinnable panel: unpinned, it is a tab on the right edge and slides over the grid (the tool rail opens it).
 */
export function Dock({
  panel,
  onPanel,
  onClose,
  rules,
  onRules,
  onNewRule,
  onEditRule,
  rows,
  picked,
  current,
  onPick,
  reveal,
  onShownChange,
}: {
  panel: DockPanel;
  onPanel(p: DockPanel): void;
  onClose(): void;
  rules?: RulesState;
  onRules(s: RulesState): void;
  onNewRule(r: Partial<Rule>): void;
  onEditRule(r: Rule): void;
  rows: Exchange[];
  /** The selected exchanges (the Timeline), and the one shown (Summary). */
  picked: Exchange[];
  current?: Exchange;
  onPick(id: string): void;
  /** Bumped when the tool rail asks for the panel: an unpinned dock slides open. */
  reveal?: number;
  onShownChange?(shown: boolean): void;
}) {
  const [editing, setEditing] = useState<Rule>();
  return (
    <PinnablePanel
      id="debugger.dock"
      title={TITLES[panel]}
      side="right"
      defaultWidth={340}
      revealKey={`${panel}:${reveal ?? 0}`}
      onShownChange={onShownChange}
      actions={
        <button type="button" className="p-1 text-muted hover:text-fg" aria-label="Close the panel" onClick={onClose}>
          <X size={13} />
        </button>
      }
    >
      <aside className="flex-1 flex flex-col min-h-0 bg-bg" aria-label={`${TITLES[panel]} panel`} data-dock={panel}>
        <div className="flex-1 min-h-0 flex flex-col">
          {panel === 'filter' && <FilterPanel state={rules} onChange={onRules} onNewRule={onNewRule} onEdit={onEditRule} />}
          {panel === 'highlight' && <HighlightPanel state={rules} onChange={onRules} onEdit={(r) => (setEditing(r), onPanel('highlight-rule'))} />}
          {panel === 'highlight-rule' && (
            <HighlightRuleEditor key={editing?.id ?? 'new'} rule={editing} onSaved={(s) => (onRules(s), setEditing(undefined), onPanel('highlight'))} onCancel={() => setEditing(undefined)} />
          )}
          {panel === 'auto-reply' && <AutoReplyPanel state={rules} onChange={onRules} onNewRule={onNewRule} onEdit={onEditRule} />}
          {panel === 'modify' && <ModifyPanel state={rules} onChange={onRules} onNewRule={onNewRule} onEdit={onEditRule} />}
          {panel === 'timeline' && <TimelinePanel picked={picked} />}
          {panel === 'summary' && <SummaryPanel e={current} />}
          {panel === 'structure' && <StructurePanel rows={rows} onPick={onPick} />}
          {panel === 'performance' && <PerformancePanel rows={rows} onPick={onPick} />}
          {panel === 'convert' && <ConvertTool />}
        </div>
      </aside>
    </PinnablePanel>
  );
}
