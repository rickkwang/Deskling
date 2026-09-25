// Plays one character animation at a time with Microsoft Agent semantics:
// - frames advance after their duration, following probabilistic `branches`
//   (weights are percentages; the remainder falls through to the next frame);
// - exit() sets "exiting": frames with an `exitBranch` jump there and the rest
//   play on in sequence (no random branching; the last frame ends it), so
//   looping animations "hurry up and finish" instead of being cut. Exit paths
//   are deterministic, so their length is known up front. When something is
//   waiting on the exit (exit(), or a Return before the next animation), a
//   long path starts from an identical-looking frame nearer the end if there
//   is one, plays faster to finish within EXIT_BUDGET_MS, and a frame held on
//   screen lets go; a Return with nothing waiting keeps its authored pace;
// - when an animation ends, its last visible frame stays on screen;
// - Return animations: an animation that ends away from the neutral pose
//   (`useExitBranching` or an explicit `returnAnimation`) is returned to
//   neutral before the next animation plays, or on returnToNeutral().

import { exitNext } from '../character/exit.js';

const EXIT_BUDGET_MS = 1000; // a longer exit path plays faster to fit
const HOLD_MS = 100; // on exit, a frame still held longer than this lets go
const EXIT_TIMEOUT_MS = 2000; // an exit path that never ends (bad data) is cut...
const FADE_MS = 90; // ...with a quick dip out and back in, not a jump

// ms from leaving frame i until the exit path ends; Infinity if it loops.
function exitLength(frames, i) {
  let ms = 0;
  const seen = new Set();
  for (;;) {
    i = exitNext(frames, i);
    if (i >= frames.length) return ms;
    if (seen.has(i)) return Infinity;
    seen.add(i);
    ms += frames[i].duration;
  }
}

export class AnimationPlayer {
  constructor(el, character, sheetUrl) {
    this.el = el;
    this.c = character;
    const { cellWidth, cellHeight } = character.spritesheet;
    el.style.width = `${cellWidth}px`;
    el.style.height = `${cellHeight}px`;
    el.style.backgroundImage = 'none';
    el.getAnimations?.().forEach((a) => a.cancel()); // a previous player's fade
    this.fade = null;
    this.sheetUrl = sheetUrl;
    this.timer = null;
    this.current = null;
    this.pendingReturn = null;
    this.generation = 0;
  }

  has(name) {
    return Boolean(this.c.animations[name]);
  }

  get playing() {
    return this.current !== null;
  }

  // Resolves with 'done' when the animation reaches its end, or 'cut'.
  async play(name) {
    if (this.current) this._finish('cut'); // keeps a pending Return

    const anim = this.c.animations[name];
    if (!anim) return 'missing';
    const gen = ++this.generation;
    if (await this.returnToNeutral({ hurry: true }) === 'cut' || gen !== this.generation) return 'cut';
    return this._run(name, anim, 0, false);
  }

  // Plays the pending Return, if the last animation left the character posed;
  // `hurry` when the next animation is waiting on it.
  async returnToNeutral({ hurry = false } = {}) {
    if (this.current) return 'busy';
    const ret = this.pendingReturn;
    this.pendingReturn = null;
    if (!ret) return 'none';
    if (ret.animation) return this._run(ret.animation, this.c.animations[ret.animation], 0, false);
    // "Use Exit Branching": continue from the pose via the exit branches.
    return this._run(ret.name, ret.anim, ret.index, true, { resume: true, hurry });
  }

  // `hurry` when something is waiting on it; a hurried exit() also hurries
  // one already under way at its own pace (a Return, a timed-out idle).
  exit({ hurry = true } = {}) {
    const cur = this.current;
    if (!cur || cur.hurry || (cur.exiting && !hurry)) return;
    cur.exiting = true;
    this._planExit(cur, hurry);
    if (!hurry) return;
    // A frame held on screen (some hold for seconds) lets go now: it is a
    // still image, so ending it early is invisible.
    const left = cur.frameEnds - performance.now();
    if (left > HOLD_MS) {
      clearTimeout(this.timer);
      cur.frameEnds -= left - HOLD_MS;
      this.timer = setTimeout(() => this._advance(), HOLD_MS);
    }
  }

