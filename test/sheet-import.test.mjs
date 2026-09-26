// node --test test/  — generated sprite sheet -> Character package.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePng, encodePng } from '../src/character/png-codec.js';
import { aboutOf, described, importSheet, makeCharacter, renamed, SHEET_COLUMNS, SHEET_ROWS } from '../src/character/sheet-import.js';
import { validateCharacter } from '../src/character/validate.js';
import { exitNext } from '../src/character/exit.js';

const KEY = [255, 0, 255];

// A white figure with a black outline standing on each cell's ground line,
// its outer pixels half-blended into the key the way image models draw edges.
function makeSheet({ skip = [], stray = [], lift = {} } = {}) {
  const cw = 120, ch = 100, width = cw * SHEET_COLUMNS, height = ch * SHEET_ROWS;
  const data = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) data.set([...KEY, 255], p * 4);
  const put = (x, y, rgb) => data.set([...rgb, 255], (y * width + x) * 4);
  for (let n = 1; n <= SHEET_COLUMNS * SHEET_ROWS; n++) {
    if (skip.includes(n)) continue;
    const x0 = ((n - 1) % SHEET_COLUMNS) * cw + 40, bottom = Math.floor((n - 1) / SHEET_COLUMNS) * ch + 90 - (lift[n] || 0);
    const w = 30 + (n % 4) * 5, h = 60;
    for (let y = bottom - h; y <= bottom; y++) {
      for (let x = x0 - 1; x <= x0 + w + 1; x++) {
        const edge = x === x0 - 1 || x === x0 + w + 1;
        const outline = x === x0 || x === x0 + w || y === bottom - h || y === bottom;
        put(x, y, edge ? [128, 0, 128] : outline ? [0, 0, 0] : [255, 255, 255]);
      }
    }
    if (stray.includes(n)) put(x0 + w + 12, bottom - h, [0, 0, 0]);
  }
  return { width, height, data };
}

test('PNG encode/decode round-trips RGBA', () => {
  const img = { width: 3, height: 2, data: new Uint8Array([1, 2, 3, 4, 250, 0, 9, 255, 0, 0, 0, 0, 7, 7, 7, 7, 200, 100, 50, 128, 9, 8, 7, 6]) };
  assert.deepEqual(decodePng(encodePng(img)), img);
});

test('a generated sheet becomes a valid character', () => {
  const { character, sheet } = importSheet(makeSheet(), { name: 'Test Pet' });
  assert.equal(character.id, 'test-pet');
  const { errors } = validateCharacter(character, { sheetSize: sheet });
  assert.deepEqual(errors, []);
  const { cellWidth, cellHeight, columns, rows } = character.spritesheet;
  assert.equal(sheet.width, cellWidth * columns);
  assert.equal(sheet.height, cellHeight * rows);
});

test('every state and idle animation starts and settles on the rest pose', () => {
  const { character } = importSheet(makeSheet(), { name: 'Pet' });
  const rest = JSON.stringify(character.animations.RestPose.frames[0].cells);
  const used = new Map();
  for (const [state, def] of Object.entries(character.states)) for (const n of def.animations) used.set(n, state);
  for (const n of character.idle.levels.flat()) used.set(n, 'idle');
  for (const [name, state] of used) {
    const frames = character.animations[name].frames.filter((f) => f.cells.length);
    if (!['show', 'greeting'].includes(state)) assert.equal(JSON.stringify(frames[0].cells), rest, `${name} starts at rest`);
    if (!['hide', 'goodbye'].includes(state)) assert.equal(JSON.stringify(frames.at(-1).cells), rest, `${name} settles at rest`);
  }
});

test('loops leave through their exit branches', () => {
  const { character } = importSheet(makeSheet(), { name: 'Pet' });
  for (const name of ['Thinking', 'IdleSnooze']) {
    const { frames } = character.animations[name];
    assert.ok(frames.some((f) => f.branches), `${name} loops`);
    frames.forEach((f, start) => {
      let i = start;
      for (let steps = 0; i < frames.length && steps < frames.length; steps++) i = exitNext(frames, i);
      assert.equal(i, frames.length, `${name} exits from frame ${start}`);
    });
  }
});

