import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Assistant, RESPONSE_STYLES } from '../ai/assistant.js';
import { DragFollower } from './drag-follow.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SELFTEST = process.argv.includes('--selftest');
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
// QA preview: electron . --preview[=<character>] [--frame=0.5] [--capture]
const PREVIEW = process.argv.some((a) => a === '--preview' || a.startsWith('--preview='));
// QA: electron . --settings-preview=character|behavior  (captures qa/settings-<tab>.png)
const SETTINGS_PREVIEW = arg('settings-preview');
// QA: electron . --audit  (sprite/animation visibility audit for every character)
const AUDIT = process.argv.includes('--audit');
const WIN_W = 340;
const WIN_H = 600;

let win = null;
let bubbleWin = null;
let settingsWin = null;
let tray = null;
const assistant = new Assistant();

// ---- settings -------------------------------------------------------------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = {
  character: 'clippy', model: null,
  // Screen point where the pet's feet stand (the window is laid out around it).
  petX: null, petY: null,
  scale: 1,
  // Behavior (Assistant Settings)
  enabled: true, greeting: true, speech: false, responseStyle: 'normal', instructions: '',
};
// Earlier names of the app, newest first: carry their data over once.
const OLD_NAMES = ['It Looks Like', 'ai-desk-pet'];
function migrateUserData() {
  const dir = app.getPath('userData');
  if (fs.existsSync(path.join(dir, 'settings.json'))) return;
  const old = OLD_NAMES.map((n) => path.join(app.getPath('appData'), n)).find((d) => fs.existsSync(path.join(d, 'settings.json')));
  if (!old) return;
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['settings.json', 'characters']) {
    const from = path.join(old, name);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(dir, name), { recursive: true });
  }
}

