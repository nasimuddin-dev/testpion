import { ArrowRightLeft, BarChart3, Download, Filter, Gauge, Highlighter, Info, ListTree, Reply, Send, SlidersHorizontal, type LucideIcon } from 'lucide-react';
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
export function ToolRail({ active, onPanel, onSubmit, exportItems }: { active?: DockPanel; onPanel(p: DockPanel): void; onSubmit(): void; exportItems: MenuItem[] }) {
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
      className={cx('h-9 w-9 inline-flex items-center justify-center rounded-md text-muted transition-colors hover:text-fg hover:bg-hover', lit(i) && 'bg-accent-soft text-accent')}
      onClick={i.panel ? () => onPanel(i.panel!) : i.onClick}
      {...extra}
    >
      <i.icon size={17} />
    </button>
  );
  return (
    <nav className="w-11 shrink-0 border-r border-line flex flex-col items-center gap-0.5 py-1 bg-panel/40" aria-label="Debugger tools" data-tool-rail>
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
    </nav>
  );
}
