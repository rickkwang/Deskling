// node --test test/  — runtime semantics against the real Clippy data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CharacterRuntime } from '../src/runtime/character-runtime.js';
import { AnimationPlayer } from '../src/runtime/animation-player.js';

const clippy = JSON.parse(fs.readFileSync('characters/clippy/character.json', 'utf8'));
// Speed everything up 20x so the test runs in a few seconds.
const fast = structuredClone(clippy);
for (const a of Object.values(fast.animations)) for (const f of a.frames) f.duration = Math.ceil(f.duration / 20);
Object.assign(fast.idle, { firstDelayMs: 20, intervalMs: 20, levelAfterMs: [0, 500, 1000], maxLoopMs: 150 });
const el = () => ({ style: {} });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('looping Thinking only ends through its exit branch after stop()', async () => {
  const rt = new CharacterRuntime(el(), fast, 'x.png');
  const played = [];
  rt.addEventListener('animation', (e) => played.push(e.detail.name));
  rt.setState('listening');
  rt.setState('thinking');
  await wait(600); // Thinking frame 32 branches back to 21 forever
  assert.equal(rt.player.current?.name, 'Thinking');
  const seen = new Set();
  const orig = rt.player._show.bind(rt.player);
  rt.player._show = (i) => { seen.add(i); orig(i); };
  rt.setState('speaking');
  await rt.settle();
  assert.ok(seen.has(33), 'exit branch 32 -> 33 taken');
  assert.deepEqual(played.slice(-1), ['Explain']);
  rt.destroy();
});

test('stop() drops queued requests', async () => {
  const rt = new CharacterRuntime(el(), fast, 'x.png');
  const a = rt.play('Congratulate');
  const b = rt.play('GetAttention');
  rt.stop();
  assert.equal(await b, 'stopped');
  assert.equal(await a, 'done');
  rt.destroy();
});

test('invalid transitions are rejected', () => {
  const rt = new CharacterRuntime(el(), fast, 'x.png');
  assert.equal(rt.setState('speaking'), false); // idle -> speaking not allowed
  assert.equal(rt.setState('listening'), true);
  rt.destroy();
});

test('idle progresses through levels 1 -> 2 -> 3', async (t) => {
  const rt = new CharacterRuntime(el(), fast, 'x.png');
  t.after(() => rt.destroy());
  const levels = new Set();
  rt.addEventListener('animation', (e) => e.detail.kind === 'idle' && levels.add(e.detail.level));
  rt.setState('listening');
  rt.setState('idle');
  const t0 = Date.now();
  while (!levels.has(3) && Date.now() - t0 < 8000) await wait(50);
  assert.ok(levels.has(1) && levels.has(2) && levels.has(3), `levels seen: ${[...levels]}`);
});

test('a one-shot request on a looping animation still finishes', async () => {
  // Rocky maps `confused` to Thinking, which branches back forever.
  const rocky = JSON.parse(fs.readFileSync('characters/rocky/character.json', 'utf8'));
  assert.equal(rocky.states.confused.animations[0], 'Thinking');
  const rt = new CharacterRuntime(el(), rocky, 'x.png');
  const res = await rt.act('confused');
  assert.equal(res, 'done');
  rt.destroy();
});

test('Agent Return: a posed animation returns to neutral via exit branches', async (t) => {
  // Merlin's Greet ends on a gesture (frame 12); its exit branches lead back
  // to frame 0, the neutral pose. The runtime plays that Return when idle.
  const merlin = JSON.parse(fs.readFileSync('characters/merlin/character.json', 'utf8'));
  const m = structuredClone(merlin);
  for (const a of Object.values(m.animations)) for (const f of a.frames) if (f.duration) f.duration = 1;
  m.idle.firstDelayMs = 60000;
  const rt = new CharacterRuntime(el(), m, 'x.png');
  t.after(() => rt.destroy());
  const shown = [];
  const orig = rt.player._show.bind(rt.player);
  rt.player._show = (i) => { shown.push([rt.player.current.name, i]); orig(i); };
  let result;
  do { shown.length = 0; result = await rt.play('Greet'); } while (!shown.some(([, i]) => i === 12)); // 50% branch
  assert.equal(result, 'done');
  await rt.settle();
  assert.equal(rt.player.pendingReturn, null, 'return consumed');
  const neutral = JSON.stringify(m.animations.Greet.frames[0].cells);
  assert.equal(rt.player.el.style.backgroundPosition, m.animations.Greet.frames[0].cells.map(([c, r]) => `-${c * m.spritesheet.cellWidth}px -${r * m.spritesheet.cellHeight}px`).join(','), `final image is the neutral cell ${neutral}`);
});

