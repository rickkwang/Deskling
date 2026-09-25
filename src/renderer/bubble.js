// The speech balloon window: a view. The pet window owns the conversation and
// sends content here; main places this window next to the pet (above/below,
// sliding sideways to stay on screen) and tells us where the tail goes.

const $ = (sel) => document.querySelector(sel);
const bubble = $('#bubble');
const msg = $('#msg');
const form = $('#ask');
const input = $('#input');
const sendBtn = $('#send');
const api = window.pet.balloon;

let busy = false;
let side = 'below';
let tailLeft = 186;

// The balloon's outline: a rounded box with the tail on the side facing the
// pet, its tip `tail` px outside the box (main.js sends it with the theme and
// places the window for it). Radius, tail shape and shadow blur come from the
// theme's stylesheet.
let tail = 7;
const SHEEN = 22; // height of the Aqua gel highlight
const shape = $('#shape');

function themeGeometry() {
  const css = getComputedStyle(document.body);
  const num = (name, fallback) => {
    const v = parseFloat(css.getPropertyValue(name));
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    r: num('--radius', 9),
    kind: css.getPropertyValue('--tail-shape').trim() || 'straight',
    blur: num('--shadow-blur', 3),
  };
}

// The tail as it is drawn along the top edge, left to right: x positions and
// `out` (distance beyond the edge), with Bézier control points per segment.
function tailSegments(kind, c, w, r) {
  const t = tail;
  if (kind === 'popover') {
    // NSPopover's arrow on macOS 26 (measured): 29 wide at the base, which
    // flares into the edge, with a rounded tip.
    c = Math.min(Math.max(c, r + 15), w - r - 15);
    return { start: [c - 15, 0], segs: [
      { ctrl: [[c - 10, 0], [c - 4.5, t - 3.5]], to: [c - 2, t - 1] },
      { ctrl: [[c, t + 0.3]], to: [c + 2, t - 1] },
      { ctrl: [[c + 4.5, t - 3.5], [c + 10, 0]], to: [c + 15, 0] },
    ] };
  }
  if (kind === 'corner') {
    // Balloon Help (Inside Macintosh: More Macintosh Toolbox, fig. 3-4): a
    // thin spike out of a corner, its tip out past the balloon's side.
    const near = 9, far = 19; // where the spike's two edges meet the balloon
    return c < w / 2
      ? { start: [near, 0], segs: [{ to: [c, t] }, { to: [far, 0] }] }
      : { start: [w - far, 0], segs: [{ to: [c, t] }, { to: [w - near, 0] }] };
  }
  return { start: [c - t, 0], segs: [{ to: [c, t] }, { to: [c + t, 0] }] };
}

// Path commands for the tail on an edge at `y` bulging by `sign` (-1 up, +1
// down), traversed left to right, or right to left when `reverse`.
function tailPath({ start, segs }, y, sign, reverse) {
  const pt = ([x, out]) => `${x} ${y + sign * out}`;
  const cmd = (ctrl, to) => (['L', 'Q', 'C'][ctrl.length]) + [...ctrl, to].map(pt).join(' ');
  if (!reverse) return `H${start[0]}` + segs.map((s) => cmd(s.ctrl || [], s.to)).join('');
  const points = [start, ...segs.map((s) => s.to)];
  let d = `H${points.at(-1)[0]}`;
  for (let i = segs.length - 1; i >= 0; i--) d += cmd([...(segs[i].ctrl || [])].reverse(), points[i]);
  return d;
}

function drawShape() {
  const w = bubble.offsetWidth;
  const h = bubble.offsetHeight;
  const { r, kind, blur } = themeGeometry();
  const x0 = 0.5, y0 = 0.5, x1 = w - 0.5, y1 = h - 0.5; // on the pixel grid
  const segs = tailSegments(kind, tailLeft, w, r);
  const top = side === 'below' ? tailPath(segs, y0, -1, false) : '';
  const bottom = side === 'above' ? tailPath(segs, y1, 1, true) : '';
  $('#shape-path').setAttribute('d',
    `M${x0 + r} ${y0}${top}H${x1 - r}A${r} ${r} 0 0 1 ${x1} ${y0 + r}V${y1 - r}` +
    `A${r} ${r} 0 0 1 ${x1 - r} ${y1}${bottom}H${x0 + r}A${r} ${r} 0 0 1 ${x0} ${y1 - r}` +
    `V${y0 + r}A${r} ${r} 0 0 1 ${x0 + r} ${y0}Z`);
  shape.setAttribute('width', w);
  shape.setAttribute('height', h);
  $('#shape-blur feGaussianBlur').setAttribute('stdDeviation', blur);
  // Aqua: a gel highlight floating just inside the rim, a glow at the bottom.
  setRect('#glass-sheen', 3, 2, w - 6, Math.min(SHEEN, h * 0.4));
  setRect('#glass-glow', 0, h * 0.35, w, h * 0.65 + tail);
  // Windows 98 (square corners): a raised frame lit from the top left. The
  // outer line runs along the tail too, light on top and dark below; the
  // inner line stops at the tail, where a patch of face colour covers it.
  $('#bevel-outer-light').setAttribute('d', `M${x0} ${y1}V${y0}${top}H${x1}`);
  $('#bevel-outer-dark').setAttribute('d', `M${x1} ${y0}V${y1}${bottom}H${x0}`);
  $('#bevel-inner-light').setAttribute('d', `M1.5 ${h - 2}V1.5H${w - 2}`);
  $('#bevel-inner-dark').setAttribute('d', `M${w - 1.5} 1V${h - 1.5}H1`);
  const edge = side === 'below' ? y0 : y1;
  const sign = side === 'below' ? -1 : 1;
  const inside = edge - sign * 2.5;
  $('#tail-patch').setAttribute('d', `M${segs.start[0]} ${inside}${tailPath(segs, edge, sign, false).replace(/^H[\d.-]+/, `V${edge}`)}V${inside}Z`);
}

function setRect(sel, x, y, width, height) {
  const el = $(sel);
  for (const [k, v] of Object.entries({ x, y, width, height })) el.setAttribute(k, v);
}

api.onContent(({ text, error, dots, busy: b }) => {
  busy = b;
  msg.classList.toggle('error', Boolean(error));
  msg.classList.toggle('dots', Boolean(dots));
  msg.textContent = dots ? 'Thinking…' : text;
  msg.scrollTop = msg.scrollHeight;
  sendBtn.disabled = !input.value.trim() || busy;
});

api.onPlace((place) => {
  document.body.classList.toggle('below', place.side === 'below');
  document.body.classList.toggle('above', place.side === 'above');
  bubble.style.setProperty('--tail-left', `${place.tailLeft}px`);
  ({ side, tailLeft } = place);
  drawShape();
});

// Showing/hiding is a CSS transition (bubble.css); main makes the window
// click-through while the balloon is hidden.
api.onOpen((open) => {
  document.body.classList.toggle('open', open);
  if (!open) input.blur();
});

api.onFocus(() => input.focus());

api.onTheme((theme) => {
  document.body.dataset.theme = theme.id;
  tail = theme.tail;
  drawShape(); // the size may not change, but radius and tail do
});

// Main sizes the window to the balloon.
new ResizeObserver(() => {
  api.size(Math.ceil(bubble.offsetHeight));
  drawShape();
}).observe(bubble);

input.addEventListener('input', () => {
  sendBtn.disabled = !input.value.trim() || busy;
  api.typing();
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') api.escape();
});
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || busy) return;
  input.value = '';
  sendBtn.disabled = true;
  api.submit(text);
});
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.pet.contextMenu();
});
