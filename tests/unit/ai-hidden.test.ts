import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_ACTIONS, KIND_INFO, NODE_KINDS, fullMenuContext, nodeMenuEntries, nodeMenuShapeOf, liveKinds, type NodeKind } from '@testpion/shared';
import { AI_TASKS, aiHidden as settingsHidden, aiPrefersStable, normalizeAiSettings } from '../../packages/core/src/index.js';
import { TOOL_DOCS } from '../../packages/core/src/mcp-server/tool-docs.js';
import { buildNodeMenu, fullCtx } from '../../apps/desktop/src/lib/node-menu';
import { AI_LAUNCH_KEYS, setAiHiddenSource, withoutAiLaunch } from '../../apps/desktop/src/lib/ai-visible';
import { LABEL } from '../../apps/desktop/src/lib/vocabulary';

/**
 * B-15 · ONE table for the right-click "… with AI" items (packages/shared/src/ai-actions.ts) and ONE setting that hides
 * every AI action of the window. This test enumerates both: every row of the table against the AI tasks, the CLI, the MCP
 * tools and the item kinds' `ai` capability; every menu without its AI items when AI is hidden; and every file of the
 * window that opens an AI surface, each with the way it honours the setting — a new entry point that is not listed here
 * (and gated the way its kind says) fails the test.
 */

const root = join(__dirname, '..', '..');
const SRC = join(root, 'apps', 'desktop', 'src');

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}
const rel = (f: string) => relative(SRC, f).split(sep).join('/');
const text = new Map(sources(SRC).map((f) => [rel(f), readFileSync(f, 'utf8')] as const));

describe('the AI table of the node menus', () => {
  it('every row names an AI task, a CLI command and an MCP tool that exist, and a label the vocabulary has', () => {
    const tasks = new Set(AI_TASKS.flatMap((t) => [t.id, ...(t.aliases ?? [])]));
    const docs = new Set(Object.keys(TOOL_DOCS));
    const ids = new Set<string>();
    for (const a of AI_ACTIONS) {
      expect(ids.has(a.id), `${a.id} twice`).toBe(false);
      ids.add(a.id);
      expect(tasks.has(a.task), `${a.id}: task ${a.task}`).toBe(true);
      expect(a.cli, a.id).toMatch(/^testpion /);
      expect(docs.has(a.mcp), `${a.id}: MCP tool ${a.mcp}`).toBe(true);
      expect(LABEL[a.label], `${a.id}: label ${a.label}`).toBeTruthy();
      expect(a.text.length, a.id).toBeGreaterThan(20);
    }
  });

  it('a node kind has the `ai` capability exactly when its menu has an AI item; a kind with the capability is named by a row', () => {
    const withAi = new Set<string>();
    for (const n of NODE_KINDS) if (nodeMenuShapeOf(n).groups.some((g) => g.actions.some((a) => a.ai))) withAi.add(n);
    for (const k of liveKinds()) {
      const has = k.capabilities.ai === true;
      const menu = NODE_KINDS.filter((n) => n === k.id).some((n) => withAi.has(n));
      expect(menu, `${k.id}: ai capability ${has}, AI item in its menu ${menu}`).toBe(has);
    }
    // a row's kinds are node kinds, and their item kind says `ai`
    for (const a of AI_ACTIONS) {
      for (const n of ('kinds' in a ? a.kinds : []) as readonly NodeKind[]) {
        expect(NODE_KINDS.includes(n), `${a.id}: ${n}`).toBe(true);
        expect(KIND_INFO[n as keyof typeof KIND_INFO].capabilities.ai, `${a.id}: ${n}`).toBe(true);
      }
      if ('cap' in a) expect(liveKinds().filter((k) => k.capabilities[a.cap] === true).every((k) => k.capabilities.ai === true), `${a.id}: kinds with ${a.cap}`).toBe(true);
    }
  });

  it('a node with several AI items has one AI ▸ submenu; one AI item stays flat (the shape agents read follows the window)', () => {
    for (const n of NODE_KINDS) {
      const ai = nodeMenuEntries(n, fullMenuContext(n)).flatMap((g) => g.entries.filter((e) => e.def.ai));
      const labels = buildNodeMenu(n, fullCtx(n)).map((i) => i.label);
      if (ai.length > 1) {
        expect(labels.filter((l) => l === LABEL.aiActions), n).toHaveLength(1);
        const sub = buildNodeMenu(n, fullCtx(n)).find((i) => i.label === LABEL.aiActions)!;
        expect(sub.items!.map((i) => i.label), n).toEqual(ai.map((e) => LABEL[e.label]));
      } else expect(labels.includes(LABEL.aiActions), n).toBe(false);
    }
  });
});

