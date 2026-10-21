import { Eye, Play, Save } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { RAG_MAP_SLOTS, RAG_PROTOCOLS, RAG_TARGET_PRESETS, assignSlot, emptyMapping, findRagTargetPreset, ragStepTemplate, type RagLimits, type RagMapSlot, type RagMapping, type RagProtocol, type RagTarget } from '@testpion/shared';
import type { AiTaskResult, RagProbe, RagSample } from '@testpion/core';
import { asError, call } from '../../api';
import { toastError, useApp } from '../../store';
import { toastAiError } from '../../lib/ai-errors';
import { AiAction } from '../ai/AiAction';
import { useLibrary } from '../../lib/library';
import { parseYaml, stringifyYaml } from '../../lib/yaml';
import { Badge, Button, Callout, Field, FooterHint, Input, Modal, Select, Spinner, Toggle, type MenuItem } from '../ui';
import { CodeEditor } from '../CodeEditor';
import { JsonTree } from '../JsonView';
import { AiPreviewDialog } from '../ai/AiPreviewDialog';

/** The stored form of a target in the library: its name is the item's. */
export type SavedRagTarget = RagTarget;

const slotValue = (m: RagMapping, slot: RagMapSlot): string => {
  switch (slot) {
    case 'answer':
    case 'answer.pieces':
      return m.answer;
    case 'contexts':
      return m.contexts ?? '';
    case 'latencyMs':
      return m.latencyMs ?? '';
    case 'toolCalls':
      return m.toolCalls ?? '';
    case 'toolCall.name':
    case 'toolCall.arguments':
      return m.toolCall?.[slot.slice(9) as 'name'] ?? '';
    case 'conversationId':
      return m.conversationId ?? '';
    default:
      return slot.startsWith('usage.') ? (m.usage?.[slot.slice(6) as 'input'] ?? '') : (m.context?.[slot.slice(8) as 'text'] ?? '');
  }
};

/** The mapping with one slot typed in by hand ("" clears it). */
function setSlotText(m: RagMapping, slot: RagMapSlot, text: string): RagMapping {
  const v = text.trim() || undefined;
  if (slot === 'answer') return { ...m, answer: text.trim() };
  if (slot === 'contexts') return { ...m, contexts: v };
  if (slot === 'latencyMs') return { ...m, latencyMs: v };
  if (slot === 'toolCalls') return { ...m, toolCalls: v };
  if (slot === 'conversationId') return { ...m, conversationId: v };
  if (slot === 'toolCall.name' || slot === 'toolCall.arguments') return { ...m, toolCall: { ...m.toolCall, [slot.slice(9)]: v } };
  if (slot.startsWith('usage.')) return { ...m, usage: { ...m.usage, [slot.slice(6)]: v } };
  return { ...m, context: { ...m.context, [slot.slice(8)]: v } };
}

const FIELD_SLOTS = RAG_MAP_SLOTS.filter((s) => s.slot !== 'answer.pieces');

/**
 * Connect a RAG system: write its request (a step of any protocol), probe it with a question, click the answer, the list
 * of retrieved contexts and their fields in the sample response (each click writes a JSONPath into the mapping, which
 * can also be typed), see the sample the mapping reads, and save the target. The one dialog for new and existing targets,
 * opened from AI Lab ▸ RAG and from an evaluation of type RAG.
 */
