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
    { duration: 5, cells: [[0, 0]], branches: [{ to: 0, weight: 100 }] },
    { duration: 5, cells: [[0, 0]], branches: [{ to: 0, weight: 100 }], exitBranch: 2 },
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
