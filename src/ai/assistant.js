// Conversation layer: persona prompt + short rolling history on top of a provider.
import * as ollama from './ollama.js';

const BASE_RULES = [
  'You live on the user\'s desktop as a small animated assistant; your replies appear in a speech balloon, which scrolls.',
  // The personas are real Microsoft characters, so models otherwise offer
  // the original's features (search your files, help in Word).
  'You are a fan-made recreation of the character in an app called Deskling, not part of Microsoft Office or Windows, and you cannot use any of their features.',
  'When asked about yourself, say only what you are told here; do not make up facts, history or abilities.',
  'Plain text only: no markdown, no headings, no code fences, no bullet lists (the balloon shows them as raw symbols).',
  'You have no internet access, so you know nothing live such as today\'s news, weather, prices or the current time; say so rather than guess.',
  // Small models invent features (drop files on me, I'll send that email)
  // unless told what the whole of their ability is.
  'All you can do is chat in this balloon: answer questions, explain, give tips, and write, rewrite or translate text the user types.',
  'That is the whole app: you cannot receive files or drag-and-drop, and you cannot send email or messages, open apps or files, see the screen, browse the web, set reminders, or change anything on the computer.',
  'Never offer or describe any other ability, and never claim to have done something; instead write the text for the user to use, or tell them the steps to do it themselves.',
].join(' ');
// Last, closest to the reply, where small models follow it most reliably.
// Small models drift into English under an English system prompt, so a
// language that can be told from its script is named outright.
const SCRIPTS = [
  { re: /[\u3040-\u30ff]/g, name: 'Japanese (日本語)' }, // kana, before Han
  { re: /[\uac00-\ud7af]/g, name: 'Korean (한국어)' },
  { re: /[\u4e00-\u9fff]/g, name: 'Chinese (中文), in the same script (simplified or traditional)' },
];
export function languageRule(text) {
  const letters = (text.match(/\p{L}/gu) || []).length;
  const found = SCRIPTS.find(({ re }) => (text.match(re) || []).length >= Math.max(1, letters * 0.2));
  const unless = 'unless their standing instructions say otherwise';
  return found
    ? `The user is writing in ${found.name}: reply in ${found.name.split(' (')[0]}, ${unless}.`
    : `Reply in the language of the user's latest message, ${unless}.`;
}

// Response Style options shown in Assistant Settings. Each sets the reply's
// length, as a concrete target (small local models follow numbers far better
// than "brief"); the tone styles answer at Normal length.
const LENGTH = 'this overrides any other note about length';
const NORMAL = `Length: about 3 to 5 sentences, enough to actually answer, with a concrete tip or example where it helps (${LENGTH}).`;
export const RESPONSE_STYLES = {
  concise: { label: 'Concise', prompt: `Get straight to the point. Length: one or two sentences (${LENGTH}).`, maxTokens: 200 },
  normal: { label: 'Normal', prompt: NORMAL, maxTokens: 500 },
  chatty: { label: 'Chatty', prompt: `Be conversational and warm. Length: about 4 to 6 sentences, ending with a short follow-up question (${LENGTH}).`, maxTokens: 600 },
  detailed: { label: 'Detailed', prompt: `Give a thorough answer covering the key steps or reasons. Length: 2 to 4 short paragraphs, roughly 150 to 300 words, separated by blank lines (${LENGTH}).`, maxTokens: 1000 },
  friendly: { label: 'Friendly', prompt: `Be warm and encouraging. ${NORMAL}`, maxTokens: 500 },
  professional: { label: 'Professional', prompt: `Be precise and neutral in tone, like a capable colleague. ${NORMAL}`, maxTokens: 500 },
  playful: { label: 'Playful', prompt: `Be playful and witty with light humor, while still answering the question. ${NORMAL}`, maxTokens: 500 },
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

  systemPrompt(text = '') {
    const style = RESPONSE_STYLES[this.behavior.responseStyle];
    const parts = [this.persona?.systemPrompt || '', BASE_RULES, style.prompt];
    if (this.behavior.instructions) {
      parts.push(`The user's standing instructions (follow them unless they conflict with the rules above): ${this.behavior.instructions}`);
    }
    parts.push(languageRule(text));
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
      { role: 'system', content: this.systemPrompt(text) },
      ...this.history,
      { role: 'user', content: text },
    ];
    const { maxTokens } = RESPONSE_STYLES[this.behavior.responseStyle];
    const reply = await this.provider.chat({ model: this.model, messages, maxTokens, onToken, signal: this.abort.signal });
    // Kept in memory only (never saved), and only as much as the model sees.
    this.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
    this.history = this.history.slice(-MAX_HISTORY);
    this.abort = null;
    return reply;
  }
}
