import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { applyFlowEdit, lintTestFile } from '../../packages/core/src/index.js';
import { flowChecks, frameBoxes, freeSpot, layoutExtras, flowGraph, STEP_SIZE, type FlowStep } from '../../packages/shared/src/flow-graph';

// Canvas comfort: sticky notes and frames in the file's layout:, and the checks the designer shows as you edit.
const FLOW = `# A flow with notes
name: Notes flow
tests:
  - id: login
    name: Log in
    type: http
    method: POST
    url: "{{baseUrl}}/auth" # the token endpoint
  - id: me
    name: Who am I
    type: http
    method: GET
    url: "{{baseUrl}}/me"
    dependsOn: [login]
layout:
  login: [0, 0]
  me: [300, 0]
`;
const edit = (text: string, op: Parameters<typeof applyFlowEdit>[1]) => applyFlowEdit(text, op, { file: 'notes.yaml' });

describe('flow edit: notes and frames', () => {
  it('adds, changes and removes a note, keeping comments and the steps places', () => {
    const a = edit(FLOW, { op: 'addNote', note: { x: 10.4, y: 200, text: '**Why**: log in first', color: 'yellow' } });
    expect(a.added).toEqual(['note-1']);
    expect(a.text).toContain('# the token endpoint');
    const data = parse(a.text);
    expect(data.layout.notes).toEqual([{ id: 'note-1', x: 10, y: 200, w: 220, h: 120, color: 'yellow', text: '**Why**: log in first' }]);
    expect(data.layout.login).toEqual([0, 0]);
    const b = edit(a.text, { op: 'updateNote', id: 'note-1', set: { w: 30, text: 'Line 1\nLine 2', color: 'blue' } });
    expect(parse(b.text).layout.notes[0]).toMatchObject({ w: 80, color: 'blue', text: 'Line 1\nLine 2' });
    const c = edit(b.text, { op: 'removeNote', id: 'note-1' });
    expect(parse(c.text).layout.notes).toBeUndefined();
    expect(parse(c.text).layout.me).toEqual([300, 0]);
  });

  it('refuses a colour that is not in the palette and an unknown note', () => {
    expect(() => edit(FLOW, { op: 'addNote', note: { text: 'x', color: 'orange' } })).toThrow(/not a colour/);
    expect(() => edit(FLOW, { op: 'removeNote', id: 'nope' })).toThrow(/No note "nope"/);
  });

  it('frames steps; a renamed step stays in its frame, a removed one leaves it, the last one takes the frame with it', () => {
    const a = edit(FLOW, { op: 'addFrame', title: 'Auth', color: 'green', steps: ['login', 'Who am I'] });
    expect(a.added).toEqual(['frame-1']);
    expect(parse(a.text).layout.frames).toEqual([{ id: 'frame-1', title: 'Auth', color: 'green', steps: ['login', 'me'] }]);
    expect(a.text).toMatch(/steps: \[ ?login, me ?\]/);
    const b = edit(a.text, { op: 'renameStep', id: 'me', newId: 'whoami' });
    expect(parse(b.text).layout.frames[0].steps).toEqual(['login', 'whoami']);
    const c = edit(b.text, { op: 'updateFrame', id: 'frame-1', set: { title: 'Sign-in', color: null } });
    expect(parse(c.text).layout.frames[0]).toEqual({ id: 'frame-1', title: 'Sign-in', steps: ['login', 'whoami'] });
    const d = edit(c.text, { op: 'removeStep', id: 'whoami' });
    expect(parse(d.text).layout.frames[0].steps).toEqual(['login']);
    const e = edit(d.text, { op: 'removeStep', id: 'login' });
    expect(parse(e.text).layout).toBeUndefined();
    expect(() => edit(FLOW, { op: 'addFrame', steps: ['nope'] })).toThrow(/No step "nope"/);
  });

  it('auto-arrange forgets the places but keeps the notes and frames', () => {
    let t = edit(FLOW, { op: 'addNote', note: { text: 'keep me' } }).text;
    t = edit(t, { op: 'addFrame', title: 'All', steps: ['login', 'me'] }).text;
    const data = parse(edit(t, { op: 'setLayout', positions: null }).text);
    expect(Object.keys(data.layout)).toEqual(['notes', 'frames']);
  });

  it('keeps CRLF line endings', () => {
    const crlf = FLOW.replace(/\n/g, '\r\n');
    const r = edit(crlf, { op: 'addNote', note: { text: 'a' } });
    expect(r.text.includes('\r\n')).toBe(true);
    expect(/[^\r]\n/.test(r.text)).toBe(false);
  });

  it('reads notes and frames back, ignoring what is malformed; frames go around their steps', () => {
    const t = edit(edit(FLOW, { op: 'addNote', note: { text: 'hi', x: 5, y: 6 } }).text, { op: 'addFrame', title: 'F', steps: ['login'] }).text;
    const x = layoutExtras(parse(t).layout);
    expect(x.notes).toEqual([{ id: 'note-1', x: 5, y: 6, w: 220, h: 120, text: 'hi' }]);
    expect(x.frames).toEqual([{ id: 'frame-1', title: 'F', steps: ['login'] }]);
    expect(layoutExtras({ notes: [{ x: 1 }, 'x'], frames: 'no' })).toEqual({ notes: [], frames: [] });
    const g = flowGraph([{ id: 'login', name: 'Log in', type: 'http', position: [100, 100] }]);
    const [box] = frameBoxes(g.nodes, x.frames);
    expect(box!.x).toBeLessThan(100);
    expect(box!.y).toBeLessThan(100);
    expect(box!.x + box!.w).toBeGreaterThan(100 + g.nodes[0]!.w);
  });
});

