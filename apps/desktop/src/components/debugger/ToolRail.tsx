import { ArrowRightLeft, BarChart3, Captions, Download, Filter, Gauge, Highlighter, Info, ListTree, Reply, Send, SlidersHorizontal, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { cx, Menu, Tooltip, type MenuItem } from '../ui';

/** The panels of the Debugger's dock, in the order of their tabs. */
export type DockPanel = 'filter' | 'highlight' | 'highlight-rule' | 'auto-reply' | 'modify' | 'timeline' | 'summary' | 'structure' | 'performance' | 'convert';

interface RailItem {
  id: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  shortcut?: string;
  /** A dock panel it opens, or a menu. */
  panel?: DockPanel;
  items?: MenuItem[];
  onClick?(): void;
  separator?: boolean;
}

/**
 * The Debugger's tool rail (as in HTTP Debugger Pro): send a request, the rule panels (filter, highlight, auto-reply,
 * modify and redirect), what the selection looks like (timeline, summary, structure), performance, conversions, and
 * export / import. Each opens its panel in the dock on the right; the active one is lit.
 */
const LABELS_KEY = 'testpion.debugger.railLabels';

export function ToolRail({ active, onPanel, onSubmit, exportItems }: { active?: DockPanel; onPanel(p: DockPanel): void; onSubmit(): void; exportItems: MenuItem[] }) {
  // icons only (as in HTTP Debugger Pro), or each with its name under it for whoever is new to them; remembered
  const [labels, setLabels] = useState(() => {
    try {
      return localStorage.getItem(LABELS_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggleLabels = () => {
    setLabels((v) => {
      try {
        localStorage.setItem(LABELS_KEY, v ? '0' : '1');
      } catch {
        /* remembered for this session only */
      }
      return !v;
    });
  };
  const items: RailItem[] = [
    { id: 'submitter', label: 'Submitter', hint: 'Send custom requests to a server: the selected one, ready to change, or a new one.', icon: Send, onClick: onSubmit },
    { id: 'filter', label: 'Filter', hint: 'Filter out requests you do not need, or capture only the ones you do: rules you make.', icon: Filter, panel: 'filter' },
    { id: 'highlight', label: 'Highlight', hint: 'Highlight important requests: by status, URL, time, size, program.', icon: Highlighter, panel: 'highlight' },
    { id: 'auto-reply', label: 'Auto-Reply', hint: 'Automatically reply to requests: the server never sees them.', icon: Reply, panel: 'auto-reply' },
    {
      id: 'modify',
      label: 'Modify',
      hint: 'Modify headers and redirect connections.',
      icon: SlidersHorizontal,
      items: [
        { label: 'Modify headers', onSelect: () => onPanel('modify') },
        { label: 'Redirect connections', onSelect: () => onPanel('modify') },
      ],
    },
    { id: 'timeline', label: 'Timeline', hint: 'See the timing breakdown of the selected requests.', icon: BarChart3, panel: 'timeline', shortcut: 'F5', separator: true },
    { id: 'summary', label: 'Summary', hint: 'The selected request at a glance: program, connection, sizes and types.', icon: Info, panel: 'summary' },
    { id: 'structure', label: 'Structure', hint: 'See the structure of the requests: domains and their paths, with counts and sizes.', icon: ListTree, panel: 'structure', shortcut: 'F6' },
    { id: 'performance', label: 'Performance', hint: 'Reveal response time and payload bottlenecks.', icon: Gauge, panel: 'performance', separator: true },
    { id: 'convert', label: 'Convert', hint: 'Decode and encode: URL, Base64, hex, JWT, timestamps, JSON.', icon: ArrowRightLeft, panel: 'convert' },
    { id: 'export', label: 'Export / Import', hint: 'Export or import traffic: sessions, HAR, Fiddler SAZ.', icon: Download, items: exportItems },
  ];
  const lit = (i: RailItem) => !!active && (i.panel === active || (i.id === 'highlight' && active === 'highlight-rule') || (i.id === 'modify' && active === 'modify'));
  const button = (i: RailItem, extra: Record<string, unknown> = {}) => (
    <button
      type="button"
      aria-label={i.label}
      aria-pressed={lit(i)}
      className={cx(
        'inline-flex items-center justify-center rounded-md text-muted transition-colors hover:text-fg hover:bg-hover',
        labels ? 'h-12 w-[4.5rem] flex-col gap-0.5 text-[10px] leading-none' : 'h-9 w-9',
        lit(i) && 'bg-accent-soft text-accent',
      )}
      onClick={i.panel ? () => onPanel(i.panel!) : i.onClick}
      {...extra}
    >
      <i.icon size={17} />
      {labels && <span className="max-w-full truncate px-0.5">{i.label}</span>}
    </button>
  );
  return (
    <nav className={cx('shrink-0 border-r border-line flex flex-col items-center gap-0.5 py-1 bg-panel/40', labels ? 'w-20' : 'w-11')} aria-label="Debugger tools" data-tool-rail data-labels={labels || undefined}>
      {items.map((i) => (
        <div key={i.id} className="contents">
          {i.separator && <div className="w-6 border-t border-line my-1" />}
          {i.items ? (
            // a menu's button takes the menu's handlers: its hint is the native one
            <Menu align="start" width={220} items={i.items} trigger={button(i, { title: `${i.label}: ${i.hint}` })} />
          ) : (
            <Tooltip
              side="right"
              content={
                <span className="block max-w-56">
                  <b>
                    {i.label}
                    {i.shortcut ? ` (${i.shortcut})` : ''}
                  </b>
                  <span className="block font-normal opacity-80">{i.hint}</span>
                </span>
              }
            >
              {button(i)}
            </Tooltip>
          )}
        </div>
      ))}
      <div className="mt-auto pt-1">
        <Tooltip side="right" content={labels ? 'Icons only' : 'Show the tools\' names'}>
          <button
            type="button"
            aria-label={labels ? 'Hide the tool names' : 'Show the tool names'}
            aria-pressed={labels}
            className={cx('h-8 w-8 inline-flex items-center justify-center rounded-md text-muted hover:text-fg hover:bg-hover', labels && 'text-accent')}
            onClick={toggleLabels}
          >
            <Captions size={15} />
          </button>
        </Tooltip>
      </div>
    </nav>
  );
}
