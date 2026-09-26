import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, Tray, nativeImage, screen, shell } from 'electron';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Assistant, RESPONSE_STYLES } from '../ai/assistant.js';
import { DragFollower } from './drag-follow.js';
import { FocusTimer, LIMITS, validSeconds, PRESETS, SOUNDS, duration, minutesLeft } from './focus-timer.js';
import { checkForUpdate, prepareInstall, releasePage } from './updater.js';
import { ClaudeSessions, claudeSettingsFile, hooksInstalled, listen, readClaudeSettings, setHooks } from './claude-code.js';
import { decodePng, encodePng } from '../character/png-codec.js';
import { cutSheet, idFromName, makeCharacter, renamed } from '../character/sheet-import.js';
import { SHEET_PROMPT } from '../character/sheet-prompt.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SELFTEST = process.argv.includes('--selftest');
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
// QA preview: electron . --preview[=<character>] [--frame=0.5] [--capture]
const PREVIEW = process.argv.some((a) => a === '--preview' || a.startsWith('--preview='));
// QA: electron . --settings-preview=character|behavior  (captures qa/settings-<tab>.png)
//     [--character=<id>] [--sheet=<image>: start adding a character from it]
const SETTINGS_PREVIEW = arg('settings-preview');
// QA: electron . --selftest --edge --hold=60000 --timer-demo=60  (starts the
// focus timer at once, running 60 times fast)
const TIMER_DEMO = Number(arg('timer-demo')) || 0;
// QA: electron . --selftest --edge --hold=60000 --claude-code[=<port>]  (listens
// for Claude Code hooks without installing them, on another port if a real
// Deskling has this one; post events with curl)
const CLAUDE_DEMO = process.argv.some((a) => a === '--claude-code' || a.startsWith('--claude-code='));
// QA: electron . --audit  (sprite/animation visibility audit for every character)
const AUDIT = process.argv.includes('--audit');
// QA captures: in the project, or beside the settings in a packaged app (its
// own files are read-only).
const qaDir = (...parts) => path.join(app.isPackaged ? app.getPath('userData') : ROOT, 'qa', ...parts);
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
  balloon: 'classic', // speech balloon theme (BALLOON_THEMES)
  // Behavior (Assistant Settings)
  enabled: true, greeting: true, speech: false, responseStyle: 'normal', instructions: '',
  focusSeconds: 25 * 60, breakSeconds: 5 * 60, timerSound: 'indigo', // Focus Timer
  claudeCode: false, // work along with Claude Code (hooks in its settings.json)
};
// Speech balloon looks: src/renderer/balloon-themes/<id>.css. `tail` is how
// far the tail tip reaches beyond the box (it sets where the window goes);
// `corner` tails grow out of a corner, like System 7 Balloon Help, so the
// balloon is placed with that corner at the pet.
const BALLOON_THEMES = {
  classic: { label: 'Classic', tail: 7 },
  aqua: { label: 'Aqua', tail: 7 },
  macos: { label: 'macOS', tail: 12 }, // NSPopover's arrow on macOS 26
  win98: { label: 'Windows 98', tail: 7 },
  system7: { label: 'System 7', tail: 12, corner: true },
};
const balloonTheme = () => BALLOON_THEMES[settings.balloon];

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
  if (!(settings.balloon in BALLOON_THEMES)) settings.balloon = 'classic';
  if (!validSeconds('focus', settings.focusSeconds)) settings.focusSeconds = 25 * 60;
  if (!validSeconds('break', settings.breakSeconds)) settings.breakSeconds = 5 * 60;
  if (!(settings.timerSound in SOUNDS)) settings.timerSound = 'indigo';
}
function saveSettings() {
  if (SELFTEST || SETTINGS_PREVIEW) return;
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

// ---- characters -----------------------------------------------------------
// Bundled characters live in <app>/characters; user characters in
// <userData>/characters/<id>/character.json (same schema).

const userCharactersDir = () => path.join(app.getPath('userData'), 'characters');
const isCustom = (entry) => entry.dir.startsWith(userCharactersDir() + path.sep);

function characterDirs() {
  return [path.join(ROOT, 'characters'), userCharactersDir()];
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

// The sheet's URL carries its modification time: a character deleted and added
// again under the same id must not show the old, cached image.
function sheetUrl(dir, file) {
  const p = path.join(dir, file);
  const url = pathToFileURL(p);
  try { url.search = `v=${Math.round(fs.statSync(p).mtimeMs)}`; } catch { /* missing: validation reports it */ }
  return url.href;
}

// First visible frame of RestPose, used as the character's thumbnail.
function characterCard(entry) {
  const data = JSON.parse(fs.readFileSync(path.join(entry.dir, 'character.json'), 'utf8'));
  const frames = (data.animations.RestPose || Object.values(data.animations)[0]).frames;
  const cell = frames.find((f) => f.cells.length)?.cells[0] || [0, 0];
  const { cellWidth, cellHeight } = data.spritesheet;
  return {
    id: data.id, displayName: data.displayName, description: data.description,
    sheetUrl: sheetUrl(entry.dir, data.spritesheet.path),
    cell, cellWidth, cellHeight, custom: isCustom(entry),
  };
}

function loadCharacter(id) {
  const all = listCharacters();
  const entry = all.find((c) => c.id === id) || all.find((c) => c.id === 'clippy') || all[0];
  const data = JSON.parse(fs.readFileSync(path.join(entry.dir, 'character.json'), 'utf8'));
  return { data, sheetUrl: sheetUrl(entry.dir, data.spritesheet.path) };
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
// Room above the pet's head taken by the focus timer pill (0 when hidden).
let headroom = 0;

function layoutWindow({ width, height, anchorX, anchorY, petW, petH, top = 0 }) {
  anchor = { x: anchorX, y: anchorY };
  headroom = top;
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
const BALLOON_MARGIN = 14; // band around the box in its window (shadow + tail; bubble.css)
const EDGE_GAP = 12; // breathing room between the balloon and the screen edge
const TIP_GAP = 8; // tail tip to the pet's feet (below) or head (above)
const CORNER_TIP = 2; // a corner tail's tip, in from the balloon's side
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
    sendBalloonTheme();
    if (balloon.content) bubbleWin.webContents.send('bubble:content', balloon.content);
    if (balloon.visible) showBalloon();
  });
}

function sendBalloonTheme() {
  bubbleWin?.webContents.send('bubble:theme', { id: settings.balloon, tail: balloonTheme().tail });
}

// Below the pet if it fits, else above; slid sideways to keep EDGE_GAP from
// the screen edges, with the tail pointing at the pet.
function placeBalloon() {
  if (!bubbleWin || !balloon.shown) return;
  const [wx, wy] = win.getPosition();
  const fx = wx + anchor.x;
  const fy = wy + anchor.y;
  const petTop = fy - petBox.h - headroom;
  const { workArea: a } = screen.getDisplayNearestPoint({ x: fx, y: fy });
  const bh = balloon.h;
  const { tail, corner } = balloonTheme();
  const belowTop = fy + TIP_GAP + tail;
  const aboveTop = petTop - TIP_GAP - tail - bh;
  const fitsBelow = belowTop + bh + EDGE_GAP <= a.y + a.height;
  const fitsAbove = aboveTop - EDGE_GAP >= a.y;
  const side = fitsBelow ? 'below' : fitsAbove ? 'above' : (a.y + a.height - fy >= petTop - a.y ? 'below' : 'above');
  const boxTop = side === 'below' ? belowTop : aboveTop;
  // Prefer the pet near the balloon's right end, like the classic assistant;
  // a corner tail sits at the right corner, or the left one if that is
  // cut off by the screen edge.
  const minLeft = a.x + EDGE_GAP;
  const maxLeft = a.x + a.width - EDGE_GAP - BALLOON_W;
  const rightEnd = fx - (BALLOON_W - (corner ? CORNER_TIP : 50));
  const preferredLeft = corner && rightEnd < minLeft ? fx - CORNER_TIP : rightEnd;
  const boxLeft = clamp(preferredLeft, minLeft, maxLeft);
  const inset = corner ? CORNER_TIP : 20;
  const tailLeft = clamp(fx - boxLeft, inset, BALLOON_W - inset);
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
      const dir = qaDir();
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
    offerUpdate();
  }
  updateTray();
}