test('poses line up on one ground line; stray marks and key fringes are removed', () => {
  const { character, sheet, warnings } = importSheet(makeSheet({ stray: [9], lift: { 28: 12 } }), { name: 'Pet' });
  assert.deepEqual(warnings, []);
  const { cellWidth: w, cellHeight: h } = character.spritesheet;
  const px = (x, y) => sheet.data.subarray((y * sheet.width + x) * 4, (y * sheet.width + x) * 4 + 4);
  const bottom = (n) => {
    const col = (n - 1) % SHEET_COLUMNS, row = Math.floor((n - 1) / SHEET_COLUMNS);
    for (let y = h - 1; y >= 0; y--) for (let x = 0; x < w; x++) if (px(col * w + x, row * h + y)[3] > 128) return y;
    return -1;
  };
  assert.equal(bottom(2), bottom(1));
  assert.equal(bottom(25), bottom(1));
  assert.ok(bottom(1) - bottom(28) >= 10, 'a clear hop keeps its lift');
  for (let p = 0; p < sheet.width * sheet.height; p++) {
    const [r, g, b, a] = sheet.data.subarray(p * 4, p * 4 + 4);
    if (a > 0) assert.ok(Math.min(r, b) - g < 60, `no magenta left at pixel ${p}: ${r},${g},${b},${a}`);
  }
});

test('a sheet with missing poses is rejected', () => {
  assert.throws(() => importSheet(makeSheet({ skip: [7, 40] }), { name: 'Pet' }), /cell\(s\) 7, 40/);
});

test('a sheet drawn on transparency imports without keying', () => {
  const img = makeSheet();
  for (let p = 0; p < img.width * img.height; p++) {
    const px = img.data.subarray(p * 4, p * 4 + 4);
    if (px[0] === 255 && px[1] === 0 && px[2] === 255) px.set([0, 0, 0, 0]);
  }
  const { character, sheet } = importSheet(img, { name: 'Clear' });
  assert.deepEqual(validateCharacter(character, { sheetSize: sheet }).errors, []);
});

test('saying who a character is reaches its persona, and can be taken back', () => {
  const c = makeCharacter({ name: 'Rick', id: 'rick', cellWidth: 1, cellHeight: 1 });
  assert.equal(aboutOf(c), '');
  const d = described(c, 'a mad scientist from Rick and Morty');
  assert.equal(aboutOf(d), 'a mad scientist from Rick and Morty');
  assert.match(d.persona.systemPrompt, /^You are Rick, a mad scientist from Rick and Morty\. /);
  assert.deepEqual(d.persona, makeCharacter({ name: 'Rick', id: 'r', cellWidth: 1, cellHeight: 1, description: 'a mad scientist from Rick and Morty' }).persona);
  assert.deepEqual(described(d, ''), c, 'empty goes back to the default');
  const r = renamed(d, 'Morty');
  assert.equal(r.persona.systemPrompt.split('.')[0], 'You are Morty, a mad scientist from Rick and Morty', 'survives a rename, as written');
  assert.equal(aboutOf(r), 'a mad scientist from Rick and Morty');
  const edited = { ...c, persona: { ...c.persona, systemPrompt: 'Hand-written.' } };
  assert.equal(described(edited, 'x').persona.systemPrompt, 'Hand-written.', 'a hand-edited persona is left alone');
});

test('renaming rewrites generated text and swaps only whole words elsewhere', () => {
  const c = makeCharacter({ name: 'A', id: 'a', cellWidth: 1, cellHeight: 1 });
  const r = renamed(c, 'Biscuit');
  assert.equal(r.displayName, 'Biscuit');
  assert.deepEqual(r.persona, makeCharacter({ name: 'Biscuit', id: 'b', cellWidth: 1, cellHeight: 1 }).persona);
  assert.match(r.description, /^Biscuit, a desktop pet/);
  const edited = { ...c, persona: { ...c.persona, systemPrompt: 'You are A, a cat named A.' } };
  assert.equal(renamed(edited, 'Biscuit').persona.systemPrompt, 'You are Biscuit, a cat named Biscuit.');
});