describe('flow edit: inputs (the Start node)', () => {
  it('writes defaults.vars for a flow that is not exposed, and removes them', () => {
    const a = edit(FLOW, {
      op: 'setInputs',
      inputs: [
        { name: 'who', default: 'tester' },
        { name: ' ', default: 'x' },
      ],
    });
    expect(parse(a.text).defaults).toEqual({ vars: { who: 'tester' } });
    expect(a.text.indexOf('defaults:')).toBeLessThan(a.text.indexOf('tests:'));
    const b = edit(a.text, { op: 'setInputs', inputs: [] });
    expect(parse(b.text).defaults).toBeUndefined();
    expect(() => edit(FLOW, { op: 'setInputs', inputs: [{ name: 'a' }, { name: 'a' }] })).toThrow(/Two inputs/);
    expect(() => edit(FLOW, { op: 'setInputs', inputs: [{ name: '1x' }] })).toThrow(/not a variable name/);
  });

  it('writes expose.inputs for an exposed flow', () => {
    const exposed = FLOW.replace('name: Notes flow\n', 'name: Notes flow\nexpose:\n  tool: notes_flow\n');
    const r = edit(exposed, { op: 'setInputs', inputs: [{ name: 'who', default: 'a', description: 'Who logs in' }] });
    expect(parse(r.text).expose).toEqual({ tool: 'notes_flow', inputs: [{ name: 'who', default: 'a', description: 'Who logs in' }] });
    expect(parse(r.text).defaults).toBeUndefined();
  });
});

