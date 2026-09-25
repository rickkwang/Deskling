// node --test test/  — prompt building (no model needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Assistant, RESPONSE_STYLES, languageRule } from '../src/ai/assistant.js';

test('the reply language is named when the script gives it away', () => {
  assert.match(languageRule('怎么提高英语口语？'), /reply in Chinese/);
  assert.match(languageRule('請問這個怎麼用'), /reply in Chinese/);
  assert.match(languageRule('帮我翻译 hello world'), /reply in Chinese/);
  assert.match(languageRule('日本語で話せますか？'), /reply in Japanese/);
  assert.match(languageRule('안녕하세요'), /reply in Korean/);
  assert.match(languageRule('How are you?'), /language of the user's latest message/);
  assert.match(languageRule('Is 你好 a greeting?'), /language of the user's latest message/, 'one borrowed word does not decide');
});

test('every style sets a concrete length, and the language rule comes last', () => {
  const a = new Assistant();
  a.setPersona({ systemPrompt: 'You are Clippy.' });
  for (const style of Object.keys(RESPONSE_STYLES)) {
    a.setBehavior({ responseStyle: style, instructions: 'Call me Captain.' });
    const p = a.systemPrompt('你好');
    assert.match(p, /Length: /, style);
    assert.ok(p.includes(RESPONSE_STYLES[style].prompt), style);
    assert.match(p, /Call me Captain\./);
    assert.match(p, /reply in Chinese, unless their standing instructions say otherwise\.$/);
  }
});

test('history keeps only the last turns the model sees', async () => {
  const a = new Assistant();
  a.setPersona({ systemPrompt: '' });
  a.model = { name: 'stub' };
  let sent = null;
  a.provider = { chat: async ({ messages }) => { sent = messages; return 'ok'; } };
  for (let i = 0; i < 20; i++) await a.send(`q${i}`);
  assert.equal(a.history.length, 12);
  assert.equal(a.history[0].content, 'q14');
  assert.equal(sent.length, 1 + 12 + 1, 'system + history + new message');
});

test('the prompt says the assistant can only talk, not act', () => {
  const a = new Assistant();
  a.setPersona({ systemPrompt: 'You are Clippy.' });
  const p = a.systemPrompt('帮我发封邮件');
  assert.match(p, /cannot send email/);
  assert.match(p, /cannot receive files or drag-and-drop/);
  assert.match(p, /Never offer or describe any other ability/);
});
