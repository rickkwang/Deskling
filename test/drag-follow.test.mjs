import test from 'node:test';
import assert from 'node:assert/strict';
import { DragFollower } from '../src/main/drag-follow.js';

// A fake macOS that refuses x < 125 (like Stage Manager's strip) and moves the
// window back a moment later.
function simulate(targets, osMinX = 125) {
  const f = new DragFollower();
  let pos = { x: 600, y: 400 };
  const requests = [];
  for (const t of targets) {
    const req = f.next(t);
    if (req) {
      requests.push(req);
      pos = { ...req };
      f.observe(pos); // echo of our own move
      if (pos.x < osMinX) {
        pos = { x: osMinX, y: pos.y };
        f.observe(pos); // the OS pushes it back
      }
    }
  }
  return { requests, pos };
}

test('dragging into a refused area stops re-requesting it (no jitter)', () => {
  // Cursor pushes left past the strip, then wiggles up and down along it.
  const targets = [];
  for (let x = 400; x >= -6; x -= 20) targets.push({ x, y: 400 });
  for (let i = 0; i < 20; i++) targets.push({ x: -6, y: 400 + (i % 2 ? 30 : -30) });
  const { requests, pos } = simulate(targets);
  const refused = requests.filter((r) => r.x < 125);
  assert.equal(refused.length, 1, `only the first refused position is ever requested, got ${refused.length}`);
  assert.equal(pos.x, 125);
  // Vertical movement along the limit still works.
  assert.ok(requests.some((r) => r.x === 125 && r.y === 430));
});

test('normal drags are unaffected', () => {
  const targets = [];
  for (let x = 600; x <= 1700; x += 50) targets.push({ x, y: 300 + x / 10 });
  const { requests, pos } = simulate(targets, -Infinity);
  assert.equal(requests.length, targets.length);
  assert.deepEqual(pos, targets.at(-1));
});

test('unchanged targets are not re-requested', () => {
  const f = new DragFollower();
  assert.ok(f.next({ x: 10, y: 10 }));
  assert.equal(f.next({ x: 10, y: 10 }), null);
});
