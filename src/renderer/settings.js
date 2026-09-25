// Assistant Settings window: Character + Behavior tabs. Every change is sent to
// the main process, which persists it and broadcasts it to the pet.

const $ = (sel) => document.querySelector(sel);
const { settings: initial, characters: initialCharacters, ai, styles, balloons, timer } = await window.pet.getSettings();
let characters = initialCharacters;
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
let tiles = [];
function buildGrid() {
  tiles = characters.map((card) => {
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
    return { tile, card };
  });
  // Last tile: add a character from a generated sprite sheet.
  const add = document.createElement('button');
  add.className = 'tile add-tile';
  add.title = 'Add a character from a sprite sheet image';
  const plus = document.createElement('div');
  plus.className = 'thumb';
  plus.textContent = '+';
  const label = document.createElement('span');
  label.textContent = 'Add…';
  add.append(plus, label);
  add.addEventListener('click', pickSheet);
  grid.replaceChildren(...tiles.map((t) => t.tile), add);
}
buildGrid();

grid.addEventListener('keydown', (e) => {
  const keys = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 4, ArrowUp: -4 };
  if (!(e.key in keys)) return;
  const i = tiles.findIndex((t) => t.tile === document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  const next = tiles[Math.max(0, Math.min(tiles.length - 1, i + keys[e.key]))];
  next.tile.focus();
  next.tile.click();
});

window.pet.characters.onChange((list) => {
  characters = list;
  buildGrid();
  render();
  fitWindow();
});

// The card under the grid: naming a new character, or renaming / deleting the
// selected custom one. Bundled characters have no card.
const custom = {
  card: $('#custom'), thumb: $('#custom-thumb'), name: $('#custom-name'), note: $('#custom-note'),
  primary: $('#custom-primary'), secondary: $('#custom-secondary'),
};
// While adding: { busy } as the image is cut, { preview, warnings } waiting
// for a name, { error } if the image can't be used.
let adding = null;

async function pickSheet() {
  const file = await window.pet.characters.choose();
  if (!file) return;
  adding = { busy: true };
  custom.name.value = '';
  render();
  fitWindow();
  // Let "Preparing…" paint before main spends a moment cutting the sheet.
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  const result = await window.pet.characters.prepare(file);
  adding = result.error ? { error: result.error } : { preview: result, warnings: result.warnings };
  render();
  if (!adding.error) custom.name.focus();
}

function stopAdding() {
  if (adding?.preview) window.pet.characters.cancel();
  adding = null;
  render();
  fitWindow();
}

async function confirmAdd() {
  const name = custom.name.value.trim();
  if (!name) return custom.name.focus();
  custom.primary.disabled = true;
  const result = await window.pet.characters.add(name);
  if (result?.id) {
    adding = null;
    fitWindow();
  } else {
    adding.saveError = result?.error || 'Couldn’t add the character.';
  }
  render();
}

custom.primary.addEventListener('click', () => {
  if (adding?.busy) return;
  if (adding?.error) pickSheet();
  else if (adding) confirmAdd();
  else window.pet.characters.remove(settings.character);
});
custom.secondary.addEventListener('click', stopAdding);
custom.name.addEventListener('input', () => { if (adding?.preview) custom.primary.disabled = !custom.name.value.trim(); });
custom.name.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); if (adding?.preview) confirmAdd(); else custom.name.blur(); }
  if (e.key === 'Escape') { e.preventDefault(); if (adding) stopAdding(); else { custom.name.value = currentCard()?.displayName || ''; custom.name.blur(); } }
});
custom.name.addEventListener('change', () => {
  const card = currentCard();
  const name = custom.name.value.trim();
  if (adding || !card?.custom) return;
  if (!name) custom.name.value = card.displayName;
  else if (name !== card.displayName) window.pet.characters.rename(card.id, name);
});
$('#copy-prompt').addEventListener('click', (e) => {
  window.pet.characters.copyPrompt();
  e.target.textContent = 'copied';
  setTimeout(() => { e.target.textContent = 'copy the prompt'; }, 1600);
});

const currentCard = () => characters.find((c) => c.id === settings.character);