export function RagConnectDialog({ id, onClose, onSaved }: { id?: string; onClose(): void; onSaved?(id: string, name: string): void }) {
  const env = useApp((s) => s.environment);
  const targets = useLibrary<SavedRagTarget>('rag-targets');
  const existing = id ? targets.lib.items.find((i) => i.id === id) : undefined;
  const [name, setName] = useState('');
  const [protocol, setProtocol] = useState<RagProtocol>('http');
  const [stepText, setStepText] = useState(() => ragStepTemplate('http'));
  const [mapping, setMapping] = useState<RagMapping>(emptyMapping());
  const [readOnly, setReadOnly] = useState(false);
  const [limits, setLimits] = useState<RagLimits>({});
  const [conversation, setConversation] = useState<'' | 'stateless-history' | 'server-session'>('');
  const [cookies, setCookies] = useState(false);
  const [presetId, setPresetId] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [suggestNotes, setSuggestNotes] = useState<string[]>([]);
  const [question, setQuestion] = useState('What time does the clinic open?');
  const [probe, setProbe] = useState<RagProbe>();
  const [sample, setSample] = useState<RagSample>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [judgePreview, setJudgePreview] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // an existing target fills the form once (the library loads after the dialog opens)
  useEffect(() => {
    if (!existing || loaded) return;
    setLoaded(true);
    setName(existing.name);
    setProtocol(existing.data.protocol);
    setStepText(stringifyYaml(existing.data.step));
    setMapping(existing.data.mapping ?? emptyMapping());
    setReadOnly(existing.data.readOnly === true);
    setLimits(existing.data.limits ?? {});
    setConversation(existing.data.conversation?.mode ?? '');
    setCookies(existing.data.conversation?.cookies === true);
  }, [existing, loaded]);

  const parsed = useMemo((): { step?: Record<string, unknown>; problem?: string } => {
    try {
      const v = parseYaml(stepText);
      return v && typeof v === 'object' && !Array.isArray(v) ? { step: v as Record<string, unknown> } : { problem: 'The request must be a YAML mapping (type, url, …).' };
    } catch (e) {
      return { problem: (e as Error).message.split('\n')[0] };
    }
  }, [stepText]);
  const cleanLimits = Object.fromEntries(Object.entries(limits).filter(([, v]) => typeof v === 'number' && v >= 0)) as RagLimits;
  const target: RagTarget | undefined = parsed.step ? { protocol, step: parsed.step, mapping, ...(readOnly ? { readOnly: true } : {}), ...(Object.keys(cleanLimits).length ? { limits: cleanLimits } : {}), ...(conversation ? { conversation: { mode: conversation, ...(conversation === 'server-session' && cookies ? { cookies: true } : {}) } } : {}) } : undefined;

  /** One-click start from a framework's request and mapping (OpenAI-compatible, LangServe, LlamaIndex, Haystack, Dify, Flowise …). */
  const applyPreset = (id: string) => {
    setPresetId(id);
    const preset = findRagTargetPreset(id);
    if (!preset) return;
    setProtocol(preset.protocol);
    setStepText(stringifyYaml(preset.step));
    setMapping(JSON.parse(JSON.stringify(preset.mapping)) as RagMapping);
    setProbe(undefined);
    setSample(undefined);
    setSuggestNotes(preset.note ? [preset.note] : []);
    if (!name.trim()) setName(preset.name.replace(/ \(.*$/, ''));
  };

  /** AI "Suggest mapping": the model reads the sample response; TestPion has already applied what it suggested (the engine's verifier). */
  const suggest = async () => {
    if (!probe) return;
    setSuggesting(true);
    setSuggestNotes([]);
    try {
      const r = await call<AiTaskResult>('ai.runTask', { task: 'rag-suggest-mapping', context: { response: probe.response.doc, question, protocol }, environment: env });
      const v = r.value as { mapping?: RagMapping; notes?: string[] } | undefined;
      if (v?.mapping) setMapping(v.mapping);
      setSuggestNotes([...(v?.notes ?? []), ...r.problems.map((p) => `The suggestion still has a problem: ${p}`)]);
      if (v?.mapping && !r.problems.length) useApp.getState().toast('The suggested mapping reads an answer from the sample. Check it, then save.', 'success');
    } catch (e) {
      toastAiError(e);
    } finally {
      setSuggesting(false);
    }
  };

  const doProbe = async () => {
    if (!target) return;
    setBusy(true);
    setError(undefined);
    try {
      const p = await call<RagProbe>('rag.probe', { target, question, environment: env });
      setProbe(p);
      setSample(p.sample);
    } catch (e) {
      setError(asError(e).message);
    } finally {
      setBusy(false);
    }
  };

  // the sample the mapping reads from the response already seen, as the mapping changes (no new call)
  useEffect(() => {
    if (!probe) return;
    let live = true;
    const t = setTimeout(() => {
      call<RagSample>('rag.map', { response: { doc: probe.response.doc, text: probe.response.text, kind: probe.response.kind }, mapping }).then(
        (s) => live && setSample(s),
        () => undefined,
      );
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [probe, mapping]);

  const pick = (row: { path: string; value: unknown }): MenuItem[] =>
    RAG_MAP_SLOTS.map((s) => {
      const scalar = row.value === null || typeof row.value !== 'object';
      const list = Array.isArray(row.value);
      return {
        label: `This is: ${s.label}`,
        disabled: s.slot === 'contexts' ? !list : s.item || s.slot === 'answer' || s.slot === 'answer.pieces' ? !scalar && s.slot !== 'context.text' : !scalar,
        title: s.slot === 'contexts' ? 'Click a list (an array) of retrieved documents' : undefined,
        onSelect: () => {
          const r = assignSlot(mapping, s.slot, row.path);
          if ('problem' in r) useApp.getState().toast(r.problem, 'error');
          else setMapping(r.mapping);
        },
      };
    });

  const problems = useMemo(() => {
    const out: string[] = [];
    if (!name.trim()) out.push('Give the target a name.');
    if (parsed.problem) out.push(`Request: ${parsed.problem}`);
    if (!mapping.answer.trim()) out.push('Map the answer: probe, then click it in the sample response.');
    return out;
  }, [name, parsed.problem, mapping.answer]);

  const save = async () => {
    if (!target) return;
    try {
      const { problems: p } = await call<{ problems: string[] }>('rag.check', { target });
      if (p.length) return void setError(p[0]);
      const savedId = await targets.put({ id, name: name.trim(), folder: existing?.folder, data: target });
      useApp.getState().toast(`Saved the RAG target "${name.trim()}"`, 'success');
      onSaved?.(savedId, name.trim());
      onClose();
    } catch (e) {
      toastError(e);
    }
  };

  const judgeLoad = () =>
    call<{ preview: AiTaskResult['preview'] }>('rag.judgePreview', {
      metric: 'faithfulness',
      sample: { question, answer: sample?.answer ?? '', contexts: sample?.contexts ?? [] },
      environment: env,
    }).then((r) => r.preview);

  return (
    <>
      <Modal
        title={existing ? `RAG target · ${existing.name}` : 'Connect a RAG system'}
        onClose={onClose}
        width={1040}
        footer={
          <>
            <Button icon={<Eye size={13} />} disabled={!sample?.answer} onClick={() => setJudgePreview(true)} title="The exact prompt a judged metric (faithfulness) would send for this sample, before anything is sent" className="mr-auto">
              What the judge receives
            </Button>
            <FooterHint>{problems[0]}</FooterHint>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" icon={<Save size={13} />} disabled={problems.length > 0} onClick={() => void save()} data-rag-save>
              Save target
            </Button>
          </>
        }
      >
        <div className="grid gap-3 text-sm" data-rag-connect>
          <div className="grid grid-cols-[1fr_14rem_14rem] gap-2">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Clinic support bot" aria-label="Target name" data-rag-name />
            </Field>
            <Field label="Start from">
              <Select value={presetId} onChange={(e) => applyPreset(e.target.value)} aria-label="Start from a preset" data-rag-preset-select>
                <option value="">A blank request</option>
                {RAG_TARGET_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Protocol">
              <Select
                value={protocol}
                aria-label="Protocol"
                onChange={(e) => {
                  const next = e.target.value as RagProtocol;
                  // a template replaces the request only while it is still the previous protocol's template
                  if (stepText === ragStepTemplate(protocol)) setStepText(ragStepTemplate(next));
                  setProtocol(next);
                }}
              >
                {RAG_PROTOCOLS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3 min-h-0">
            <div className="flex flex-col gap-2 min-w-0">
              <Field label="Request" hint={<>The question is <code>{'{{question}}'}</code> (<code>{'{{questionJson}}'}</code> inside a JSON text). Use <code>{'{{variables}}'}</code> and secrets for hosts and keys.</>}>
                <div className="h-44 border border-line rounded-md overflow-hidden" data-rag-step>
                  <CodeEditor language="yaml" value={stepText} onChange={setStepText} />
                </div>
              </Field>
              <Toggle checked={readOnly} onChange={setReadOnly} label="This endpoint only answers questions: a production environment may call it" />
              <label className="flex items-center gap-1.5 text-xs" title="A dataset record with `turns` is replayed turn by turn. History in each request: the request uses {{messages}} (or {{history}}, {{historyText}}). Server session: click the conversation id in the sample response; the request uses {{conversationId}}." data-rag-conversation>
                Conversations
                <Select className="h-7 min-h-7 py-0 text-xs flex-1" value={conversation} onChange={(e) => setConversation(e.target.value as typeof conversation)} aria-label="How the system keeps a conversation">
                  <option value="">one question per call</option>
                  <option value="stateless-history">the request carries the history ({'{{messages}}'})</option>
                  <option value="server-session">the system keeps a session ({'{{conversationId}}'})</option>
                </Select>
              </label>
              {conversation === 'server-session' && <Toggle checked={cookies} onChange={setCookies} label="The session is a cookie: send the cookies each answer sets with the next turn" title="Only within one conversation; the values are treated as secrets and never written to a result" data-rag-conversation-cookies />}
              <details className="text-xs rounded-lg border border-line px-2 py-1" data-rag-limits>
                <summary className="cursor-pointer text-muted select-none">Limits on the calls an evaluation makes{Object.keys(cleanLimits).length ? ' · set' : ''}</summary>
                <div className="grid grid-cols-4 gap-2 mt-2 pb-1">
                  {(
                    [
                      ['concurrency', 'At once', 'The most calls in flight, however many workers the evaluation has'],
                      ['requestsPerMinute', 'Per minute', 'The most requests started in a minute'],
                      ['timeoutMs', 'Timeout (ms)', 'How long one call may take'],
                      ['retries', 'Retries', 'How often a call that failed on the server’s side is tried again'],
                    ] as const
                  ).map(([k, label, hint]) => (
                    <Field key={k} label={label} hint={undefined}>
                      <Input type="number" min={k === 'retries' ? 0 : 1} className="h-7 min-h-7 text-xs" title={hint} value={limits[k] ?? ''} placeholder="no limit" onChange={(e) => setLimits({ ...limits, [k]: e.target.value === '' ? undefined : Number(e.target.value) })} aria-label={label} data-rag-limit={k} />
                    </Field>
                  ))}
                </div>
              </details>
              <div className="flex items-center gap-2">
                <Input className="flex-1" value={question} onChange={(e) => setQuestion(e.target.value)} aria-label="Probe question" data-rag-question onKeyDown={(e) => e.key === 'Enter' && void doProbe()} />
                <Button variant="primary" icon={busy ? <Spinner /> : <Play size={13} />} disabled={!target || busy || !question.trim()} onClick={() => void doProbe()} data-rag-probe>
                  Probe
                </Button>
              </div>
              {error && <Callout tone="bad">{error}</Callout>}
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted">Mapping</span>
                {probe && (
                  <AiAction
                    className="ml-auto"
                    label={suggesting ? 'Reading the response …' : 'Suggest mapping'}
                    hint="The AI reads the sample response and proposes where the answer and the retrieved documents are. TestPion applies the proposal to the sample first and sends a mapping that reads nothing back to the model."
                    request={{ task: 'rag-suggest-mapping', title: 'Suggest the mapping', context: { response: probe.response.doc, question, protocol } }}
                    open={() => void suggest()}
                  />
                )}
              </div>
              {suggestNotes.map((n) => (
                <div key={n} className="text-xs text-warn" data-rag-suggest-note>
                  {n}
                </div>
              ))}
              <div className="grid grid-cols-[9rem_1fr] gap-x-2 gap-y-1 items-center" data-rag-mapping>
                {FIELD_SLOTS.map((s) => (
                  <label key={s.slot} className="contents">
                    <span className="text-xs text-muted truncate" title={s.label}>
                      {s.label.replace('The list of retrieved contexts', 'Contexts (list)').replace('The answer', 'Answer')}
                    </span>
                    <Input className="mono h-7 min-h-7 text-xs" value={slotValue(mapping, s.slot)} placeholder={s.item ? 'relative to one context, e.g. $.text' : '$.…'} onChange={(e) => setMapping(setSlotText(mapping, s.slot, e.target.value))} aria-label={s.label} data-rag-slot={s.slot} />
                  </label>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-2 min-w-0">
              <div className="text-xs text-muted">Sample response {probe && <Badge>{probe.response.kind === 'sse' ? 'event stream' : probe.response.kind}{probe.status !== undefined ? ` · ${probe.status}` : ''} · {probe.latencyMs} ms</Badge>}</div>
              <div className="h-52 border border-line rounded-md overflow-hidden" data-rag-response>
                {probe ? (
                  <JsonTree data={probe.response.doc} pickItems={pick} hint="Click a key, then choose what it is: the answer, the list of contexts, a context's text or id …" />
                ) : (
                  <div className="h-full grid place-items-center text-muted text-xs p-4 text-center">Probe the system with a question, then click the answer and the retrieved documents in its response.</div>
                )}
              </div>
              <div className="text-xs text-muted">What the mapping reads</div>
              <div className="border border-line rounded-md p-2 min-h-24 text-xs flex flex-col gap-1" data-rag-sample>
                {sample ? (
                  <>
                    <div>
                      <span className="text-muted">Answer </span>
                      {sample.answer ? <span data-rag-answer>{sample.answer}</span> : <span className="text-bad">none yet</span>}
                    </div>
                    {sample.contexts.length > 0 && (
                      <table className="w-full">
                        <tbody>
                          {sample.contexts.map((d) => (
                            <tr key={d.id} className="border-t border-line/60 align-top">
                              <td className="mono pr-2 whitespace-nowrap">{d.id}</td>
                              <td className="pr-2 text-muted whitespace-nowrap">{d.score ?? ''}</td>
                              <td>{d.text.length > 160 ? `${d.text.slice(0, 159)}…` : d.text}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {sample.usage && <div className="text-muted">tokens {JSON.stringify(sample.usage)}</div>}
                    {sample.latencyMs !== undefined && <div className="text-muted">latency {sample.latencyMs} ms</div>}
                    {sample.warnings.map((w, i) => (
                      <div key={i} className="text-warn">
                        {w}
                      </div>
                    ))}
                  </>
                ) : (
                  <span className="text-muted">Nothing yet.</span>
                )}
              </div>
            </div>
          </div>
        </div>
      </Modal>
      {judgePreview && <AiPreviewDialog request={{ title: 'Faithfulness judge' }} load={judgeLoad} onClose={() => setJudgePreview(false)} />}
    </>
  );
}

