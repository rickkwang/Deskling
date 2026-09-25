import { CharacterRuntime } from '../runtime/character-runtime.js';
import { validateCharacter } from '../character/validate.js';
import { speak, cancelSpeech } from './speech.js';
import { clock } from '../main/focus-timer.js';

const petEl = document.querySelector('#pet');
const timerEl = document.querySelector('#timer');

// The pet window is just big enough for the pet and never changes for the
// balloon, which is a separate window placed by main (bubble.html). Main keeps
// the pet's feet at the same screen point when the pet's size changes.
const PAD = 6; // transparent margin around the pet
// Focus timer pill (style.css), above the pet's head: wider for "1:25:00".
const TIMER_W = { short: 68, long: 92 };
const TIMER_H = 20;
const TIMER_GAP = 3;

let runtime = null;
let character = null;
let busy = false;
let settings = {};
const LONG_PRESS_MS = 550;

// ---- character ------------------------------------------------------------

function mountCharacter({ data, sheetUrl }) {
  const { errors, warnings } = validateCharacter(data);
  warnings.forEach((w) => console.warn(`[character] ${w}`));
  if (errors.length) throw new Error(`Invalid character "${data.id}": ${errors[0]}`);
  runtime?.destroy();
  character = data;
  runtime = new CharacterRuntime(petEl, data, sheetUrl);
  applyLayout();
  petEl.setAttribute('aria-label', data.displayName);
  runtime.addEventListener('state', (e) => log(`state ${e.detail.from} -> ${e.detail.to}`));
  runtime.addEventListener('animation', (e) => {
    const { name, kind, level } = e.detail;
    const src = character.states[kind]?.source;
    log(`play ${name} (${kind}${level ? ` L${level}` : ''}${src ? `, ${src}` : ''})`);
  });
  return runtime;
}

// ---- layout -----------------------------------------------------------------

async function applyLayout() {
  const scale = settings.scale || 1;
  const { cellWidth, cellHeight } = character.spritesheet;
  const petW = Math.round(cellWidth * scale);
  const petH = Math.round(cellHeight * scale);
  const top = timerEl.hidden ? 0 : TIMER_H + TIMER_GAP;
  const pillW = TIMER_W[timerEl.dataset.width || 'short'];
  const w = Math.max(petW, pillW) + PAD * 2;
  const cx = Math.round(w / 2);
  const baseline = PAD + top + petH;
  // Positioned unscaled, then scaled around the feet.
  petEl.style.left = `${Math.round(cx - cellWidth / 2)}px`;
  petEl.style.top = `${baseline - cellHeight}px`;
  petEl.style.transform = scale === 1 ? '' : `scale(${scale})`;
  // Pixel-exact only when every sprite pixel maps to whole device pixels.
  petEl.classList.toggle('crisp', Number.isInteger(scale * window.devicePixelRatio));
  timerEl.style.left = `${cx - pillW / 2}px`;
  timerEl.style.top = `${PAD}px`;
  timerEl.style.width = `${pillW}px`;
  await window.pet.layout({ width: w, height: baseline + PAD, anchorX: cx, anchorY: baseline, petW, petH, top });
}

// ---- balloon ----------------------------------------------------------------
// This window owns the conversation; the balloon window only displays it.

let balloonOpen = false;
let content = { text: '', error: false, dots: false };

function renderBalloon() {
  window.pet.bubble({ ...content, busy });
}

function openBubble({ focus = false } = {}) {
  balloonOpen = true;
  renderBalloon();
  window.pet.bubbleShow({ focus });
}

function hideBubble() {
  balloonOpen = false;
  window.pet.bubbleHide();
}

function closeBubble() {
  hideBubble();
  cancelSpeech();
  if (busy) window.pet.cancel();
  if (runtime.state !== 'hidden') runtime.setState('idle');
}

function say(text, { error = false } = {}) {
  content = { text, error, dots: false };
  renderBalloon();
}

// A random line from the character's greetings, never the same one twice in a row.
let lastGreeting = '';
function greeting() {
  const lines = character.persona.greetings;
  const fresh = lines.length > 1 ? lines.filter((l) => l !== lastGreeting) : lines;
  lastGreeting = fresh[Math.floor(Math.random() * fresh.length)];
  return lastGreeting;
}

function listen() {
  if (['idle', 'speaking'].includes(runtime.state)) runtime.setState('listening');
}

window.pet.onBubbleSubmit((text) => ask(text));
window.pet.onBubbleTyping(() => listen());
window.pet.onBubbleEscape(() => closeBubble());

// ---- conversation -----------------------------------------------------------