function hidePet() {
  // Renderer plays the Hide animation, then asks us to hide the window.
  if (win?.isVisible()) win.webContents.send('pet:visibility', 'hide');
}

// ---- custom characters (Settings > Character) -------------------------------
// A sprite sheet drawn by an image model from SHEET_PROMPT becomes a character:
// pick the image (it is cut and previewed), name it, and it is added and
// selected. Custom characters can be renamed and deleted; bundled ones cannot.

let pendingSheet = null; // { png, cellWidth, cellHeight } of a cut sheet waiting for a name

// Poses are scaled to Clippy's height anyway: larger images only cost time
// (the cut runs on the main thread, about a second at this size).
const MAX_SHEET_WIDTH = 2048;

const cleanName = (name) => String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 30);

function readImage(file) {
  let img = nativeImage.createFromPath(file); // PNG (any depth), JPEG
  if (img.isEmpty()) {
    // HEIC, WebP, TIFF…: macOS's own converter reads them.
    const tmp = path.join(app.getPath('temp'), `deskling-sheet-${process.pid}.png`);
    try {
      execFileSync('/usr/bin/sips', ['-s', 'format', 'png', file, '--out', tmp], { stdio: 'ignore' });
      img = nativeImage.createFromPath(tmp);
    } catch { /* not an image */ } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  if (img.isEmpty()) throw new Error('Deskling can’t read this file. Use a PNG or JPEG image.');
  if (img.getSize().width > MAX_SHEET_WIDTH) img = img.resize({ width: MAX_SHEET_WIDTH, quality: 'best' });
  return decodePng(img.toPNG());
}

async function chooseSheet() {
  const qaSheet = SETTINGS_PREVIEW && arg('sheet');
  if (qaSheet) return qaSheet;
  const { canceled, filePaths } = await dialog.showOpenDialog(settingsWin, {
    title: 'Choose a Sprite Sheet',
    buttonLabel: 'Choose',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'heic', 'webp'] }],
  });
  return canceled ? null : filePaths[0] ?? null;
}

