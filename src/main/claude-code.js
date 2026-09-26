// Claude Code activity, like Codex's pets: while a Claude Code session works
// the pet works too, and it tells the user when one finishes, needs an answer
// or fails. Claude Code's hooks POST their event JSON to a small server on
// 127.0.0.1; the hook is a curl that stays silent when Deskling isn't running.
// Plain logic with an injectable clock; main.js runs the server and shows it.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const PORT = 47823;
const ENDPOINT = `http://127.0.0.1:${PORT}/claude-code`;
// Browsers can't send this header to another origin without a preflight,
// which the server never answers, so web pages can't post events.
const HEADER = 'x-deskling';
const MAX_BODY = 4 * 1024 * 1024; // PostToolUse carries the tool's output
// The terminal app Claude Code runs in (macOS sets its bundle id), so a click
// on the pet's notice can bring it forward.
export const HOOK_COMMAND = `curl -sf -m 2 -H 'Content-Type: application/json' -H '${HEADER}: 1' -H "x-terminal: $__CFBundleIdentifier" --data-binary @- ${ENDPOINT} >/dev/null 2>&1 || true`;
export const HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'];
// Tools that wait for the user rather than work. Other tools' PreToolUse adds
// nothing (the turn is already working), so the hook only runs for these.
const ASKING_TOOLS = ['AskUserQuestion', 'ExitPlanMode'];
const MATCHERS = { PreToolUse: ASKING_TOOLS.join('|') };
const ASKING_NOTICES = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']);
// A quick turn finished while the user watched the terminal: no news.
export const DONE_AFTER_MS = 20 * 1000;
// A turn interrupted with Esc never sends Stop: stop working after this much
// quiet (a later Stop still reports), and forget the session after a day.
export const STALE_MS = 15 * 60 * 1000;
const FORGET_MS = 24 * 60 * 60 * 1000;

// ---- hooks in Claude Code's settings.json --------------------------------------

export const claudeSettingsFile = (env = process.env) => path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');

// Any Deskling hook, including ones an older version wrote, so they are
// replaced rather than piled up.
const isOurs = (hook) => typeof hook?.command === 'string' && hook.command.includes(`${HEADER}:`);
const current = (group) => group?.hooks?.some((h) => h.command === HOOK_COMMAND);

export function hooksInstalled(config) {
  return HOOK_EVENTS.every((event) => config?.hooks?.[event]?.some(current));
}

// Installed as this version writes them, and nothing older: wherever they sit.
function upToDate(config) {
  const ours = Object.values(config.hooks || {}).flatMap((groups) => (Array.isArray(groups) ? groups : []).flatMap((g) => g?.hooks || [])).filter(isOurs);
  return ours.length === HOOK_EVENTS.length
    && HOOK_EVENTS.every((event) => config.hooks[event]?.some((g) => current(g) && (g.matcher || '') === (MATCHERS[event] || '')));
}

// Returns a copy with Deskling's hooks added (once, last) or removed;
// everything else is left as it was.
export function withHooks(config, on) {
  const next = { ...config, hooks: { ...config.hooks } };
  for (const event of Object.keys(next.hooks)) {
    if (!Array.isArray(next.hooks[event])) continue;
    const groups = next.hooks[event]
      .map((g) => (g?.hooks?.some(isOurs) ? { ...g, hooks: g.hooks.filter((h) => !isOurs(h)) } : g))
      .filter((g) => !Array.isArray(g?.hooks) || g.hooks.length);
    if (groups.length) next.hooks[event] = groups;
    else delete next.hooks[event];
  }
  if (on) {
    for (const event of HOOK_EVENTS) {
      const hook = { type: 'command', command: HOOK_COMMAND, async: true, timeout: 5 };
      next.hooks[event] = [...(next.hooks[event] || []), { matcher: MATCHERS[event] || '', hooks: [hook] }];
    }
  }
  if (!Object.keys(next.hooks).length) delete next.hooks;
  return next;
}

export function readClaudeSettings(file = claudeSettingsFile()) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  try { return JSON.parse(text); } catch { throw new Error(`${file} isn’t valid JSON, so Deskling left it alone.`); }
}