describe('lint: layout', () => {
  it('accepts places, notes and frames; flags malformed ones', () => {
    let t = edit(FLOW, { op: 'addNote', note: { text: 'hi' } }).text;
    t = edit(t, { op: 'addFrame', title: 'F', steps: ['login'] }).text;
    expect(lintTestFile(t, { file: 'notes.yaml' })).toEqual([]);
    const broken = t.replace('steps: [ login ]', 'steps: [ nope ]').replace('steps: [login]', 'steps: [nope]').replace('text: hi', 'text: hi\n      size: 3');
    const msgs = lintTestFile(broken, { file: 'notes.yaml' }).map((p) => p.message);
    expect(msgs).toContain('The frame "F" names "nope", which is not a step of this file');
    expect(msgs).toContain('"size" is not a key of a note (id, x, y, w, h, color, text)');
    const places = lintTestFile(FLOW.replace('me: [300, 0]', 'me: here'), { file: 'notes.yaml' }).map((p) => p.message);
    expect(places).toContain(`layout: "me" is a step's place on the canvas: [x, y] in numbers`);
  });

  it('reports cycles and steps that can never run', () => {
    const text = [
      'name: Loops',
      'tests:',
      '  - { id: a, name: A, url: "http://x/a", dependsOn: [b] }',
      '  - { id: b, name: B, url: "http://x/b", dependsOn: [a] }',
      '  - { id: c, name: C, url: "http://x/c", dependsOn: [b] }',
      '  - { id: d, name: D, url: "http://x/d" }',
      '',
    ].join('\n');
    const p = lintTestFile(text, { file: 'loops.yaml' });
    expect(p.filter((x) => x.severity === 'error' && /cycle/.test(x.message)).map((x) => x.line)).toEqual([3, 4]);
    expect(p.find((x) => /"C" can never run/.test(x.message))).toMatchObject({ severity: 'warning', line: 5 });
    expect(p.some((x) => /"D"/.test(x.message))).toBe(false);
  });
});

const s = (id: string, extra: Partial<FlowStep> = {}): FlowStep => ({ id, name: id, type: 'http', ...extra });

describe('flowChecks', () => {
  it('finds unset variables, missing steps, when without a condition and steps waiting for a finally step', () => {
    const kinds = flowChecks([
      s('a', { unresolved: ['token'] }),
      s('b', { dependsOn: ['ghost'] }),
      s('c', { when: true, dependsOn: ['a'] }),
      s('clean', { finally: true }),
      s('e', { dependsOn: ['clean'] }),
    ]).map((c) => `${c.step}:${c.kind}`);
    expect(kinds).toEqual(['a:unset-variable', 'b:missing-step', 'c:when-without-condition', 'e:waits-for-finally']);
  });

  it('follows what never runs: through dependencies, constant conditions, and branches that are all not taken', () => {
    const checks = flowChecks([
      s('cond', { type: 'condition', if: 'true' }),
      s('yes', { when: true, dependsOn: ['cond'] }),
      s('no', { when: false, dependsOn: ['cond'] }),
      s('after-no', { dependsOn: ['no'] }),
      s('after-both', { dependsOn: ['yes', 'no'] }),
      s('off', { if: 'false' }),
      s('x', { dependsOn: ['y'] }),
      s('y', { dependsOn: ['x'] }),
      s('z', { dependsOn: ['y', 'yes'] }),
      s('cleanup', { finally: true, dependsOn: ['x'] }),
    ]);
    const never = checks.filter((c) => c.kind === 'unreachable').map((c) => c.step);
    expect(never).toEqual(['no', 'after-no', 'off', 'z']);
    expect(checks.filter((c) => c.kind === 'cycle').map((c) => c.step)).toEqual(['x', 'y']);
    expect(checks.find((c) => c.step === 'no')!.message).toMatch(/false branch of "cond", whose if: is always true/);
    expect(checks.find((c) => c.step === 'z')!.message).toMatch(/waits for "y", which never runs/);
  });

  it('scales: a chain of 20000 steps written last-first is checked in one pass, without overflowing the stack', () => {
    const n = 20000;
    // step i waits for step i+1; the last waits for a step nobody defines: every step never runs
    const steps = Array.from({ length: n }, (_, i) => s(`s${i}`, { dependsOn: [i === n - 1 ? 'ghost' : `s${i + 1}`] }));
    const t0 = performance.now();
    const checks = flowChecks(steps);
    const ms = performance.now() - t0;
    expect(checks.filter((c) => c.kind === 'unreachable')).toHaveLength(n - 1);
    expect(checks.filter((c) => c.kind === 'missing-step')).toHaveLength(1);
    expect(ms).toBeLessThan(1500);
    // a ring of 5000 steps is one cycle
    const ring = Array.from({ length: 5000 }, (_, i) => s(`r${i}`, { dependsOn: [`r${(i + 1) % 5000}`] }));
    expect(flowChecks(ring).filter((c) => c.kind === 'cycle')).toHaveLength(5000);
  });

  it('says nothing about a healthy flow', () => {
    expect(flowChecks([s('a'), s('cond', { type: 'condition', if: 'status == 200', dependsOn: ['a'] }), s('b', { when: true, dependsOn: ['cond'] })])).toEqual([]);
  });
});

