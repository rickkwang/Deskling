import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capped, MAX_ENTRY, openLog, readTail, stamp, teeConsole } from '../src/main/desklog.js';

const freshDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'deskling-log-'));

test('an entry is stamped, kinds are kept apart and the file holds them in order', () => {
  const dir = freshDir();
  let t = new Date('2026-10-17T09:26:00Z');
  const log = openLog(dir, { now: () => t });
  log.info('Deskling 0.3.16 starts');
  t = new Date('2026-10-17T09:26:05Z');
  log.warn('[update] check failed: offline');
  log.error('uncaught: boom');
  const lines = fs.readFileSync(path.join(dir, 'deskling.log'), 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(lines, [
    '2026-10-17T09:26:00.000Z [info] Deskling 0.3.16 starts',
    '2026-10-17T09:26:05.000Z [warn] [update] check failed: offline',
    '2026-10-17T09:26:05.000Z [error] uncaught: boom',
  ]);
});

test('a crash keeps its stack, one line per frame, up to the cap', () => {
  const stack = Array.from({ length: 60 }, (_, i) => `    at frame ${i} (app.js:1:2)`).join('\n');
  const kept = capped(stack, 500); // a small cap stands in for MAX_ENTRY here
  assert.ok(kept.includes('\n'), 'multiline survives');
  assert.ok(kept.length <= 702, 'the cap is honoured');
  const keptLines = kept.split('\n');
  assert.match(keptLines.at(-1), /\s…$/); // the cut is marked
  for (const line of keptLines.slice(0, -1)) assert.ok(stack.includes(`${line}\n`), 'every kept line above the mark is a whole original line');
  const longLine = 'y'.repeat(1000); // a single line has no whole line to leave: hard-cut, not vanish
  const hard = capped(longLine, 500);
  assert.equal(hard.length, 502);
  assert.ok(hard.startsWith('yyyy') && hard.endsWith('…'));
  assert.ok(longLine.startsWith(hard.slice(0, 500)), 'the hard cut keeps the message head');
  assert.equal(capped('short'), 'short');
  assert.equal(capped(undefined), '');
});

test('a full log flips to deskling.log.1, and a report reads across both', () => {
  const dir = freshDir();
  let t = 0;
  const clock = () => new Date(1.7e12 + (t += 10_000)); // a tick per call
  const log = openLog(dir, { now: clock, maxBytes: 300 });
  const fill = (n, word) => { for (let i = 0; i < n; i++) log.error(`${word} entry ${i} `.padEnd(80, 'y')); };
  fill(6, 'old'); // overflows once and the overflow flips again mid-run; latest .1 holds old3..old5
  fill(2, 'new');
  assert.ok(fs.existsSync(path.join(dir, 'deskling.log.1')));
  // Fewer lines than exist: the tail must span the rotation boundary, so only
  // a readTail that actually merges .1 can pass these (keep=40 would not).
  const lines = readTail(dir, { keep: 3 }).split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /old entry 5/); // exists only in the older rotation
  assert.match(lines[2], /new entry 1/); // exists only in the current one
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the tail's `keep` decides how much a report carries", () => {
  const dir = freshDir();
  const log = openLog(dir, { now: () => new Date });
  for (let i = 1; i <= 60; i++) log.info(`line ${i}`);
  const lines = readTail(dir).split('\n');
  assert.equal(lines.length, 40);
  assert.match(lines[0], / line 21$/);
  assert.match(lines.at(-1), / line 60$/);
});

test("a missing log reads as nothing, and logging never crashes", () => {
  const dir = freshDir();
  assert.equal(readTail(dir), '');
  const log = openLog('/deskling-cannot-write-here/nope');
  log.error('this must not throw'); // and it doesn't
});

test("a tee leaves the console speaking and copies what it says to the log", () => {
  const dir = freshDir();
  const log = openLog(dir, { now: () => new Date });
  const printed = [];
  const conso = { warn: (...p) => printed.push(['warn', p]), error: (...p) => printed.push(['error', p]) };
  teeConsole(conso, log);
  conso.warn('[update] failed: offline');
  conso.error('uncaught: boom');
  assert.deepEqual(printed, [['warn', ['[update] failed: offline']], ['error', ['uncaught: boom']]]);
  const tail = readTail(dir);
  assert.match(tail, /\[warn\] \[update\] failed: offline/);
  assert.match(tail, /\[error\] uncaught: boom/);
});

test('openLog without options writes too (the clock turns by itself, no option needed)', () => {
  const dir = freshDir();
  const log = openLog(dir); // and nothing else
  log.info('written with the defaults alone');
  assert.match(readTail(dir), /written with the defaults alone/);
});

test('stamp formats as the report wants it: ISO time, kind, text', () => {
  assert.equal(stamp('error', 'x', new Date('2026-10-17T09:26:05Z')), '2026-10-17T09:26:05.000Z [error] x');
});
