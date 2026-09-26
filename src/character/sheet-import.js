// Turns one generated sprite-sheet image into a Character package. The image
// follows the Deskling sheet prompt: 8 columns x 5 rows of poses on a flat
// chroma-key background, cells numbered 1-40 left to right, row by row:
//   1-4   neutral, blink half, blink closed, breathing in
//   5-8   thinking: hand to chin, look up-left, look up-right, tap chin
//   9-12  listening: perk up, lean in, hand at ear, attentive smile
//  13-16  talking: palm out, mouth closed, both hands out, finger raised
//  17-20  confused: tilt, hand to head, scratch, shrug
//  21-24  agreeing: nod down, head up, thumbs-up, arms raised
//  25-28  waving: arm up, wave left, wave right, hop
//  29-32  sleepy: eyelids drooping, nodding off, asleep, breathing out
//  33-36  appearing: tiny, half, overshoot, squashed
//  37-40  disappearing: squashed, half, small, dot
// The image model only draws poses; everything that makes the character behave
// like a Microsoft Agent one (rest-pose hand-overs, loops with exit branches,
// idle levels) comes from the frame tables below.

export const SHEET_COLUMNS = 8;
export const SHEET_ROWS = 5;

const KEY_BG = 0.85; // share of key colour at or above which a pixel is background,
const KEY_FG = 0.12; // at or below which it is opaque; in between, an anti-aliased edge
const SOLID = 64; // alpha that counts as part of a pose when finding shapes
const STRAY = 0.02; // shapes under this share of a cell's largest are stray marks
const GROUND_SNAP = 6; // px: smaller differences from the row's ground line are noise
const PAD = 4;

const cell = (n) => [(n - 1) % SHEET_COLUMNS, Math.floor((n - 1) / SHEET_COLUMNS)];

// [cell, ms] steps; `null` is an empty frame. Options on a step:
// { loopTo, weight, exit } -> branches back / exit branch.
const f = (n, duration, opts = {}) => {
  const frame = { duration, cells: n ? [cell(n)] : [] };
  if (opts.loopTo !== undefined) frame.branches = [{ to: opts.loopTo, weight: opts.weight ?? 100 }];
  if (opts.exit !== undefined) frame.exitBranch = opts.exit;
  return frame;
};

// Timed like the Microsoft Agent characters: 100 ms ticks (Agent's 10 fps),
// holds in whole ticks, and each animation about as long as Clippy's
// counterpart (Alert 2.4 s, Explain 1.5 s, GetAttention 2.6 s, ...).
export const ANIMATIONS = {
  RestPose: [f(1, 100)],
  IdleBlink: [f(1, 100), f(2, 100), f(3, 100), f(2, 100), f(1, 100)],
  IdleBreathe: [f(1, 200), f(4, 800), f(1, 300)],
  IdlePonder: [f(1, 100), f(5, 200), f(6, 800), f(7, 800), f(5, 200), f(1, 100)],
  // Hand to chin, then look up-left / up-right until told to stop.
  Thinking: [
    f(1, 100), f(5, 200),
    f(6, 500, { exit: 5 }),
    f(7, 500, { loopTo: 2, weight: 30, exit: 5 }),
    f(8, 400, { loopTo: 2, exit: 5 }),
    f(5, 200), f(1, 100),
  ],
  Alert: [f(1, 100), f(9, 200), f(10, 200), f(11, 800), f(12, 800), f(10, 200), f(1, 100)],
  Explain: [f(1, 100), f(13, 200), f(14, 100), f(15, 300), f(14, 100), f(16, 400), f(13, 200), f(1, 100)],
  HeadScratch: [f(1, 100), f(17, 200), f(18, 200), f(19, 200), f(18, 200), f(19, 200), f(20, 500), f(17, 200), f(1, 100)],
  Acknowledge: [f(1, 100), f(21, 300), f(22, 200), f(23, 700), f(22, 100), f(24, 800), f(22, 200), f(1, 100)],
  GetAttention: [
    f(1, 100), f(25, 200), f(26, 200), f(27, 200), f(26, 200), f(27, 200),
    f(28, 400), f(27, 200), f(26, 200), f(27, 200), f(25, 200), f(1, 100),
  ],
  Show: [f(33, 100), f(34, 100), f(35, 100), f(36, 100), f(1, 100)],
  Hide: [f(1, 100), f(37, 100), f(38, 100), f(39, 100), f(40, 100), f(null, 10)],
  Greeting: [
    f(33, 100), f(34, 100), f(35, 100), f(36, 100), f(1, 200),
    f(25, 200), f(26, 200), f(27, 200), f(26, 200), f(27, 200), f(25, 200), f(24, 800), f(1, 200),
  ],
  GoodBye: [
    f(1, 100), f(25, 200), f(26, 200), f(27, 200), f(26, 200), f(25, 200), f(1, 200),
    f(37, 100), f(38, 100), f(39, 100), f(40, 100), f(null, 10),
  ],
  // Nods off, then breathes asleep until woken, and wakes up the same way.
  IdleSnooze: [
    f(1, 100), f(29, 500), f(30, 600),
    f(31, 1000, { exit: 5 }),
    f(32, 1000, { loopTo: 3, exit: 5 }),
    f(30, 200), f(29, 200), f(1, 100),
  ],
};

