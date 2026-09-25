// Character audit (electron . --audit): for every character, check that
//  1. every referenced sprite cell actually contains pixels;
//  2. every animation, played through the real AnimationPlayer (sped up, then
//     exited), ends on a visible image — except hide/goodbye;
//  3. every runtime state/action resolves to an animation that ends visible;
//  4. every state and idle animation starts from the rest pose and settles
//     back on it (after its Return), so hand-overs don't jump.
import { AnimationPlayer } from '../runtime/animation-player.js';
import { REQUIRED_STATES } from '../character/validate.js';
import { exitNext } from '../character/exit.js';

const { log, done } = window.pet.selftest;
const characters = await window.pet.auditCharacters();
const EXPECT_BLANK = new Set(['hide', 'goodbye']);
// Share of the pose's pixels that may differ from the rest pose at a hand-over.
// Compared after a slight blur, which hides the dither noise between two
// exports of the same drawing (Office Logo) but not a change of pose. Neutral
// poses measure up to 9% (Peedy's wings); the idles taken out of the idle
// levels for jumping measured 13-30%.
const SEAM_MAX = 0.1;
let failures = 0;

for (const { data, sheetUrl } of characters) {
  const img = new Image();
  img.src = sheetUrl;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const { cellWidth: w, cellHeight: h } = data.spritesheet;
  const memo = new Map();
  const cellVisible = ([col, row]) => {
    const key = `${col},${row}`;
    if (!memo.has(key)) {
      const px = ctx.getImageData(col * w, row * h, w, h).data;
      let n = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i] > 16) n++;
      memo.set(key, n > 20);
    }
    return memo.get(key);
  };
  const visible = (cells) => Boolean(cells?.length) && cells.some(cellVisible);
  const issues = [];

  // 1. frames with images must show something (layers may be empty individually).
  // Entrance/exit animations legitimately fade through near-empty frames.
  const transitions = new Set(['show', 'hide', 'greeting', 'goodbye'].flatMap((st) => data.states[st]?.animations || []));
  let fades = 0;
  for (const [name, anim] of Object.entries(data.animations)) {
    anim.frames.forEach((f, i) => {
      if (!f.cells.length || visible(f.cells)) return;
      if (transitions.has(name) || /^Hide/.test(name)) fades++;
      else issues.push(`${name}[${i}] shows only empty sprite cells for ${f.duration} ms`);
    });
  }

  // 2. play every animation through the real player
  const fast = structuredClone(data);
  for (const a of Object.values(fast.animations)) for (const f of a.frames) if (f.duration) f.duration = 1;
  const el = document.createElement('div');
  const player = new AnimationPlayer(el, fast, sheetUrl);
  let last = null;
  const draw = player._draw.bind(player);
  player._draw = (cells) => { last = cells; draw(cells); };
  const endsBlank = new Set();
  for (const name of Object.keys(fast.animations)) {
    last = null;
    const p = player.play(name);
    const t = setTimeout(() => player.exit(), 150);
    await p;
    clearTimeout(t);
    if (!visible(last)) endsBlank.add(name);
  }

  // 3. states/actions used by the runtime
  const used = Object.entries(data.states);
  for (const [state, def] of used) {
    for (const n of def.animations) {
      if (endsBlank.has(n) && !EXPECT_BLANK.has(state)) issues.push(`state ${state} -> ${n} ends on a blank frame (character would vanish)`);
    }
  }
  for (const n of data.idle.levels.flat()) if (endsBlank.has(n)) issues.push(`idle ${n} ends on a blank frame`);
  const missing = REQUIRED_STATES.filter((s) => !data.states[s]);
  if (missing.length) issues.push(`missing states ${missing}`);
  if (!visible(data.animations.RestPose?.frames[0]?.cells)) issues.push('RestPose is not visible');

  // 4. seams with the rest pose
  const blur = document.createElement('canvas');
  blur.width = w;
  blur.height = h;
  const bctx = blur.getContext('2d', { willReadFrequently: true });
  const flat = document.createElement('canvas');
  flat.width = w;
  flat.height = h;
  const fctx = flat.getContext('2d');
  const pose = (cells) => {
    fctx.clearRect(0, 0, w, h);
    for (const [col, row] of cells) fctx.drawImage(img, col * w, row * h, w, h, 0, 0, w, h);
    bctx.clearRect(0, 0, w, h);
    bctx.filter = 'blur(1.2px)';
    bctx.drawImage(flat, 0, 0);
    bctx.filter = 'none';
    return bctx.getImageData(0, 0, w, h).data;
  };
  const rest = pose(data.animations.RestPose.frames[0].cells);
  const seam = (cells) => {
    const px = pose(cells);
    let solid = 0, changed = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (Math.max(px[i + 3], rest[i + 3]) <= 32) continue;
      solid++;
      const d = Math.max(Math.abs(px[i] - rest[i]), Math.abs(px[i + 1] - rest[i + 1]), Math.abs(px[i + 2] - rest[i + 2]), Math.abs(px[i + 3] - rest[i + 3]));
      if (d > 48) changed++;
    }
    return solid ? changed / solid : 0;
  };
  const drawn = (f) => f.cells.length > 0;
  const lastDrawn = (frames) => frames.findLast(drawn)?.cells;
  // Where the animation leaves the character once it is over: after its
  // Return animation, or its exit branches back from the final pose.
  const settles = (anim) => {
    if (anim.returnAnimation) return lastDrawn(data.animations[anim.returnAnimation].frames);
    const { frames } = anim;
    let i = frames.findLastIndex(drawn);
    if (i < 0) return [];
    let cells = frames[i].cells;
    if (anim.useExitBranching) {
      const seen = new Set();
      while ((i = exitNext(frames, i)) < frames.length && !seen.has(i)) {
        seen.add(i);
        if (drawn(frames[i])) cells = frames[i].cells;
      }
    }
    return cells;
  };
  const handovers = new Map(); // animation -> roles
  for (const [state, def] of used) for (const n of def.animations) handovers.set(n, [...(handovers.get(n) || []), state]);
  data.idle.levels.forEach((lvl, i) => lvl.forEach((n) => handovers.set(n, [...(handovers.get(n) || []), `idle${i + 1}`])));
  for (const [name, roles] of handovers) {
    const anim = data.animations[name];
    const entrance = roles.some((r) => r === 'show' || r === 'greeting');
    const exit = roles.some((r) => r === 'hide' || r === 'goodbye');
    const start = entrance ? 0 : seam(anim.frames.find(drawn).cells);
    const end = exit ? 0 : seam(settles(anim));
    if (start > SEAM_MAX) issues.push(`${name} (${roles}) starts ${Math.round(start * 100)}% off the rest pose`);
    if (end > SEAM_MAX) issues.push(`${name} (${roles}) settles ${Math.round(end * 100)}% off the rest pose`);
  }

  const other = [...endsBlank].filter((n) => !used.some(([, d]) => d.animations.includes(n)) && !data.idle.levels.flat().includes(n));
  failures += issues.length ? 1 : 0;
  log(`${issues.length ? 'FAIL' : 'ok  '} ${data.id.padEnd(7)} ${Object.keys(data.animations).length} animations${fades ? `; ${fades} fade frames in show/hide` : ''}${other.length ? `; unused animations ending blank: ${other.join(', ')}` : ''}`);
  issues.slice(0, 12).forEach((m) => log(`       - ${m}`));
  if (issues.length > 12) log(`       … ${issues.length - 12} more`);
}
done(failures ? 1 : 0);
