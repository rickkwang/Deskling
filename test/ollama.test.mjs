// node --test test/  — what the Ollama provider asks for (no Ollama needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chat } from '../src/ai/ollama.js';

test('chat asks for a context sized to the conversation, and frees the model after 5 minutes', async (t) => {
  let body = null;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response(`${JSON.stringify({ message: { content: 'hi' } })}\n`);
  });
  assert.equal(await chat({ model: { name: 'm' }, messages: [], maxTokens: 100 }), 'hi');
  // Left unset, Ollama reserves the model's full context (262,144 tokens for
  // nemotron-3-nano: 8.3 GB instead of 3.2 GB).
  assert.equal(body.options.num_ctx, 16384);
  assert.equal(body.keep_alive, '5m');
});
