// Assistant Settings window: Character + Behavior tabs. Every change is sent to
// the main process, which persists it and broadcasts it to the pet.

const $ = (sel) => document.querySelector(sel);
const { settings: initial, characters, ai, styles } = await window.pet.getSettings();
let settings = initial;

// ---- tabs ------------------------------------------------------------------

const tabBar = $('.tabs');
const tabs = [...document.querySelectorAll('[role="tab"]')];
function selectTab(name) {
  for (const tab of tabs) {
    const on = tab.id === `tab-${name}`;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !on;
  }
  tabBar.dataset.active = name;
  fitWindow();
}

// Like System Preferences: the window grows or shrinks to the active pane.
function fitWindow() {
  requestAnimationFrame(() => {
    // Measure the pane at its natural size (no flex stretching), synchronously.
    document.body.classList.add('measuring');
    const bottom = document.querySelector('.panel').getBoundingClientRect().bottom + 20; // body padding
    document.body.classList.remove('measuring');
    // How much taller than the default the user may drag the window.
    const extra = 60;
    window.pet.fitSettings({ height: Math.ceil(bottom), extra });
  });
}
tabs.forEach((tab) => {
  tab.addEventListener('click', () => selectTab(tab.id.replace('tab-', '')));
  tab.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const next = tabs[(tabs.indexOf(tab) + 1) % tabs.length];
    selectTab(next.id.replace('tab-', ''));
    next.focus();
  });
});
selectTab(location.hash === '#behavior' ? 'behavior' : 'character');
window.pet.onSettingsTab(selectTab);
// Slide only on user switches, not when the window first opens.
requestAnimationFrame(() => requestAnimationFrame(() => tabBar.classList.add('ready')));

// ---- character tab -----------------------------------------------------------

// Thumbnails are drawn from the RestPose cell trimmed to its visible pixels,
// so every character is centred and stands on the same baseline.
const sheets = new Map();
function loadSheet(url) {
  if (!sheets.has(url)) {
    const img = new Image();
    img.src = url;
    sheets.set(url, img.decode().then(() => img));
  }
  return sheets.get(url);
}

function visibleBounds(img, x0, y0, w, h) {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, x0, y0, w, h, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] > 24) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? { x: 0, y: 0, w, h } : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function sprite(card, box) {
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  canvas.className = 'sprite';
  canvas.width = Math.round(box.w * dpr);
  canvas.height = Math.round(box.h * dpr);
  canvas.style.width = `${box.w}px`;
  canvas.style.height = `${box.h}px`;
  loadSheet(card.sheetUrl).then((img) => {
    const { cellWidth: w, cellHeight: h, cell: [col, row] } = card;
    const b = visibleBounds(img, col * w, row * h, w, h);
    const scale = Math.min(1, box.w / b.w, box.h / b.h) * dpr;
    const dw = b.w * scale;
    const dh = b.h * scale;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = scale < dpr; // crisp when not downscaled
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, col * w + b.x, row * h + b.y, b.w, b.h, (canvas.width - dw) / 2, canvas.height - dh, dw, dh);
  });
  return canvas;
}

const grid = $('#grid');
const tiles = characters.map((card) => {
  const tile = document.createElement('button');
  tile.className = 'tile';
  tile.setAttribute('role', 'radio');
  tile.title = card.description || card.displayName;
  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  thumb.append(sprite(card, { w: 52, h: 48 }));
  const name = document.createElement('span');
  name.textContent = card.displayName;
  tile.append(thumb, name);
  tile.addEventListener('click', () => window.pet.setSettings({ character: card.id }));
  grid.append(tile);
  return { tile, card };
});

grid.addEventListener('keydown', (e) => {
  const keys = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 4, ArrowUp: -4 };
  if (!(e.key in keys)) return;
  e.preventDefault();
  const i = tiles.findIndex((t) => t.tile === document.activeElement);
  const next = tiles[Math.max(0, Math.min(tiles.length - 1, i + keys[e.key]))];
  next.tile.focus();
  next.tile.click();
});

// ---- behavior tab ------------------------------------------------------------

const styleSelect = $('#style');
for (const [value, { label }] of Object.entries(styles)) styleSelect.add(new Option(label, value));

const modelSelect = $('#model');
if (ai.models.length) {
  for (const m of ai.models) modelSelect.add(new Option(m, m));
  $('#model-note').textContent = 'Local Ollama model';
} else {
  modelSelect.add(new Option(ai.available ? 'No local models' : 'Ollama not running', ''));
  modelSelect.disabled = true;
  $('#model-note').textContent = ai.available ? 'Pull one with ollama pull' : 'Start it with ollama serve';
}

const bind = (id, key, prop = 'checked') => $(id).addEventListener('change', (e) => window.pet.setSettings({ [key]: e.target[prop] }));
bind('#enabled', 'enabled');
bind('#greeting', 'greeting');
bind('#speech', 'speech');
bind('#style', 'responseStyle', 'value');
bind('#model', 'model', 'value');

// Size: live while dragging; main resizes the pet around its feet.
const scaleInput = $('#scale');
const scaleValue = $('#scale-value');
const showScale = () => {
  scaleValue.textContent = `${Math.round(scaleInput.value * 100)}%`;
  const { min, max, value } = scaleInput;
  scaleInput.style.setProperty('--fill', `${((value - min) / (max - min)) * 100}%`);
};
scaleInput.addEventListener('input', () => {
  showScale();
  window.pet.setSettings({ scale: Number(scaleInput.value) });
});

const instructions = $('#instructions');
const count = $('#count');
let saveTimer = null;
instructions.addEventListener('input', () => {
  updateCount();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => window.pet.setSettings({ instructions: instructions.value }), 400);
});
function updateCount() {
  const n = instructions.value.length;
  count.textContent = `${n}/${instructions.maxLength}`;
  count.classList.toggle('full', n >= instructions.maxLength);
}

// ---- render ------------------------------------------------------------------

function render() {
  for (const { tile, card } of tiles) {
    const on = card.id === settings.character;
    tile.setAttribute('aria-checked', String(on));
    tile.tabIndex = on ? 0 : -1;
  }
  const current = characters.find((c) => c.id === settings.character) || characters[0];
  $('#avatar').replaceChildren(sprite(current, { w: 30, h: 30 }));
  $('#enabled').checked = settings.enabled;
  grid.classList.toggle('off', !settings.enabled);
  if (document.activeElement !== scaleInput) scaleInput.value = settings.scale ?? 1;
  showScale();
  $('#greeting').checked = settings.greeting;
  $('#speech').checked = settings.speech;
  styleSelect.value = settings.responseStyle;
  if (ai.models.length) modelSelect.value = ai.models.includes(settings.model) ? settings.model : ai.model;
  if (document.activeElement !== instructions) {
    instructions.value = settings.instructions || '';
    updateCount();
  }
}

window.pet.onSettings((next) => {
  settings = next;
  render();
});
render();
fitWindow();
