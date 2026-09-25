// Character runtime: request queue + app state machine + idle levels.
// Knows nothing about any specific character; everything comes from the
// character's `states` / `idle` data.
//
// Microsoft Agent behaviours reproduced:
// - Play requests are queued and processed sequentially.
// - stop() clears the queue and lets the current animation exit via its exit
//   branches; interrupt() does the same for the current request only.
// - When nothing is queued the character idles, progressing through
//   IdlingLevel1 -> 2 -> 3 (level 3 stays until cancelled).

import { AnimationPlayer } from './animation-player.js';

export const STATES = ['hidden', 'idle', 'listening', 'thinking', 'speaking'];
export const ACTIONS = ['confused', 'acknowledge', 'getAttention', 'explain', 'show', 'hide', 'greeting', 'goodbye'];

// Allowed app-state transitions (idle -> listening -> thinking -> speaking -> idle,
// plus cancelling back to idle and hide/show).
const TRANSITIONS = {
  hidden: ['idle'],
  idle: ['listening', 'thinking', 'hidden'],
  listening: ['thinking', 'idle', 'hidden'],
  thinking: ['speaking', 'idle', 'hidden'],
  speaking: ['idle', 'listening', 'hidden'],
};


// One-shot requests (gestures) whose animation loops are asked to exit after
// this long, so e.g. an app-mapped looping animation can't block the queue.
const ONE_SHOT_MAX_MS = 10000;

export class CharacterRuntime extends EventTarget {
  constructor(el, character, sheetUrl) {
    super();
    this.c = character;
    this.player = new AnimationPlayer(el, character, sheetUrl);
    this.queue = [];
    this.active = null; // { name, kind }
    this.state = 'idle';
    this.idleSince = Date.now();
    this.idleTimer = null;
    this.idleMaxTimer = null;
  }

  // ---- queue -------------------------------------------------------------

  play(name, { kind = 'play', loop = false } = {}) {
    if (!this.player.has(name)) return Promise.resolve('missing');
    this._cancelIdle();
    return new Promise((resolve) => {
      this.queue.push({ name, kind, loop, resolve });
      if (!this.active) this._pump();
    });
  }

  // Resolves once the queue has drained (like waiting on a Speak request).
  settle() {
    if (!this.active && !this.queue.length) return Promise.resolve();
    return new Promise((resolve) => this.addEventListener('queue-empty', () => resolve(), { once: true }));
  }

  stop() {
    const dropped = this.queue.splice(0);
    dropped.forEach((r) => r.resolve('stopped'));
    this.interrupt();
  }

  interrupt() {
    if (!this.active) return;
    this.active.loop = false;
    this.player.exit();
  }

  async _pump() {
    if (this.destroyed) return;
    const req = this.queue.shift();
    if (!req) {
      // Nothing queued: bring a posed character back to neutral (its Return),
      // except while thinking, whose loop resumes immediately.
      if (this.player.pendingReturn && this.state !== 'thinking' && this.state !== 'hidden') {
        this.active = { name: 'return', kind: 'return' };
        await this.player.returnToNeutral();
        if (this.destroyed) return;
        if (this.queue.length) return this._pump();
      }
      this.active = null;
      this._emit('queue-empty');
      this._resume();
      return;
    }
    this.active = req;
    this._emit('animation', { name: req.name, kind: req.kind });
    const hurry = req.loop ? null : setTimeout(() => this.player.exit(), ONE_SHOT_MAX_MS);
    let result = await this.player.play(req.name);
    clearTimeout(hurry);
    while (req.loop && result === 'done' && !this.queue.length) {
      result = await this.player.play(req.name);
    }
    req.resolve(result);
    this._pump();
  }

  // ---- state machine -----------------------------------------------------

  setState(next) {
    if (next === this.state) return true;
    if (!TRANSITIONS[this.state]?.includes(next)) {
      console.warn(`[runtime] ignored transition ${this.state} -> ${next}`);
      return false;
    }
    const prev = this.state;
    this.state = next;
    if (next === 'idle') this.idleSince = Date.now();
    this._emit('state', { from: prev, to: next });
    if (next === 'hidden') return true;
    this.stop();
    this._playState(next);
    return true;
  }

  // One-shot official gestures (confused, acknowledge, ...). They interrupt the
  // current animation; afterwards the current state's behaviour resumes.
  act(action) {
    const def = this.c.states[action];
    if (!def) return Promise.resolve('missing');
    this.stop();
    return this.play(this._pick(def.animations), { kind: action });
  }

  async hide() {
    await this.act('hide');
    this.setState('hidden');
  }

  async show({ greet = false } = {}) {
    const from = this.state;
    this.state = 'idle';
    this.idleSince = Date.now();
    if (from !== 'idle') this._emit('state', { from, to: 'idle' });
    const action = greet && this.c.states.greeting ? 'greeting' : 'show';
    await this.act(action);
  }

  _playState(state) {
    const def = this.c.states[state];
    if (!def) return;
    this.play(this._pick(def.animations), { kind: state, loop: def.mode === 'loop' });
  }

  // Called when the queue drains: hold/loop the state's behaviour.
  _resume() {
    if (this.state === 'thinking') this._playState('thinking');
    else if (this.state === 'idle') this._scheduleIdle(this.c.idle?.firstDelayMs ?? 6000);
  }

  // ---- idling ------------------------------------------------------------

  _scheduleIdle(delay) {
    this._cancelIdle();
    if (this.destroyed) return;
    const idle = this.c.idle;
    if (!idle) return;
    this.idleTimer = setTimeout(() => this._playIdle(), delay);
  }

  _cancelIdle() {
    clearTimeout(this.idleTimer);
    clearTimeout(this.idleMaxTimer);
    this.idleTimer = null;
    if (this.active?.kind === 'idle') this.player.exit();
  }

  async _playIdle() {
    if (this.state !== 'idle' || this.active) return;
    const { levels, levelAfterMs, intervalMs } = this.c.idle;
    const elapsed = Date.now() - this.idleSince;
    let level = 0;
    levelAfterMs.forEach((t, i) => { if (elapsed >= t && levels[i]?.length) level = i; });
    const name = this._pick(levels[level]);
    this.active = { name, kind: 'idle', loop: false };
    this._emit('animation', { name, kind: 'idle', level: level + 1 });
    // Hurry up long idle loops at levels 1-2; level 3 stays until cancelled.
    if (level < 2) this.idleMaxTimer = setTimeout(() => this.player.exit(), this.c.idle.maxLoopMs ?? 12000);
    await this.player.play(name);
    clearTimeout(this.idleMaxTimer);
    if (this.active?.kind === 'idle' && this.state === 'idle') await this.player.returnToNeutral();
    if (this.active?.kind === 'idle') this.active = null;
    if (this.queue.length) this._pump();
    else if (this.state === 'idle') this._scheduleIdle(intervalMs);
  }

  // ---- helpers -----------------------------------------------------------

  _pick(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  _emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  destroy() {
    this.destroyed = true;
    this._cancelIdle();
    this.queue.splice(0);
    this.player.cut();
  }
}
