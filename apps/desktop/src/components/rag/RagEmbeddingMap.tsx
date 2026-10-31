import { useState } from 'react';
import type { EmbeddingMap } from '@testpion/core';
import { call } from '../../api';
import { plural } from '../../lib/format';
import { Button, Callout, Field, Input, Modal, Spinner } from '../ui';

const W = 640;
const H = 380;
const PAD = 24;
const KINDS = [
  { kind: 'question', label: 'Question', cls: 'fill-accent' },
  { kind: 'right', label: 'Right document', cls: 'fill-ok' },
  { kind: 'retrieved', label: 'Retrieved document', cls: 'fill-muted' },
] as const;

/**
 * The embedding map of a run: its questions, right documents and retrieved documents placed by meaning, and two findings read from the
 * distances (a retrieved document that reads like a right one it is not; a question far from every document). Drawing it calls the
 * embedding model, so it starts on a click and says which model it uses; the bot is not asked again.
 */
export function RagEmbeddingMap({ runId, onClose }: { runId: string; onClose(): void }) {
  const [embedder, setEmbedder] = useState('');
  const [map, setMap] = useState<EmbeddingMap>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [hover, setHover] = useState<string>();
  const draw = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setMap(await call<EmbeddingMap>('rag.embeddingMap', { runId, ...(embedder.trim() ? { embedder: embedder.trim() } : {}) }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const shown = map?.points.find((p) => p.id === hover);
  const at = (v: number, size: number) => PAD + ((v + 1) / 2) * (size - 2 * PAD);
  return (
    <Modal title="Map by meaning" onClose={onClose} onSubmit={() => void draw()} width={720} footer={<Button onClick={onClose}>Close</Button>}>
      <div className="grid gap-3 text-sm" data-rag-embedding-map>
        <p className="text-muted">Places the questions and the documents by what they mean: things close together mean alike. A red ring marks a question no document is near. It asks an embedding model, not your bot.</p>
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Field label="Embedding model" hint="provider/model; empty: the provider of the AI reviewer">
              <Input value={embedder} onChange={(e) => setEmbedder(e.target.value)} placeholder="for example ollama/nomic-embed-text" data-embedding-model />
            </Field>
          </div>
          <Button variant="primary" onClick={() => void draw()} disabled={busy} title={busy ? 'Drawing the map' : undefined} data-embedding-draw>
            {map ? 'Draw again' : 'Draw the map'}
          </Button>
        </div>
        {busy && (
          <div className="flex items-center gap-2 text-muted">
            <Spinner /> Embedding the texts…
          </div>
        )}
        {error && <Callout tone="bad">{error}</Callout>}
        {map && (
          <>
            <p data-embedding-text>{map.text}</p>
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-md border border-line bg-surface" role="img" aria-label="Questions and documents by meaning" data-embedding-plot>
              {map.points.map((p) => {
                const far = p.kind === 'question' && map.farQuestions.some((f) => `q:${f.case}` === p.id);
                const name = p.kind === 'question' ? p.id.slice(2) : p.label;
                return (
                  <g key={p.id} opacity={hover && hover !== p.id ? 0.4 : 1} onMouseEnter={() => setHover(p.id)} onMouseLeave={() => setHover(undefined)} data-embedding-point={p.kind} data-embedding-far-point={far ? '' : undefined}>
                    <circle cx={at(p.x, W)} cy={at(-p.y, H)} r={p.kind === 'question' ? 6 : 5} className={KINDS.find((k) => k.kind === p.kind)!.cls} stroke={far ? 'var(--bad, #e5484d)' : 'var(--bg)'} strokeWidth={far ? 2.5 : 1.5} />
                    <text x={at(p.x, W) + (p.x > 0.6 ? -9 : 9)} y={at(-p.y, H) + 3} textAnchor={p.x > 0.6 ? 'end' : 'start'} className="fill-muted" fontSize="10">
                      {name.length > 16 ? `${name.slice(0, 15)}…` : name}
                    </text>
                    <title>{`${p.label}: ${p.text}`}</title>
                  </g>
                );
              })}
            </svg>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
              {KINDS.map((k) => (
                <span key={k.kind} className="inline-flex items-center gap-1">
                  <svg width="10" height="10" aria-hidden>
                    <circle cx="5" cy="5" r="5" className={k.cls} />
                  </svg>
                  {k.label} ({map.points.filter((p) => p.kind === k.kind).length})
                </span>
              ))}
              {map.leftOut > 0 && <span>{plural(map.leftOut, 'more text')} left out to keep it readable</span>}
            </div>
            {shown && (
              <div className="rounded-md border border-line p-2 text-xs" data-embedding-hover>
                <span className="font-medium">{shown.label.slice(0, 120)}</span> <span className="text-muted">{shown.text}</span>
              </div>
            )}
            <div className="grid gap-1" data-embedding-findings>
              <h4 className="font-medium">Look-alikes</h4>
              {map.lookAlikes.length === 0 && <p className="text-muted">No retrieved document reads like a right one it is not.</p>}
              {map.lookAlikes.map((l) => (
                <button key={l.doc} className="text-left rounded px-2 py-1 hover:bg-hover" onMouseEnter={() => setHover(`d:${l.doc}`)} onMouseLeave={() => setHover(undefined)} data-embedding-lookalike={l.doc}>
                  <span className="mono">{l.doc}</span> reads like the right document <span className="mono">{l.like}</span> <span className="text-muted">({Math.round(l.similarity * 100)}% alike, retrieved for {l.cases.join(', ')})</span>
                </button>
              ))}
              <h4 className="font-medium mt-2">Far questions</h4>
              {map.farQuestions.length === 0 && <p className="text-muted">Every question has a document near it.</p>}
              {map.farQuestions.map((f) => (
                <button key={f.case} className="text-left rounded px-2 py-1 hover:bg-hover" onMouseEnter={() => setHover(`q:${f.case}`)} onMouseLeave={() => setHover(undefined)} data-embedding-far={f.case}>
                  {f.question} <span className="text-muted">(nearest document {Math.round(f.nearest * 100)}% alike: the documents may not cover it)</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
