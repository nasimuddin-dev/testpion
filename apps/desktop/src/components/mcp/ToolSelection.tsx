import { useCallback, useEffect, useState } from 'react';
import { call } from '../../api';
import { toastError, useApp } from '../../store';
import { plural } from '../../lib/format';
import { Badge, Busy, Button, ListInput } from '../ui';

interface Info {
  file: string;
  exists: boolean;
  cases: number;
}
interface Miss {
  ask: string;
  expected: string;
  picked: string;
}
interface ModelResult {
  model: string;
  cases: number;
  correct: number;
  accuracy: number;
  errors: number;
  firstError?: string;
  misses: Miss[];
  confusions: Array<{ expected: string; picked: string; count: number }>;
  usage: { inputTokens: number; outputTokens: number };
  costUsd?: number;
}
interface Run {
  text: string;
  models: ModelResult[];
  missedByAll: Miss[];
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

/**
 * "Which tool does each model pick?" (Server info): the cases of this server (a request a user would type and the tool
 * it needs, kept in datasets/), written with AI and corrected by a person, asked of each model with the tool list
 * offered. No tool is called. The same run as `testpion mcp --select` and the MCP tool `mcp_server_tools` with select.
 */
export function ToolSelection({ serverId }: { serverId: string }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [busy, setBusy] = useState<'cases' | 'run' | null>(null);
  const load = useCallback(() => {
    call<Info>('mcp.selectionInfo', { serverId })
      .then(setInfo)
      .catch(() => setInfo(null));
  }, [serverId]);
  useEffect(() => {
    setInfo(null);
    setRun(null);
    load();
  }, [load]);
  if (!info) return null;
  const write = () => {
    setBusy('cases');
    call<{ file: string; cases: number; uncovered: string[]; model: string }>('mcp.selectionCases', { serverId, force: info.exists })
      .then((r) => {
        useApp
          .getState()
          .toast(
            `Wrote ${plural(r.cases, 'case')} to ${r.file} with ${r.model}. AI-generated: read them before you rely on them.${r.uncovered.length ? ` No case for: ${r.uncovered.slice(0, 5).join(', ')}.` : ''}`,
            'success',
          );
        load();
      })
      .catch(toastError)
      .finally(() => setBusy(null));
  };
  const ask = () => {
    setBusy('run');
    call<Run>('mcp.selection', { serverId, models })
      .then(setRun)
      .catch(toastError)
      .finally(() => setBusy(null));
  };
  const noRun = !info.cases ? 'Write the cases first' : !models.length ? 'Name at least one model (provider/model)' : undefined;
  return (
    <section className="px-3 py-2 border-b border-line text-sm" data-mcp-selection={run ? 'ran' : info.cases ? 'ready' : 'empty'} aria-label="Which tool does each model pick?">
      <div className="flex items-center gap-2">
        <h3 className="font-medium">Which tool does each model pick?</h3>
        <div className="flex-1" />
        <Button
          size="sm"
          variant={info.cases ? 'ghost' : 'primary'}
          disabled={!!busy}
          title="The AI assistant writes requests a user would type, each with the tool it needs"
          onClick={write}
          data-mcp-selection-write
        >
          {info.exists ? 'Write the cases again' : 'Write cases with AI'}
        </Button>
      </div>
      <p className="text-muted text-xs mt-0.5" data-mcp-selection-text>
        {info.cases
          ? `${plural(info.cases, 'case')} in ${info.file}: a request a user would type and the tool it needs. Each model is offered the tool list and asked once; no tool is called.`
          : `A model chooses a tool by its name and description, and what one model understands another does not. Write cases (kept in ${info.file}; read and correct them), then ask the models.`}
      </p>
      {info.cases > 0 && (
        <div className="mt-1.5 flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <ListInput value={models} onValue={setModels} placeholder="provider/model, provider/model" aria-label="Models to ask" data-mcp-selection-models />
          </div>
          <Button size="sm" variant="primary" disabled={!!busy || !!noRun} reason={noRun} onClick={ask} data-mcp-selection-run>
            Ask the models
          </Button>
        </div>
      )}
      {busy && <Busy inline>{busy === 'cases' ? 'Writing the cases…' : 'Asking the models…'}</Busy>}
      {run && (
        <div className="mt-1.5 grid gap-1.5" data-mcp-selection-result>
          <p className="text-xs">{run.text}</p>
          {run.models.map((m) => (
            <div key={m.model} className="text-xs" data-mcp-selection-model={m.model}>
              <div className="flex items-center gap-2">
                <Badge tone={m.errors === m.cases ? 'bad' : m.accuracy >= 0.9 ? 'ok' : 'warn'}>{m.errors === m.cases ? 'No answer' : pct(m.accuracy)}</Badge>
                <span className="font-medium">{m.model}</span>
                <span className="text-muted">
                  {m.correct} of {m.cases - m.errors} right · {m.usage.inputTokens} in / {m.usage.outputTokens} out{m.costUsd !== undefined ? ` · $${m.costUsd.toFixed(4)}` : ''}
                </span>
              </div>
              {m.errors > 0 && (
                <div className="text-bad mt-0.5">
                  {plural(m.errors, 'request')} not answered{m.firstError ? `: ${m.firstError}` : ''}
                </div>
              )}
              {m.confusions.map((x) => (
                <div key={`${x.expected}-${x.picked}`} className="mt-0.5">
                  Confuses <code>{x.expected}</code> with <code>{x.picked}</code> ({x.count}×): make their descriptions say when to use which.
                </div>
              ))}
              {m.misses.length > 0 && (
                <ul className="mt-0.5 grid gap-0.5 max-h-40 overflow-auto">
                  {m.misses.map((x, i) => (
                    <li key={`${x.ask}-${i}`} className="text-muted" data-mcp-selection-miss>
                      “{x.ask}” needed <code>{x.expected}</code>, chose <code>{x.picked}</code>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          {run.missedByAll.length > 0 && <p className="text-xs">Every model missed {plural(run.missedByAll.length, 'request')}: the description is probably at fault, not a model.</p>}
        </div>
      )}
    </section>
  );
}
