import type { CheckConfig } from '../../types';

/** What a new evaluation of type RAG starts with: records with a question, a reference answer and the gold document ids, and metrics that need no judge model plus the two judged ones. */
export const RAG_STARTER_DATASET =
  '{"id":"hours","question":"What time does the clinic open?","reference":"The clinic opens at 8am on weekdays.","reference_ids":["doc-1"]}\n{"id":"cancel","question":"Can appointments be cancelled?","reference":"Appointments can be cancelled up to 24 hours before without a fee.","reference_ids":["doc-3"]}';

export const RAG_STARTER_EVALUATORS: CheckConfig[] = [
  { type: 'token-f1', threshold: 0.5 },
  { type: 'context-recall-ids', threshold: 0.8 },
  { type: 'faithfulness', threshold: 0.8 },
  { type: 'answer-relevance', threshold: 0.7 },
  { type: 'latency', max: 5000 },
];

