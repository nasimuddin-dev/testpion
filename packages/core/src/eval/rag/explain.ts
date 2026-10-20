/**
 * The AI task `rag-explain-sample` (planning/rag-testing.md §4f "Explain this sample"): one RAG sample that scored low, with
 * what every metric said about it, explained in plain words — which part of the system failed (the retrieval, the ranking, the
 * generator, the metric itself) and what to change first. It reads only the sample the run stored (question, answer, the
 * retrieved documents, the reference) and the metric results; it proposes nothing and writes nothing.
 */
export const RAG_EXPLAIN_INSTRUCTION = [
  'You explain why one sample of a RAG (retrieval-augmented generation) evaluation scored the way it did.',
  'The context holds `question`, `answer`, `reference` (the expected answer, when there is one), `contexts` (the documents the system retrieved, with their rank, id and score), `referenceIds` (the ids of the documents that should have been retrieved), `failure` (the class TestPion gave it: retrieval-miss, ranking, noise, unfaithful, off-topic, incomplete, false-refusal, citation, system-error …) and `metrics` (each metric with its score, whether it passed, and the evidence it gave).',
  'Say in plain words: (1) what went wrong, naming the part of the system — the retriever (it did not bring the documents the question needs, or ranked them low, or brought a lot of unrelated ones), the generator (it said something the documents do not support, left out what they say, or answered another question), or the metric (a verdict that looks wrong given the evidence: say so and which); (2) the evidence for it, quoting the shortest relevant words of the answer or a document and naming the document id; (3) the first thing to change, one concrete step, and how to see whether it worked (which metric should move).',
  'Be concise: three short paragraphs at most. Judge only from the context; do not guess at the system’s internals. If everything passed, say so and name the weakest metric.',
].join('\n');