const STATES = {
  idle: { animations: ['RestPose'], source: 'official' },
  listening: { animations: ['Alert'], source: 'official' },
  thinking: { animations: ['Thinking'], source: 'official', mode: 'loop' },
  speaking: { animations: ['Explain'], source: 'official' },
  confused: { animations: ['HeadScratch'], source: 'app-mapped' },
  acknowledge: { animations: ['Acknowledge'], source: 'official' },
  getAttention: { animations: ['GetAttention'], source: 'official' },
  explain: { animations: ['Explain'], source: 'official' },
  show: { animations: ['Show'], source: 'official' },
  hide: { animations: ['Hide'], source: 'official' },
  greeting: { animations: ['Greeting'], source: 'official' },
  goodbye: { animations: ['GoodBye'], source: 'official' },
};

const IDLE = {
  source: 'app-mapped',
  firstDelayMs: 6000,
  intervalMs: 9000,
  maxLoopMs: 12000,
  levelAfterMs: [0, 60000, 240000],
  levels: [
    ['IdleBlink', 'IdleBreathe'],
    ['IdleBlink', 'IdleBreathe', 'IdlePonder', 'HeadScratch'],
    ['IdleSnooze'],
  ],
};

export function idFromName(name) {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// image: { width, height, data: RGBA }. height: on-screen height in px of the
// neutral pose, Clippy's by default (the sheet is scaled down to it, never up).
export function importSheet(image, { name, id = idFromName(name || ''), description = '', height } = {}) {
  const { sheet, cellWidth, cellHeight, warnings } = cutSheet(image, { height });
  return { character: makeCharacter({ name, id, description, cellWidth, cellHeight }), sheet, warnings };
}

// The image -> the Character's sprite sheet (8x5 cells of equal size).
export function cutSheet(image, { height = 86 } = {}) {
  image = { ...image, data: Uint8Array.from(image.data) }; // keyOut un-mixes edges in place
  const warnings = [];
  const alpha = transparentBackground(image) ? image.data.filter((_, i) => i % 4 === 3) : keyOut(image, keyColour(image));
  const frames = findPoses(image, alpha, warnings);
  const rest = frames[0];
  const scale = Math.min(1, height / (rest.maxY - rest.minY + 1));
  const sprites = frames.map((fr) => placeable(image, alpha, fr, scale));
  return { ...layout(sprites), warnings };
}

export function makeCharacter({ name, id = idFromName(name || ''), description = '', cellWidth, cellHeight }) {
  if (!name) throw new Error('a character name is required');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`cannot make an id from "${name}"; pass one (kebab-case)`);
  return {
    schemaVersion: 1,
    id,
    displayName: name,
    description: description || defaultDescription(name),
    animationSet: 'office',
    spritesheet: { path: 'spritesheet.png', cellWidth, cellHeight, columns: SHEET_COLUMNS, rows: SHEET_ROWS },
    anchor: 'bottom-center',
    states: STATES,
    idle: IDLE,
    persona: persona(name, description),
    provenance: {
      frames: 'Deskling sheet importer (src/character/sheet-import.js): Deskling sheet layout, 8x5 poses',
      art: 'Generated with an image model from the Deskling sheet prompt.',
    },
    animations: Object.fromEntries(Object.entries(ANIMATIONS).map(([n, fr]) => [n, { frames: fr }])),
  };
}

