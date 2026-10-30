import { useEffect, useState } from 'react';
import { call } from '../api';
import { attempt, useApp } from '../store';
import { Button, Field, Input, Modal, Select } from './ui';

interface Choice {
  id: string;
  name: string;
}

/**
 * "Save as a prompt version…" (Try a prompt): the wording being tried becomes a version of a saved evaluation (a prompt or an agent
 * one), beside its other versions. The evaluation keeps the prompt it has: run the version from the evaluation's Prompt versions bar,
 * compare it with the others, and make it current only when it did better. Nothing is run here.
 */
export function SavePromptVersionDialog({ prompt, system, onClose }: { prompt: string; system?: string; onClose(): void }) {
  const [choices, setChoices] = useState<Choice[]>();
  const [evaluation, setEvaluation] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void call<{ items: Array<{ id: string; name: string; data: { type?: string } }> }>('lib.get', { kind: 'evaluations' }).then(
      (lib) => {
        const list = lib.items.filter((i) => i.data.type !== 'rag').map((i) => ({ id: i.id, name: i.name }));
        setChoices(list);
        setEvaluation(list[0]?.id ?? '');
      },
      () => setChoices([]),
    );
  }, []);
  const why = !prompt.trim() ? 'Write a prompt first' : !choices?.length ? 'Save an evaluation first (AI quality ▸ Checks): a version belongs to one' : !name.trim() ? 'Give the version a name' : '';
  const save = async () => {
    if (why) return;
    setBusy(true);
    const ok = await attempt(async () => {
      await call('eval.saveVersion', { evaluation, name: name.trim(), prompt, ...(system?.trim() ? { system } : {}) });
      const title = choices?.find((c) => c.id === evaluation)?.name ?? 'the evaluation';
      useApp.getState().toast(`Saved "${name.trim()}" as a version of ${title}. Run it from the evaluation's Prompt versions.`, 'success');
    });
    setBusy(false);
    if (ok !== false) onClose();
  };
  return (
    <Modal
      title="Save as a prompt version"
      onClose={onClose}
      onSubmit={() => void save()}
      width={520}
      footer={
        <>
          <Button variant="primary" disabled={!!why || busy} title={why || undefined} onClick={() => void save()} data-version-save>
            Save version
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <div className="grid gap-3 text-sm" data-save-version>
        <p className="text-muted">Keeps this prompt beside the other versions of an evaluation. The evaluation keeps the prompt it has until you make this one current.</p>
        <Field label="Evaluation">
          <Select value={evaluation} onChange={(e) => setEvaluation(e.target.value)} disabled={!choices?.length} data-version-evaluation>
            {choices === undefined && <option>Loading…</option>}
            {choices?.length === 0 && <option>No evaluation saved yet</option>}
            {choices?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Name of the version" hint="for example “Shorter prompt”">
          <Input value={name} onChange={(e) => setName(e.target.value)} data-version-name />
        </Field>
      </div>
    </Modal>
  );
}
