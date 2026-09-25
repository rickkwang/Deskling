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

api.onContent(({ text, error, dots, busy: b }) => {
  busy = b;
  msg.classList.toggle('error', Boolean(error));
  msg.classList.toggle('dots', Boolean(dots));
  msg.textContent = dots ? 'Thinking…' : text;
  msg.scrollTop = msg.scrollHeight;
  sendBtn.disabled = !input.value.trim() || busy;
});

api.onPlace(({ side, tailLeft }) => {
  document.body.classList.toggle('below', side === 'below');
  document.body.classList.toggle('above', side === 'above');
  bubble.style.setProperty('--tail-left', `${tailLeft}px`);
});

// Showing/hiding is a CSS transition (bubble.css); main makes the window
// click-through while the balloon is hidden.
api.onOpen((open) => {
  document.body.classList.toggle('open', open);
  if (!open) input.blur();
});

api.onFocus(() => input.focus());

// Main sizes the window to the balloon.
new ResizeObserver(() => api.size(Math.ceil(bubble.offsetHeight))).observe(bubble);

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
