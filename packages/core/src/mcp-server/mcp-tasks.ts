/**
 * Long runs as MCP tasks (the 2025-11-25 revision; experimental in the SDK): a client that asks for it (`task` in
 * tools/call) gets a task at once instead of waiting for a run that takes minutes, polls `tasks/get`, and reads the
 * result with `tasks/result`. A client that does not ask gets the result as before. Only the tools that run things take
 * it (`execution.taskSupport: optional`); the others answer a task request with an error, as the protocol says.
 *
 * Tasks live in this server process only: they end with the session, are kept an hour at most, and a server holds
 * twenty at a time, so an agent cannot fill memory with them.
 */
import { randomBytes } from 'node:crypto';
import { ApsError } from '../errors.js';

/** The tools whose runs can take minutes. */
export const TASK_TOOLS: ReadonlySet<string> = new Set(['run_collection', 'run_tests', 'run_evaluation', 'run_monitor', 'rag_run', 'load_test', 'flow_data_run', 'security_tests_run']);

/** What the server announces: tasks can be listed and cancelled, and tools/call can make one. */
export const TASKS_CAPABILITY = { list: {}, cancel: {}, requests: { tools: { call: {} } } };

/** `execution` of a listed tool, when it can run as a task. */
export const taskExecution = (name: string): { execution?: { taskSupport: 'optional' } } => (TASK_TOOLS.has(name) ? { execution: { taskSupport: 'optional' } } : {});

const MAX_TTL_MS = 60 * 60 * 1000;
const MAX_TASKS = 20;
const POLL_MS = 2000;

type Status = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';
interface Task {
  taskId: string;
  status: Status;
  ttl: number | null;
  createdAt: string;
  lastUpdatedAt: string;
  pollInterval?: number;
  statusMessage?: string;
}
type Result = Record<string, unknown>;
const terminal = (s: Status) => s === 'completed' || s === 'failed' || s === 'cancelled';

/** The task store of one server (the SDK's TaskStore interface): in memory, bounded in number and in time. */
export class BoundedTaskStore {
  private readonly tasks = new Map<string, { task: Task; result?: Result; timer?: NodeJS.Timeout }>();

  private keep(taskId: string, ms: number): void {
    const stored = this.tasks.get(taskId);
    if (!stored) return;
    if (stored.timer) clearTimeout(stored.timer);
    stored.timer = setTimeout(() => this.tasks.delete(taskId), ms);
    stored.timer.unref?.();
  }
  private need(taskId: string) {
    const stored = this.tasks.get(taskId);
    if (!stored) throw new Error(`No task ${taskId} (tasks are kept an hour at most, and end with the session)`);
    return stored;
  }

  async createTask(params: { ttl?: number | null; pollInterval?: number }): Promise<Task> {
    const running = [...this.tasks.values()].filter((t) => !terminal(t.task.status)).length;
    if (running >= MAX_TASKS)
      throw new ApsError('RateLimitError', `This server runs at most ${MAX_TASKS} tasks at a time`, { suggestions: ['Wait for one to finish (tasks/list), or cancel one (tasks/cancel).'] });
    const at = new Date().toISOString();
    const ttl = Math.min(MAX_TTL_MS, params.ttl && params.ttl > 0 ? params.ttl : MAX_TTL_MS);
    const task: Task = { taskId: randomBytes(16).toString('hex'), status: 'working', ttl, createdAt: at, lastUpdatedAt: at, pollInterval: params.pollInterval ?? POLL_MS };
    this.tasks.set(task.taskId, { task });
    this.keep(task.taskId, ttl);
    return { ...task };
  }
  async getTask(taskId: string): Promise<Task | null> {
    const stored = this.tasks.get(taskId);
    return stored ? { ...stored.task } : null;
  }
  async storeTaskResult(taskId: string, status: 'completed' | 'failed', result: Result): Promise<void> {
    const stored = this.need(taskId);
    // a cancelled task keeps its state: the run that finishes afterwards is dropped
    if (terminal(stored.task.status)) return;
    stored.result = result;
    stored.task.status = status;
    stored.task.lastUpdatedAt = new Date().toISOString();
    this.keep(taskId, stored.task.ttl ?? MAX_TTL_MS);
  }
  async getTaskResult(taskId: string): Promise<Result> {
    const stored = this.need(taskId);
    if (!stored.result) throw new Error(`Task ${taskId} has no result (${stored.task.status})`);
    return stored.result;
  }
  async updateTaskStatus(taskId: string, status: Status, statusMessage?: string): Promise<void> {
    const stored = this.need(taskId);
    if (terminal(stored.task.status)) throw new Error(`Task ${taskId} is already ${stored.task.status}`);
    stored.task.status = status;
    if (statusMessage) stored.task.statusMessage = statusMessage;
    stored.task.lastUpdatedAt = new Date().toISOString();
  }
  async listTasks(): Promise<{ tasks: Task[] }> {
    return { tasks: [...this.tasks.values()].map((t) => ({ ...t.task })) };
  }
}

interface RequestStore {
  createTask(params: { ttl?: number | null; pollInterval?: number }): Promise<Task>;
  storeTaskResult(taskId: string, status: 'completed' | 'failed', result: Result): Promise<void>;
}

/**
 * Answers a tools/call that asked for a task: the task now, the run in the background, its result (or its error, as an
 * error result) stored when it ends. A tool that does not take tasks refuses, as the protocol says.
 */
export async function startToolTask(tool: string, extra: { taskStore?: unknown }, asked: { ttl?: number | null }, run: () => Promise<Result>): Promise<{ task: Task }> {
  const store = extra.taskStore as RequestStore | undefined;
  if (!store || !TASK_TOOLS.has(tool))
    throw new ApsError('ValidationError', `${tool} does not run as a task`, { suggestions: [`Call it without "task". The tools that take one: ${[...TASK_TOOLS].join(', ')}.`] });
  const task = await store.createTask({ ttl: asked.ttl, pollInterval: POLL_MS });
  void run()
    .then(
      (r) => store.storeTaskResult(task.taskId, r.isError === true ? 'failed' : 'completed', r),
      (e: unknown) => store.storeTaskResult(task.taskId, 'failed', { isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }] }),
    )
    .catch(() => undefined);
  return { task };
}
