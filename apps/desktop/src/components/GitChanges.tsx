import { Columns2, ExternalLink, Minus, Plus, RotateCcw, Undo2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { outputFileName, refOfWorkspacePath } from '@testpion/shared';
import { call } from '../api';
import { confirmAction, toastError } from '../store';
import { openRef } from '../lib/open-ref';
import { changesByItemMarkdown, groupChanges, type ChangeGroup } from '../lib/git-rows';
import { plural } from '../lib/format';
import { LABEL } from '../lib/vocabulary';
import type { GitFile, SemanticChange } from '../views/GitView';
import { ChangeMark } from './ChangeMark';
import { DiffText } from './GitCommitPanel';
import { KindIcon } from './KindIcon';
import { RefLink } from './RefLink';
import { RowMenu } from './TreeParts';
import { OutputActions } from './output/OutputFrame';
import { Badge, Button, LinkButton, SectionTitle, cx } from './ui';

/**
 * The changes of the workspace, by item (planning/git-everything.md §4c): each row names what changed ("MCP server
 * Weather: URL", "Dataset users.csv: 12 rows added"), with its kind's icon and change mark, the way to open it and to
 * see it side by side. The file is the unit of Stage and Discard, so those sit on the file's row; the path is muted text.
 * The down arrow saves the changes as Markdown by item, or as a patch.
 */
export function GitChanges({
  files,
  changes,
  run,
  onCompare,
  diff,
  setDiff,
}: {
  files: GitFile[];
  changes: SemanticChange[];
  /** The line diff open under a file (also opened from a link to a changed file, at a line). */
  diff?: { path: string; text: string; line?: number };
  setDiff(d?: { path: string; text: string; line?: number }): void;
  run(label: string, op: () => Promise<unknown>, done?: string): Promise<void>;
  onCompare(file: string, itemId?: string): void;
}) {
  const groups = useMemo(() => groupChanges(files, changes), [files, changes]);
  // a changed file's menu (right-click or ⋯): open · show the line diff · stage · discard
  const [menu, setMenu] = useState<string>();
  const showDiff = (f: GitFile) => void call<string>('git.diff', { path: f.path, staged: f.staged }).then((text) => setDiff(diff?.path === f.path ? undefined : { path: f.path, text }), toastError);
  const discard = async (f: GitFile) => {
    if (await confirmAction({ title: 'Discard changes', message: `Throw away the changes to ${f.path}?`, confirmLabel: 'Discard', danger: true }))
      await run('discard', () => call('git.discard', { files: [f] }));
  };
  const output = {
    id: 'git.diff',
    what: 'changes',
    name: outputFileName({ name: 'workspace-changes', ext: '' }),
    empty: files.length ? undefined : 'Nothing changed since the last commit',
    formats: [
      { format: 'md' as const, label: 'Changes by item (Markdown)', build: () => changesByItemMarkdown(changes), default: true },
      {
        format: 'diff' as const,
        label: 'Patch (unified diff)',
        build: async () => (await Promise.all(files.map((f) => call<string>('git.diff', { path: f.path, staged: f.staged })))).join('\n'),
      },
    ],
  };
  return (
    <section data-output="git.diff" data-git-changes>
      <SectionTitle
        right={
          <div className="flex items-center gap-1">
            {files.length > 0 && (
              <>
                <Button size="sm" variant="ghost" icon={<Plus size={12} />} onClick={() => void run('stage', () => call('git.stage', { paths: files.map((f) => f.path) }))}>
                  Stage all
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Undo2 size={12} />}
                  onClick={async () => {
                    if (
                      await confirmAction({
                        title: 'Discard all changes',
                        message: `Throw away ${plural(files.length, 'changed file')}?`,
                        detail: 'Files go back to the last commit; new files are deleted.',
                        confirmLabel: 'Discard',
                        danger: true,
                      })
                    )
                      await run('discard', () => call('git.discard', { files }), 'Changes discarded');
                  }}
                >
                  Discard all
                </Button>
              </>
            )}
            <OutputActions spec={output} />
          </div>
        }
      >
        Changes {files.length ? <Badge>{files.length}</Badge> : null}
      </SectionTitle>
      {!files.length ? (
        <div className="text-sm text-muted py-3">Nothing changed since the last commit.</div>
      ) : (
        <ul className="grid gap-1" aria-label="Changes">
          {groups.map((g) => (
            <li key={g.file.path} data-change-file={g.file.path} className={cx('rounded-md border border-line bg-panel', menu === g.file.path && 'bg-hover')}>
              <FileRow g={g} menu={menu} setMenu={setMenu} showDiff={showDiff} discard={discard} run={run} onCompare={onCompare} />
              {!g.single && g.items.length > 0 && (
                <ul className="border-t border-line px-3 py-1.5 grid gap-0.5">
                  {g.items.map((c, i) => (
                    <li key={i} className="flex items-center gap-2 text-xs" data-change-item={c.title}>
                      <ItemName c={c} onCompare={onCompare} />
                    </li>
                  ))}
                </ul>
              )}
              {diff?.path === g.file.path && (
                <div className="border-t border-line max-h-80 overflow-auto text-[0.9em]">
                  <DiffText text={diff.text} line={diff.line} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One item: its change mark, kind icon and name (a link to open it), what changed, and Compare. */
function ItemName({ c, onCompare }: { c: SemanticChange; onCompare(file: string, itemId?: string): void }) {
  return (
    <>
      <ChangeMark change={c.change} />
      {c.kindId && <KindIcon kind={c.kindId} size={13} className="text-muted shrink-0" />}
      {c.ref && c.change !== 'removed' && c.change !== 'conflicted' ? (
        <RefLink to={c.ref} icon={false} className="text-fg">
          {c.title}
        </RefLink>
      ) : (
        <span className="truncate">{c.title}</span>
      )}
      {c.details.length > 0 && <span className="text-muted truncate">{c.details.join(', ')}</span>}
      {c.change !== 'conflicted' && (
        <LinkButton className="ml-auto shrink-0" icon={<Columns2 size={12} />} title="Side by side: the last commit and now, part by part" onClick={() => onCompare(c.file, c.itemId)}>
          Compare
        </LinkButton>
      )}
    </>
  );
}

function FileRow({
  g,
  menu,
  setMenu,
  showDiff,
  discard,
  run,
  onCompare,
}: {
  g: ChangeGroup;
  menu?: string;
  setMenu(path: string | undefined): void;
  showDiff(f: GitFile): void;
  discard(f: GitFile): Promise<void>;
  run(label: string, op: () => Promise<unknown>, done?: string): Promise<void>;
  onCompare(file: string, itemId?: string): void;
}) {
  const f = g.file;
  const toggle = () => void run('stage', () => call(f.staged ? 'git.unstage' : 'git.stage', { paths: [f.path] }));
  return (
    <div
      className="flex items-center gap-2 px-2 py-1.5 text-sm"
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu(f.path);
      }}
    >
      {g.single ? (
        <span className="flex items-center gap-2 min-w-0 text-xs flex-1" data-change-item={g.single.title}>
          <ItemName c={g.single} onCompare={onCompare} />
        </span>
      ) : (
        <span className="flex items-center gap-2 min-w-0 flex-1">
          <ChangeMark change={f.state} />
          {g.kindId && <KindIcon kind={g.kindId} size={13} className="text-muted shrink-0" />}
          <span className="truncate font-medium text-xs">{g.label}</span>
          {g.items.length > 1 && <span className="text-xs text-muted shrink-0">{plural(g.items.length, 'change')}</span>}
        </span>
      )}
      <button className="font-mono text-[0.7rem] text-muted truncate max-w-[30%] text-left hover:underline" title={`${f.path}: show the line diff`} onClick={() => showDiff(f)}>
        {f.path}
      </button>
      {f.staged && <Badge tone="accent">staged</Badge>}
      <span className="ml-auto flex gap-1 shrink-0">
        <Button size="sm" variant="ghost" icon={f.staged ? <Minus size={12} /> : <Plus size={12} />} onClick={toggle}>
          {f.staged ? 'Unstage' : 'Stage'}
        </Button>
        <Button size="sm" variant="ghost" icon={<RotateCcw size={12} />} onClick={() => void discard(f)}>
          Discard
        </Button>
        <RowMenu
          label={g.single?.title ?? g.label}
          open={menu === f.path}
          onOpenChange={(o) => setMenu(o ? f.path : undefined)}
          items={
            menu === f.path
              ? [
                  ...(() => {
                    const ref = g.items.find((c) => c.ref && c.change !== 'removed' && c.change !== 'conflicted')?.ref ?? refOfWorkspacePath(f.path);
                    return ref && f.state !== 'deleted' ? [{ label: LABEL.open, icon: <ExternalLink size={14} />, onSelect: () => void openRef(ref) }] : [];
                  })(),
                  { label: 'Show the line diff', icon: <Columns2 size={14} />, onSelect: () => showDiff(f) },
                  { label: f.staged ? `Unstage ${f.path}` : `Stage ${f.path}`, icon: f.staged ? <Minus size={14} /> : <Plus size={14} />, separator: true, onSelect: toggle },
                  { label: 'Discard…', icon: <RotateCcw size={14} />, danger: true, separator: true, onSelect: () => void discard(f) },
                ]
              : []
          }
        />
      </span>
    </div>
  );
}
