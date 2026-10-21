import { describe, it, expect } from 'vitest';
import { AI_ACTIONS, AI_TASK_IDS } from '@testpion/shared';
import { listAiTasks } from '../../packages/core/src/index.js';
import { TASK_INSTRUCTIONS } from '../../packages/core/src/ai/tasks/prompts.js';

describe('AI task ids', () => {
  it('the union in shared names exactly the tasks of the registry, each with its instruction', () => {
    expect(listAiTasks().map((t) => t.id).sort()).toEqual([...AI_TASK_IDS].sort());
    expect(Object.keys(TASK_INSTRUCTIONS).sort()).toEqual([...AI_TASK_IDS].sort());
    expect(new Set(AI_TASK_IDS).size).toBe(AI_TASK_IDS.length);
  });

  it('every AI action runs a task of the registry', () => {
    for (const a of AI_ACTIONS) expect(AI_TASK_IDS, a.id).toContain(a.task);
  });
});