function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch { /* first run */ }
  // Migrate the old fixed-layout window position (340x600, feet at 266,360).
  if (settings.petX == null && settings.x != null) {
    settings.petX = settings.x + 266;
    settings.petY = settings.y + 360;
  }
  delete settings.x;
  delete settings.y;
}
function saveSettings() {
  if (SELFTEST || SETTINGS_PREVIEW) return;
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

// ---- characters -----------------------------------------------------------
// Bundled characters live in <app>/characters; user characters in
// <userData>/characters/<id>/character.json (same schema).

function characterDirs() {
  return [path.join(ROOT, 'characters'), path.join(app.getPath('userData'), 'characters')];
}

function listCharacters() {
  const found = new Map();
  for (const base of characterDirs()) {
    if (!fs.existsSync(base)) continue;
    for (const id of fs.readdirSync(base)) {
      const file = path.join(base, id, 'character.json');
      if (!fs.existsSync(file)) continue;
      try {
        const { id: cid, displayName, order } = JSON.parse(fs.readFileSync(file, 'utf8'));
        found.set(cid, { id: cid, displayName, order: order ?? Infinity, dir: path.join(base, id) });
      } catch (e) {
        console.warn(`[characters] skipping ${file}: ${e.message}`);
      }
    }
  }
  return [...found.values()].sort((a, b) => a.order - b.order || a.displayName.localeCompare(b.displayName));
}

// First visible frame of RestPose, used as the character's thumbnail.
function characterCard(entry) {
  const data = JSON.parse(fs.readFileSync(path.join(entry.dir, 'character.json'), 'utf8'));
  const frames = (data.animations.RestPose || Object.values(data.animations)[0]).frames;
  const cell = frames.find((f) => f.cells.length)?.cells[0] || [0, 0];
  const { cellWidth, cellHeight } = data.spritesheet;
  return {
    id: data.id, displayName: data.displayName, description: data.description,
    sheetUrl: pathToFileURL(path.join(entry.dir, data.spritesheet.path)).href,
    cell, cellWidth, cellHeight,
  };
}

function loadCharacter(id) {
  const all = listCharacters();
  const entry = all.find((c) => c.id === id) || all.find((c) => c.id === 'clippy') || all[0];
  const data = JSON.parse(fs.readFileSync(path.join(entry.dir, 'character.json'), 'utf8'));
  return { data, sheetUrl: pathToFileURL(path.join(entry.dir, data.spritesheet.path)).href };
}

// ---- window ---------------------------------------------------------------

// Size of the pet on screen (reported by the renderer's layout).
let petBox = { w: 124, h: 93 };

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// Keeps the whole pet inside a display's work area: sides within the screen,
// head below the menu bar, feet above the dock. Used both while dragging and
// when laying out, so a drop never "bounces back".
function clampFeet(p, near = p) {
  const { workArea: a } = screen.getDisplayNearestPoint(near);
  const half = petBox.w / 2;
  return {
    x: Math.round(clamp(p.x, a.x + half, a.x + a.width - half)),
    // The window's top (not just the pet's head) must stay below the menu bar,
    // or macOS pushes the window down itself.
    y: Math.round(clamp(p.y, a.y + Math.max(petBox.h, anchor.y), a.y + a.height)),
  };
}

// Feet position of the pet, kept on screen.
function petPoint() {
  let p = settings.petX != null ? { x: settings.petX, y: settings.petY } : null;
  if (!p) {
    const { workArea } = screen.getPrimaryDisplay();
    p = { x: workArea.x + workArea.width - 90, y: workArea.y + workArea.height - 16 };
  }
  return clampFeet(p);
}

// Where the feet sit inside the window (set by the renderer's layout).
let anchor = { x: WIN_W - 16 - 58, y: 360 };

function layoutWindow({ width, height, anchorX, anchorY, petW, petH }) {
  anchor = { x: anchorX, y: anchorY };
  if (petW && petH) petBox = { w: petW, h: petH };
  const p = petPoint();
  if (SELFTEST && process.argv.includes('--trace-drag')) console.log(`[layout] ${Date.now() % 100000} ${width}x${height} anchor ${anchorX},${anchorY} feet ${p.x},${p.y}`);
  win.setBounds({ x: Math.round(p.x - anchorX), y: Math.round(p.y - anchorY), width, height });
  if (SELFTEST && process.argv.includes('--trace-drag')) console.log(`[layout] set ${Math.round(p.x - anchorX)},${Math.round(p.y - anchorY)} got ${JSON.stringify(win.getBounds())}`);
  placeBalloon();
}

function createWindow() {
  const p = petPoint();
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: p.x - anchor.x,
    y: p.y - anchor.y,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'src/main/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  win.once('ready-to-show', () => { if (settings.enabled || SELFTEST) win.showInactive(); });
  // While dragging, learn positions macOS refuses (see drag-follow.js).
  win.on('move', () => {
    if (!dragTimer) return;
    const [x, y] = win.getPosition();
    follower.observe({ x, y });
  });
  if (SELFTEST && process.argv.includes('--trace-drag')) {
    win.on('move', () => console.log(`[move] ${Date.now() % 100000} ${JSON.stringify(win.getBounds())} visible=${win.isVisible()}`));
    win.on('show', () => console.log(`[show] ${Date.now() % 100000} ${JSON.stringify(win.getBounds())}`));
  }
}

// ---- balloon window ---------------------------------------------------------
// The speech balloon is its own window, so opening it, resizing it or flipping
// it never moves or resizes the pet window (no jitter), and it can sit on any
// side of the pet.

const BALLOON_W = 264; // balloon box width (bubble.css)
const BALLOON_MARGIN = 10; // band around the box in its window (shadow + tail)
const EDGE_GAP = 12; // breathing room between the balloon and the screen edge
const TAIL_GAP = 2; // tail tip to the pet's feet (below) or head (above)
// The balloon window stays on screen once created; showing and hiding the
// balloon are CSS transitions inside it (bubble.css), with clicks passing
// through while it is hidden. Ordering a window in and out makes macOS drop
// the first frames of an entrance, and a transition can reverse mid-way.
// A fading balloon rides along with the pet at a fixed offset (a plain window
// move each frame; re-laying it out while it animates drops frames).
const LEAVE_MS = 180; // fade-out (bubble.css)
const balloon = { visible: false, h: 90, hiddenForDrag: false, side: 'below', content: null, shown: false, placed: '', follow: null };

function createBubbleWindow() {
  bubbleWin = new BrowserWindow({
    width: BALLOON_W + BALLOON_MARGIN * 2,
    height: balloon.h + BALLOON_MARGIN * 2,
    // Not a child window: macOS constrains a parent together with its
    // children, which kept the pet from reaching the left screen edge.
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.cjs'), contextIsolation: true },
  });
  bubbleWin.setAlwaysOnTop(true, 'floating');
  bubbleWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  bubbleWin.loadFile(path.join(ROOT, 'src/renderer/bubble.html'));
  // Content sent before the page loaded would be lost: replay the latest.
  bubbleWin.webContents.on('did-finish-load', () => {
    if (balloon.content) bubbleWin.webContents.send('bubble:content', balloon.content);
    if (balloon.visible) showBalloon();
  });
}

// Below the pet if it fits, else above; slid sideways to keep EDGE_GAP from
// the screen edges, with the tail pointing at the pet.
function placeBalloon() {
  if (!bubbleWin || !balloon.shown) return;
  const [wx, wy] = win.getPosition();
  const fx = wx + anchor.x;
  const fy = wy + anchor.y;
  const petTop = fy - petBox.h;
  const { workArea: a } = screen.getDisplayNearestPoint({ x: fx, y: fy });
  const bh = balloon.h;
  const tail = 2 * 7 + 1; // tail height (bubble.css --tail) plus overlap
  const belowTop = fy + TAIL_GAP + tail - 2;
  const aboveTop = petTop - TAIL_GAP - tail + 2 - bh;
  const fitsBelow = belowTop + bh + EDGE_GAP <= a.y + a.height;
  const fitsAbove = aboveTop - EDGE_GAP >= a.y;
  const side = fitsBelow ? 'below' : fitsAbove ? 'above' : (a.y + a.height - fy >= petTop - a.y ? 'below' : 'above');
  const boxTop = side === 'below' ? belowTop : aboveTop;
  // Prefer the pet near the balloon's right end, like the classic assistant.
  const preferredLeft = fx - (BALLOON_W - 50);
  const boxLeft = clamp(preferredLeft, a.x + EDGE_GAP, a.x + a.width - EDGE_GAP - BALLOON_W);
  const tailLeft = clamp(fx - boxLeft, 20, BALLOON_W - 20);
  balloon.side = side;
  bubbleWin.setBounds({
    x: Math.round(boxLeft - BALLOON_MARGIN),
    y: Math.round(boxTop - BALLOON_MARGIN),
    width: BALLOON_W + BALLOON_MARGIN * 2,
    height: bh + BALLOON_MARGIN * 2,
  });
  const place = { side, tailLeft: Math.round(tailLeft) };
  const key = JSON.stringify(place);
  if (key !== balloon.placed) {
    balloon.placed = key;
    bubbleWin.webContents.send('bubble:place', place);
  }
}

function showBalloon({ focus = false } = {}) {
  balloon.visible = true;
  // Created on first use (creating it together with the pet window let macOS
  // re-place the pet window).
  if (!bubbleWin) return createBubbleWindow();
  if (balloon.hiddenForDrag || !win?.isVisible()) return;
  const opening = !balloon.shown; // (re)appearing, or caught while fading out
  stopFollowing();
  balloon.shown = true;
  placeBalloon();
  bubbleWin.setIgnoreMouseEvents(false);
  if (!bubbleWin.isVisible()) bubbleWin.showInactive();
  if (opening) bubbleWin.webContents.send('bubble:open', true);
  if (focus) {
    bubbleWin.focus();
    bubbleWin.webContents.send('bubble:focus');
  }
}

function hideBalloon() {
  balloon.visible = false;
  fadeOutBalloon();
}

function fadeOutBalloon() {
  if (!balloon.shown) return;
  balloon.shown = false;
  bubbleWin.setIgnoreMouseEvents(true);
  bubbleWin.webContents.send('bubble:open', false);
  const [bx, by] = bubbleWin.getPosition();
  const [px, py] = win.getPosition();
  stopFollowing();
  balloon.follow = { dx: bx - px, dy: by - py, timer: setTimeout(stopFollowing, LEAVE_MS + 20) };
}

function stopFollowing() {
  clearTimeout(balloon.follow?.timer);
  balloon.follow = null;
}

function createPreviewWindow() {
  win = new BrowserWindow({
    width: 1280, height: 900, title: 'Character Preview',
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.cjs'), contextIsolation: true },
  });
  win.loadFile(path.join(ROOT, 'src/renderer/preview.html'));
  if (process.argv.includes('--capture')) {
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 1500));
      const img = await win.webContents.capturePage();
      const dir = path.join(ROOT, 'qa');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `preview-${arg('preview') || settings.character}.png`);
      fs.writeFileSync(file, img.toPNG());
      console.log(`[preview] wrote ${file}`);
      app.exit(0);
    });
  }
}

