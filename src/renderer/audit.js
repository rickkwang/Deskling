// Character audit (electron . --audit): for every character, check that
//  1. every referenced sprite cell actually contains pixels;
//  2. every animation, played through the real AnimationPlayer (sped up, then
//     exited), ends on a visible image — except hide/goodbye;
//  3. every runtime state/action resolves to an animation that ends visible.
import { AnimationPlayer } from '../runtime/animation-player.js';
import { REQUIRED_STATES } from '../character/validate.js';

const { log, done } = window.pet.selftest;
const characters = await window.pet.auditCharacters();
const EXPECT_BLANK = new Set(['hide', 'goodbye']);
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

  const other = [...endsBlank].filter((n) => !used.some(([, d]) => d.animations.includes(n)) && !data.idle.levels.flat().includes(n));
  failures += issues.length ? 1 : 0;
  log(`${issues.length ? 'FAIL' : 'ok  '} ${data.id.padEnd(7)} ${Object.keys(data.animations).length} animations${fades ? `; ${fades} fade frames in show/hide` : ''}${other.length ? `; unused animations ending blank: ${other.join(', ')}` : ''}`);
  issues.slice(0, 12).forEach((m) => log(`       - ${m}`));
  if (issues.length > 12) log(`       … ${issues.length - 12} more`);
}
done(failures ? 1 : 0);
