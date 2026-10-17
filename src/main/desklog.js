// The app's own short record of what went wrong, in its data folder. It has no
// other point: no telemetry, nothing is read by the app itself. It exists so a
// user who hits a problem can paste it into a report with "Report a Problem…"
// (see diagnostics.js) instead of only living with the bug.
//
// It rotates: deskling.log to deskling.log.1 when full, so one bad day is
// readable in full without growing forever. Stacks keep their line breaks
// (only length-capped) — that is what a report needs most.

import fs from 'node:fs';
import path from 'node:path';

export const LOG_FILE = 'deskling.log';
export const MAX_BYTES = 256 * 1024; // both rotations together stay under ~512 KB
export const MAX_ENTRY = 4000; // one runaway loop can't grow the file by the minute

// YYYY-MM-DDThh:mm:ss.sssZ [kind] text — the compact side of a report.
export const stamp = (kind, text, now = new Date()) => `${now.toISOString()} [${kind}] ${text}`;

// A multiline entry (a crash's stack) keeps its lines; only its length is
// capped, cut at the last full line so a half-written line never ships. A
// single line over the cap has no whole line to leave, so it is hard-cut —
// the message survives, with the cut marked, instead of vanishing entirely.
export const capped = (text, max = MAX_ENTRY) => {
  const cut = (t) => {
    if (t.length <= max) return t;
    const head = t.slice(0, max + 200);
    const whole = head.split('\n');
    return whole.length > 1 ? `${whole.slice(0, -1).join('\n')} …` : `${head.slice(0, max)} …`;
  };
  return cut(String(text ?? '').replace(/\r/g, '').trimEnd());
};

export function openLog(dir, { maxBytes = MAX_BYTES, now = () => new Date() } = {}) {
  const file = path.join(dir, LOG_FILE);
  const record = (kind, parts) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      try { if (fs.statSync(file).size > maxBytes) fs.renameSync(file, `${file}.1`); } catch { /* not there yet */ }
      fs.appendFileSync(file, `${stamp(kind, capped(parts.map(String).join(' ')), now())}\n`);
    } catch { /* a log must never be the crash */ }
  };
  return {
    info: (...parts) => record('info', parts),
    warn: (...parts) => record('warn', parts),
    error: (...parts) => record('error', parts),
    file,
  };
}

// The older rotation counts too: just after a flip, the start of this one is
// the tail of that one.
export function readTail(dir, { keep = 40 } = {}) {
  const file = path.join(dir, LOG_FILE);
  const lines = [];
  for (const f of [`${file}.1`, file]) {
    try { lines.push(...fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)); } catch { /* missing rotation */ }
  }
  return lines.slice(-keep).join('\n');
}

// The existing console.warn/error calls keep printing; a copy reaches the log.
// Why a tee: the code warns at many scattered spots (updates, Claude Code,
// characters, timers); tee records them all without touching each one.
export function teeConsole(console_, log) {
  for (const kind of ['warn', 'error']) {
    const original = console_[kind].bind(console_);
    console_[kind] = (...parts) => { original(...parts); log[kind](...parts); };
  }
}