function showPet() {
  if (!win) return;
  if (!win.isVisible()) {
    win.showInactive();
    win.webContents.send('pet:visibility', 'show');
  }
  updateTray();
}

function hidePet() {
  // Renderer plays the Hide animation, then asks us to hide the window.
  if (win?.isVisible()) win.webContents.send('pet:visibility', 'hide');
}

// ---- menus ----------------------------------------------------------------

function switchCharacter(id) {
  if (id === settings.character) return;
  settings.character = id;
  const next = loadCharacter(id);
  assistant.setPersona(next.data.persona);
  win?.webContents.send('pet:character', next);
}

// Applies a partial settings change from any UI, persists and broadcasts it.
function updateSettings(patch) {
  if (patch.scale !== undefined) patch.scale = Math.min(2, Math.max(0.5, Number(patch.scale) || 1));
  const prev = { ...settings };
  if (patch.character && patch.character !== prev.character) switchCharacter(patch.character);
  Object.assign(settings, patch);
  if (patch.model !== undefined) assistant.setModel(settings.model);
  if (patch.responseStyle !== undefined || patch.instructions !== undefined) {
    assistant.setBehavior({ responseStyle: settings.responseStyle, instructions: settings.instructions });
  }
  if (patch.enabled !== undefined && patch.enabled !== prev.enabled) {
    if (settings.enabled) showPet(); else hidePet();
  }
  saveSettings();
  for (const w of [win, settingsWin]) w?.webContents.send('settings:changed', publicSettings());
  updateTray();
}

