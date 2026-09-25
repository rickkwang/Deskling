// QA preview: every animation of a character looping side by side, tagged with
// the app states that use it (green = official, orange = app-mapped).
import { AnimationPlayer } from '../runtime/animation-player.js';

const { character: { data, sheetUrl }, frame } = await window.pet.init();
document.getElementById('title').textContent = `${data.displayName} — ${Object.keys(data.animations).length} animations`;
const usedBy = {};
for (const [state, def] of Object.entries(data.states)) {
  for (const n of def.animations) (usedBy[n] ||= []).push([state, def.source]);
}
data.idle?.levels.forEach((lvl, i) => lvl.forEach((n) => (usedBy[n] ||= []).push([`idle L${i + 1}`, data.idle.source])));

const grid = document.getElementById('grid');
for (const name of Object.keys(data.animations).sort()) {
  const cell = document.createElement('div');
  cell.className = 'cell';
  const sprite = document.createElement('div');
  sprite.className = 'sprite';
  const tags = (usedBy[name] || []).map(([s, src]) => `<span class="tag ${src}">${s}</span>`).join('');
  cell.append(sprite);
  cell.insertAdjacentHTML('beforeend', `<div><b>${name}</b> · ${data.animations[name].frames.length}f</div><div>${tags}</div>`);
  grid.append(cell);
  const player = new AnimationPlayer(sprite, data, sheetUrl);
  if (frame != null) {
    // Static contact sheet: freeze on a given fraction of each animation.
    const frames = data.animations[name].frames;
    const i = Math.min(frames.length - 1, Math.floor(frames.length * frame));
    player._draw(frames[i].cells.length ? frames[i].cells : (frames.find((f) => f.cells.length)?.cells || []));
  } else {
    (async () => { for (;;) { const p = player.play(name); setTimeout(() => player.exit(), 8000); await p; await new Promise((r) => setTimeout(r, 600)); } })();
  }
}
window.pet.selftest.previewReady?.();
