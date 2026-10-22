import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { OUTPUT_FORMATS, OUTPUT_SURFACES } from '../../packages/shared/src/index.js';
import { RPC_PARAMS } from '../../apps/desktop/backend/rpc-params.js';
import { COMMANDS } from '../../apps/desktop/src/lib/shortcuts.js';

/**
 * Every output of the app can be saved, the same way (planning/output-export.md §3f): each panel that shows a response
 * or a result is a surface of OUTPUT_SURFACES, marked `data-output="<id>"`, and gets the shared down arrow through
 * OutputActions / OutputHeader. A new result panel without it, or a private way of saving a file, fails here.
 */
const root = join(__dirname, '..', '..');
const src = join(root, 'apps', 'desktop', 'src');
const rel = (f: string) => relative(src, f).split(sep).join('/');

function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const sources = files(src).map((f) => ({ file: rel(f), text: readFileSync(f, 'utf8') }));
const shared = (f: string) => f.startsWith('components/output/') || f === 'lib/files.ts';

/**
 * Saves that are not the shared control, each with why. `definition`: exports of what you edit (a collection, an
 * environment, the workspace, your key bindings, a CI file, a feedback report, a certificate) through their own export
 * dialogs, not outputs. (Every output of planning/output-export.md is on the control now; a new
 * private save of an output is not allowed here.)
 */
const ALLOWED: Record<string, string> = {
  // B-22: Export… of any item or section as a TestPion bundle (the backend's saveOrDownload, then finishSave)
  'components/ExportBundleDialog.tsx': 'definition: export of items as a bundle',
  'components/KeyboardSettings.tsx': 'definition: key bindings export',
  'components/CiDialog.tsx': 'definition: a CI pipeline file',
  'components/FeedbackDialog.tsx': 'definition: a feedback report',
  'components/DebuggerTools.tsx': "definition: the Debugger's CA certificate",
  'views/TestsView.tsx': 'definition: an Arazzo workflow export',
  'views/EvaluationsView.tsx': 'definition: a RAG dataset exported as Ragas or DeepEval records',
  'components/ImportReport.tsx': 'definition: the compatibility report of an import (JSON, Markdown)',
};
const PRIVATE_SAVE = /\bsaveText\b|URL\.createObjectURL\(|\.download\s*=|\bdownload=|\bdownloadContent\(|\bfinishSave\(/;

const markers = sources.flatMap((s) => [...s.text.matchAll(/data-output="([^"]+)"/g)].map((m) => ({ file: s.file, id: m[1]! })));
const byId = new Map(OUTPUT_SURFACES.map((s) => [s.id, s]));

describe('output surfaces', () => {
  it('every surface has formats the registry knows', () => {
    for (const s of OUTPUT_SURFACES) {
      expect(s.formats.length, s.id).toBeGreaterThan(0);
      for (const f of s.formats) expect(OUTPUT_FORMATS[f], `${s.id}: ${f}`).toBeDefined();
    }
  });

  it('a marked panel is a registered surface, marked with a literal id', () => {
    expect(markers.filter((m) => !byId.has(m.id)).map((m) => `${m.file}: ${m.id}`)).toEqual([]);
    expect(sources.filter((s) => /data-output=\{/.test(s.text)).map((s) => s.file)).toEqual([]);
  });

  it('every shipped surface is marked in exactly one file, and a planned one is not marked yet', () => {
    for (const s of OUTPUT_SURFACES) {
      const where = [...new Set(markers.filter((m) => m.id === s.id).map((m) => m.file))];
      if (s.state === true) expect(where, s.id).toHaveLength(1);
      else expect(where, `${s.id} is marked: set its state to true`).toEqual([]);
    }
  });

  it('a marked file puts the shared control in its bar (OutputActions / OutputHeader), and only the bars render the control', () => {
    const marked = [...new Set(markers.map((m) => m.file))];
    expect(marked.filter((f) => !/<Output(Actions|Header)\b/.test(sources.find((s) => s.file === f)!.text))).toEqual([]);
    expect(sources.filter((s) => /<OutputDownload\b/.test(s.text)).map((s) => s.file)).toEqual(['components/output/OutputFrame.tsx']);
  });

  it('no private way of saving a file outside the shared module (allow-list: definitions)', () => {
    const offenders = sources.filter((s) => !shared(s.file) && PRIVATE_SAVE.test(s.text)).map((s) => s.file);
    expect(offenders.filter((f) => !(f in ALLOWED))).toEqual([]);
    // an allowed file that no longer saves privately leaves the list
    expect(Object.keys(ALLOWED).filter((f) => !offenders.includes(f))).toEqual([]);
    for (const why of Object.values(ALLOWED)) expect(why).toMatch(/^definition: .{8,}/);
  });

  it('a component that renders a response or a result view is a marked surface or a reviewed exception', () => {
    // the views a result is shown in; a file that renders one must be marked (or be one of these reviewed places)
    const RESULT_VIEWS = /<(JsonTree|JsonTable|RawView|SseEvents|CheckList|TraceView|JwtView|EvalMatrix|RunPanel|RunTimeline)\b/;
    const REVIEWED: Record<string, string> = {
      'components/ResponseViewer.tsx': 'marked per tab',
      'components/JwtView.tsx': 'inside response.jwt',
      'components/TraceView.tsx': 'inside response.trace',
      'views/RestView.tsx': 'the live event list (SseEvents is marked itself)',
      'components/CollectionRunner.tsx': 'renders RunPanel (marked run.results)',
      'views/EvaluationsView.tsx': 'renders RunPanel / EvalMatrix (marked)',
      'views/TestsView.tsx': 'renders RunPanel / RunTimeline (marked)',
      'components/FlowRunDock.tsx': 'renders RunPanel / RunTimeline (marked)',
      'views/DatasetView.tsx': 'a dataset (a definition you edit), not an output',
      'components/rag/RagSampleDetail.tsx': 'one sample of a run, opened from a cell of the metrics matrix (a view of a result the run panel already offers to download)',
      'components/rag/RagConnectDialog.tsx': 'the sample response a RAG target’s mapping is made from (part of a definition you edit), not an output',
    };
    const unmarked = sources.filter((s) => RESULT_VIEWS.test(s.text) && !/data-output="/.test(s.text) && !(s.file in REVIEWED)).map((s) => s.file);
    expect(unmarked, 'a new result panel: give it an OUTPUT_SURFACES id, data-output and OutputActions / OutputHeader').toEqual([]);
    // a reviewed place that no longer renders a result view leaves the list
    expect(Object.keys(REVIEWED).filter((f) => !RESULT_VIEWS.test(sources.find((s) => s.file === f)?.text ?? ''))).toEqual([]);
  });

  it('the output RPCs check their parameters', () => {
    for (const m of ['output.save', 'output.copy', 'output.cancel', 'output.reveal']) expect(RPC_PARAMS[m], m).toBeDefined();
  });

  it('Ctrl+Shift+S downloads the focused output and no other command has it', () => {
    const c = COMMANDS.find((x) => x.id === 'download-output');
    expect(c?.combo).toBe('Mod+Shift+S');
    expect(COMMANDS.filter((x) => x.combo === 'Mod+Shift+S')).toHaveLength(1);
  });
});