describe('Hide all AI actions', () => {
  it('no node menu has an AI item, a submenu of them or an AI label while AI is hidden', () => {
    const aiLabels = new Set(AI_ACTIONS.map((a) => LABEL[a.label]));
    let seen = 0;
    for (const n of NODE_KINDS) {
      const shown = buildNodeMenu(n, fullCtx(n)).flatMap((i) => [i.label, ...(i.items ?? []).map((x) => x.label)]);
      if (shown.some((l) => aiLabels.has(l) || l === LABEL.aiActions)) seen++;
      const hidden = buildNodeMenu(n, { ...fullCtx(n), aiHidden: true }).flatMap((i) => [i.label, ...(i.items ?? []).map((x) => x.label)]);
      expect(
        hidden.filter((l) => aiLabels.has(l) || l === LABEL.aiActions),
        n,
      ).toEqual([]);
      // and everything else is still there
      expect(hidden.length, n).toBeGreaterThanOrEqual(shown.filter((l) => !aiLabels.has(l) && l !== LABEL.aiActions).length);
    }
    expect(seen).toBeGreaterThanOrEqual(6);
  });

  it('the setting hides them through the store source the menus read (and shows them again)', () => {
    const item = (n: NodeKind) => buildNodeMenu(n, fullCtx(n)).flatMap((i) => [i.label, ...(i.items ?? []).map((x) => x.label)]);
    setAiHiddenSource(() => false);
    expect(item('run')).toContain(LABEL.triageWithAi);
    setAiHiddenSource(() => true);
    try {
      expect(item('run')).not.toContain(LABEL.triageWithAi);
      expect(item('request')).not.toContain(LABEL.suggestChecks);
    } finally {
      setAiHiddenSource(() => false);
    }
    expect(item('request')).toContain(LABEL.suggestChecks);
  });

  it('the store drops every request to open an AI surface while hidden, and still lets one close', () => {
    expect(AI_LAUNCH_KEYS).toEqual(['assistant', 'flowGenerate', 'aiAnalysis', 'tidyImport', 'askSearch']);
    for (const k of AI_LAUNCH_KEYS) {
      const p = { [k]: { task: 'free' }, view: 'rest' };
      expect(withoutAiLaunch(p), k).toEqual({ view: 'rest' });
      const closing = { [k]: undefined, view: 'rest' };
      expect(withoutAiLaunch(closing), k).toBe(closing);
    }
    const plain = { view: 'rest' };
    expect(withoutAiLaunch(plain)).toBe(plain);
    // every surface the window can open is one of those keys (a new one has to be added there)
    const state = text.get('store.ts')!;
    expect(state).toContain('set: (p) => set(aiHidden() ? withoutAiLaunch(p) : p)');
    for (const k of AI_LAUNCH_KEYS) expect(state, k).toMatch(new RegExp(`\\b${k}\\?:`));
  });

  it('the settings: Hide all AI actions and Prefer stable checks are kept and read, off by default', () => {
    expect(settingsHidden({})).toBe(false);
    expect(settingsHidden({ ai: { hidden: true } })).toBe(true);
    expect(normalizeAiSettings({ hidden: true, preferStable: true, localOnly: 'yes' })).toEqual({ hidden: true, preferStable: true });
    expect(normalizeAiSettings({ hidden: 'yes' })).toBeUndefined();
    expect(aiPrefersStable({})).toBe(false);
    expect(aiPrefersStable({ ai: { preferStable: true } })).toBe(true);
    // a call's own choice wins over the setting
    expect(aiPrefersStable({ ai: { preferStable: true } }, false)).toBe(false);
    expect(aiPrefersStable({}, true)).toBe(true);
    expect(text.get('views/SettingsView.tsx')).toContain('Hide all AI actions');
    expect(text.get('components/ai/AiSettingsPanel.tsx')).toContain('Prefer stable checks');
  });
});

/** The ways a file that opens an AI surface honours "Hide all AI actions". */
type Gate =
  /** it renders its control only when `useAiEnabled()` */
  | 'hook'
  /** it only uses the shared `<AiAction>` button, which is not rendered while AI is hidden */
  | 'component'
  /** it only hands the action to a node menu (`on:`), which leaves AI items out */
  | 'menu'
  /** it builds its items with `aiMenuItems`, which returns none while AI is hidden */
  | 'items'
  /** it is a definition that goes through the store, which drops the request */
  | 'store'
  /** it offers the action from an event handler, after checking aiHidden() */
  | 'snapshot';

