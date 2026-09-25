import { CharacterRuntime } from '../runtime/character-runtime.js';
import { validateCharacter } from '../character/validate.js';
import { speak, cancelSpeech } from './speech.js';

const petEl = document.querySelector('#pet');

// The pet window is just big enough for the pet and never changes for the
// balloon, which is a separate window placed by main (bubble.html). Main keeps
// the pet's feet at the same screen point when the pet's size changes.
const PAD = 6; // transparent margin around the pet

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
  const w = petW + PAD * 2;
  const cx = Math.round(w / 2);
  const baseline = PAD + petH;
  // Positioned unscaled, then scaled around the feet.
  petEl.style.left = `${Math.round(cx - cellWidth / 2)}px`;
  petEl.style.top = `${baseline - cellHeight}px`;
  petEl.style.transform = scale === 1 ? '' : `scale(${scale})`;
  // Pixel-exact only when every sprite pixel maps to whole device pixels.
  petEl.classList.toggle('crisp', Number.isInteger(scale * window.devicePixelRatio));
  await window.pet.layout({ width: w, height: baseline + PAD, anchorX: cx, anchorY: baseline, petW, petH });
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
  return res;
}

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
  setInteractive(Boolean(el?.closest('#pet')));
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
  await runtime.act('goodbye');
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
mountCharacter(init.character);
log(`ai: ${init.ai.available ? `ollama ok, local models [${init.ai.models.join(', ')}], using ${init.ai.model}` : `unavailable (${init.ai.error})`}`);
// Greeting setting: "Say hello when the assistant opens" (Greeting animation +
// balloon); otherwise just the plain Show animation.
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
