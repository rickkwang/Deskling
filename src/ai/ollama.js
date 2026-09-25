// Ollama provider. Only uses models already present on this machine; never
// pulls or downloads anything. Cloud-proxied models (`:cloud`) are skipped
// because they are not local.

const BASE = process.env.OLLAMA_HOST
  ? (process.env.OLLAMA_HOST.startsWith('http') ? process.env.OLLAMA_HOST : `http://${process.env.OLLAMA_HOST}`)
  : 'http://127.0.0.1:11434';

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

// Streams a chat completion. Calls onToken(text) per chunk; resolves with the
// full reply.
export async function chat({ model, messages, maxTokens = 400, onToken, signal }) {
  const body = {
    model: model.name,
    messages,
    stream: true,
    keep_alive: '15m',
    options: { temperature: 0.7, num_predict: maxTokens },
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
