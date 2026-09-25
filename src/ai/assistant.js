// Conversation layer: persona prompt + short rolling history on top of a provider.
import * as ollama from './ollama.js';

const BASE_RULES = [
  'You live on the user\'s desktop as a small animated assistant and reply inside a tiny speech balloon.',
  'Reply in the same language the user writes in.',
  'Plain text only: no markdown, no headings, no code fences, no bullet lists.',
].join(' ');

// Response Style options shown in Assistant Settings.
export const RESPONSE_STYLES = {
  concise: { label: 'Concise', prompt: 'Answer in one or two short sentences.', maxTokens: 200 },
  normal: { label: 'Normal', prompt: 'Be brief: at most 3 short sentences unless the user explicitly asks for detail.', maxTokens: 400 },
  chatty: { label: 'Chatty', prompt: 'Be conversational and warm. A few sentences is fine, and you may ask a short follow-up question.', maxTokens: 500 },
  detailed: { label: 'Detailed', prompt: 'Give thorough, complete answers with the key steps or reasons, in short paragraphs.', maxTokens: 900 },
  friendly: { label: 'Friendly', prompt: 'Be warm and encouraging. Keep it to about 3 sentences.', maxTokens: 400 },
  professional: { label: 'Professional', prompt: 'Be precise and neutral in tone, like a capable colleague. Keep it to about 3 sentences.', maxTokens: 400 },
  playful: { label: 'Playful', prompt: 'Be playful and witty with light humor, while still answering the question. Keep it to about 3 sentences.', maxTokens: 400 },
};

export const MAX_INSTRUCTIONS = 500;

const MAX_HISTORY = 12;

export class Assistant {
  constructor() {
    this.provider = ollama;
    this.models = [];
    this.model = null;
    this.status = { available: false };
    this.persona = null;
    this.behavior = { responseStyle: 'normal', instructions: '' };
    this.history = [];
    this.abort = null;
  }

  async refresh(preferredModel = this.preferred) {
    this.preferred = preferredModel;
    this.status = await this.provider.detect();
    this.models = this.status.models;
    this.model = this.provider.pickModel(this.models, preferredModel);
    return this.info();
  }

  info() {
    return {
      available: this.status.available,
      error: this.status.error,
      models: this.models.map((m) => m.name),
      model: this.model?.name || null,
    };
  }

  setModel(name) {
    this.preferred = name;
    this.model = this.provider.pickModel(this.models, name);
  }

  setBehavior({ responseStyle, instructions }) {
    this.behavior = {
      responseStyle: RESPONSE_STYLES[responseStyle] ? responseStyle : 'normal',
      instructions: String(instructions || '').slice(0, MAX_INSTRUCTIONS).trim(),
    };
  }

  systemPrompt() {
    const style = RESPONSE_STYLES[this.behavior.responseStyle];
    const parts = [this.persona?.systemPrompt || '', BASE_RULES, style.prompt];
    if (this.behavior.instructions) {
      parts.push(`The user's standing instructions (follow them unless they conflict with the rules above): ${this.behavior.instructions}`);
    }
    return parts.filter(Boolean).join(' ');
  }

  setPersona(persona) {
    this.persona = persona;
    this.reset();
  }

  reset() {
    this.cancel();
    this.history = [];
  }

  cancel() {
    this.abort?.abort();
    this.abort = null;
  }

  async send(text, onToken) {
    if (!this.model) {
      await this.refresh();
      if (!this.model) throw new Error(this.status.available ? 'NO_LOCAL_MODEL' : 'OLLAMA_UNAVAILABLE');
    }
    this.cancel();
    this.abort = new AbortController();
    const messages = [
      { role: 'system', content: this.systemPrompt() },
      ...this.history.slice(-MAX_HISTORY),
      { role: 'user', content: text },
    ];
    const { maxTokens } = RESPONSE_STYLES[this.behavior.responseStyle];
    const reply = await this.provider.chat({ model: this.model, messages, maxTokens, onToken, signal: this.abort.signal });
    this.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
    this.abort = null;
    return reply;
  }
}
