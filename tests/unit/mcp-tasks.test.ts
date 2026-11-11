/** The task store of the MCP server: bounded in number and in time, and a cancelled task keeps its state. */
import { describe, expect, it } from 'vitest';
import { BoundedTaskStore, TASK_TOOLS, startToolTask, taskExecution } from '../../packages/core/src/mcp-server/mcp-tasks.js';

describe('MCP tasks', () => {
  it('keeps a task an hour at most, whatever the client asks', async () => {
    const s = new BoundedTaskStore();
    expect((await s.createTask({})).ttl).toBe(3_600_000);
    expect((await s.createTask({ ttl: 9_999_999_999 })).ttl).toBe(3_600_000);
    expect((await s.createTask({ ttl: null })).ttl).toBe(3_600_000);
    const t = await s.createTask({ ttl: 5000 });
    expect(t).toMatchObject({ status: 'working', ttl: 5000, pollInterval: 2000 });
    expect(t.taskId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('runs twenty at a time; a finished one makes room', async () => {
    const s = new BoundedTaskStore();
    const made = [];
    for (let i = 0; i < 20; i++) made.push(await s.createTask({}));
    await expect(s.createTask({})).rejects.toThrow(/at most 20 tasks at a time/);
    await s.storeTaskResult(made[0]!.taskId, 'completed', { content: [] });
    expect((await s.createTask({})).status).toBe('working');
    expect((await s.listTasks()).tasks).toHaveLength(21);
  });

  it('a cancelled task stays cancelled when its run ends afterwards', async () => {
    const s = new BoundedTaskStore();
    const t = await s.createTask({});
    await s.updateTaskStatus(t.taskId, 'cancelled');
    await s.storeTaskResult(t.taskId, 'completed', { content: [] });
    expect((await s.getTask(t.taskId))?.status).toBe('cancelled');
    await expect(s.getTaskResult(t.taskId)).rejects.toThrow(/has no result \(cancelled\)/);
    await expect(s.updateTaskStatus(t.taskId, 'working')).rejects.toThrow(/already cancelled/);
    expect(await s.getTask('nope')).toBeNull();
  });

  it('a run that throws, or says isError, ends the task failed with the words', async () => {
    const s = new BoundedTaskStore();
    const extra = { taskStore: s };
    const thrown = await startToolTask('run_tests', extra, {}, async () => {
      throw new Error('the workspace is locked');
    });
    const said = await startToolTask('run_tests', extra, {}, async () => ({ isError: true, content: [{ type: 'text', text: '2 tests failed' }] }));
    const ok = await startToolTask('run_tests', extra, { ttl: 1000 }, async () => ({ content: [{ type: 'text', text: 'passed' }] }));
    await new Promise((r) => setTimeout(r, 20));
    expect((await s.getTask(thrown.task.taskId))?.status).toBe('failed');
    expect(await s.getTaskResult(thrown.task.taskId)).toEqual({ isError: true, content: [{ type: 'text', text: 'the workspace is locked' }] });
    expect((await s.getTask(said.task.taskId))?.status).toBe('failed');
    expect((await s.getTask(ok.task.taskId))?.status).toBe('completed');
    await expect(startToolTask('list_collections', extra, {}, async () => ({}))).rejects.toThrow(/does not run as a task/);
  });

  it('only the tools that run things take a task', () => {
    expect(taskExecution('run_collection')).toEqual({ execution: { taskSupport: 'optional' } });
    expect(taskExecution('list_collections')).toEqual({});
    expect(TASK_TOOLS.size).toBe(8);
  });
});
