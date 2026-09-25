// Plays one character animation at a time with Microsoft Agent semantics:
// - frames advance after their duration, following probabilistic `branches`
//   (weights are percentages; the remainder falls through to the next frame);
// - exit() sets "exiting": frames with an `exitBranch` jump there and the rest
//   play on in sequence (no random branching; the last frame ends it), so
//   looping animations "hurry up and finish" instead of being cut;
// - when an animation ends, its last visible frame stays on screen;
// - Return animations: an animation that ends away from the neutral pose
//   (`useExitBranching` or an explicit `returnAnimation`) is returned to
//   neutral before the next animation plays, or on returnToNeutral().

import { exitNext } from '../character/exit.js';

const EXIT_TIMEOUT_MS = 2000; // exit paths longer than this are cut short...
const FADE_MS = 90; // ...with a quick dip out and back in, not a jump

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
    if (await this.returnToNeutral() === 'cut' || gen !== this.generation) return 'cut';
    return this._run(name, anim, 0, false);
  }

  // Plays the pending Return, if the last animation left the character posed.
  async returnToNeutral() {
    if (this.current) return 'busy';
    const ret = this.pendingReturn;
    this.pendingReturn = null;
    if (!ret) return 'none';
    if (ret.animation) return this._run(ret.animation, this.c.animations[ret.animation], 0, false);
    // "Use Exit Branching": continue from the pose via the exit branches.
    return this._run(ret.name, ret.anim, ret.index, true, { resume: true });
  }

  exit() {
    const cur = this.current;
    if (!cur || cur.exiting) return;
    cur.exiting = true;
    cur.exitTimer = setTimeout(() => this._timeUp(), EXIT_TIMEOUT_MS);
  }

  cut() {
    this.pendingReturn = null;
    this.fade?.cancel();
    this.fade = null;
    if (this.current) this._finish('cut');
  }

  _run(name, anim, index, exiting, { resume = false } = {}) {
    return new Promise((resolve) => {
      this.current = { name, anim, index, shown: index, exiting, isReturn: resume, resolve };
      if (exiting) this.current.exitTimer = setTimeout(() => this._timeUp(), EXIT_TIMEOUT_MS);
      if (resume) this._advance();
      else this._show(index);
    });
  }

  // The exit path is too long (or loops): don't keep the user waiting, but fade
  // the current pose out; the next frame drawn fades back in (see _draw).
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
    this.timer = setTimeout(() => this._advance(), frame.duration);
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