// A new name, also in the description and persona (greetings, system prompt)
// so the character introduces itself right. Text the importer wrote is written
// again for the new name; text edited by hand has the old name swapped where it
// stands as a whole word.
export function renamed(character, name) {
  const old = character.displayName;
  const esc = old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const word = new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'gu');
  const swap = (v) => {
    if (typeof v === 'string') return old ? v.replace(word, () => name) : v;
    if (Array.isArray(v)) return v.map(swap);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)]));
    return v;
  };
  // The importer builds the persona from the description it was given, or none.
  const from = ['', character.description].find((d) => same(character.persona, persona(old, d)));
  // Who it is, in the user's words, is kept as written ("from Rick and Morty").
  const description = character.description === defaultDescription(old) ? defaultDescription(name)
    : from ? character.description : swap(character.description);
  return {
    ...character,
    displayName: name,
    description,
    persona: from === undefined ? swap(character.persona) : persona(name, from && description),
  };
}

const defaultDescription = (name) => `${name}, a desktop pet made from a generated sprite sheet.`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Who the character is, in the user's words ('' when they gave none).
export const aboutOf = (character) => (character.description === defaultDescription(character.displayName) ? '' : character.description);

// Says who the character is: in its description and, so the model knows (a
// name alone and it makes something up), its persona. A persona edited by
// hand is left alone.
export function described(character, about) {
  const name = character.displayName;
  const from = ['', character.description].find((d) => same(character.persona, persona(name, d)));
  return {
    ...character,
    description: about || defaultDescription(name),
    persona: from === undefined ? character.persona : persona(name, about),
  };
}

function persona(name, description) {
  const who = description ? `${name}, ${description.replace(/\.$/, '')}` : name;
  return {
    systemPrompt: `You are ${who}. You live on the user's desktop as a small animated assistant: friendly, warm and a little playful.`,
    greetings: [
      `Hi! I'm ${name}. Need a hand with anything?`,
      'Hello again! What are we working on today?',
      `${name} here. Ask me anything!`,
    ],
    timer: {
      focusDone: ['Focus session done! Stretch a little and rest your eyes.', 'Nice work! Time for a short break.'],
      breakDone: ['Break is over. Ready for another round?', 'Feeling rested? Let\'s get back to it.'],
    },
  };
}

// A sheet drawn on transparency (some image tools do this) needs no keying.
function transparentBackground({ width, height, data }) {
  let clear = 0, n = 0;
  for (let x = 0; x < width; x += 4) for (const y of [0, height - 1]) { n++; if (data[(y * width + x) * 4 + 3] < 16) clear++; }
  for (let y = 0; y < height; y += 4) for (const x of [0, width - 1]) { n++; if (data[(y * width + x) * 4 + 3] < 16) clear++; }
  return clear > n / 2;
}

// The background is the colour along the image border (median per channel).
function keyColour({ width, height, data }) {
  const ch = [[], [], []];
  const take = (x, y) => { const i = (y * width + x) * 4; for (let c = 0; c < 3; c++) ch[c].push(data[i + c]); };
  for (let x = 0; x < width; x++) { take(x, 0); take(x, height - 1); }
  for (let y = 0; y < height; y++) { take(0, y); take(width - 1, y); }
  return ch.map((v) => v.sort((a, b) => a - b)[v.length >> 1]);
}

// How much of the key a pixel holds: its key channels (magenta: red, blue)
// minus the others (green), relative to the key's own. Blends of the key with
// any colour, dark outlines included, score in between; black, white and
// colours unlike the key score 0.
function keyOut({ width, height, data }, key) {
  const high = [0, 1, 2].filter((c) => key[c] >= 128);
  const low = [0, 1, 2].filter((c) => key[c] < 128);
  const keyness = (r, g, b) => {
    const px = [r, g, b];
    return Math.min(...high.map((c) => px[c])) - Math.max(...low.map((c) => px[c]));
  };
  const full = high.length && low.length ? keyness(...key) : 0;
  if (full < 128) throw new Error('the background must be one saturated colour such as #FF00FF or #00FF00');
  const alpha = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    const k = keyness(data[i], data[i + 1], data[i + 2]) / full;
    const a = Math.min(1, Math.max(0, (KEY_BG - k) / (KEY_BG - KEY_FG)));
    alpha[p] = Math.round(a * 255) * (data[i + 3] / 255);
    // Un-mix the key from anti-aliased edges so they don't keep a coloured fringe.
    if (a > 0 && a < 1) for (let c = 0; c < 3; c++) data[i + c] = clamp((data[i + c] - (1 - a) * key[c]) / a);
  }
  return alpha;
}