function prepareSheet(file) {
  pendingSheet = null;
  try {
    const { sheet, cellWidth, cellHeight, warnings } = cutSheet(readImage(file));
    const png = encodePng(sheet);
    pendingSheet = { png, cellWidth, cellHeight };
    return { sheetUrl: `data:image/png;base64,${png.toString('base64')}`, cell: [0, 0], cellWidth, cellHeight, warnings };
  } catch (e) {
    return { error: e.message };
  }
}

function addCharacter(rawName) {
  const name = cleanName(rawName);
  if (!pendingSheet || !name) return { error: 'Choose an image and give the character a name.' };
  const taken = new Set(listCharacters().map((c) => c.id));
  const base = idFromName(name) || 'character';
  let id = base;
  for (let n = 2; taken.has(id) || fs.existsSync(path.join(userCharactersDir(), id)); n++) id = `${base}-${n}`;
  const { png, cellWidth, cellHeight } = pendingSheet;
  const dir = path.join(userCharactersDir(), id);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'spritesheet.png'), png);
    writeCharacter(dir, makeCharacter({ name, id, cellWidth, cellHeight }));
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    return { error: `Couldn’t save the character: ${e.message}` };
  }
  pendingSheet = null;
  charactersChanged();
  updateSettings({ character: id });
  return { id };
}

const writeCharacter = (dir, data) => fs.writeFileSync(path.join(dir, 'character.json'), `${JSON.stringify(data, null, 1)}\n`);
const customEntry = (id) => listCharacters().find((c) => c.id === id && isCustom(c));

function renameCharacter(id, rawName) {
  const entry = customEntry(id);
  const name = cleanName(rawName);
  if (!entry || !name) return;
  const file = path.join(entry.dir, 'character.json');
  writeCharacter(entry.dir, renamed(JSON.parse(fs.readFileSync(file, 'utf8')), name));
  charactersChanged();
  // The pet keeps going (no goodbye and hello, the conversation stays); only
  // its name and persona change.
  if (id === settings.character) {
    const { data } = loadCharacter(id);
    assistant.setPersona(data.persona, { keepHistory: true });
    win?.webContents.send('pet:renamed', { displayName: data.displayName, persona: data.persona });
  }
}

