// Focus timer (Pomodoro): a focus session, then a break that starts on its
// own; after the break it waits for the user to start the next round. Plain
// logic with an injectable clock; main.js drives it and shows it.

// Durations are in seconds: any whole number in [min, max].
export const LIMITS = { focus: [1, 12 * 3600], break: [1, 4 * 3600] };
export const validSeconds = (kind, s) => Number.isInteger(s) && s >= LIMITS[kind][0] && s <= LIMITS[kind][1];
export const PRESETS = [[25 * 60, 5 * 60], [50 * 60, 10 * 60], [90 * 60, 20 * 60]];
// Played when a phase ends, from src/renderer/sounds/ (see CREDITS.md there).
export const SOUNDS = {
  none: { label: 'None' },
  indigo: { label: 'Indigo', file: 'AlertIndigo.mp3' },
  mailSent: { label: 'Mail Sent', file: 'EmailMailSent.mp3' },
  noMail: { label: 'No Mail', file: 'EmailNoMail.mp3' },
  nudge: { label: 'Nudge', file: 'MSNNudge.mp3' },
  startup: { label: 'Startup Chime', file: 'Boot.wav' },
};

export class FocusTimer {
  // onChange(status) after every state change; onEnd({ ended, seconds, next,
  // rounds }) when a phase runs out. `second` in ms (shorter for QA).
  constructor({ onChange = () => {}, onEnd = () => {}, now = Date.now, second = 1000 } = {}) {
    this.second = second;
    this.onChange = onChange;
    this.onEnd = onEnd;
    this.now = now;
    this.phase = 'off'; // off | focus | break | ready (break over, next round not started)
    this.endsAt = 0;
    this.left = 0; // ms left while paused
    this.paused = false;
    this.rounds = 0; // focus sessions finished today
    this.day = this.today();
  }

  today() {
    return new Date(this.now()).toDateString();
  }

  start(focusSeconds, breakSeconds) {
    this.seconds = { focus: focusSeconds, break: breakSeconds };
    this.enter('focus');
  }

  enter(phase) {
    this.phase = phase;
    this.paused = false;
    this.endsAt = phase === 'focus' || phase === 'break' ? this.now() + this.seconds[phase] * this.second : 0;
    this.onChange(this.status());
  }

  // Called about once a second; ends the phase when its time is up.
  check() {
    if (this.paused || !this.endsAt || this.now() < this.endsAt) return;
    const ended = this.phase;
    if (ended === 'focus') {
      if (this.today() !== this.day) { this.day = this.today(); this.rounds = 0; }
      this.rounds += 1;
    }
    this.enter(ended === 'focus' ? 'break' : 'ready');
    this.onEnd({ ended, seconds: this.seconds[ended], next: this.seconds.break, rounds: this.rounds });
  }

  pause() {
    if (!this.endsAt || this.paused) return;
    this.paused = true;
    this.left = Math.max(0, this.endsAt - this.now());
    this.onChange(this.status());
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.endsAt = this.now() + this.left;
    this.onChange(this.status());
  }

  // Ends the current phase now, without a reminder.
  skip() {
    if (this.phase === 'focus') this.enter('break');
    else if (this.phase === 'break') this.enter('ready');
  }

  stop() {
    this.enter('off');
  }

  status() {
    const running = this.phase === 'focus' || this.phase === 'break';
    const total = running ? this.seconds[this.phase] * this.second : 0;
    const left = !running ? 0 : this.paused ? this.left : Math.max(0, this.endsAt - this.now());
    return { phase: this.phase, paused: this.paused, left, total, seconds: this.seconds, rounds: this.rounds };
  }
}

// "18:42" or "1:18:42", rounded up so a phase never shows 0:00 while it is
// still running.
export function clock(ms) {
  const t = Math.ceil(ms / 1000);
  const [h, m, s] = [Math.floor(t / 3600), Math.floor(t / 60) % 60, t % 60];
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// Rounded up to whole minutes: "25 min", "1 h 5 min", "under 1 min".
export function minutesLeft(seconds) {
  return seconds < 60 ? 'under 1 min' : duration(Math.ceil(seconds / 60) * 60);
}

// "25 min", "1 h 30 min", "45 s", "1 min 30 s".
export function duration(seconds) {
  const [h, m, s] = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60];
  return [h && `${h} h`, m && `${m} min`, s && `${s} s`].filter(Boolean).join(' ') || '0 s';
}