describe('placement: a new step never lands on another', () => {
  const at = (text: string, id: string) => (parse(text) as { layout: Record<string, [number, number]> }).layout[id];
  it('freeSpot keeps a free place and moves a taken one down until it is free', () => {
    expect(freeSpot([], [10, 20])).toEqual([10, 20]);
    const taken = [{ x: 0, y: 0, ...STEP_SIZE }];
    const p = freeSpot(taken, [20, 10]);
    expect(p[0]).toBe(20);
    expect(p[1]).toBeGreaterThanOrEqual(STEP_SIZE.h);
    // two in a column: below both
    const q = freeSpot([...taken, { x: 0, y: p[1], ...STEP_SIZE }], [20, 10]);
    expect(q[1]).toBeGreaterThanOrEqual(p[1] + STEP_SIZE.h);
  });
  it('addStep at a taken place puts the step below it; negative places are kept', () => {
    const a = edit(FLOW, { op: 'addStep', step: { name: 'Next', type: 'log', message: 'x' }, at: [300, 0] });
    const id = a.added![0]!;
    expect(at(a.text, id)![0]).toBe(300);
    expect(at(a.text, id)![1]).toBeGreaterThanOrEqual(STEP_SIZE.h);
    const b = edit(FLOW, { op: 'setLayout', positions: { login: [-120, -40] } });
    expect(at(b.text, 'login')).toEqual([-120, -40]);
    const g = flowGraph((parse(b.text) as { tests: FlowStep[] }).tests.map((t) => ({ ...t, position: at(b.text, t.id!) })));
    expect(g.nodes.find((n) => n.id === 'login')).toMatchObject({ x: -120, y: -40 });
  });
  it('batch applies its edits in order as one text (one undo step), and refuses a nested batch', () => {
    const r = edit(FLOW, {
      op: 'batch',
      ops: [
        { op: 'setLayout', positions: { login: [0, 0], me: [300, 0] } },
        { op: 'addStep', step: { name: 'Here', type: 'log', message: 'x' }, at: [600, 200] },
        { op: 'group', ids: ['login', 'me'], parallel: 'group-1' },
      ],
    });
    expect(r.added).toHaveLength(1);
    expect(at(r.text, r.added![0]!)).toEqual([600, 200]);
    expect(r.text).toMatch(/parallel: group-1/);
    expect(() => edit(FLOW, { op: 'batch', ops: [{ op: 'batch', ops: [] }] })).toThrow(/not batches/);
  });
  it('a new step never goes under a note; auto-arrange moves a note off the steps it would cover', () => {
    const noted = edit(FLOW, { op: 'addNote', note: { x: 600, y: 0, w: 200, h: 100, text: 'here' } }).text;
    const a = edit(noted, { op: 'addStep', step: { name: 'Next', type: 'log', message: 'x' }, at: [600, 0] });
    expect(at(a.text, a.added![0]!)![1]).toBeGreaterThanOrEqual(100);
    // a note on the first step's automatic place
    const g = flowGraph((parse(FLOW) as { tests: FlowStep[] }).tests);
    const first = g.nodes[0]!;
    const covering = edit(FLOW, { op: 'addNote', note: { x: first.x, y: first.y, w: 200, h: 100, text: 'over login' } }).text;
    const r = edit(covering, { op: 'setLayout', positions: null });
    const note = layoutExtras((parse(r.text) as { layout: unknown }).layout).notes[0]!;
    const hit = g.nodes.some((n) => note.x < n.x + n.w && note.x + note.w > n.x && note.y < n.y + n.h && note.y + note.h > n.y);
    expect(hit).toBe(false);
  });
});