const publicSettings = () => {
  const { petX, petY, ...rest } = settings;
  return rest;
};

let settingsUserSized = false;
// Resize limits: width is fixed-range; height ranges from the active pane's
// natural height to that plus the pane's own allowance (how much it can use
// well), so the window never becomes sparse.
const SETTINGS_MIN_W = 420;
const SETTINGS_MAX_W = 460;
const SETTINGS_DEFAULT_H = 600; // default window: 440 x 600, like System Preferences' Assistant pane

function openSettings(tab) {
  if (settingsWin) {
    settingsWin.show();
    settingsWin.focus();
    if (tab) settingsWin.webContents.send('settings:tab', tab);
    return;
  }
  settingsWin = new BrowserWindow({
    width: 440,
    height: SETTINGS_DEFAULT_H,
    title: 'Assistant',
    // Content runs under the title bar so the page is one surface; it draws
    // its own centred title and drag region.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    resizable: true,
    minWidth: SETTINGS_MIN_W,
    maxWidth: SETTINGS_MAX_W,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#faf9f5', // settings.css --paper
    show: false,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.cjs'), contextIsolation: true },
  });
  settingsWin.loadFile(path.join(ROOT, 'src/renderer/settings.html'), tab ? { hash: tab } : undefined);
  settingsWin.once('ready-to-show', () => {
    settingsWin.show();
    app.focus({ steal: true });
  });
  if (SETTINGS_PREVIEW) {
    settingsWin.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 1200));
      const size = arg('size'); // e.g. --size=520x700 simulates a manual resize
      if (size) {
        settingsUserSized = true;
        const [width, height] = size.split('x').map(Number);
        settingsWin.setBounds({ ...settingsWin.getBounds(), width, height });
        await new Promise((r) => setTimeout(r, 400));
      }
      const tabState = await settingsWin.webContents.executeJavaScript(`location.hash + ' selected=' + document.querySelector('[aria-selected=true]')?.id`);
      console.log(`[settings-preview] tab ${tabState}`);
      const b = settingsWin.getBounds();
      console.log(`[settings-preview] bounds ${b.x},${b.y},${b.width},${b.height}`);
      await new Promise((r) => setTimeout(r, 1500)); // time for an OS-level screenshot
      const img = await settingsWin.webContents.capturePage();
      fs.mkdirSync(path.join(ROOT, 'qa'), { recursive: true });
      fs.writeFileSync(path.join(ROOT, 'qa', `settings-${SETTINGS_PREVIEW}.png`), img.toPNG());
      app.exit(0);
    });
  }
  // Once the user resizes by hand, stop snapping to the pane's natural height.
  settingsWin.on('will-resize', () => { settingsUserSized = true; });
  settingsWin.on('closed', () => { settingsWin = null; settingsUserSized = false; });
}

