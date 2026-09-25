// node --test test/  — focus timer logic, on a fake clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FocusTimer, clock, duration, minutesLeft, validSeconds } from '../src/main/focus-timer.js';

const MIN = 60_000;
const M = 60; // seconds
function setup() {
  let t = Date.parse('2026-09-25T09:00:00');
  const ends = [];
  const timer = new FocusTimer({ now: () => t, onEnd: (e) => ends.push(e) });
  return { timer, ends, advance: (ms) => { t += ms; timer.check(); } };
}

test('focus runs into a break on its own, then waits for the next round', () => {
  const { timer, ends, advance } = setup();
  timer.start(25 * M, 5 * M);
  advance(25 * MIN - 1000);
  assert.equal(timer.status().phase, 'focus');
  assert.equal(clock(timer.status().left), '0:01');
  advance(1000);
  assert.deepEqual(ends, [{ ended: 'focus', seconds: 25 * M, next: 5 * M, rounds: 1 }]);
  assert.equal(timer.status().phase, 'break');
  advance(5 * MIN);
  assert.equal(ends[1].ended, 'break');
  assert.equal(timer.status().phase, 'ready');
  advance(60 * MIN);
  assert.equal(ends.length, 2, 'nothing runs while waiting');
});

test('a paused phase keeps its time left', () => {
  const { timer, ends, advance } = setup();
  timer.start(25 * M, 5 * M);
  advance(10 * MIN);
  timer.pause();
  advance(60 * MIN);
  assert.equal(ends.length, 0);
  assert.equal(timer.status().left, 15 * MIN);
  timer.resume();
  advance(15 * MIN);
  assert.equal(ends.length, 1);
});

test('skipping gives no reminder; rounds count per day', () => {
  const { timer, ends, advance } = setup();
  timer.start(25 * M, 5 * M);
  timer.skip();
  assert.equal(timer.status().phase, 'break');
  timer.skip();
  assert.equal(timer.status().phase, 'ready');
  assert.equal(ends.length, 0);
  timer.start(25 * M, 5 * M);
  advance(25 * MIN);
  timer.start(25 * M, 5 * M);
  advance(25 * MIN);
  assert.equal(ends.at(-1).rounds, 2);
  timer.start(25 * M, 5 * M);
  advance(24 * 60 * MIN); // ends the next day
  assert.equal(ends.at(-1).rounds, 1);
});

test('durations are whole seconds within the limits', () => {
  assert.ok(validSeconds('focus', 1));
  assert.ok(validSeconds('focus', 90 * M + 30));
  assert.ok(validSeconds('focus', 12 * 3600));
  assert.ok(!validSeconds('focus', 12 * 3600 + 1));
  assert.ok(!validSeconds('focus', 0));
  assert.ok(!validSeconds('focus', 2.5));
  assert.ok(!validSeconds('break', '300'));
  assert.ok(!validSeconds('break', 4 * 3600 + 1));
});

test('times read as a clock and as words', () => {
  assert.equal(clock(59_000), '0:59');
  assert.equal(clock(25 * MIN), '25:00');
  assert.equal(clock(90 * MIN + 5000), '1:30:05');
  assert.equal(clock(400), '0:01', 'rounds up');
  assert.equal(duration(25 * M), '25 min');
  assert.equal(duration(90 * M), '1 h 30 min');
  assert.equal(duration(45), '45 s');
  assert.equal(duration(3600 + 5), '1 h 5 s');
});

test('menus show time left in whole minutes, so the tray is rebuilt once a minute', () => {
  assert.equal(minutesLeft(25 * M), '25 min');
  assert.equal(minutesLeft(24 * M + 1), '25 min', 'rounds up');
  assert.equal(minutesLeft(24 * M + 59), minutesLeft(24 * M + 1), 'steady within a minute');
  assert.equal(minutesLeft(64 * M + 30), '1 h 5 min');
  assert.equal(minutesLeft(59), 'under 1 min');
});