test('exiting plays on in sequence, ignoring random branches, and ends at the last frame', async () => {
  // Frame 0 loops forever and the last frame branches back (like Rover's Idle);
  // frame 1 has no exit branch; the last frame's exit branch points at itself.
  const frames = [
    { duration: 5, cells: [[0, 0]], branches: [{ to: 0, weight: 100 }] },
    { duration: 5, cells: [[1, 0]], branches: [{ to: 0, weight: 100 }] },
    { duration: 5, cells: [[2, 0]], branches: [{ to: 0, weight: 100 }], exitBranch: 2 },
  ];
  const c = { spritesheet: { cellWidth: 1, cellHeight: 1 }, animations: { Loop: { frames } } };
  const player = new AnimationPlayer(el(), c, 'x.png');
  const seen = [];
  const show = player._show.bind(player);
  player._show = (i) => { seen.push(i); show(i); };
  const result = player.play('Loop');
  await wait(40);
  player.exit();
  const t0 = Date.now();
  assert.equal(await result, 'done');
  assert.ok(Date.now() - t0 < 200, 'finished through the exit path, not the safety timeout');
  assert.deepEqual(seen.slice(-2), [1, 2]);
});

// A strip of distinct poses 0..n-1 that rewinds to pose 0 on the way out,
// like Clippy's Thinking: frames n..2n-2 replay n-2..0.
function rewinding(n, duration) {
  const cell = (i) => [[i, 0]];
  const frames = [];
  for (let i = 0; i < n; i++) frames.push({ duration, cells: cell(i) });
  for (let i = n - 2; i >= 0; i--) frames.push({ duration, cells: cell(i) });
  return { spritesheet: { cellWidth: 1, cellHeight: 1 }, animations: { A: { frames } } };
}

test('exit takes a same-looking frame nearer the end instead of playing the long way', async () => {
  const c = rewinding(30, 10); // from frame 1, the long way is ~56 frames
  const player = new AnimationPlayer(el(), c, 'x.png');
  const seen = [];
  const show = player._show.bind(player);
  player._show = (i) => { seen.push(i); show(i); };
  const result = player.play('A');
  while (!seen.includes(1)) await wait(1);
  player.exit();
  assert.equal(await result, 'done');
  // Frame 1 shows pose 1; so does frame 57, one frame from the end.
  assert.deepEqual(seen.slice(-1), [58]);
  assert.ok(seen.length <= 4, `rewound through ${seen}`);
});

test('a long exit path plays faster to finish within the budget', async () => {
  // No same-looking frames to skip to: 40 frames x 100 ms = 4 s of exit.
  const frames = Array.from({ length: 41 }, (_, i) => ({ duration: 100, cells: [[i, 0]] }));
  const c = { spritesheet: { cellWidth: 1, cellHeight: 1 }, animations: { A: { frames } } };
  const player = new AnimationPlayer(el(), c, 'x.png');
  const shown = [];
  const show = player._show.bind(player);
  player._show = (i) => { shown.push(i); show(i); };
  const result = player.play('A');
  while (!player.current) await wait(1);
  player.exit();
  const t0 = Date.now();
  assert.equal(await result, 'done');
  const took = Date.now() - t0;
  assert.ok(took < 1400, `exit took ${took} ms`);
  assert.equal(shown.length, 41, 'every frame still shown, just faster');
});

