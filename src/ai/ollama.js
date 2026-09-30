// Ollama provider. Only uses models already present on this machine; never
// pulls or downloads anything. Cloud-proxied models (`:cloud`) are skipped
// because they are not local.

import { execFile, spawn } from 'node:child_process';

const BASE = process.env.OLLAMA_HOST
  ? (process.env.OLLAMA_HOST.startsWith('http') ? process.env.OLLAMA_HOST : `http://${process.env.OLLAMA_HOST}`)
  : 'http://127.0.0.1:11434';

// Chat on starts Ollama if it isn't running (the app, else `ollama serve`);
// chat off stops only an Ollama this app started, and otherwise just unloads
// the model, so an Ollama the user runs for other things is left alone.
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:|\/|$)/.test(BASE);
// A packaged app's PATH lacks where the CLI is usually installed.
const PATH = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(':');
let started = null; // 'app', or the `ollama serve` process

const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, (e) => resolve(!e)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function running() {
  try {
    return (await fetch(`${BASE}/api/version`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

function serve() {
  return new Promise((resolve) => {
    const child = spawn('ollama', ['serve'], { env: { ...process.env, PATH }, stdio: 'ignore' });
    child.once('spawn', () => resolve(child));
    child.once('error', () => resolve(null)); // not installed
    child.once('exit', () => { if (started === child) started = null; });
  });
}

// Starts and stops run in order, so switching chat off during a launch stops
// what it started, and back on starts it again.
let queue = Promise.resolve();
const next = (step) => (queue = queue.then(step));

// Resolves once Ollama answers, or right away if it can't be started.
export const start = () => next(launch);
export const stop = (model) => next(() => halt(model));

async function launch() {
  if (!LOCAL || started || await running()) return;
  if (await run('open', ['-g', '-j', '-a', 'Ollama'])) started = 'app';
  else started = await serve();
  for (let i = 0; started && i < 30; i++) {
    if (await running()) return;
    await sleep(500);
  }
}

async function halt(model) {
  const was = started;
  started = null;
  // The app turns down a polite quit ("User canceled"); SIGTERM ends it and its server.
  if (was) {
    if (was === 'app') await run('pkill', ['-TERM', '-x', 'Ollama']);
    else was.kill();
    // Until it's gone: a launch right after must not take it for running.
    for (let i = 0; i < 20 && await running(); i++) await sleep(250);
  } else if (model && LOCAL) {
    await fetch(`${BASE}/api/generate`, {
      method: 'POST',
      body: JSON.stringify({ model: model.name, keep_alive: 0 }),
      signal: AbortSignal.timeout(2500),
    }).catch(() => {});
  }
}

export function isLocalModel(m) {
  if (m.remote_host || m.remote_model) return false;
  if (/[:-]cloud$/.test(m.name)) return false;
  if (Array.isArray(m.capabilities) && !m.capabilities.includes('completion')) return false;
  if (/embed/i.test(m.name)) return false;
  return true;
}

export async function detect() {
  try {
    const res = await fetch(`${BASE}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { models = [] } = await res.json();
    const local = models.filter(isLocalModel).map((m) => ({
      name: m.name,
      size: m.size,
      params: m.details?.parameter_size || '',
      thinking: Array.isArray(m.capabilities) && m.capabilities.includes('thinking'),
    }));
    local.sort((a, b) => a.size - b.size); // smallest first
    return { available: true, models: local, skipped: models.length - local.length };
  } catch (e) {
    return { available: false, models: [], error: e.message };
  }
}

export function pickModel(models, preferred) {
  return models.find((m) => m.name === preferred) || models[0] || null;
}

// Context window asked of Ollama. Left unset, it reserves the model's full
// context: 262,144 tokens for nemotron-3-nano, 8.3 GB instead of 3.2 GB. A
// conversation (system prompt, 12 messages of history, the reply) needs at
// most about 8,500 tokens; past this, Ollama drops the oldest messages.
const CONTEXT_TOKENS = 16384;
// How long the model stays loaded after a reply (Ollama's own default): the
// next reply is quick, and the memory is freed soon after the chat stops.
const KEEP_ALIVE = '5m';

// Streams a chat completion. Calls onToken(text) per chunk; resolves with the
// full reply.
export async function chat({ model, messages, maxTokens = 400, onToken, signal }) {
  const body = {
    model: model.name,
    messages,
    stream: true,
    keep_alive: KEEP_ALIVE,
    options: { temperature: 0.7, num_predict: maxTokens, num_ctx: CONTEXT_TOKENS },
  };
  if (model.thinking) body.think = false; // answer directly; a pet shouldn't ramble privately
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.error) throw new Error(msg.error);
      const text = msg.message?.content || '';
      if (text) {
        full += text;
        onToken?.(text);
      }
    }
  }
  return full;
}