const ERRORS = {
  NO_LOCAL_MODEL: "I couldn't find a local Ollama model. Pull a small one yourself (e.g. `ollama pull qwen2.5:1.5b`) — I won't download anything on my own.",
  OLLAMA_UNAVAILABLE: "Ollama doesn't seem to be running. Start it with `ollama serve`, then ask me again.",
};

let streamed = '';
window.pet.onToken((token) => {
  if (!busy) return;
  if (runtime.state === 'thinking') runtime.setState('speaking');
  streamed += token;
  say(streamed.trimStart());
});

// A reminder from the focus timer waits for a reply in progress to finish.
let pendingReminder = null;

async function ask(text) {
  if (busy || !text) return;
  busy = true;
  streamed = '';
  cancelSpeech();
  content = { text: '', error: false, dots: true };
  if (balloonOpen) renderBalloon();
  else openBubble();
  if (runtime.state === 'speaking') runtime.setState('listening');
  runtime.setState('thinking');
  const res = await window.pet.send(text);
  busy = false;
  if (res.ok && res.text.trim()) {
    say(res.text.trim());
    // Like an Agent Speak request: stay in speaking until the gesture and the
    // spoken text (Speech setting) are finished, then idle.
    await Promise.all([runtime.settle(), settings.speech ? speak(res.text.trim()) : null]);
    if (runtime.state === 'speaking') runtime.setState('idle');
  } else if (res.error === 'ABORTED') {
    renderBalloon();
    runtime.setState('idle');
  } else {
    say(ERRORS[res.error] || (res.ok ? "Hmm, I didn't come up with anything. Try asking another way?" : `Something went wrong: ${res.error}`), { error: true });
    runtime.setState('idle');
    runtime.act('confused');
  }
  if (pendingReminder) remind(pendingReminder);
  return res;
}

// ---- focus timer ------------------------------------------------------------
// Main keeps the time; this shows it as a pill above the pet's head and gives
// the reminders in the balloon.

const GLYPHS = {
  pause: 'M4.5 3.5h2.2v9H4.5zM9.3 3.5h2.2v9H9.3z',
  play: 'M5 3.2v9.6L12.8 8z',
};
let timerState = { phase: 'off' };

function renderTimer(t) {
  timerState = t;
  const running = t.phase === 'focus' || t.phase === 'break';
  const show = running || t.phase === 'ready';
  timerEl.dataset.phase = t.phase;
  timerEl.classList.toggle('paused', Boolean(t.paused));
  if (show) {
    timerEl.querySelector('.time').textContent = running ? clock(t.left) : clock(t.seconds.focus * 1000);
    timerEl.style.setProperty('--used', running ? (100 * (1 - t.left / t.total)).toFixed(2) : 0);
    timerEl.querySelector('.glyph').setAttribute('d', running && !t.paused ? GLYPHS.pause : GLYPHS.play);
    const what = { focus: 'Focus', break: 'Break', ready: 'Break over' }[t.phase];
    const click = t.phase === 'ready' ? 'start the next focus session' : t.paused ? 'resume' : 'pause';
    timerEl.title = `${what}${t.paused ? ' (paused)' : ''}. Click to ${click}; right-click the pet for more.`;
  }
  // Sized per phase (not per tick), so it never changes while counting down.
  const width = show && t.seconds[running ? t.phase : 'focus'] >= 3600 ? 'long' : 'short';
  if (show === !timerEl.hidden && width === timerEl.dataset.width) return;
  timerEl.dataset.width = width;
  timerEl.hidden = !show;
  applyLayout();
  requestAnimationFrame(() => timerEl.classList.toggle('shown', show));
}

timerEl.addEventListener('click', () => {
  const t = timerState;
  window.pet.timer.action(t.phase === 'ready' ? 'start' : t.paused ? 'resume' : 'pause');
});
window.pet.timer.onStatus(renderTimer);

async function remind(info) {
  if (busy) { pendingReminder = info; return; }
  pendingReminder = null;
  busy = true;
  cancelSpeech();
  content = { text: '', error: false, dots: true };
  // Done focusing: congratulate; break over: get the user's attention.
  runtime.setState('idle');
  runtime.act(info.ended === 'focus' ? 'acknowledge' : 'getAttention');
  openBubble();
  const text = await window.pet.timer.remark(info);
  busy = false;
  say(text);
  if (pendingReminder) return remind(pendingReminder);
  if (settings.speech) speak(text);
}
window.pet.timer.onEnd(remind);
window.pet.timer.onSound((file) => new Audio(`sounds/${file}`).play().catch(() => {}));

// ---- input: click vs drag, click-through ---------------------------------

let interactive = false;
function setInteractive(v) {
  if (v !== interactive) {
    interactive = v;
    window.pet.setInteractive(v);
  }
}