function buildContextMenu() {
  return Menu.buildFromTemplate([
    { label: 'Speech', type: 'checkbox', checked: settings.speech, click: (item) => updateSettings({ speech: item.checked }) },
    {
      label: 'Character',
      submenu: listCharacters().map((c) => ({
        label: c.displayName, type: 'radio', checked: c.id === settings.character,
        click: () => updateSettings({ character: c.id }),
      })),
    },
    { type: 'separator' },
    { label: 'New Conversation', click: () => { assistant.reset(); win.webContents.send('chat:reset'); } },
    { label: 'Assistant Settings…', click: () => openSettings() },
    { type: 'separator' },
    { label: 'Quit Assistant', click: () => app.quit() },
  ]);
}

function updateTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Desktop Assistant', type: 'checkbox', checked: settings.enabled, click: (item) => updateSettings({ enabled: item.checked }) },
    { label: 'Assistant Settings…', click: () => openSettings() },
    { type: 'separator' },
    { label: 'Quit Assistant', click: () => app.quit() },
  ]));
}

function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('📎');
  tray.setToolTip('Deskling');
  updateTray();
}

// ---- IPC ------------------------------------------------------------------

let press = null;
let dragTimer = null;

const follower = new DragFollower();

function followCursor() {
  const c = screen.getCursorScreenPoint();
  const feet = clampFeet({ x: press.feet.x + c.x - press.cursor.x, y: press.feet.y + c.y - press.cursor.y }, c);
  const pos = follower.next({ x: feet.x - anchor.x, y: feet.y - anchor.y });
  if (!pos) return;
  win.setPosition(pos.x, pos.y);
  const f = balloon.follow;
  if (f) bubbleWin.setPosition(pos.x + f.dx, pos.y + f.dy);
  if (SELFTEST && process.argv.includes('--trace-drag')) {
    const [nx, ny] = win.getPosition();
    console.log(`[drag] cursor ${c.x},${c.y} feet ${feet.x},${feet.y} set ${pos.x},${pos.y} got ${nx},${ny}`);
  }
}

