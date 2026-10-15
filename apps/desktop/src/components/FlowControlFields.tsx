import { useState } from 'react';
import type { FlowStep } from '@testpion/shared';
import { toastError } from '../store';
import type { KeyValue } from '../types';
import { asMap, asRows, asText, useCommitted } from './FlowBlockFields';
import { KeyValueEditor } from './KeyValueEditor';
import { VarInput } from './VarInput';
import { Field, Input, SectionTitle, Select, Toggle } from './ui';

/**
 * The flow designer's fields for the third release's blocks (FlowDesigner's inspector): a Set variable's names, values
 * and scope; an Assert's subject (its checks are the inspector's AssertionEditor); a request's Wait until (expression,
 * interval, timeout, backoff); and for any step its parallel group and whether it is a finally step. Every change is
 * one tests.flowEdit updateStep through `update`, like the other fields.
 */

/** The steps that are requests (a Wait until runs one again). */
export const POLLABLE = new Set(['http', 'graphql', 'grpc', 'websocket', 'mcp', 'llm', 'rag', 'agent', 'flow']);

/** A Set variable step's values and scope, or an Assert step's subject; null for the other types. */
export function ControlBlockFields({ step, raw, update }: { step: FlowStep; raw: Record<string, unknown>; update(set: Record<string, unknown>): Promise<unknown> }) {
  const [values, setValues] = useCommitted<KeyValue[]>(asRows(raw.set ?? raw.values), (rows) => {
    const m = asMap(rows);
    if (!m) return toastError(new Error('A Set variable step writes at least one variable'));
    return update({ set: m, ...(raw.values !== undefined ? { values: null } : {}) });
  });
  if (step.type === 'set')
    return (
      <>
        <SectionTitle>Set variables</SectionTitle>
        <Field label="Variables" hint='Values are templates: {{token}}, "Bearer {{token}}"; "{{count}}" alone keeps its type'>
          <div data-inspector-set>
            <KeyValueEditor rows={values} onChange={setValues} keyPlaceholder="Variable" valuePlaceholder="{{value}}" />
          </div>
        </Field>
        <Field label="Scope" hint="The environment, collection and global values are kept like a script's tp.environment.set (current values); the CLI keeps them for the run">
          <Select aria-label="Scope" data-inspector-scope value={String(raw.scope ?? 'run')} onChange={(e) => void update({ scope: e.target.value === 'run' ? null : e.target.value })}>
            <option value="run">This run only</option>
            <option value="environment">Environment</option>
            <option value="collection">Collection</option>
            <option value="global">Global</option>
          </Select>
        </Field>
      </>
    );
  if (step.type === 'assert')
    return (
      <>
        <SectionTitle>Assert</SectionTitle>
        <Field label="Check" hint="No request: the checks below run on the previous step's response, or on the variables ($.name reads a variable)">
          <Select
            aria-label="Subject"
            data-inspector-subject
            value={String(raw.subject ?? 'response')}
            onChange={(e) => void update({ subject: e.target.value === 'response' ? null : e.target.value })}
          >
            <option value="response">The previous step&apos;s response</option>
            <option value="variables">The variables</option>
          </Select>
        </Field>
      </>
    );
  return null;
}

const durationText = (v: unknown, fallback: string) => (v === undefined || v === null ? fallback : typeof v === 'number' ? `${v}ms` : String(v));