const clamp = (v) => Math.min(255, Math.max(0, Math.round(v)));

// Connected shapes, each assigned to the grid cell holding its centre; stray
// marks (motion lines, sparkles) are dropped. Returns the 40 poses in order.
function findPoses({ width, height }, alpha, warnings) {
  const label = new Int32Array(width * height).fill(-1);
  const shapes = [];
  const stack = [];
  for (let start = 0; start < width * height; start++) {
    if (alpha[start] < SOLID || label[start] >= 0) continue;
    const s = { id: shapes.length, area: 0, sx: 0, sy: 0, minX: width, minY: height, maxX: 0, maxY: 0 };
    label[start] = s.id;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop();
      const x = p % width, y = (p - x) / width;
      s.area++; s.sx += x; s.sy += y;
      if (x < s.minX) s.minX = x;
      if (x > s.maxX) s.maxX = x;
      if (y < s.minY) s.minY = y;
      if (y > s.maxY) s.maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const q = ny * width + nx;
          if (alpha[q] >= SOLID && label[q] < 0) { label[q] = s.id; stack.push(q); }
        }
      }
    }
    shapes.push(s);
  }

  const cw = width / SHEET_COLUMNS, ch = height / SHEET_ROWS;
  const cells = Array.from({ length: SHEET_COLUMNS * SHEET_ROWS }, () => []);
  for (const s of shapes) {
    const col = Math.min(SHEET_COLUMNS - 1, Math.floor(s.sx / s.area / cw));
    const row = Math.min(SHEET_ROWS - 1, Math.floor(s.sy / s.area / ch));
    cells[row * SHEET_COLUMNS + col].push(s);
  }
  const empty = [], overlapping = [];
  const frames = cells.map((list, i) => {
    const biggest = Math.max(0, ...list.map((s) => s.area));
    const kept = list.filter((s) => s.area >= biggest * STRAY);
    if (!kept.length) { empty.push(i + 1); return null; }
    const fr = { cell: i + 1, ids: new Set(kept.map((s) => s.id)), label };
    for (const k of ['minX', 'minY']) fr[k] = Math.min(...kept.map((s) => s[k]));
    for (const k of ['maxX', 'maxY']) fr[k] = Math.max(...kept.map((s) => s[k]));
    const [col, row] = cell(i + 1);
    if (fr.minX < (col - 0.1) * cw || fr.maxX > (col + 1.1) * cw || fr.minY < (row - 0.1) * ch || fr.maxY > (row + 1.1) * ch) {
      overlapping.push(i + 1);
    }
    return fr;
  });
  if (overlapping.length) warnings.push(`pose${overlapping.length > 1 ? 's' : ''} ${overlapping.join(', ')} run${overlapping.length > 1 ? '' : 's'} into neighbouring cells`);
  if (empty.length) {
    throw new Error(`expected ${SHEET_COLUMNS}x${SHEET_ROWS} poses on a flat background; no pose found in cell(s) ${empty.join(', ')}`);
  }

  // Each row stands on one ground line; only a clear lift (a hop) is kept.
  for (let r = 0; r < SHEET_ROWS; r++) {
    const row = frames.slice(r * SHEET_COLUMNS, (r + 1) * SHEET_COLUMNS);
    const ground = row.map((fr) => fr.maxY).sort((a, b) => a - b)[SHEET_COLUMNS >> 1];
    for (const fr of row) fr.lift = Math.abs(fr.maxY - ground) <= GROUND_SNAP ? 0 : ground - fr.maxY;
  }
  return frames;
}

