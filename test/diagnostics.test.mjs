import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, chatFacts, NEW_BUG_URL, scrub } from '../src/main/diagnostics.js';

const paths = ['/Users/Me/Library/Application Support/Deskling', '/Users/Me'];

test('the report names the app, the machine and what the user has set', () => {
  const report = buildReport({
    version: '0.3.16', now: new Date('2026-10-17T09:26:00Z'), electron: '44.4.5',
    mac: '26.2', arch: 'arm64', locale: 'zh-CN',
    character: 'clawd', balloon: 'classic', scale: 105, showPet: true,
    chat: 'on', ollama: 'qwen2.5:1.5b', claudeHooks: true,
  });
  assert.ok(report.startsWith('Deskling 0.3.16 · 2026-10-17 · Electron 44.4.5 · macOS 26.2 · arm64 · zh-CN'));
  assert.match(report, /^Pet: clawd · classic balloon · size 105% · shown$/m);
  assert.match(report, /^Chat: on · qwen2.5:1\.5b$/m);
  assert.match(report, /^Claude Code hooks: on$/m);
});

test('unset facts leave no gap, and nothing empty is ever said', () => {
  for (const report of [
    buildReport({ version: '0.3.16', chat: 'off' }),
    buildReport({ version: '0.3.16', character: 'rover', chat: 'on', ollama: 'none installed yet' }),
    buildReport(),
  ]) {
    assert.doesNotMatch(report, /undefined|NaN|null/);
    assert.doesNotMatch(report, /  /); // no doubled separators from a missing fact
  }
  assert.equal(buildReport({ version: '0.3.16' }), 'Deskling 0.3.16\nChat: off');
});

test("the Chat line is the mapping main.js runs, in every state it can see", () => {
  // Driven through chatFacts (the production path), not hand-made strings.
  const w = (on, info) => buildReport({ ...chatFacts(on, info), version: '1' }).split('\n').find((l) => l.startsWith('Chat:'));
  assert.equal(w(false, {}), 'Chat: off');
  assert.equal(w(true, { available: true, model: null, models: [] }), 'Chat: on · no local model installed');
  assert.equal(w(true, { available: true, model: 'qwen2.5:1.5b', models: ['qwen2.5:1.5b'] }), 'Chat: on · qwen2.5:1.5b');
  assert.equal(w(true, { available: false, model: null, error: 'fetch failed' }), 'Chat: on · Ollama unreachable · (fetch failed)');
});

test("this Mac's paths never reach a public issue, not even in a log line", () => {
  const report = buildReport({
    version: '0.1',
    paths,
    claudeHooks: false,
    claudeError: 'EPERM, /Users/Me/.claude/settings.json',
    logTail: '… EPSSLASH /Users/Me/Library/Application Support/Deskling/deskling.log marked read-only …',
  });
  assert.doesNotMatch(report, /Users\/Me/);
  assert.match(report, /EPERM, ~\/\.claude\/settings\.json/);
  assert.match(report, /~/);
  assert.match(report, /^Claude Code hooks: off \(EPERM, ~\/\.claude\/settings\.json\)$/m);

  const quiet = buildReport({ version: '0.1', claudeHooks: null, claudeError: null });
  assert.doesNotMatch(quiet, /Claude Code/); // no hooks worry, no line
});

test('a report with errors carries them, an errorless one stays short, and every line is scrubbed', () => {
  const withLog = buildReport({ version: '0.1', paths, logTail: '2026-10-17T09:20:00Z [error] ran into /Users/Me/private/stuff' });
  assert.match(withLog, /\[error\]/);
  assert.doesNotMatch(withLog, /Users\/Me/);
  assert.match(withLog, /read it before sending/);

  const quiet = buildReport({ version: '0.1' });
  assert.equal(quiet.split('\n').length, 2);
});

test('the bug form URL opens the template', () => {
  assert.match(NEW_BUG_URL, /issues\/new\?template=bug_report\.yml$/);
});

test("scrub takes the real path behind a symlink or /private prefix, longest first", () => {
  // The data folder shares its start with home: the longer one must win.
  const out = scrub('from /Users/Me/Library/Application Support/Deskling/deskling.log and /Users/Me/bin', [...paths].reverse());
  assert.equal(out, 'from ~/deskling.log and ~/bin');
});