function renderCustom() {
  const card = currentCard();
  const show = Boolean(adding || card?.custom);
  custom.card.hidden = !show;
  if (!show) return;
  const failed = Boolean(adding?.error);
  custom.card.classList.toggle('failed', failed);
  custom.card.classList.toggle('busy', Boolean(adding?.busy));
  custom.name.hidden = failed || Boolean(adding?.busy);
  custom.secondary.hidden = !adding || Boolean(adding.busy);
  custom.primary.classList.toggle('danger', !adding);
  custom.note.classList.toggle('warn', Boolean(adding?.saveError || adding?.warnings?.length));
  if (adding?.busy) {
    custom.thumb.replaceChildren();
    custom.note.textContent = 'Preparing the character…';
    custom.primary.textContent = 'Add';
    custom.primary.disabled = true;
  } else if (failed) {
    custom.thumb.replaceChildren();
    custom.note.textContent = `Couldn’t use this image: ${adding.error}`;
    custom.secondary.textContent = 'Cancel';
    custom.primary.textContent = 'Choose Another…';
    custom.primary.disabled = false;
  } else if (adding) {
    custom.thumb.replaceChildren(sprite(adding.preview, { w: 52, h: 48 }));
    custom.note.textContent = adding.saveError
      || (adding.warnings.length ? `Some poses may look off: ${adding.warnings.join('; ')}` : 'New character');
    custom.secondary.textContent = 'Cancel';
    custom.primary.textContent = 'Add';
    custom.primary.disabled = !custom.name.value.trim();
  } else {
    custom.thumb.replaceChildren(sprite(card, { w: 52, h: 48 }));
    if (document.activeElement !== custom.name) custom.name.value = card.displayName;
    custom.note.textContent = 'Your character · click the name to rename';
    custom.primary.textContent = 'Delete…';
    custom.primary.disabled = false;
  }
}

// Balloon style: a miniature of each look (settings.css .mini-<id>).
const balloonRow = $('#balloons');
const balloonTiles = Object.entries(balloons).map(([id, label]) => {
  const tile = document.createElement('button');
  tile.className = 'tile';
  tile.setAttribute('role', 'radio');
  const mini = document.createElement('span');
  mini.className = `mini mini-${id}`;
  mini.textContent = 'Hi!';
  const name = document.createElement('span');
  name.textContent = label;
  tile.append(mini, name);
  tile.addEventListener('click', () => window.pet.setSettings({ balloon: id }));
  balloonRow.append(tile);
  return { tile, id };
});

balloonRow.addEventListener('keydown', (e) => {
  const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
  if (!step) return;
  e.preventDefault();
  const i = balloonTiles.findIndex((t) => t.tile === document.activeElement);
  const next = balloonTiles[Math.max(0, Math.min(balloonTiles.length - 1, i + step))];
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

// Hours, minutes and seconds. The total is what counts: 90 min reads back as
// 1 h 30 min, and out-of-range totals snap to the nearest limit.
const DURATIONS = [['focus', 'focusSeconds'], ['break', 'breakSeconds']];
const durationFields = (kind) => [...document.querySelectorAll(`#${kind}-duration input`)];
function showDuration(kind, seconds) {
  const [h, m, s] = durationFields(kind);
  h.value = Math.floor(seconds / 3600);
  m.value = Math.floor(seconds / 60) % 60;
  s.value = seconds % 60;
}
for (const [kind, key] of DURATIONS) {
  const [min, max] = timer.limits[kind];
  durationFields(kind)[0].max = Math.floor(max / 3600);
  for (const input of durationFields(kind)) {
    input.addEventListener('change', () => {
      const total = durationFields(kind).reduce((sum, f) => sum + Math.max(0, Math.round(Number(f.value) || 0)) * f.dataset.unit, 0);
      const seconds = Math.min(max, Math.max(min, total));
      showDuration(kind, seconds);
      window.pet.setSettings({ [key]: seconds });
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
  }
}
const soundSelect = $('#timer-sound');
for (const [id, { label }] of Object.entries(timer.sounds)) soundSelect.add(new Option(label, id));
// Picking a sound plays it, like the Sound pane in System Preferences.
soundSelect.addEventListener('change', () => {
  const id = soundSelect.value;
  const { file } = timer.sounds[id];
  if (file) new Audio(`sounds/${file}`).play().catch(() => {});
  window.pet.setSettings({ timerSound: id });
});

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
  for (const { tile, id } of balloonTiles) {
    const on = id === settings.balloon;
    tile.setAttribute('aria-checked', String(on));
    tile.tabIndex = on ? 0 : -1;
  }
  renderCustom();
  const current = currentCard() || characters[0];
  $('#avatar').replaceChildren(sprite(current, { w: 30, h: 30 }));
  $('#enabled').checked = settings.enabled;
  grid.classList.toggle('off', !settings.enabled);
  if (document.activeElement !== scaleInput) scaleInput.value = settings.scale ?? 1;
  showScale();
  $('#greeting').checked = settings.greeting;
  $('#speech').checked = settings.speech;
  styleSelect.value = settings.responseStyle;
  for (const [kind, key] of DURATIONS) {
    if (!durationFields(kind).includes(document.activeElement)) showDuration(kind, settings[key]);
  }
  soundSelect.value = settings.timerSound;
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
