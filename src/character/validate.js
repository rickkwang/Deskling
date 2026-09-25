// Character package validation. Runs in Node (tools/validate) and in the
// renderer before a character is loaded, so it must stay dependency-free.

import { exitNext } from './exit.js';

export const REQUIRED_STATES = [
  'idle', 'listening', 'thinking', 'speaking',
  'confused', 'acknowledge', 'getAttention', 'explain', 'show', 'hide',
];
export const OPTIONAL_STATES = ['greeting', 'goodbye'];
const SOURCES = ['official', 'app-mapped'];
const MODES = ['once', 'loop'];

const isInt = (n) => Number.isInteger(n) && n >= 0;

// Exiting from any frame must reach the end of the animation; otherwise Stop()
// could never finish it ("your exit branching must not create a circular
// loop"). Follows the player's exit path exactly.
function exitCanTerminate(frames) {
  const bad = [];
  for (let start = 0; start < frames.length; start++) {
    const seen = new Set();
    let i = start;
    while (i < frames.length && !seen.has(i)) {
      seen.add(i);
      i = exitNext(frames, i);
    }
    if (i < frames.length) bad.push(start);
  }
  return bad;
}

export function validateCharacter(c, { sheetSize } = {}) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);

  if (c.schemaVersion !== 1) err(`schemaVersion must be 1 (got ${c.schemaVersion})`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(c.id || '')) err('id must be kebab-case');
  if (!c.displayName) err('displayName is required');

  const s = c.spritesheet || {};
  for (const k of ['cellWidth', 'cellHeight', 'columns', 'rows']) {
    if (!isInt(s[k]) || s[k] === 0) err(`spritesheet.${k} must be a positive integer`);
  }
  if (!s.path) err('spritesheet.path is required');
  if (sheetSize) {
    if (s.columns * s.cellWidth > sheetSize.width || s.rows * s.cellHeight > sheetSize.height) {
      err(`grid ${s.columns}x${s.rows} of ${s.cellWidth}x${s.cellHeight} exceeds sheet ${sheetSize.width}x${sheetSize.height}`);
    }
  }

  const anims = c.animations || {};
  if (!Object.keys(anims).length) err('animations is empty');
  for (const [name, a] of Object.entries(anims)) {
    const frames = a.frames || [];
    if (!frames.length) { err(`${name}: no frames`); continue; }
    frames.forEach((f, i) => {
      const at = `${name}[${i}]`;
      if (!isInt(f.duration)) err(`${at}: duration must be a non-negative integer`);
      for (const cell of f.cells || []) {
        const [col, row] = cell;
        if (!isInt(col) || !isInt(row) || col >= s.columns || row >= s.rows) err(`${at}: cell ${cell} outside ${s.columns}x${s.rows} grid`);
      }
      let weight = 0;
      for (const b of f.branches || []) {
        if (!isInt(b.to) || b.to >= frames.length) err(`${at}: branch target ${b.to} out of range`);
        weight += b.weight;
      }
      if (weight > 100) err(`${at}: branch weights sum to ${weight} (> 100)`);
      if (f.exitBranch !== undefined && (!isInt(f.exitBranch) || f.exitBranch > frames.length)) {
        err(`${at}: exitBranch ${f.exitBranch} out of range`);
      }
    });
    if (a.returnAnimation && !anims[a.returnAnimation]) err(`${name}: returnAnimation "${a.returnAnimation}" is missing`);
    const stuck = exitCanTerminate(frames);
    if (stuck.length) warnings.push(`${name}: exit from ${stuck.length} frame(s) (first: ${stuck[0]}) can never finish; runtime will hard-cut`);
  }

  const states = c.states || {};
  for (const st of REQUIRED_STATES) if (!states[st]) err(`states.${st} is required`);
  for (const [st, def] of Object.entries(states)) {
    if (!REQUIRED_STATES.includes(st) && !OPTIONAL_STATES.includes(st)) warnings.push(`states.${st} is not used by the runtime`);
    if (!Array.isArray(def.animations) || !def.animations.length) { err(`states.${st}.animations must be a non-empty array`); continue; }
    for (const n of def.animations) if (!anims[n]) err(`states.${st} references missing animation "${n}"`);
    if (!SOURCES.includes(def.source)) err(`states.${st}.source must be one of ${SOURCES.join('|')}`);
    if (def.mode && !MODES.includes(def.mode)) err(`states.${st}.mode must be one of ${MODES.join('|')}`);
  }

  const idle = c.idle;
  if (idle) {
    if (!Array.isArray(idle.levels) || idle.levels.length !== 3) err('idle.levels must have 3 levels');
    else idle.levels.forEach((lvl, i) => lvl.forEach((n) => { if (!anims[n]) err(`idle.levels[${i}] references missing animation "${n}"`); }));
  }

  if (!c.persona?.systemPrompt) err('persona.systemPrompt is required');
  const greetings = c.persona?.greetings;
  if (!Array.isArray(greetings) || !greetings.length || !greetings.every((g) => typeof g === 'string' && g.trim())) {
    err('persona.greetings must be a non-empty list of strings');
  }
  return { errors, warnings };
}