test('a frame held for seconds lets go when the animation exits', async () => {
  const frames = [{ duration: 4000, cells: [[0, 0]] }, { duration: 10, cells: [[1, 0]] }];
  const c = { spritesheet: { cellWidth: 1, cellHeight: 1 }, animations: { A: { frames } } };
  const player = new AnimationPlayer(el(), c, 'x.png');
  const result = player.play('A');
  await wait(20);
  player.exit();
  const t0 = Date.now();
  assert.equal(await result, 'done');
  assert.ok(Date.now() - t0 < 400, 'did not sit out the 4 s hold');
});

test('a Return keeps its pace unless something is waiting on it', async () => {
  // Ends posed on frame 4; its exit branches rewind 3, 2, 1, 0: 1.6 s.
  const frames = [0, 1, 2, 3, 4].map((i) => ({ duration: 400, cells: [[i, 0]], exitBranch: i === 0 ? 5 : i - 1 }));
  frames.push({ duration: 0, cells: [] });
  const c = { spritesheet: { cellWidth: 1, cellHeight: 1 }, animations: { A: { useExitBranching: true, frames } } };
  const player = new AnimationPlayer(el(), c, 'x.png');
  const timeReturn = async (interrupt) => {
    assert.equal(await player.play('A'), 'done');
    assert.ok(player.pendingReturn, 'posed at the end');
    const t0 = Date.now();
    const done = player.returnToNeutral();
    if (interrupt) { await wait(50); player.exit(); }
    await done;
    return Date.now() - t0;
  };
  const idle = await timeReturn(false);
  assert.ok(idle >= 1500, `nothing waiting: authored pace (${idle} ms)`);
  const hurried = await timeReturn(true);
  // 50 ms in, 1.2 s of path is left: squeezed into the 1 s budget.
  assert.ok(hurried < 1300, `interrupted: hurried (${hurried} ms)`);
});

// Entrances and exits as ryOS plays them: Office characters come and go with
// Greeting / Goodbye (their Show and Hide are a few frames that pop); Agent
// and XP characters appear with Show (then Greet to say hello) and leave with Hide.
function fastCharacter(id) {
  const c = JSON.parse(fs.readFileSync(`characters/${id}/character.json`, 'utf8'));
  for (const a of Object.values(c.animations)) for (const f of a.frames) f.duration = Math.ceil(f.duration / 50);
  return c;
}
async function played(id, run) {
  const rt = new CharacterRuntime(el(), fastCharacter(id), 'x.png');
  rt.state = 'hidden';
  const names = [];
  rt.addEventListener('animation', (e) => names.push(e.detail.name));
  await run(rt);
  rt.destroy();
  return names.filter((n) => n !== 'RestPose' && !n.startsWith('Idle'));
}

test('Agent and XP characters appear with Show, then Greet when saying hello', async () => {
  assert.deepEqual(await played('rover', (rt) => rt.show({ greet: true })), ['Show', 'Greet']);
  assert.deepEqual(await played('rover', (rt) => rt.show()), ['Show']);
  assert.deepEqual(await played('genie', (rt) => rt.show({ greet: true })), ['Show', 'Greet']);
});

test('Office characters always enter with their full Greeting, never the Show pop', async () => {
  assert.deepEqual(await played('clippy', (rt) => rt.show({ greet: true })), ['Greeting']);
  assert.deepEqual(await played('clippy', (rt) => rt.show()), ['Greeting']);
});

test('characters leave with Goodbye (Office) or Hide (Agent, XP)', async () => {
  const leave = (rt) => { rt.state = 'idle'; return rt.hide(); };
  assert.deepEqual(await played('clippy', leave), ['GoodBye']);
  assert.deepEqual(await played('f1', leave), ['Goodbye']);
  assert.deepEqual(await played('genie', leave), ['Hide']);
  assert.deepEqual(await played('rover', leave), ['Hide']);
  assert.deepEqual(await played('genie', (rt) => { rt.state = 'idle'; return rt.leave?.(); }), ['Hide'], 'switching characters leaves the same way');
});

test('leaving during an entrance does not go on to the hello', async () => {
  const names = await played('rover', async (rt) => {
    const entering = rt.show({ greet: true });
    await wait(5);
    await rt.hide();
    await entering;
  });
  assert.deepEqual(names, ['Show', 'Hide']);
});
