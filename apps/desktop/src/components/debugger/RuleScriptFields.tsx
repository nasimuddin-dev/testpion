import { FileCode, Pencil, Play, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { call, asError } from '../../api';
import { Badge, Button, Empty, Field, Input, Select } from '../ui';
import { CodeEditor } from '../CodeEditor';
import type { Rule } from '../DebuggerRules';

/**
 * The rule editor's block for a script rule (FG-21): the JavaScript with the same editor the request scripts use, how long a hook may
 * run, and a test on a captured exchange that says what the script would do (it sends nothing and changes nothing).
 */
type SetRule = (patch: Partial<Rule>) => void;

export const SCRIPT_TEMPLATE = `// Runs for the requests this rule matches. Define either hook, or both.
function onRequest(ctx) {
  // ctx.request: method, url, host, headers (lower-case names), body (text, or undefined)
  // ctx.request.headers['x-env'] = 'staging';        // set a header; \`delete\` removes one
  // ctx.reply(403, { error: 'blocked' });             // answer here: the server never sees the request
  // ctx.delay(200); ctx.highlight('red'); console.log('seen', ctx.request.url);
}

function onResponse(ctx) {
  // ctx.response: status, headers, body (text): change them to change what the program receives
  // if (ctx.response.status === 500) ctx.response.status = 503;
}
`;

interface Tested {
  ok: boolean;
  matches: boolean;
  phases: Array<{ phase: 'request' | 'response'; ran: boolean; noHook?: boolean; error?: string; ms: number; logs: string[]; does: string[] }>;
}
interface Row {
  id: string;
  method: string;
  url: string;
}

export function ScriptFields({ r, set }: { r: Partial<Rule>; set: SetRule }) {
  const script = r.script ?? { code: SCRIPT_TEMPLATE };
  const [rows, setRows] = useState<Row[]>();
  const [pick, setPick] = useState('');
  const [result, setResult] = useState<Tested>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    void call<Row[]>('debug.exchanges', { limit: 40, kind: 'http' }).then(
      (x) => {
        if (!live) return;
        setRows(x);
        setPick((p) => p || x.at(-1)?.id || '');
      },
      () => live && setRows([]),
    );
    return () => {
      live = false;
    };
  }, [reload]);
  const hasCode = script.code !== undefined ? script.code.trim().length > 0 : !!script.file;
  const test = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setResult(await call<Tested>('debug.testScript', { rule: { ...r, kind: 'script', script }, id: pick }));
    } catch (e) {
      setResult(undefined);
      setError(asError(e).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {script.file === undefined ? (
        <Field label="Script" hint="onRequest(ctx) and / or onResponse(ctx). No network, files or secrets; a hook that fails or runs too long is skipped and the traffic goes on.">
          <div className="h-64 rounded border border-line overflow-hidden" data-rule-script-editor>
            <CodeEditor value={script.code ?? ''} onChange={(code) => set({ script: { ...script, code } })} language="javascript" path="debugger-rule-script.js" />
          </div>
        </Field>
      ) : (
        <Field label="Script file" hint="A file of the workspace, read at every request. Edit it in your editor; it is saved with your project.">
          <Input className="mono" value={script.file} onChange={(e) => set({ script: { ...script, file: e.target.value } })} placeholder="debugger/scripts/auth.js" />
        </Field>
      )}
      <div className="grid grid-cols-2 gap-3 items-end">
        <Field label="Time a hook may run (ms)" hint="10 to 2000; default 100">
          <Input type="number" min={10} max={2000} value={script.timeoutMs ?? ''} onChange={(e) => set({ script: { ...script, timeoutMs: e.target.value ? Number(e.target.value) : undefined } })} />
        </Field>
        <div>
          <Button size="sm" icon={script.file === undefined ? <FileCode size={12} /> : <Pencil size={12} />} onClick={() => set({ script: script.file === undefined ? { file: '', timeoutMs: script.timeoutMs } : { code: SCRIPT_TEMPLATE, timeoutMs: script.timeoutMs } })}>
            {script.file === undefined ? 'Use a file instead' : 'Write it here instead'}
          </Button>
        </div>
      </div>
      <Field label="Test on a captured exchange" hint="Runs both hooks on it and says what the script would do. Nothing is sent.">
        {rows && rows.length === 0 ? (
          <Empty title="Nothing captured yet" actions={[{ label: 'Check again', icon: <RotateCcw size={13} />, onClick: () => setReload((n) => n + 1) }]}>Capture some traffic, then come back to test the script on one of its exchanges.</Empty>
        ) : (
          <div className="flex items-center gap-2">
            <Select className="flex-1 min-w-0" aria-label="Exchange to test on" value={pick} onChange={(e) => setPick(e.target.value)}>
              {(rows ?? []).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.method} {x.url.length > 80 ? `${x.url.slice(0, 80)}…` : x.url}
                </option>
              ))}
            </Select>
            <Button icon={<Play size={13} />} loading={busy} disabled={!pick || !hasCode} reason={!hasCode ? 'Write the script first' : 'Pick an exchange to test on'} onClick={() => void test()} data-script-test>
              Test
            </Button>
          </div>
        )}
        {error && <div className="mt-2 text-xs text-bad">{error}</div>}
        {result && (
          <div className="mt-2 grid gap-2 text-xs" data-script-result>
            {!result.matches && <div className="text-warn">This exchange does not match the rule's Matches, so the script would not run for it. The result below is what it does if it did.</div>}
            {result.phases.map((p) => (
              <div key={p.phase} className="rounded border border-line p-2 grid gap-1" data-script-phase={p.phase}>
                <div className="flex items-center gap-2">
                  <b>{p.phase === 'request' ? 'onRequest' : 'onResponse'}</b>
                  {p.error ? <Badge tone="bad">failed</Badge> : p.noHook ? <Badge>not defined</Badge> : <Badge tone="ok">{p.ms} ms</Badge>}
                </div>
                {p.error && <div className="text-bad mono">{p.error}</div>}
                {p.does.length > 0 ? p.does.map((d) => <div key={d}>It {d}.</div>) : !p.error && !p.noHook && <div className="text-muted">It changes nothing.</div>}
                {p.logs.map((l, i) => (
                  <div key={i} className="mono text-muted">
                    log: {l}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </Field>
    </>
  );
}
