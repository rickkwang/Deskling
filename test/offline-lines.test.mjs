import test from 'node:test';
import assert from 'node:assert/strict';
import { Pokes, offlineReason } from '../src/ai/offline-lines.js';

test('offlineReason: off, not running, no model, or ready', () => {
  assert.equal(offlineReason({ enabled: false, available: true, model: 'm' }), 'off');
  assert.equal(offlineReason({ enabled: true, available: false, model: null }), 'unavailable');
  assert.equal(offlineReason({ enabled: true, available: true, model: null }), 'noModel');
  assert.equal(offlineReason({ enabled: true, available: true, model: 'm' }), null);
});

test('pokes never repeat the last line and fill in the name', () => {
  const pokes = new Pokes({ now: (() => { let t = 0; return () => (t += 60_000); })() });
  let last = '';
  for (let i = 0; i < 200; i++) {
    const { text } = pokes.next('Clippy');
    assert.ok(text && text !== last);
    assert.ok(!text.includes('{name}') && !text.includes('{n}'));
    last = text;
  }
});

test('a run of quick pokes gets a reaction with a gesture', () => {
  let t = 0;
  const pokes = new Pokes({ now: () => (t += 500), random: () => 0.9 });
  const seen = Array.from({ length: 9 }, () => pokes.next('Clippy'));
  assert.equal(seen[1].gesture, undefined);
  assert.equal(seen[2].gesture, 'getAttention');
  assert.equal(seen[4].gesture, 'confused');
  assert.equal(seen[8].gesture, 'acknowledge');
  t += 10_000; // a pause starts over
  assert.equal(pokes.next('Clippy').gesture, undefined);
});

test('the hour picks a line for any time of day', () => {
  for (let h = 0; h < 24; h++) {
    const { text } = new Pokes({ random: () => 0, hour: () => h }).next();
    assert.ok(text);
  }
});

test('a Chinese system gets Chinese lines, with the name filled in', () => {
  let t = 0;
  const pokes = new Pokes({ lang: 'zh-CN', now: () => (t += 60_000) });
  for (let i = 0; i < 100; i++) {
    const { text } = pokes.next('Clippy');
    assert.match(text, /[\u4e00-\u9fff]/);
    assert.ok(!text.includes('{name}'));
  }
  assert.match(new Pokes({ lang: 'zh-TW' }).next().text, /[\u4e00-\u9fff]/);
  assert.doesNotMatch(new Pokes({ lang: 'fr-FR' }).next().text, /[\u4e00-\u9fff]/);
});