let press = null;
document.addEventListener('mousemove', (e) => {
  if (press) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  setInteractive(Boolean(el?.closest('#pet, #timer')));
});
document.addEventListener('mouseleave', () => { if (!press) setInteractive(false); });

// Dragging is driven by main: it follows the cursor from where the press
// started and folds the balloon away until the pet is dropped.
petEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  try { petEl.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
  press = { x: e.screenX, y: e.screenY, dragging: false };
  window.pet.dragPress();
  // Long-press opens the same quick-options menu as right-click.
  press.timer = setTimeout(() => {
    if (!press || press.dragging) return;
    press = null;
    try { petEl.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    window.pet.contextMenu();
  }, LONG_PRESS_MS);
});
petEl.addEventListener('pointermove', (e) => {
  if (!press || press.dragging) return;
  if (Math.hypot(e.screenX - press.x, e.screenY - press.y) > 3) {
    press.dragging = true;
    clearTimeout(press.timer);
    log('drag start');
    window.pet.dragStart();
  }
});

function endPress() {
  if (!press) return;
  const { dragging, timer } = press;
  clearTimeout(timer);
  press = null;
  if (!dragging) return onPetClick();
  window.pet.dragEnd().then(() => log('drag end'));
}
petEl.addEventListener('pointerup', endPress);
document.addEventListener('pointerup', endPress);
petEl.addEventListener('lostpointercapture', () => { if (press?.dragging) endPress(); });

function onPetClick() {
  if (balloonOpen && !busy && runtime.state !== 'listening') {
    listen();
    openBubble({ focus: true });
    return;
  }
  if (balloonOpen) return closeBubble();
  if (!busy) content = { ...content, error: false, dots: false };
  listen();
  openBubble({ focus: true });
}

document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.pet.contextMenu();
});

// ---- main-process events ----------------------------------------------------

async function hidePet() {
  hideBubble();
  await runtime.hide();
  window.pet.hideWindow();
}

window.pet.onVisibility((v) => (v === 'hide' ? hidePet() : runtime.show()));
window.pet.onSettings((next) => {
  const rescale = next.scale !== settings.scale;
  settings = next;
  document.body.dataset.theme = settings.balloon;
  if (rescale) applyLayout();
  if (!settings.speech) cancelSpeech();
});
window.pet.onChatReset(() => {
  if (busy) window.pet.cancel();
  cancelSpeech();
  say(greeting());
  runtime.setState('idle');
});
window.pet.onCharacter(async (next) => {
  if (busy) window.pet.cancel();
  cancelSpeech();
  hideBubble();
  await runtime.leave();
  mountCharacter(next);
  // Office: Greeting plays "when the character is chosen".
  await runtime.show({ greet: true });
  say(greeting());
  if (settings.greeting) openBubble();
});

// ---- boot -------------------------------------------------------------------

function log(line) {
  console.log(`[pet] ${line}`);
  if (selftest) window.pet.selftest.log(line);
}

let selftest = false;
const init = await window.pet.init();
selftest = init.selftest;
settings = init.settings;
document.body.dataset.theme = settings.balloon;
mountCharacter(init.character);
renderTimer(await window.pet.timer.status());
log(`ai: ${init.ai.available ? `ollama ok, local models [${init.ai.models.join(', ')}], using ${init.ai.model}` : `unavailable (${init.ai.error})`}`);
// Greeting setting: "Say hello when the assistant opens" (the hello gesture
// and balloon). Office characters' entrance is their Greeting either way.
const greeted = runtime.show({ greet: settings.greeting });
if (!init.ai.model) {
  say(init.ai.available ? ERRORS.NO_LOCAL_MODEL : ERRORS.OLLAMA_UNAVAILABLE, { error: true });
  greeted.then(() => { runtime.act('confused'); openBubble(); });
} else {
  say(greeting());
  if (settings.greeting) greeted.then(() => openBubble());
}

if (selftest) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  if (selftest.edge) {
    // Edge check: pet (and optionally its balloon) at --pet-at; report placement.
    await greeted;
    if (selftest.edgeOpen) openBubble();
    else hideBubble();
    await wait(600);
    log(`edge ${JSON.stringify(await window.pet.selftest.geometry())}`);
    await wait(selftest.hold); // time for an OS screenshot / manual drag
    log(`edge-after ${JSON.stringify(await window.pet.selftest.geometry())}`);
    window.pet.selftest.done(0);
  } else {
    const { runSelftest } = await import('./selftest.js');
    const api = {
      type: (text) => { listen(); return ask(text); },
      text: () => (content.dots ? '' : content.text),
      balloonOpen: () => balloonOpen,
    };
    runSelftest({ runtime: () => runtime, petEl, api, greeted, log, quiet: selftest.quiet });
  }
}
