import { plural } from '../lib/format';
import { useState } from 'react';
import { ChevronDown, ChevronRight, Download, Sparkles } from 'lucide-react';
import type { ImportFinding, ImportReport as Report, PlanNode } from '../types';
import { downloadContent } from '../lib/files';
import { LABEL } from '../lib/vocabulary';
import { Badge, Button, cx } from './ui';

/** The message of a finding without the `"Item": ` prefix the notes carry (the report shows the item beside it). */
const detail = (f: ImportFinding) => f.message.replace(/^(?:Folder |Environment )?"[^"]+":\s*/, '');

const SEVERITY: Record<ImportFinding['severity'], { label: string; tone: 'bad' | 'warn' | 'default' }> = {
  'not-imported': { label: 'Not imported', tone: 'bad' },
  changed: { label: 'Changed', tone: 'warn' },
  info: { label: 'Note', tone: 'default' },
};

/**
 * The compatibility report of an import: how much came over fully, with changes or not at all, and every finding
 * grouped by what it is, each naming the item. The one component for the preview step and the result of the Import
 * dialog (and a stored report); Download writes it as JSON or Markdown.
 */
export function ImportReportView({ report, markdown, onFixWithAi }: { report: Report; markdown?: () => Promise<string>; onFixWithAi?: () => void }) {
  const s = report.summary;
  const c = report.counts;
  const [open, setOpen] = useState<string | undefined>(report.groups.find((g) => g.severity !== 'info')?.code);
  return (
    <div className="flex flex-col gap-2 text-sm" data-import-report>
      <div className="flex flex-wrap gap-x-4 gap-y-1" data-import-summary>
        <span>
          <b>{plural(c.requests, 'request')}</b> in <b>{plural(c.folders, 'folder')}</b>
        </span>
        {c.environments > 0 && (
          <span>
            <b>{plural(c.environments, 'environment')}</b>
          </span>
        )}
        {c.specs > 0 && <span>{plural(c.specs, 'API definition')}</span>}
        {c.flows > 0 && <span>{plural(c.flows, 'flow')}</span>}
        {c.libraryItems > 0 && <span>{plural(c.libraryItems, 'gRPC call / connection', 'gRPC calls / connections')}</span>}
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        <Badge tone="ok" title="Came over as it was">
          {s.full} fully
        </Badge>
        <Badge tone={s.changed ? 'warn' : 'default'} title="Imported, with something changed or marked">
          {s.changed} with changes
        </Badge>
        <Badge tone={s.notImported ? 'bad' : 'default'} title="Left out: the findings say why">
          {s.notImported} not imported
        </Badge>
        {s.valuesNeeded > 0 && <Badge tone="accent">{plural(s.valuesNeeded, 'value')} to enter</Badge>}
        {report.scripts && (report.scripts.converted > 0 || report.scripts.kept > 0 || report.scripts.todo > 0) && (
          <span className="text-xs text-muted">
            scripts: {report.scripts.converted} converted to tp.*{report.scripts.kept ? `, ${report.scripts.kept} kept as written` : ''}
            {report.scripts.todo ? `, ${report.scripts.todo} marked for a rewrite` : ''}
          </span>
        )}
        <span className="ml-auto flex gap-1">
          {onFixWithAi && report.findings.some((f) => f.code === 'SCRIPT_API') && (
            <Button size="sm" icon={<Sparkles size={12} />} title="Rewrite the scripts the import marked, with TestPion's script API: a reviewed proposal, each script checked in the sandbox" onClick={onFixWithAi} data-import-fix-ai>
              {LABEL.fixImportLeftovers}
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<Download size={12} />} title="Download the report as JSON" onClick={() => downloadContent('import-report.json', JSON.stringify(report, null, 2), { type: 'application/json' })}>
            JSON
          </Button>
          {markdown && (
            <Button size="sm" variant="ghost" icon={<Download size={12} />} title="Download the report as Markdown" onClick={() => void markdown().then((t) => downloadContent('import-report.md', t, { type: 'text/markdown' }))}>
              Markdown
            </Button>
          )}
        </span>
      </div>
      {report.groups.length === 0 && <p className="text-muted">Everything came over as it was.</p>}
      {report.groups.map((g) => {
        const rows = report.findings.filter((f) => f.code === g.code);
        const isOpen = open === g.code;
        return (
          <div key={g.code} className="border border-border rounded-md" data-import-group={g.code}>
            <button className="w-full flex items-center gap-2 px-2 py-1.5 text-left" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? undefined : g.code)}>
              {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <span className="font-medium">{g.title}</span>
              <Badge tone={SEVERITY[g.severity].tone}>{g.count}</Badge>
              <span className="text-xs text-muted ml-auto">{SEVERITY[g.severity].label}</span>
            </button>
            {isOpen && (
              <ul className="px-2 pb-2 flex flex-col gap-1 max-h-56 overflow-auto">
                {rows.map((f, i) => (
                  <li key={i} className="text-xs" data-import-finding>
                    {f.where.length > 0 && <span className="mono text-accent">{f.where.join(' / ')}</span>}
                    {f.field && <span className="text-muted"> ({f.field})</span>}
                    {f.where.length > 0 ? ': ' : ''}
                    {detail(f)}
                    {f.suggestion && <span className="text-muted"> {f.suggestion}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {report.truncated ? <p className="text-xs text-muted">{report.truncated} more findings are not listed (Download has the first 2000; the command testpion import --json in a terminal lists all).</p> : null}
    </div>
  );
}

const METHOD_TONE: Record<string, string> = { GET: 'text-ok', POST: 'text-accent', PUT: 'text-warn', PATCH: 'text-warn', DELETE: 'text-bad' };

/** The tree of what an import would create: folders (collapsible) and requests with their method; a node with changes is marked. */
export function ImportTree({ nodes, depth = 0 }: { nodes: PlanNode[]; depth?: number }) {
  return (
    <ul className={cx('flex flex-col', depth === 0 && 'max-h-52 overflow-auto')} role={depth === 0 ? 'tree' : 'group'}>
      {nodes.map((n, i) => (
        <TreeRow key={i} node={n} depth={depth} />
      ))}
    </ul>
  );
}

function TreeRow({ node, depth }: { node: PlanNode; depth: number }) {
  const [open, setOpen] = useState(depth < 1);
  const folder = node.kind === 'folder';
  return (
    <li role="treeitem" aria-expanded={folder ? open : undefined} data-import-node={node.status}>
      <div className="flex items-center gap-1.5 py-0.5 text-xs" style={{ paddingLeft: depth * 14 }}>
        {folder ? (
          <button className="flex items-center gap-1" onClick={() => setOpen(!open)} aria-label={open ? 'Collapse' : 'Expand'}>
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span className="font-medium">{node.name}</span>
          </button>
        ) : (
          <>
            <span className={cx('mono w-12 shrink-0 text-2xs', METHOD_TONE[node.method ?? ''] ?? 'text-muted')}>{node.kind === 'graphql' ? 'GQL' : node.method}</span>
            <span>{node.name}</span>
          </>
        )}
        {node.status === 'changed' && (
          <span className="text-warn" title="Something of it did not map one to one: see the report">
            •
          </span>
        )}
      </div>
      {folder && open && node.children && <ImportTree nodes={node.children} depth={depth + 1} />}
    </li>
  );
}