  // Sets out how the current animation exits. In a hurry: from the frame on
  // screen, or from a frame drawn with the same cells whose exit path is
  // shorter (many exits rewind through the frames that led in, so the pose
  // recurs nearer the end), a path longer than EXIT_BUDGET_MS playing
  // proportionally faster. Either way, a path that loops is cut after a while.
  _planExit(cur, hurry) {
    cur.hurry = hurry;
    clearTimeout(cur.exitTimer);
    const { frames } = cur.anim;
    const same = JSON.stringify(frames[cur.shown].cells);
    let from = cur.index;
    let ms = exitLength(frames, from);
    frames.forEach((f, k) => {
      if (!hurry || JSON.stringify(f.cells) !== same) return;
      const m = exitLength(frames, k);
      if (m < ms) { from = k; ms = m; }
    });
    if (from !== cur.index) cur.index = cur.shown = from; // looks the same
    if (ms === Infinity) cur.exitTimer = setTimeout(() => this._timeUp(), EXIT_TIMEOUT_MS);
    else if (hurry) cur.speed = Math.min(1, EXIT_BUDGET_MS / ms);
  }

  cut() {
    this.pendingReturn = null;
    this.fade?.cancel();
    this.fade = null;
    if (this.current) this._finish('cut');
  }

  _run(name, anim, index, exiting, { resume = false, hurry = false } = {}) {
    return new Promise((resolve) => {
      this.current = { name, anim, index, shown: index, exiting, isReturn: resume, resolve, speed: 1, frameEnds: 0 };
      if (exiting) this._planExit(this.current, hurry);
      if (resume) this._advance();
      else this._show(index);
    });
  }

  // The exit path loops (bad data): don't keep the user waiting, but fade the
  // current pose out; the next frame drawn fades back in (see _draw).
  _timeUp() {
    const cur = this.current;
    clearTimeout(this.timer);
    this.fade = this.el.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, easing: 'ease-in', fill: 'forwards' }) ?? null;
    const done = () => { if (this.current === cur) this._finish('done'); };
    if (this.fade) this.fade.onfinish = done;
    else done();
  }

  _finish(reason) {
    const cur = this.current;
    clearTimeout(this.timer);
    clearTimeout(cur.exitTimer);
    this.current = null;
    // Reached its natural end in a non-neutral pose: remember how to return.
    if (reason === 'done' && !cur.exiting && !cur.isReturn) {
      if (cur.anim.returnAnimation && this.has(cur.anim.returnAnimation)) {
        this.pendingReturn = { animation: cur.anim.returnAnimation };
      } else if (cur.anim.useExitBranching && cur.anim.frames[cur.shown]?.exitBranch !== undefined) {
        this.pendingReturn = { name: cur.name, anim: cur.anim, index: cur.shown };
      }
    }
    cur.resolve(reason);
  }

  _show(index) {
    const cur = this.current;
    const frame = cur.anim.frames[index];
    cur.index = index;
    // A blank zero-duration frame is a control frame (Agent's "explicit final
    // frame ... not played visibly" / branch point): keep the previous image.
    // Blank frames with a duration are real (e.g. Show/Hide/GoodBye).
    if (frame.cells.length || frame.duration > 0) {
      cur.shown = index;
      this._draw(frame.cells);
    }
    const ms = frame.duration * cur.speed;
    cur.frameEnds = performance.now() + ms;
    this.timer = setTimeout(() => this._advance(), ms);
  }

  _advance() {
    const cur = this.current;
    const { frames } = cur.anim;
    const frame = frames[cur.index];
    let next = cur.index + 1;
    if (cur.exiting) {
      next = exitNext(frames, cur.index);
    } else if (frame.branches) {
      let roll = Math.random() * 100;
      for (const b of frame.branches) {
        if (roll <= b.weight) { next = b.to; break; }
        roll -= b.weight;
      }
    }
    if (next >= frames.length) this._finish('done');
    else this._show(next);
  }

  _draw(cells) {
    const { cellWidth: w, cellHeight: h } = this.c.spritesheet;
    const style = this.el.style;
    if (this.fade) {
      this.fade.cancel();
      this.fade = null;
      this.el.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: 'ease-out' });
    }
    if (!cells.length) {
      style.backgroundImage = 'none';
      return;
    }
    // Later cells are drawn on top (Agent frames can layer several images).
    const layers = [...cells].reverse();
    style.backgroundImage = layers.map(() => `url("${this.sheetUrl}")`).join(',');
    style.backgroundPosition = layers.map(([col, row]) => `-${col * w}px -${row * h}px`).join(',');
  }
}
