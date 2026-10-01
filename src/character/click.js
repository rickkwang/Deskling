// What a character does when it is clicked: opening the balloon picks one of
// its "attention" animations at random, closing it one of the brief nods. The
// names are the Agent / Office / XP animation sets'; a character with none of
// them (one made from a sprite sheet) uses the animations of its own states
// instead, and one with a `click` list of its own (Clawd) uses that.

const OPEN = [
  'ClickedOn', 'GetAttentionMinor', 'GetAttention', 'Wave', 'Acknowledge', 'Announce',
  'GestureUp', 'GestureLeft', 'GestureRight', 'GestureDown',
];
const CLOSE = ['Acknowledge', 'Pleased', 'GestureDown', 'Blink'];

const OPEN_STATES = ['listening', 'getAttention', 'greeting'];
const CLOSE_STATES = ['acknowledge'];

const cellsOf = (c, name) => c.animations[name].frames.map((f) => JSON.stringify(f.cells));

// An animation drawn entirely with the frames of an entrance or exit is part
// of it (Clawd's Jumping is the jump that ends its Show), and not for a click.
// The Office set's Greeting and Goodbye are its entrance and exit too.
function partOfEntrance(c, name) {
  const states = c.animationSet === 'office' ? ['show', 'hide', 'greeting', 'goodbye'] : ['show', 'hide'];
  const cells = cellsOf(c, name);
  return states.flatMap((s) => c.states[s]?.animations ?? []).some((e) => {
    const theirs = new Set(cellsOf(c, e));
    return cells.every((k) => theirs.has(k));
  });
}

function pool(c, names, states, listed) {
  const own = (listed ?? names).filter((n) => c.animations[n]);
  const list = own.length ? own : [...new Set(states.flatMap((s) => c.states[s]?.animations ?? []))];
  return list.filter((n) => !partOfEntrance(c, n));
}

export function clickAnimations(c) {
  return { open: pool(c, OPEN, OPEN_STATES, c.click?.open), close: pool(c, CLOSE, CLOSE_STATES, c.click?.close) };
}

// A random one, never the same twice in a row.
export function pickClick(list, last) {
  const fresh = list.length > 1 ? list.filter((n) => n !== last) : list;
  return fresh[Math.floor(Math.random() * fresh.length)];
}
