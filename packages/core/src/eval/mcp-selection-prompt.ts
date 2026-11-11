/** The format and the instruction of the `mcp-selection-cases` AI task (mcp-selection.ts runs the cases; no imports, so the task registry can take them). */
export const SELECTION_CASES_SCHEMA = {
  type: 'object',
  required: ['cases'],
  properties: {
    cases: {
      type: 'array',
      items: {
        type: 'object',
        required: ['tool', 'ask'],
        properties: {
          tool: { type: 'string', description: 'The name of the tool the request needs, exactly as listed; "none" when no tool fits' },
          ask: { type: 'string', description: 'What a user would type, in their own words' },
        },
      },
    },
  },
} as const;

export const SELECTION_CASES_INSTRUCTION = [
  'These are the tools of one MCP server (`tools`: name, description, parameters). Write test requests that show whether an AI agent picks the right tool.',
  'For every tool write `perTool` requests a real user would type to an assistant that has these tools: a goal in plain words, with the concrete values the tool needs (an id, a name, a date) made up.',
  'Never use the name of the tool or copy a sentence of its description: the request must be answerable only by understanding what the tool is for.',
  'Where two tools are easy to confuse, write requests that need exactly one of them, so a wrong pick shows.',
  'Then add `none` requests (as many as `noneCases`): things a user might ask that no tool here can do. Their `tool` is "none".',
  'Return JSON only: {"cases": [{"tool", "ask"}]}.',
].join('\n');