async function deleteCharacter(id) {
  const entry = customEntry(id);
  if (!entry) return false;
  const { response } = await dialog.showMessageBox(settingsWin, {
    type: 'warning',
    message: `Delete “${entry.displayName}”?`,
    detail: 'The character and its sprite sheet are removed from this Mac. This can’t be undone.',
    buttons: ['Delete', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  if (response !== 0) return false;
  if (id === settings.character) updateSettings({ character: 'clippy' });
  fs.rmSync(entry.dir, { recursive: true, force: true });
  charactersChanged();
  return true;
}

function charactersChanged() {
  settingsWin?.webContents.send('settings:characters', listCharacters().map(characterCard));
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
  if (patch.balloon !== undefined && !(patch.balloon in BALLOON_THEMES)) delete patch.balloon;
  if (patch.focusSeconds !== undefined && !validSeconds('focus', patch.focusSeconds)) delete patch.focusSeconds;
  if (patch.breakSeconds !== undefined && !validSeconds('break', patch.breakSeconds)) delete patch.breakSeconds;
  if (patch.timerSound !== undefined && !(patch.timerSound in SOUNDS)) delete patch.timerSound;
  if (patch.claudeCode !== undefined && patch.claudeCode !== settings.claudeCode && !connectClaudeCode(Boolean(patch.claudeCode))) delete patch.claudeCode;
  const prev = { ...settings };
  if (patch.character && patch.character !== prev.character) switchCharacter(patch.character);
  Object.assign(settings, patch);
  if (patch.model !== undefined) assistant.setModel(settings.model);
  if (patch.responseStyle !== undefined || patch.instructions !== undefined) {
    assistant.setBehavior({ responseStyle: settings.responseStyle, instructions: settings.instructions });
  }
  if (patch.balloon !== undefined && patch.balloon !== prev.balloon) {
    sendBalloonTheme();
    if (balloon.shown) { balloon.placed = ''; placeBalloon(); } // the tail changed
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
      if (arg('sheet')) {
        await settingsWin.webContents.executeJavaScript(`document.querySelector('.add-tile').click()`);
        await new Promise((r) => setTimeout(r, 1500));
      }
      const tabState = await settingsWin.webContents.executeJavaScript(`location.hash + ' selected=' + document.querySelector('[aria-selected=true]')?.id`);
      console.log(`[settings-preview] tab ${tabState}`);
      const b = settingsWin.getBounds();
      console.log(`[settings-preview] bounds ${b.x},${b.y},${b.width},${b.height}`);
      await new Promise((r) => setTimeout(r, 1500)); // time for an OS-level screenshot
      const img = await settingsWin.webContents.capturePage();
      fs.mkdirSync(qaDir(), { recursive: true });
      fs.writeFileSync(qaDir(`settings-${SETTINGS_PREVIEW}.png`), img.toPNG());
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
    { label: 'Focus Timer', submenu: timerMenu() },
    { type: 'separator' },
    { label: 'New Conversation', click: () => { assistant.reset(); win.webContents.send('chat:reset'); } },
    { label: 'Assistant Settings…', click: () => openSettings() },
    { type: 'separator' },
    ...appMenu(),
    { type: 'separator' },
    { label: 'Quit Assistant', click: () => app.quit() },
  ]);
}

function updateTray() {
  if (!tray) return;
  const t = timer.status();
  trayLeft = t.left ? timeLeft(t) : '';
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Desktop Assistant', type: 'checkbox', checked: settings.enabled, click: (item) => updateSettings({ enabled: item.checked }) },
    { label: 'Focus Timer', submenu: timerMenu() },
    { label: 'Assistant Settings…', click: () => openSettings() },
    { type: 'separator' },
    ...appMenu(),
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

// ---- focus timer ----------------------------------------------------------
// Runs here, so it keeps time while the pet is hidden. The pet shows it as a
// small pill above its head and gives the reminders; with the pet hidden, a
// system notification does.

const timer = new FocusTimer({ onChange: timerChanged, onEnd: timerEnded, second: TIMER_DEMO ? 1000 / TIMER_DEMO : 1000 });
// Time left in the menus, in whole minutes, so the tray's copy (which only
// changes when rebuilt) is refreshed once a minute rather than every second.
const timeLeft = (t) => minutesLeft(Math.ceil(t.left / timer.second));
let trayLeft = '';
setInterval(() => {
  timer.check();
  const t = timer.status();
  if (!t.left || t.paused) return;
  win?.webContents.send('timer:status', t);
  if (timeLeft(t) !== trayLeft) updateTray();
}, 1000);

function timerChanged(status) {
  win?.webContents.send('timer:status', status);
  updateTray();
}

function startTimer(focus = settings.focusSeconds, rest = settings.breakSeconds) {
  if (focus !== settings.focusSeconds || rest !== settings.breakSeconds) updateSettings({ focusSeconds: focus, breakSeconds: rest });
  timer.start(focus, rest);
}

function timerAction(action) {
  if (action === 'start') startTimer();
  else if (['pause', 'resume', 'skip', 'stop'].includes(action)) timer[action]();
}

function timerEvent({ ended, seconds, next, rounds }) {
  const where = win?.isVisible() ? 'by clicking the timer above you' : 'from Focus Timer in the menu bar';
  return ended === 'focus'
    ? `The user's focus session of ${duration(seconds)} just ended (${rounds} finished today), and a break of ${duration(next)} has started. Congratulate them and suggest one concrete way to rest, such as stretching, drinking water or looking away from the screen.`
    : `The user's break of ${duration(seconds)} is over. Encourage them to start the next focus session when they are ready, ${where}.`;
}

// The character's reminder: written by the model, or a preset line if it
// cannot (no Ollama, no model, too slow).
async function timerRemark(info) {
  try {
    return await assistant.remark(timerEvent(info), { locale: app.getLocale() });
  } catch (e) {
    console.warn(`[timer] preset reminder (${e.message})`);
    const key = info.ended === 'focus' ? 'focusDone' : 'breakDone';
    const lines = assistant.persona?.timer?.[key] || (key === 'focusDone'
      ? ['Focus session done! Time for a short break.']
      : ["Break's over. Ready for another round?"]);
    return lines[Math.floor(Math.random() * lines.length)];
  }
}

// The sound plays from the pet window, hidden or not.
async function timerEnded(info) {
  const sound = SOUNDS[settings.timerSound].file;
  if (sound) win?.webContents.send('timer:sound', sound);
  if (win?.isVisible()) return win.webContents.send('timer:end', info);
  const body = await timerRemark(info);
  const silent = Boolean(sound);
  if (Notification.isSupported()) new Notification({ title: info.ended === 'focus' ? 'Focus session done' : 'Break is over', body, silent }).show();
}

function timerMenu() {
  const t = timer.status();
  if (t.phase === 'focus' || t.phase === 'break') {
    return [
      { label: `${t.phase === 'focus' ? 'Focusing' : 'On a break'} · ${timeLeft(t)} left${t.paused ? ' (paused)' : ''}`, enabled: false },
      t.paused ? { label: 'Resume', click: () => timer.resume() } : { label: 'Pause', click: () => timer.pause() },
      { label: t.phase === 'focus' ? 'Skip to Break' : 'Skip Break', click: () => timer.skip() },
      { label: 'Stop', click: () => timer.stop() },
    ];
  }
  return [
    { label: `Start Focus · ${duration(settings.focusSeconds)}`, click: () => startTimer() },
    ...(t.phase === 'ready' ? [{ label: 'Stop', click: () => timer.stop() }] : []),
    { type: 'separator' },
    ...PRESETS.map(([focus, rest]) => ({
      label: `${duration(focus)} focus, ${duration(rest)} break`, type: 'radio',
      checked: focus === settings.focusSeconds && rest === settings.breakSeconds,
      click: () => startTimer(focus, rest),
    })),
    { label: 'Customize…', click: () => openSettings('behavior') },
  ];
}

// ---- Claude Code ------------------------------------------------------------
// Like Codex's pets: while a Claude Code session works, the pet works (its
// thinking animation), and it shows what needs the user: a session waiting
// for an answer, failed, or done; clicking it brings the terminal forward.
// Turning it on puts hooks into Claude Code's settings.json that post each
// event here (claude-code.js).

const claude = {
  server: null,
  error: '', // why the last connect failed, for Settings
  sessions: new ClaudeSessions({ onChange: () => sendClaudeStatus() }),
};
setInterval(() => claude.sessions.sweep(), 60_000);

const home = (p) => p.replace(app.getPath('home'), '~');

// The status with the notice written out for the balloon.
function claudeStatus() {
  const { working, notice: n, more } = claude.sessions.status();
  if (!n) return { working, notice: null, more };
  const line = {
    done: `Claude is done in ${n.project}${n.text ? `: ${n.text}` : '.'}`,
    asking: n.why === 'question' ? `Claude has a question for you in ${n.project}.` : `Claude needs your OK in ${n.project}.`,
    failed: `Claude stopped with an error in ${n.project}${n.text ? `: ${n.text}` : '.'}`,
  }[n.kind];
  return { working, notice: { id: n.id, kind: n.kind, line, terminal: Boolean(n.terminal) }, more };
}

function sendClaudeStatus() {
  win?.webContents.send('claude:status', claudeStatus());
}

// A click on the notice: to the terminal Claude Code runs in, and it's seen.
function openClaudeNotice() {
  const terminal = claude.sessions.status().notice?.terminal;
  if (terminal) execFile('/usr/bin/open', ['-b', terminal], (e) => e && console.warn(`[claude-code] ${e.message}`));
  claude.sessions.dismiss();
}

async function startClaudeServer() {
  if (claude.server) return true;
  try {
    claude.server = await listen((event) => claude.sessions.handle(event), Number(arg('claude-code')) || undefined);
    return true;
  } catch (e) {
    claude.error = e.code === 'EADDRINUSE' ? 'Another app is using Deskling’s port. Quit it, then turn this on again.' : e.message;
    console.warn(`[claude-code] ${e.message}`);
    return false;
  }
}

// Adds or removes the hooks; false (and claude.error) if that failed.
function connectClaudeCode(on) {
  claude.error = '';
  try {
    if (!SELFTEST && !SETTINGS_PREVIEW) setHooks(on);
  } catch (e) {
    claude.error = e.message;
    sendClaudeState();
    return false;
  }
  if (on) startClaudeServer().then(sendClaudeState);
  else {
    claude.server?.close();
    claude.server = null;
    claude.sessions.sessions.clear();
    claude.sessions.changed();
  }
  sendClaudeState();
  return true;
}

// For Settings: whether the hooks are in place (someone may remove them).
function claudeState() {
  let hooks = false;
  try { hooks = hooksInstalled(readClaudeSettings()); } catch { /* shown by error */ }
  return { file: home(claudeSettingsFile()), hooks, error: claude.error };
}

function sendClaudeState() {
  settingsWin?.webContents.send('settings:claude-code', claudeState());
}

// ---- updates --------------------------------------------------------------
// Packaged builds look for a newer GitHub release at launch and once a day.
// The pet mentions a new version once, when it can (it reports back); until
// then every check offers it again. Installing is the menu item's job.

const UPDATE_EVERY = 24 * 60 * 60 * 1000;
const update = { feed: null, installing: false };

async function checkUpdates() {
  try {
    const feed = await checkForUpdate(app.getVersion());
    if (!feed) return;
    if (feed.version !== update.feed?.version) {
      update.feed = feed;
      updateTray();
    }
    offerUpdate();
  } catch (e) {
    console.warn(`[update] ${e.message}`);
  }
}

// Only a visible pet can mention it; showPet offers it again.
function offerUpdate() {
  const version = update.feed?.version;
  if (version && settings.updateSeen !== version && win?.isVisible()) win.webContents.send('update:available', version);
}

async function installUpdate() {
  if (update.installing || !update.feed) return;
  update.installing = true;
  updateTray();
  const { version } = update.feed;
  win?.webContents.send('update:status', { state: 'downloading', version });
  try {
    await prepareInstall(update.feed, { exe: app.getPath('exe'), name: app.getName() });
    app.quit();
  } catch (e) {
    console.warn(`[update] install failed: ${e.message}`);
    update.installing = false;
    updateTray();
    win?.webContents.send('update:status', { state: 'failed', version, error: e.message });
    shell.openExternal(releasePage(version));
  }
}

// "Check for Updates…" from a menu: always answers, in the balloon or (pet
// hidden) a notification.
async function checkUpdatesNow() {
  let reply;
  try {
    const feed = await checkForUpdate(app.getVersion());
    if (feed) {
      update.feed = feed;
      updateTray();
      reply = { state: 'available', version: feed.version };
    } else {
      reply = { state: 'current', version: app.getVersion() };
    }
  } catch (e) {
    reply = { state: 'check-failed', error: e.message };
  }
  if (win?.isVisible()) return win.webContents.send('update:status', reply);
  const body = { available: `Deskling ${reply.version} is out. Choose “Update to ${reply.version}…” from this menu.`, current: `You're on the latest version (${reply.version}).`, 'check-failed': `Couldn't check for updates: ${reply.error}` }[reply.state];
  if (Notification.isSupported()) new Notification({ title: 'Deskling', body }).show();
}

function showAbout() {
  app.focus({ steal: true });
  app.showAboutPanel();
}

// About, and the update item: "Update to x…" once a newer release is known.
function appMenu() {
  const { version } = update.feed || {};
  return [
    { label: 'About Deskling', click: showAbout },
    version
      ? { label: update.installing ? `Updating to ${version}…` : `Update to ${version}…`, enabled: !update.installing, click: installUpdate }
      : { label: 'Check for Updates…', click: checkUpdatesNow },
  ];
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
  for (const ch of ['bubble:submit', 'bubble:typing', 'bubble:escape', 'bubble:click']) {
    ipcMain.on(ch, (_e, payload) => win?.webContents.send(ch, payload));
  }

  ipcMain.handle('settings:get', async () => ({
    settings: publicSettings(),
    characters: listCharacters().map(characterCard),
    ai: await assistant.refresh(settings.model),
    styles: RESPONSE_STYLES,
    timer: { limits: LIMITS, sounds: SOUNDS },
    claudeCode: claudeState(),
    balloons: Object.fromEntries(Object.entries(BALLOON_THEMES).map(([id, t]) => [id, t.label])),
  }));
  ipcMain.on('settings:set', (_e, patch) => updateSettings(patch));
  ipcMain.handle('characters:choose', () => chooseSheet());
  ipcMain.handle('characters:prepare', (_e, file) => prepareSheet(file));
  ipcMain.handle('characters:add', (_e, name) => addCharacter(name));
  ipcMain.on('characters:cancel', () => { pendingSheet = null; });
  ipcMain.on('characters:rename', (_e, id, name) => renameCharacter(id, name));
  ipcMain.handle('characters:delete', (_e, id) => deleteCharacter(id));
  ipcMain.on('characters:copy-prompt', () => clipboard.writeText(SHEET_PROMPT));
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
  ipcMain.on('update:seen', (_e, version) => updateSettings({ updateSeen: version }));
  ipcMain.on('timer:action', (_e, action) => timerAction(action));
  ipcMain.handle('timer:remark', (_e, info) => timerRemark(info));
  ipcMain.handle('timer:status', () => timer.status());
  ipcMain.handle('claude:status', () => claudeStatus());
  ipcMain.on('claude:dismiss', () => claude.sessions.dismiss());
  ipcMain.on('claude:open', openClaudeNotice);
  ipcMain.on('claude:reconnect', () => connectClaudeCode(true));

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
    const dir = qaDir(settings.character);
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
  app.setAboutPanelOptions({
    applicationName: 'Deskling',
    applicationVersion: app.getVersion(),
    version: '',
    credits: 'A little creature that lives on your desktop.\nCharacters from Microsoft Agent; a local Ollama model does the talking.',
    copyright: '© 2026 Myrick',
  });
  // Selftest can target one character without touching saved settings.
  if ((SELFTEST || SETTINGS_PREVIEW) && arg('character')) settings.character = arg('character');
  if (SELFTEST && arg('scale')) settings.scale = Number(arg('scale'));
  if (SELFTEST && arg('balloon') in BALLOON_THEMES) settings.balloon = arg('balloon');
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
  if (TIMER_DEMO) timer.start(settings.focusSeconds, settings.breakSeconds);
  if (CLAUDE_DEMO) startClaudeServer();
  // Rewrites hooks an older version installed (a no-op when they're current).
  else if (settings.claudeCode && !SELFTEST) connectClaudeCode(true);
  if (app.isPackaged && !SELFTEST) {
    setTimeout(checkUpdates, 10_000);
    setInterval(checkUpdates, UPDATE_EVERY);
  }
});

app.on('window-all-closed', () => app.quit());
