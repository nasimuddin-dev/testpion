import { SHOULD_CALL, SHOULD_NOT_CALL } from '@testpion/shared';

/** Example cases for an agent evaluation (AU-19): the task, the tool it should call, the tool it must never call. They work on the offline demo model. */
export const AGENT_EXAMPLE_CASES = [
  { input: 'Find the opening hours with search_docs', [SHOULD_CALL]: 'search_docs', [SHOULD_NOT_CALL]: 'delete_record' },
  { input: 'What is the refund policy? Look it up with search_docs', [SHOULD_CALL]: 'search_docs', [SHOULD_NOT_CALL]: 'delete_record' },
  { input: 'Look up the weekend hours with search_docs', [SHOULD_CALL]: 'search_docs', [SHOULD_NOT_CALL]: 'delete_record' },
]
  .map((r) => JSON.stringify(r))
  .join('\n');

/** An agent evaluation reads the task from each case's `input` column. */
export const AGENT_PROMPT = '{{input}}';