const LAUNCHERS = ['startAi(', 'askAssistant(', 'startFlowGenerate(', 'startTidyImport(', 'startAiAnalysis(', '<AiAction', 'aiMenuItems(', 'startAskSearch(', '<AskSearchButton'];

/** Every file of the window that opens an AI surface, and how it honours the setting. */
const ENTRY_POINTS: Record<string, Gate> = {
  'App.tsx': 'hook',
  'components/ApiCoverageDialog.tsx': 'component',
  'components/ApiFuzzPanel.tsx': 'component',
  'components/ApiLintPanel.tsx': 'component',
  'components/AttentionCard.tsx': 'hook',
  'components/CollectionTree.tsx': 'menu',
  'components/Explorer.tsx': 'menu',
  'components/FlowDesigner.tsx': 'hook',
  'components/rag/RagConnectDialog.tsx': 'component',
  'components/ImportDialog.tsx': 'snapshot',
  'components/OpenApiDiffDialog.tsx': 'component',
  'components/ProblemList.tsx': 'items',
  'components/ResponseViewer.tsx': 'component',
  'components/Results.tsx': 'component',
  'components/RightPanel.tsx': 'hook',
  'components/RunPanel.tsx': 'component',
  'components/SecurityReviewDialog.tsx': 'component',
  'components/Shell.tsx': 'hook',
  'components/TestHistory.tsx': 'component',
  'components/ProblemList.tsx': 'items',
  'components/QuickOpen.tsx': 'store',
  'components/ai/AiAction.tsx': 'store',
  'components/ai/AskSearchButton.tsx': 'hook',
  'components/ai/ask-search.ts': 'store',
  'components/ai/ai-analysis.ts': 'items',
  'components/ai/flow-generate.ts': 'items',
  'components/ai/script-ai.ts': 'items',
  'components/mcp/ToolsPanel.tsx': 'component',
  'components/mcp/ToolsetEditor.tsx': 'hook',
  'components/rag/CustomMetrics.tsx': 'component',
  'components/rag/RagDataPanel.tsx': 'component',
  'components/rag/RagAuthorAction.tsx': 'component',
  'components/rag/RagConnectDialog.tsx': 'component',
  'components/rag/RagSampleDetail.tsx': 'component',
  'components/ai/RunReport.tsx': 'component',
  'lib/problems.ts': 'store',
  'views/ApiDefinitionView.tsx': 'hook',
  'views/DebuggerView.tsx': 'hook',
  'views/GraphQLView.tsx': 'component',
  'views/HistoryView.tsx': 'component',
  'views/HomeView.tsx': 'hook',
  'views/LoadView.tsx': 'component',
  'views/MonitorsView.tsx': 'component',
  'views/RestView.tsx': 'hook',
  'views/TestsRunsList.tsx': 'menu',
  'views/TracesView.tsx': 'component',
};

/** Entry points that are not a call of a launcher: a control that calls an AI RPC itself, or a surface of its own. */
const OTHER_ENTRY_POINTS: Record<string, { gate: Gate; needs: string; /** the file that has the hook and passes the control down (or not) */ via?: string }> = {
  'components/EditorTabs.tsx': { gate: 'hook', needs: 'Describe with AI' },
  'components/FlowDesignerParts.tsx': { gate: 'hook', needs: 'o.generate ?', via: 'components/FlowDesigner.tsx' },
  'components/McpClientRequestDialog.tsx': { gate: 'hook', needs: 'Draft with AI' },
  'views/GitView.tsx': { gate: 'hook', needs: 'Write message' },
  'components/ScriptsPanel.tsx': { gate: 'hook', needs: 'scriptAiItems' },
  'components/debugger/ExchangePanes.tsx': { gate: 'hook', needs: 'a.onAsk &&', via: 'views/DebuggerView.tsx' },
};

