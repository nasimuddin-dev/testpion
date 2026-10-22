import { Columns2, ExternalLink, History, Minus, Plus, RotateCcw, Undo2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { KIND_INFO, outputFileName, refOfWorkspacePath, type KindId } from '@testpion/shared';
import { call } from '../api';
import { confirmAction, toastError, useApp } from '../store';
import { openRef } from '../lib/open-ref';
import { discardGitItem, openGitItem, toastWithUndo } from '../lib/git-items';
import { changesByItemMarkdown, groupChanges, type ChangeGroup } from '../lib/git-rows';
import { plural } from '../lib/format';
import { LABEL, STAGE_HINT } from '../lib/vocabulary';
import type { GitFile, SemanticChange } from '../views/GitView';
import { ChangeMark } from './ChangeMark';
import { FilterChips } from './FilterChips';
import { DiffText } from './GitCommitPanel';
import { KindIcon } from './KindIcon';
import { RefLink } from './RefLink';
import { RowMenu } from './TreeParts';
import { OutputActions } from './output/OutputFrame';
import type { OutputSpec } from './output/output-core';
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
  const allGroups = useMemo(() => groupChanges(files, changes), [files, changes]);
  // the kinds that changed, as chips (any number on; none means all): "MCP server 3", "Dataset 1" …
  const [kinds, setKinds] = useState<KindId[]>([]);
  const counts = useMemo(() => {
    const m = new Map<KindId, number>();
    for (const c of changes) if (c.kindId) m.set(c.kindId, (m.get(c.kindId) ?? 0) + 1);
    return [...m].sort((a, b) => KIND_INFO[a[0]].label.localeCompare(KIND_INFO[b[0]].label));
  }, [changes]);
  const active = useMemo(() => kinds.filter((k) => counts.some(([c]) => c === k)), [kinds, counts]);
  const groups = useMemo(
    () =>
      active.length
        ? allGroups
            .map((g) => {
              const items = g.items.filter((c) => c.kindId && active.includes(c.kindId));
              // a file whose items are all shown keeps its one-row form
              return { ...g, items, single: g.single && items.includes(g.single) ? g.single : undefined };
            })
            .filter((g) => g.items.length)
        : allGroups,
    [allGroups, active],
  );
  // a changed file's menu (right-click or ⋯): open · show the line diff (Stage and Discard are the buttons on the row, not repeated here)
  const [menu, setMenu] = useState<string>();
  const showDiff = (f: GitFile) => void call<string>('git.diff', { path: f.path, staged: f.staged }).then((text) => setDiff(diff?.path === f.path ? undefined : { path: f.path, text }), toastError);
  const discard = async (f: GitFile) => {
    if (await confirmAction({ title: 'Discard changes', message: `Throw away the changes to ${f.path}?`, detail: `${f.state === 'untracked' || f.state === 'added' ? 'The file is new: it is deleted.' : 'The file goes back to the last commit.'} Undo puts it back right after.`, confirmLabel: 'Discard', danger: true }))
      await run('discard', async () => {
        const r = await call<{ undoId?: string }>('git.discard', { files: [f] });
        toastWithUndo(`Discarded the changes to ${f.path}`, r.undoId);
      });
  };
  const output: OutputSpec = {
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
                        // the names, so nobody discards what they did not look at
                        detail: `${files.slice(0, 8).map((f) => `${f.state === 'untracked' || f.state === 'added' ? 'new' : f.state}  ${f.path}`).join('\n')}${files.length > 8 ? `\n… and ${files.length - 8} more` : ''}\n\nFiles go back to the last commit; new files are deleted. Undo puts everything back right after.`,
                        confirmLabel: 'Discard',
                        danger: true,
                      })
                    )
                      await run('discard', async () => {
                        const r = await call<{ undoId?: string }>('git.discard', { files });
                        toastWithUndo(`Discarded the changes to ${plural(files.length, 'file')}`, r.undoId);
                      });
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
      {files.length > 0 && (
        <p className="text-xs text-muted px-3 pb-2" data-stage-hint>
          {STAGE_HINT}
        </p>
      )}
      {counts.length > 1 && (
        <FilterChips
          label="Filter the changes by kind"
          value={active}
          onChange={setKinds}
          options={counts.map(([k, n]) => ({ value: k, label: KIND_INFO[k].label, count: n, icon: <KindIcon kind={k} size={12} />, title: `Only ${KIND_INFO[k].plural.toLowerCase()}` }))}
        />
      )}
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
                    <li key={i} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs" data-change-item={c.title} data-item-staged={c.staged ? '' : undefined}>
                      <ItemName c={c} onCompare={onCompare} run={run} stageable={g.file.state !== 'conflicted'} />
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
function ItemName({ c, onCompare, run, stageable }: { c: SemanticChange; onCompare(file: string, itemId?: string): void; run?(label: string, op: () => Promise<unknown>, done?: string): Promise<void>; stageable?: boolean }) {
  return (
    <>
      <span className="flex items-center gap-2 min-w-0 flex-1 basis-44">
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
        {stageable && c.staged && <Badge tone="accent">staged</Badge>}
      </span>
      {c.change !== 'conflicted' && (
        <span className="ml-auto flex flex-wrap items-center gap-x-2 gap-y-0.5">
          {stageable && c.ref && run && (
            // just this item: the staged copy of its file gets this item's change and no other (release C: staging by index blob)
            <LinkButton
              icon={c.staged ? <Minus size={12} /> : <Plus size={12} />}
              title={c.staged ? 'Take just this item out of the staged changes' : 'Stage just this item: the others in the file stay out of the commit'}
              data-item-stage=""
              onClick={() =>
                void run('stage-item', async () => {
                  const r = await call<{ message: string }>('git.itemStage', { ref: c.ref, unstage: !!c.staged });
                  useApp.getState().toast(r.message, 'success');
                })
              }
            >
              {c.staged ? 'Unstage' : 'Stage'}
            </LinkButton>
          )}
          <LinkButton icon={<Columns2 size={12} />} title="Side by side: the last commit and now, part by part" onClick={() => onCompare(c.file, c.itemId)}>
            Compare
          </LinkButton>
          {c.ref && (
            <>
              <LinkButton icon={<History size={12} />} title="Its versions in git, who changed what, and Restore this version" onClick={() => openGitItem(c.ref!, c.title)} data-item-history="">
                History
              </LinkButton>
              <LinkButton icon={<RotateCcw size={12} />} title="Throw away the change to this item only; the rest of its file stays" onClick={() => void discardGitItem(c.ref!, c.title)} data-item-discard="">
                Discard
              </LinkButton>
            </>
          )}
        </span>
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
      className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5 text-sm"
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu(f.path);
      }}
    >
      {g.single ? (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0 text-xs flex-1 basis-56" data-change-item={g.single.title}>
          <ItemName c={g.single} onCompare={onCompare} />
        </span>
      ) : (
        <span className="flex items-center gap-2 min-w-0 flex-1 basis-44">
          <ChangeMark change={f.state} />
          {g.kindId && <KindIcon kind={g.kindId} size={13} className="text-muted shrink-0" />}
          <span className="truncate font-medium text-xs">{g.label}</span>
          {g.items.length > 1 && <span className="text-xs text-muted shrink-0">{plural(g.items.length, 'change')}</span>}
        </span>
      )}
      <button className="font-mono text-2xs text-muted truncate max-w-[30%] text-left hover:underline" title={`${f.path}: show the line diff`} onClick={() => showDiff(f)}>
        {f.path}
      </button>
      {f.staged && <Badge tone="accent" title="Staged: chosen for the next commit">{f.alsoUnstaged ? 'partly staged' : 'staged'}</Badge>}
      <span className="ml-auto flex gap-1 shrink-0">
        <Button
          size="sm"
          variant="ghost"
          icon={f.staged ? <Minus size={12} /> : <Plus size={12} />}
          onClick={toggle}
          title={g.items.length > 1 ? `${f.staged ? 'Unstages' : 'Stages'} the whole file with all ${g.items.length} changed items in it (or stage one item below)` : undefined}
        >
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
                ]
              : []
          }
        />
      </span>
    </div>
  );
}
