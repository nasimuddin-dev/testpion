/**
 * The checks a person can add to a request, a test or an AI evaluation: what each is called, which group it is in, the
 * fields it asks for and, for every one, a sentence that says in plain words what it decides (`what`; a unit test keeps
 * it filled for all of them). The names are plain: a check "decides whether one answer is good".
 */
export interface CheckDef {
  type: string;
  label: string;
  group: string;
  fields: Array<'path' | 'expected' | 'max' | 'min' | 'threshold' | 'header' | 'tool' | 'schema' | 'criteria' | 'judge' | 'method' | 'values' | 'spec' | 'operationId' | 'snapshot'>;
  /** The placeholder of the expected-value field (how to write it). */
  hint?: string;
  /** One sentence beside the check: what it decides. */
  what: string;
}

/** The group names a screen shows (the ids are kept: screens pass `groups`). */
export const CHECK_GROUP_LABEL: Record<string, string> = { RAG: 'Bot with sources', AI: 'AI answer', Agent: 'Tool use' };

export const CHECK_DEFS: CheckDef[] = [
  { type: 'status', label: 'Status code', group: 'Response', fields: ['expected'], hint: '200, 2xx, [200,201], success, error', what: 'The response has the status code you expect.' },
  { type: 'latency', label: 'Latency ≤ (ms)', group: 'Response', fields: ['max'], what: 'The response arrives in no more than this many milliseconds.' },
  { type: 'header', label: 'Header', group: 'Response', fields: ['header', 'expected'], what: 'A response header is there and has the value you expect.' },
  {
    type: 'jwt',
    label: 'JWT valid',
    group: 'Response',
    fields: ['path', 'header', 'min'],
    hint: 'the token at path, in a header (e.g. authorization) or the first one in the body: decodes and is not expired (min: seconds it must still be valid); claims to compare in test files',
    what: 'A login token in the response can be read and has not expired.',
  },
  {
    type: 'certificate',
    label: 'Certificate valid for (days)',
    group: 'Response',
    fields: ['min'],
    hint: 'HTTPS: fails when the server certificate expires in fewer days than min (default 14), or has expired',
    what: 'The server’s HTTPS certificate is still valid for at least this many days.',
  },
  {
    type: 'security-headers',
    label: 'Security headers',
    group: 'Response',
    fields: ['values'],
    hint: 'HSTS, nosniff, clickjacking, CORS with credentials, server version; list items to skip: hsts, nosniff, frame, cors, server-version',
    what: 'The response sets the headers that protect browsers (and does not give the server version away).',
  },
  { type: 'exists', label: 'Exists', group: 'Body', fields: ['path'], what: 'The field at this path is in the body.' },
  { type: 'not-exists', label: 'Does not exist', group: 'Body', fields: ['path'], what: 'The field at this path is not in the body.' },
  { type: 'equals', label: 'Equals', group: 'Body', fields: ['path', 'expected'], what: 'The value is exactly the one you give.' },
  { type: 'not-equals', label: 'Not equals', group: 'Body', fields: ['path', 'expected'], what: 'The value is anything but the one you give.' },
  { type: 'contains', label: 'Contains', group: 'Body', fields: ['path', 'expected'], what: 'The value includes the text you give.' },
  { type: 'not-contains', label: 'Does not contain', group: 'Body', fields: ['path', 'expected'], what: 'The value does not include the text you give.' },
  { type: 'regex', label: 'Matches a pattern (regular expression)', group: 'Body', fields: ['path', 'expected'], what: 'The value fits a pattern you write.' },
  {
    type: 'type',
    label: 'Type is',
    group: 'Body',
    fields: ['path', 'expected'],
    hint: 'string, number, integer, boolean, object, array, null',
    what: 'The value is of the kind you name, such as a number or a list.',
  },
  { type: 'length', label: 'Length', group: 'Body', fields: ['path', 'expected'], what: 'The text or list has the length you expect.' },
  { type: 'threshold', label: 'Number within', group: 'Body', fields: ['path', 'min', 'max'], what: 'A number is between the lowest and highest value you give.' },
  { type: 'json-schema', label: 'JSON Schema', group: 'Body', fields: ['path', 'schema'], what: 'The JSON has the shape a schema describes.' },
  { type: 'is-json', label: 'Is valid JSON', group: 'Body', fields: [], what: 'The reply can be read as JSON.' },
  {
    type: 'snapshot',
    label: 'Same as the saved response',
    group: 'Body',
    fields: ['path', 'snapshot'],
    hint: 'shape: the same fields and types, values may change; values: the same values too',
    what: 'The reply is the same as one you saved earlier (the shape, or the values too).',
  },
  {
    type: 'openapi',
    label: 'Matches OpenAPI contract',
    group: 'Response',
    fields: ['spec', 'operationId'],
    hint: 'status, content type and body checked against the operation in the OpenAPI document',
    what: 'The response follows what the OpenAPI document promises for this operation.',
  },
  { type: 'graphql-no-errors', label: 'No GraphQL errors', group: 'GraphQL', fields: [], what: 'The GraphQL response has no errors.' },
  { type: 'graphql-errors', label: 'GraphQL error contains', group: 'GraphQL', fields: ['expected'], what: 'One of the GraphQL errors includes the text you give.' },
  { type: 'exact-match', label: 'Exact match', group: 'AI', fields: ['path', 'expected'], what: 'The reply is exactly the expected answer.' },
  { type: 'tokens', label: 'Tokens ≤', group: 'AI', fields: ['max'], what: 'The call uses no more than this many tokens (the units a model is billed in).' },
  { type: 'first-token', label: 'Time to first token ≤ (ms)', group: 'AI', fields: ['max'], what: 'The first words arrive in no more than this many milliseconds.' },
  { type: 'cost', label: 'Cost ≤ (USD)', group: 'AI', fields: ['max'], what: 'The call costs no more than this many dollars.' },
  {
    type: 'similarity',
    label: 'Similar meaning to the expected answer',
    group: 'AI',
    fields: ['expected', 'threshold', 'method'],
    hint: 'method: lexical | f1 | embedding',
    what: 'The reply is close in meaning to the expected answer, even if the words differ.',
  },
  { type: 'llm-judge', label: 'Graded by an AI reviewer', group: 'AI', fields: ['criteria', 'judge', 'threshold'], what: 'A second AI model reads the reply and grades it by a rule you write.' },
  { type: 'refusal', label: 'Refuses', group: 'Safety', fields: [], what: 'The model says no to the request.' },
  { type: 'not-refusal', label: 'Does not refuse', group: 'Safety', fields: [], what: 'The model does not say no to the request.' },
  { type: 'no-leak', label: 'No sensitive data leak', group: 'Safety', fields: ['values'], what: 'The reply does not give away secrets such as keys, emails or the values you list.' },
  { type: 'tool-called', label: 'Calls the tool', group: 'Agent', fields: ['tool'], what: 'The agent calls the tool you name.' },
  { type: 'tool-not-called', label: 'Never calls the tool', group: 'Agent', fields: ['tool'], what: 'The agent never calls the tool you name.' },
  { type: 'max-tool-calls', label: 'Calls at most … tools', group: 'Agent', fields: ['max'], what: 'The agent makes no more tool calls than this.' },
  { type: 'tool-args-valid', label: 'Tool arguments are valid', group: 'Agent', fields: [], what: 'Every tool call has the arguments the tool asks for.' },
  {
    type: 'context-precision',
    label: 'Useful documents come first',
    group: 'RAG',
    fields: ['threshold', 'judge'],
    hint: 'the useful documents ranked first; with an AI reviewer, each document gets a verdict',
    what: 'The documents the bot found that help are at the top of its list.',
  },
  {
    type: 'context-recall',
    label: 'Found what the expected answer needs',
    group: 'RAG',
    fields: ['expected', 'threshold', 'judge'],
    hint: "the reference answer's statements found in the retrieved context",
    what: 'Each statement of the expected answer is in the documents the bot found.',
  },
  {
    type: 'context-entity-recall',
    label: 'Found the names and numbers expected',
    group: 'RAG',
    fields: ['expected', 'threshold'],
    hint: "the reference's names, numbers and dates found in the retrieved context (no model)",
    what: 'The names, numbers and dates of the expected answer are in the documents the bot found (no AI model needed).',
  },
  {
    type: 'groundedness',
    label: 'Answer backed by sources',
    group: 'RAG',
    fields: ['threshold', 'judge'],
    hint: "the answer's claims supported by the retrieved context; with an AI reviewer, claim by claim",
    what: 'Every claim in the answer is supported by the documents the bot found.',
  },
  {
    type: 'answer-correctness',
    label: 'Answer is correct',
    group: 'RAG',
    fields: ['expected', 'threshold', 'judge'],
    hint: "the answer's facts against the reference answer (F1); with an AI reviewer, claim by claim",
    what: 'The facts in the answer match the expected answer.',
  },
  { type: 'answer-relevance', label: 'Answers the question', group: 'RAG', fields: ['threshold', 'judge'], what: 'The answer is about what was asked, not something else.' },
  { type: 'citation', label: 'Citations are valid', group: 'RAG', fields: [], what: 'Every source the answer names is one of the documents the bot found.' },
  {
    type: 'normalized-match',
    label: 'Matches the expected answer (ignoring case and punctuation)',
    group: 'RAG',
    fields: ['expected'],
    hint: 'the answer equals the reference once case, punctuation and articles are ignored (no model); blank: the dataset record’s reference',
    what: 'The answer equals the expected answer once capitals, punctuation and small words are ignored (no AI model needed).',
  },
  {
    type: 'token-f1',
    label: 'Words in common with the expected answer',
    group: 'RAG',
    fields: ['expected', 'threshold'],
    hint: 'words shared with the reference answer, as precision and recall (no model); default threshold 0.5',
    what: 'The share of words the answer and the expected answer have in common (no AI model needed).',
  },
  {
    type: 'rouge',
    label: 'Wording close to the expected answer',
    group: 'RAG',
    fields: ['expected', 'threshold'],
    hint: 'the longest run of words in the same order as the reference (no model); default threshold 0.5',
    what: 'The answer uses the words of the expected answer in the same order (no AI model needed).',
  },
  {
    type: 'context-recall-ids',
    label: 'Found the right documents',
    group: 'RAG',
    fields: ['threshold'],
    hint: 'the gold chunk ids (the record’s reference_ids) that were retrieved (no model); default threshold 0.8',
    what: 'The bot found the documents you marked as right, by their ids (no AI model needed).',
  },
  {
    type: 'context-precision-ids',
    label: 'Found only useful documents',
    group: 'RAG',
    fields: ['threshold'],
    hint: 'the retrieved chunk ids that are gold ids (no model); default threshold 0.5',
    what: 'The documents the bot found are the ones you marked as right, not others (no AI model needed).',
  },
  {
    type: 'rag-faithfulness',
    label: 'Answer backed by sources (AI reviewer)',
    group: 'RAG',
    fields: ['threshold'],
    hint: 'the share of the answer’s claims the retrieved documents support; needs an AI reviewer model (evaluation setting); default threshold 0.8',
    what: 'An AI reviewer checks that the documents the bot found support each claim in the answer.',
  },
  {
    type: 'rag-answer-relevance',
    label: 'Answers the question (AI reviewer)',
    group: 'RAG',
    fields: ['threshold'],
    hint: 'the share of the answer’s statements that are relevant to the question; needs an AI reviewer model; default threshold 0.7',
    what: 'An AI reviewer checks that each statement of the answer is about the question.',
  },
];