/** A request's Wait until: run it again until the expression holds on its response. */
export function UntilFields({ step, raw, update }: { step: FlowStep; raw: Record<string, unknown>; update(set: Record<string, unknown>): Promise<unknown> }) {
  const u0 = raw.until;
  const spec = (typeof u0 === 'string' ? { if: u0 } : u0 && typeof u0 === 'object' ? u0 : undefined) as Record<string, unknown> | undefined;
  const [on, setOn] = useState(!!spec);
  const [expr, setExpr] = useState(asText(spec?.if) ?? "$.status == 'done'");
  const [every, setEvery] = useState(durationText(spec?.every, '2s'));
  const [timeout, setTimeoutText] = useState(durationText(spec?.timeout, '60s'));
  const [backoff, setBackoff] = useState(String(spec?.backoff ?? 1));
  if (!POLLABLE.has(step.type)) return null;
  const commit = (patch: Record<string, unknown> = {}) => {
    const next = { if: expr.trim(), every: every.trim() || '2s', timeout: timeout.trim() || '60s', ...(Number(backoff) > 1 ? { backoff: Number(backoff) } : {}), ...patch };
    if (!next.if) return;
    const same =
      spec && spec.if === next.if && durationText(spec.every, '2s') === next.every && durationText(spec.timeout, '60s') === next.timeout && Number(spec.backoff ?? 1) === Number(next.backoff ?? 1);
    if (!same) void update({ until: next, ...(raw.repeat !== undefined || raw.forEach !== undefined ? { repeat: null, forEach: null } : {}) });
  };
  return (
    <>
      <SectionTitle right={<Toggle checked={on} onChange={(v) => (setOn(v), v ? commit() : void update({ until: null }))} label="Wait until" />}>Polling</SectionTitle>
      {on ? (
        <div className="grid gap-2" data-inspector-until>
          <Field label="Until" hint="Runs the step again until this is true on its response: status, $.json.path, {{variables}}">
            <div onBlur={() => commit()}>
              <VarInput ariaLabel="Until" value={expr} onChange={setExpr} onEnter={() => commit()} placeholder="$.status == 'done'" />
            </div>
          </Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Every">
              <Input aria-label="Every" value={every} onChange={(e) => setEvery(e.target.value)} onBlur={() => commit()} onKeyDown={(e) => e.key === 'Enter' && commit()} placeholder="2s" />
            </Field>
            <Field label="Timeout">
              <Input aria-label="Timeout" value={timeout} onChange={(e) => setTimeoutText(e.target.value)} onBlur={() => commit()} onKeyDown={(e) => e.key === 'Enter' && commit()} placeholder="60s" />
            </Field>
            <Field label="Backoff">
              <Input
                type="number"
                min={1}
                max={10}
                step={0.1}
                aria-label="Backoff"
                value={backoff}
                onChange={(e) => setBackoff(e.target.value)}
                onBlur={() => commit()}
                onKeyDown={(e) => e.key === 'Enter' && commit()}
              />
            </Field>
          </div>
          <p className="text-xs text-muted">The wait grows by the backoff after each try (at most 30 s); the step fails when the timeout is up, and Stop ends the wait at once.</p>
        </div>
      ) : (
        <p className="text-xs text-muted">Off: the step runs once. On: it polls until a condition holds (a job finishing, a status changing).</p>
      )}
    </>
  );
}

/** Any step: its parallel group (steps of a group may run together) and whether it is a finally (clean-up) step. */
export function GroupFields({ step, steps, update }: { step: FlowStep; steps: FlowStep[]; update(set: Record<string, unknown>): Promise<unknown> }) {
  const groups = [...new Set(steps.map((s) => s.parallel).filter((g): g is string => !!g))];
  const [name, setName] = useState(step.parallel ?? '');
  const commit = (v: string) => v.trim() !== (step.parallel ?? '') && void update({ parallel: v.trim() || null, ...(v.trim() ? { finally: null } : {}) });
  const waiting = steps.filter((s) => s.dependsOn?.includes(step.id) && !s.finally);
  return (
    <>
      <SectionTitle>Order</SectionTitle>
      <Field label="Parallel group" hint="Steps of the same group may run at the same time (dependsOn still applies); steps that wait for nothing already run side by side">
        <div className="flex gap-1.5" data-inspector-parallel>
          <Input
            aria-label="Parallel group"
            list={`flow-groups-${step.id}`}
            value={name}
            placeholder="none"
            disabled={!!step.finally}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => commit(name)}
            onKeyDown={(e) => e.key === 'Enter' && commit(name)}
          />
          <datalist id={`flow-groups-${step.id}`}>
            {groups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </div>
      </Field>
      <div
        data-inspector-finally
        title={waiting.length ? `${waiting.map((s) => s.name).join(', ')} wait${waiting.length === 1 ? 's' : ''} for it: a finally step runs after every other step` : undefined}
      >
        <Toggle
          checked={!!step.finally}
          onChange={(v) => {
            if (v && waiting.length)
              return toastError(new Error(`${waiting.map((s) => s.name).join(', ')} wait${waiting.length === 1 ? 's' : ''} for this step: a finally step runs after every other step`));
            void update({ finally: v ? true : null, ...(v ? { parallel: null } : {}) });
          }}
          label="Finally: clean-up that runs after every other step, whatever happened"
        />
      </div>
    </>
  );
}