function registerIpc() {
  ipcMain.handle('pet:init', async () => {
    if (PREVIEW) {
      const frame = arg('frame');
      return { character: loadCharacter(arg('preview') || settings.character), frame: frame != null ? Number(frame) : null };
    }
    const character = loadCharacter(settings.character);
    assistant.setPersona(character.data.persona);
    assistant.setBehavior({ responseStyle: settings.responseStyle, instructions: settings.instructions });
    const ai = await assistant.refresh(settings.model);
    return { character, ai, settings: publicSettings(), selftest: SELFTEST && { quiet: process.argv.includes('--quiet'), edge: process.argv.includes('--edge') || process.argv.includes('--edge-open'), edgeOpen: process.argv.includes('--edge-open'), hold: Number(arg('hold') || 2500) } };
  });

  ipcMain.on('mouse:interactive', (_e, interactive) => {
    win?.setIgnoreMouseEvents(!interactive, { forward: true });
  });

  // Press: remember where the cursor and the feet were. Start: follow the
  // cursor at display refresh rate until the renderer reports the release.
  ipcMain.on('drag:press', () => {
    const [x, y] = win.getPosition();
    press = { cursor: screen.getCursorScreenPoint(), feet: { x: x + anchor.x, y: y + anchor.y } };
  });
  ipcMain.on('drag:start', () => {
    if (!press) return;
    // The balloon folds away while dragging and reopens where the pet lands.
    if (balloon.visible) {
      balloon.hiddenForDrag = true;
      fadeOutBalloon();
    }
    clearInterval(dragTimer);
    follower.reset();
    // Follow at the display's refresh rate (8 ms on 120 Hz screens).
    const hz = screen.getDisplayNearestPoint(press.cursor).displayFrequency || 60;
    dragTimer = setInterval(followCursor, Math.max(4, Math.floor(1000 / hz)));
    followCursor();
  });
  ipcMain.handle('drag:end', () => {
    if (!dragTimer) return;
    followCursor();
    clearInterval(dragTimer);
    dragTimer = null;
    const [x, y] = win.getPosition();
    settings.petX = x + anchor.x;
    settings.petY = y + anchor.y;
    saveSettings();
    if (balloon.hiddenForDrag) {
      balloon.hiddenForDrag = false;
      if (balloon.visible) showBalloon();
    }
  });
  ipcMain.handle('win:layout', (_e, geo) => layoutWindow(geo));

  // Balloon: the pet window drives it; the balloon window reports input.
  ipcMain.on('bubble:content', (_e, content) => {
    balloon.content = content;
    bubbleWin?.webContents.send('bubble:content', content);
  });
  ipcMain.on('bubble:show', (_e, opts) => showBalloon(opts));
  ipcMain.on('bubble:hide', hideBalloon);
  ipcMain.on('bubble:size', (_e, h) => {
    if (h > 0 && h !== balloon.h) {
      balloon.h = h;
      placeBalloon();
    }
  });
  for (const ch of ['bubble:submit', 'bubble:typing', 'bubble:escape']) {
    ipcMain.on(ch, (_e, payload) => win?.webContents.send(ch, payload));
  }

  ipcMain.handle('settings:get', async () => ({
    settings: publicSettings(),
    characters: listCharacters().map(characterCard),
    ai: await assistant.refresh(settings.model),
    styles: RESPONSE_STYLES,
  }));
  ipcMain.on('settings:set', (_e, patch) => updateSettings(patch));
  ipcMain.on('settings:fit', (_e, { height, extra }) => {
    if (!settingsWin) return;
    // `height` is the active pane's natural content height: it is the minimum,
    // and the window snaps to it until the user resizes by hand.
    const b = settingsWin.getBounds();
    const frame = b.height - settingsWin.getContentSize()[1];
    const natural = Math.max(300, Math.min(900, height)) + frame;
    // Panes open at the default height (or taller if their content needs it).
    const preferred = Math.max(natural, SETTINGS_DEFAULT_H);
    const max = preferred + Math.max(0, Math.min(300, extra));
    settingsWin.setMinimumSize(SETTINGS_MIN_W, natural);
    settingsWin.setMaximumSize(SETTINGS_MAX_W, max);
    const target = settingsUserSized ? Math.min(max, Math.max(b.height, natural)) : preferred;
    // Keep the title bar in place while the pane resizes (animated on macOS).
    if (target !== b.height) settingsWin.setBounds({ ...b, height: target }, settingsWin.isVisible());
  });

  ipcMain.on('win:hide', () => {
    hideBalloon(); // already faded out by the pet before its Hide animation
    bubbleWin?.hide();
    win.hide();
    // Hidden from the pet itself (e.g. Hide animation) = Desktop Assistant off.
    if (settings.enabled) updateSettings({ enabled: false });
  });
  ipcMain.on('menu:context', () => buildContextMenu().popup({ window: win }));

  ipcMain.handle('ai:send', async (e, text) => {
    try {
      const reply = await assistant.send(text, (token) => e.sender.send('ai:token', token));
      return { ok: true, text: reply, model: assistant.model?.name };
    } catch (err) {
      return { ok: false, error: err.name === 'AbortError' ? 'ABORTED' : err.message };
    }
  });
  ipcMain.on('ai:cancel', () => assistant.cancel());

  ipcMain.handle('audit:characters', () => listCharacters().map((c) => loadCharacter(c.id)));
  // Where the feet actually are vs. where they should be (macOS may clamp windows).
  ipcMain.handle('selftest:geometry', () => {
    const b = win.getBounds();
    const want = petPoint();
    const bb = balloon.shown ? bubbleWin.getBounds() : null;
    const box = bb && { left: bb.x + BALLOON_MARGIN, right: bb.x + bb.width - BALLOON_MARGIN, top: bb.y + BALLOON_MARGIN, bottom: bb.y + bb.height - BALLOON_MARGIN };
    return { want, got: { x: b.x + anchor.x, y: b.y + anchor.y }, bounds: b, workArea: screen.getDisplayNearestPoint(want).workArea, petBox, balloon: box, side: balloon.side };
  });
  ipcMain.on('selftest:log', (_e, line) => console.log(`[selftest] ${line}`));
  ipcMain.handle('selftest:capture', async (_e, name) => {
    const img = await win.webContents.capturePage();
    const dir = path.join(ROOT, 'qa', settings.character);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.png`);
    fs.writeFileSync(file, img.toPNG());
    const balloonFile = path.join(dir, `${name}-balloon.png`);
    if (balloon.shown) fs.writeFileSync(balloonFile, (await bubbleWin.webContents.capturePage()).toPNG());
    else fs.rmSync(balloonFile, { force: true });
    return file;
  });
  ipcMain.on('selftest:done', (_e, code) => { setTimeout(() => app.exit(code), 200); });
}

// ---- lifecycle ------------------------------------------------------------

if (!SELFTEST && !PREVIEW && !SETTINGS_PREVIEW && !AUDIT && !app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => updateSettings({ enabled: true }));

app.whenReady().then(() => {
  migrateUserData();
  loadSettings();
  // Selftest can target one character without touching saved settings.
  if (SELFTEST && arg('character')) settings.character = arg('character');
  if (SELFTEST && arg('scale')) settings.scale = Number(arg('scale'));
  if (SELFTEST) {
    // Keep test windows away from the real pet so they never overlap it.
    const { workArea } = screen.getPrimaryDisplay();
    settings.petX = workArea.x + 320;
    settings.petY = workArea.y + 480;
    // --pet-at=x,y (relative to the work area) puts the pet's feet somewhere specific.
    const at = arg('pet-at');
    if (at) {
      const [x, y] = at.split(',').map(Number);
      settings.petX = workArea.x + x;
      settings.petY = y < 0 ? workArea.y + workArea.height + y : workArea.y + y;
    }
  }
  if (process.platform === 'darwin' && !PREVIEW && !SETTINGS_PREVIEW && !AUDIT) app.dock?.hide();
  registerIpc();
  if (PREVIEW) return createPreviewWindow();
  if (SETTINGS_PREVIEW) return openSettings(SETTINGS_PREVIEW);
  if (AUDIT) {
    win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(ROOT, 'src/main/preload.cjs'), contextIsolation: true } });
    return win.loadFile(path.join(ROOT, 'src/renderer/audit.html'));
  }
  createWindow();
  createTray();
});

app.on('window-all-closed', () => app.quit());