// Crops one pose out of the image (its own shapes plus their soft edges),
// scales it, and finds the point it stands on: the middle of its feet.
function placeable(image, alpha, fr, scale) {
  const { width, data } = image;
  const x0 = Math.max(0, fr.minX - 2), y0 = Math.max(0, fr.minY - 2);
  const x1 = Math.min(width - 1, fr.maxX + 2), y1 = Math.min(image.height - 1, fr.maxY + 2);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const crop = new Float32Array(w * h * 4); // premultiplied
  let footW = 0, footX = 0;
  const footTop = fr.maxY - Math.max(2, (fr.maxY - fr.minY) * 0.12);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const p = y * width + x;
      const own = fr.label[p] < 0 ? nearOwn(fr, x, y, width, image.height) : fr.ids.has(fr.label[p]);
      if (!own || !alpha[p]) continue;
      const a = alpha[p] / 255, o = ((y - y0) * w + (x - x0)) * 4;
      crop[o] = data[p * 4] * a; crop[o + 1] = data[p * 4 + 1] * a; crop[o + 2] = data[p * 4 + 2] * a; crop[o + 3] = a;
      if (y >= footTop && alpha[p] >= SOLID) { footW += a; footX += a * x; }
    }
  }
  const dw = Math.max(1, Math.round(w * scale)), dh = Math.max(1, Math.round(h * scale));
  return {
    cell: fr.cell,
    w: dw, h: dh,
    px: resize(crop, w, h, dw, dh),
    footX: (footX / footW - x0 + 0.5) * scale,
    groundY: (fr.maxY - y0 + 1) * scale, // bottom of the pose within the crop
    lift: fr.lift * scale,
  };
}

// Soft-edge pixels (below SOLID) belong to a pose when a solid neighbour does.
function nearOwn(fr, x, y, width, height) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const l = fr.label[ny * width + nx];
      if (l >= 0) return fr.ids.has(l);
    }
  }
  return false;
}

// Area-average resampling of premultiplied RGBA (downscaling or 1:1).
function resize(src, sw, sh, dw, dh) {
  // One axis at a time: `n` source samples -> `m` target samples, `lines`
  // lines of them; `at(line, sample)` is a pixel's index in its image.
  const pass = (from, n, m, lines, fromAt, toAt, size) => {
    const out = new Float32Array(size * 4);
    const ratio = n / m;
    for (let t = 0; t < m; t++) {
      const a = t * ratio, b = (t + 1) * ratio;
      for (let s = Math.floor(a); s < Math.min(n, Math.ceil(b)); s++) {
        const wgt = (Math.min(b, s + 1) - Math.max(a, s)) / ratio;
        for (let l = 0; l < lines; l++) {
          const si = fromAt(l, s) * 4, di = toAt(l, t) * 4;
          for (let c = 0; c < 4; c++) out[di + c] += from[si + c] * wgt;
        }
      }
    }
    return out;
  };
  const rows = pass(src, sw, dw, sh, (y, x) => y * sw + x, (y, x) => y * dw + x, dw * sh);
  return pass(rows, sh, dh, dw, (x, y) => y * dw + x, (x, y) => y * dw + x, dw * dh);
}

// Packs the poses into an 8x5 grid of equal cells, each standing at the same
// anchor so frames line up exactly.
function layout(sprites) {
  const left = Math.max(...sprites.map((s) => s.footX));
  const right = Math.max(...sprites.map((s) => s.w - s.footX));
  const up = Math.max(...sprites.map((s) => s.groundY + s.lift));
  const down = Math.max(0, ...sprites.map((s) => s.h - s.groundY - s.lift));
  const half = Math.ceil(Math.max(left, right)) + PAD;
  const cellWidth = half * 2;
  const cellHeight = Math.ceil(up) + Math.ceil(down) + PAD * 2;
  const ay = PAD + Math.ceil(up);
  const width = cellWidth * SHEET_COLUMNS, height = cellHeight * SHEET_ROWS;
  const data = new Uint8Array(width * height * 4);
  for (const s of sprites) {
    const [col, row] = cell(s.cell);
    const ox = col * cellWidth + Math.round(half - s.footX);
    const oy = row * cellHeight + Math.round(ay - s.lift - s.groundY);
    for (let y = 0; y < s.h; y++) {
      for (let x = 0; x < s.w; x++) {
        const si = (y * s.w + x) * 4, a = s.px[si + 3];
        if (a <= 0) continue;
        const di = ((oy + y) * width + ox + x) * 4;
        data[di] = clamp(s.px[si] / a); data[di + 1] = clamp(s.px[si + 1] / a); data[di + 2] = clamp(s.px[si + 2] / a);
        data[di + 3] = clamp(a * 255);
      }
    }
  }
  return { sheet: { width, height, data }, cellWidth, cellHeight };
}
