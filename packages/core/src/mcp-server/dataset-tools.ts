import { appendDatasetRow, listWorkspaceDatasets, readWorkspaceDataset } from '../runner/datasets.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { str, type Tool } from './tool.js';

/**
 * MCP tools for the workspace's datasets (the files in datasets/: CSV, JSON, JSONL, Markdown tables and SQLite
 * databases, which drive collection runs and tests): list them, read the first rows of one with its columns, and
 * add a record to a JSONL dataset.
 */
export function datasetTools({ store }: { store: WorkspaceStore }): Tool[] {
  return [
    {
      name: 'list_datasets',
      description:
        "Data files in the workspace datasets/ folder, newest first: path (give it to run_collection as `data`), size, format (csv, json, jsonl, markdown, sqlite) and, for SQLite databases, their tables (run_collection then needs a `query`). A response saved with the app's Table ▸ Save as dataset lands here too. read_dataset shows the rows of one.",
      inputSchema: { type: 'object', properties: {} },
      run: () => listWorkspaceDatasets(store),
    },
    {
      name: 'read_dataset',
      description:
        'The first rows of a dataset in datasets/ with its columns (name and the kind of value: string, number, boolean, object, array) and how many records it holds in all. Use it to see what fields a test or a collection run can use as {{variables}}. A SQLite database lists its tables; give `query` to read rows.',
      inputSchema: {
        type: 'object',
        properties: {
          name: str('The file under datasets/, e.g. users.csv or intents.jsonl (list_datasets shows them)'),
          limit: { type: 'number', description: 'How many rows (default 20, up to 10000)' },
          query: str('SQLite only: the SELECT whose rows are the records'),
        },
        required: ['name'],
      },
      run: (a) => readWorkspaceDataset(store, String(a.name), { limit: Number(a.limit) || 20, query: a.query ? String(a.query) : undefined }),
    },
    {
      name: 'add_dataset_row',
      write: true,
      description:
        'Add one record to a JSONL dataset in datasets/ (made when missing), e.g. an input and the answer it should get, as an evaluation case: { "message": "Cancel my booking", "expected": "cancellation" }. Each field is a {{variable}} of the evaluation prompt; `expected` is what evaluators compare with.',
      inputSchema: {
        type: 'object',
        properties: { dataset: str('File under datasets/ (".jsonl" is added when there is no extension), e.g. intent-cases'), row: { type: 'object', description: 'The record: field → value' } },
        required: ['dataset', 'row'],
      },
      run: (a) => appendDatasetRow(store, String(a.dataset), a.row as Record<string, unknown>),
    },
  ];
}