describe('every entry point of the window honours Hide all AI actions', () => {
  it('lists every file that opens an AI surface (a new one has to be added, gated the way its kind says)', () => {
    const found = [...text.entries()]
      .filter(([file, src]) => LAUNCHERS.some((l) => src.includes(l)) && file !== 'lib/ai-menu.ts' && file !== 'lib/use-ai-enabled.ts')
      .map(([file]) => file)
      .sort();
    expect(found).toEqual(Object.keys(ENTRY_POINTS).sort());
  });

  it('each file is gated the way it says', () => {
    for (const [file, gate] of Object.entries(ENTRY_POINTS)) {
      const src = text.get(file)!;
      if (gate === 'hook') expect(src, `${file} renders its AI control only when useAiEnabled()`).toContain('useAiEnabled()');
      if (gate === 'component') for (const l of LAUNCHERS.filter((x) => x !== '<AiAction' && x !== '<AskSearchButton' && !(x === 'startAiAnalysis(' && src.includes('open=')))) expect(src.includes(l), `${file} calls ${l} itself: use the AiAction button`).toBe(false);
      if (gate === 'menu') {
        // the action is handed to a node menu (`on:`) and only there
        expect(src, file).toMatch(/on: \{|on: Object|\bon,|on:/);
        expect(src.includes('<AiAction'), `${file} has a button of its own`).toBe(false);
      }
      if (gate === 'items') expect(src, file).toMatch(/aiMenuItems|startAi|startFlowGenerate|startAiAnalysis|startTidyImport/);
    }
    for (const [file, { needs, via }] of Object.entries(OTHER_ENTRY_POINTS)) {
      const src = text.get(file)!;
      expect(text.get(via ?? file), `${via ?? file} renders ${file}'s AI control only when useAiEnabled()`).toContain('useAiEnabled()');
      expect(src, `${file} still has ${needs}`).toContain(needs);
    }
    for (const [file, gate] of Object.entries(ENTRY_POINTS)) if (gate === 'snapshot') expect(text.get(file), `${file} checks aiHidden() before offering the action`).toContain('!aiHidden()');
  });

  it('the shared button is not rendered while AI is hidden, and the opening functions go through the store', () => {
    const action = text.get('components/ai/AiAction.tsx')!;
    expect(action).toMatch(/if \(!enabled\) return null;/);
    expect(action).toContain('useApp.getState().set({ assistant: { ...req, preflight:');
    expect(text.get('components/ai/flow-generate.ts')).toContain('set({ flowGenerate: req })');
    expect(text.get('components/ai/ai-analysis.ts')).toContain('set({ aiAnalysis: req })');
    // the palette and the rail do not offer the assistant while hidden
    expect(text.get('App.tsx')).toMatch(/aiOn \? \[\{ id: 'assistant'/);
    expect(text.get('App.tsx')).toMatch(/aiOn && flowGenerate/);
    expect(text.get('App.tsx')).toMatch(/aiOn && aiAnalysis/);
    expect(text.get('App.tsx')).toMatch(/aiOn && tidyImport/);
  });

  it('no view writes an AI button of its own either: an empty state or a block picker row takes "Describe with AI" / "Generate with AI" from the table (aiButton)', () => {
    for (const [file, src] of text) {
      if (file === 'lib/vocabulary.ts') continue;
      expect(/label:\s*['"`][^'"`]*\b(Describe|Generate|Draft)\b[^'"`]*\bwith AI\b/.test(src), `${file} writes an AI button label: use aiButton(id)`).toBe(false);
    }
    // the flow designer's block picker row is the table's designFlow row
    expect(text.get('components/FlowDesignerParts.tsx')).toContain("aiButton('designFlow')");
  });

  it('no view writes an AI menu item of its own: the labels come from the table', () => {
    const aiKeys = AI_ACTIONS.map((a) => a.label as string);
    const allowed = new Set(['lib/vocabulary.ts', 'lib/ai-menu.ts', 'lib/node-menu.ts', 'components/ai/ai-analysis.ts']);
    for (const [file, src] of text) {
      if (allowed.has(file)) continue;
      // (a button may say LABEL.generateSpecTests; a menu item with an AI label is the table's)
      for (const k of aiKeys) expect(new RegExp(`label:\\s*LABEL\\.${k}\\b[^\\n]*onSelect`).test(src), `${file} writes a menu item with LABEL.${k}: take it from the AI table`).toBe(false);
      // a menu item (label + onSelect) that says AI
      for (const m of src.matchAll(/label:\s*['"`]([^'"`]*)['"`][^\n]*onSelect/g))
        expect(/\bAI\b/.test(m[1]!) || /Why is this flaky/.test(m[1]!), `${file}: menu item "${m[1]}" is AI: take it from the AI table (aiMenuItems)`).toBe(false);
    }
  });
});