// Writes the hooks in or out, keeping the previous file as .deskling-backup.
// A symlinked settings.json (dotfiles) stays a symlink: its target is written.
export function setHooks(on, file = claudeSettingsFile()) {
  const config = readClaudeSettings(file);
  if (on && upToDate(config)) return; // no rewrite (and no new backup) at every launch
  const next = withHooks(config, on);
  if (JSON.stringify(next) === JSON.stringify(config)) return;
  const target = fs.existsSync(file) ? fs.realpathSync(file) : file;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // It may hold tokens: the new file keeps the old one's permissions.
  const mode = fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : 0o600;
  if (fs.existsSync(target)) fs.copyFileSync(target, `${file}.deskling-backup`);
  const tmp = `${target}.deskling-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode });
  fs.chmodSync(tmp, mode); // past the umask
  fs.renameSync(tmp, target);
}

// ---- sessions -----------------------------------------------------------------

// The first line of Claude's last message, as plain text, for the balloon.
export function summary(text, max = 140) {
  const line = String(text || '').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('```')) || '';
  const plain = line.replace(/^#+\s*|^[-*]\s+/, '').replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

// Most urgent first. Within a kind, the newest.
const RANK = { asking: 3, failed: 2, done: 1 };

export class ClaudeSessions {
  // onChange({ working, notice, more }) whenever the picture changes: whether
  // any session works, the notice that matters most ({ id, kind: 'asking' |
  // 'failed' | 'done', project, text?, why?, terminal? }, or null) and how
  // many others wait behind it. Notices go away once seen: the session works
  // again, the user prompts it again, or dismiss().
  constructor({ onChange = () => {}, now = Date.now } = {}) {
    this.onChange = onChange;
    this.now = now;
    // id -> { state: 'working' | 'asking' | 'idle' | 'stale', project, terminal, since (turn start), at (last event), notice }
    this.sessions = new Map();
    this.ids = 0;
    this.last = JSON.stringify(this.status());
  }

  status() {
    const all = [...this.sessions.values()];
    const notices = all.map((s) => s.notice).filter(Boolean).sort((a, b) => RANK[b.kind] - RANK[a.kind] || b.id - a.id);
    return { working: all.some((s) => s.state === 'working'), notice: notices[0] || null, more: Math.max(0, notices.length - 1) };
  }

  handle(event) {
    const id = event?.session_id;
    if (!id || event.agent_id) return; // subagents report through their session
    const name = event.hook_event_name;
    const prev = this.sessions.get(id);
    // A turn it saw start: none for sessions begun before Deskling listened.
    const inTurn = prev && prev.state !== 'idle';
    const project = path.basename(event.cwd || '') || 'Claude Code';
    const s = { since: this.now(), notice: null, ...prev, project, terminal: event.terminal || prev?.terminal, at: this.now() };
    this.sessions.set(id, s);
    const notify = (kind, more) => { s.notice = { id: ++this.ids, kind, project, terminal: s.terminal, ...more }; };
    const ask = (why) => { if (s.state !== 'asking') notify('asking', { why }); s.state = 'asking'; };
    if (name === 'UserPromptSubmit') Object.assign(s, { state: 'working', since: this.now(), notice: null }); // back at it: seen
    else if (name === 'PostToolUse' || (name === 'PreToolUse' && !ASKING_TOOLS.includes(event.tool_name))) {
      s.state = 'working';
      if (s.notice?.kind === 'asking') s.notice = null; // answered
    } else if (name === 'PreToolUse') ask('question');
    else if (name === 'PermissionRequest' || (name === 'Notification' && ASKING_NOTICES.has(event.notification_type))) ask('permission');
    else if (name === 'Stop' || name === 'StopFailure') {
      s.state = 'idle';
      if (s.notice?.kind === 'asking') s.notice = null;
      if (name === 'StopFailure') {
        if (inTurn) notify('failed', { text: summary(event.error_message || event.error_type) });
      } else if (inTurn && this.now() - s.since >= DONE_AFTER_MS) {
        notify('done', { text: summary(event.last_assistant_message) });
      }
    } else if (name === 'SessionEnd') {
      // A done or failed notice outlives its session (claude -p ends at once).
      if (!s.notice || s.notice.kind === 'asking') this.sessions.delete(id);
      else s.state = 'idle';
    }
    this.changed();
  }

  // The user saw them (closed the balloon, or went to the terminal).
  dismiss() {
    for (const s of this.sessions.values()) s.notice = null;
    this.changed();
  }

  // Called now and then: work that went quiet (an interrupted turn) stops
  // counting; a session quiet for a day (killed) is forgotten.
  sweep() {
    for (const [id, s] of this.sessions) {
      const quiet = this.now() - s.at;
      if (quiet > FORGET_MS) this.sessions.delete(id);
      else if (quiet > STALE_MS && s.state !== 'idle') s.state = 'stale';
    }
    this.changed();
  }

  changed() {
    const key = JSON.stringify(this.status());
    if (key === this.last) return;
    this.last = key;
    this.onChange(this.status());
  }
}

// ---- server ---------------------------------------------------------------------

// Resolves once listening; rejects if the port is taken.
export function listen(onEvent, port = PORT) {
  const server = http.createServer((req, res) => {
    const ok = req.method === 'POST' && req.url === '/claude-code' && req.headers[HEADER]
      && req.headers.host === `127.0.0.1:${port}`; // not a rebound DNS name
    if (!ok) { res.writeHead(404).end(); req.resume(); return; }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
    req.on('end', () => {
      res.writeHead(204).end();
      if (size > MAX_BODY) return;
      const terminal = /^[\w.-]{1,200}$/.test(req.headers['x-terminal'] || '') ? req.headers['x-terminal'] : undefined;
      let event;
      try { event = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return; } // not JSON
      try { onEvent({ ...event, terminal }); } catch (e) { console.warn(`[claude-code] ${e.stack}`); }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
