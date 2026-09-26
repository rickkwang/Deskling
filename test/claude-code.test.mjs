// node --test test/  — Claude Code activity: sessions, hook install, server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeSessions, DONE_AFTER_MS, HOOK_COMMAND, HOOK_EVENTS, STALE_MS, hooksInstalled, listen, setHooks, summary, withHooks } from '../src/main/claude-code.js';

function setup() {
  let t = 0;
  const changes = [];
  const sessions = new ClaudeSessions({ now: () => t, onChange: (s) => changes.push(s) });
  const send = (hook_event_name, extra = {}, session_id = 's1') => sessions.handle({ session_id, cwd: `/Users/me/Coding/${session_id === 's1' ? 'deskling' : session_id}`, hook_event_name, ...extra });
  const notice = () => sessions.status().notice;
  return { sessions, changes, send, notice, advance: (ms) => { t += ms; } };
}

test('a turn works, then shows it is done until the user comes back to it', () => {
  const { sessions, changes, send, notice, advance } = setup();
  send('UserPromptSubmit', { terminal: 'com.mitchellh.ghostty' });
  send('PreToolUse', { tool_name: 'Bash' });
  advance(DONE_AFTER_MS);
  send('PostToolUse', { tool_name: 'Bash' });
  assert.deepEqual(changes, [{ working: true, notice: null, more: 0 }], 'one change for the whole turn');
  send('Stop', { last_assistant_message: '**Added** the `hooks` and [tests](x.md).\n\nMore detail.' });
  assert.equal(sessions.status().working, false);
  assert.deepEqual(notice(), { id: 1, kind: 'done', project: 'deskling', terminal: 'com.mitchellh.ghostty', text: 'Added the hooks and tests.' });
  send('UserPromptSubmit');
  assert.equal(notice(), null, 'prompting the session again means it was seen');
});

test('a quick turn (the user was watching) ends without a notice', () => {
  const { send, notice, advance } = setup();
  send('UserPromptSubmit');
  advance(DONE_AFTER_MS - 1);
  send('Stop', { last_assistant_message: 'Hi!' });
  assert.equal(notice(), null);
  send('UserPromptSubmit');
  advance(DONE_AFTER_MS);
  send('Stop', { last_assistant_message: 'Long one.' });
  assert.equal(notice().kind, 'done', 'each turn is timed from its own prompt');
});

test('waiting for an answer shows once, and goes away when answered', () => {
  const { sessions, send, notice } = setup();
  send('UserPromptSubmit');
  send('PermissionRequest', { tool_name: 'Bash' });
  const asked = notice();
  send('Notification', { notification_type: 'permission_prompt' });
  assert.equal(sessions.status().working, false);
  assert.deepEqual(notice(), asked, 'the same notice, not a second one');
  assert.equal(asked.why, 'permission');
  send('PostToolUse', { tool_name: 'Bash' });
  assert.deepEqual(sessions.status(), { working: true, notice: null, more: 0 });
  send('PreToolUse', { tool_name: 'AskUserQuestion' });
  assert.equal(notice().why, 'question');
  send('Notification', { notification_type: 'idle_prompt' });
  assert.equal(notice().why, 'question', 'idle prompts are not news');
  send('Stop');
  assert.equal(notice(), null, 'a turn that ends quickly after a question leaves nothing');
});

test('the most urgent notice shows first, with a count of the rest', () => {
  const { sessions, send, notice, advance } = setup();
  send('UserPromptSubmit', {}, 'a');
  send('UserPromptSubmit', {}, 'b');
  send('UserPromptSubmit', {}, 'c');
  send('PermissionRequest', {}, 'a');
  advance(DONE_AFTER_MS);
  send('Stop', { last_assistant_message: 'Deployed.' }, 'b');
  assert.equal(notice().project, 'a', 'a later done does not hide a question');
  assert.equal(sessions.status().more, 1);
  send('StopFailure', { error_type: 'rate_limit', error_message: 'Rate limit exceeded' }, 'c');
  assert.deepEqual([notice().project, sessions.status().more], ['a', 2]);
  send('PostToolUse', {}, 'a');
  assert.deepEqual([notice().kind, notice().text], ['failed', 'Rate limit exceeded'], 'then failures, before done');
  sessions.dismiss();
  assert.deepEqual(sessions.status(), { working: true, notice: null, more: 0 });
});

test('failures, session ends, subagents and turns it never saw start', () => {
  const { sessions, send, notice } = setup();
  send('Stop', { last_assistant_message: 'old turn' });
  assert.equal(notice(), null, 'a turn begun before Deskling listened');
  send('Stop', { last_assistant_message: 'again' });
  assert.equal(notice(), null, 'nor a second Stop');
  send('UserPromptSubmit');
  send('Stop', { agent_id: 'a1', last_assistant_message: 'subagent' });
  assert.equal(sessions.status().working, true, 'a subagent finishing is not the turn');
  send('StopFailure', { error_type: 'rate_limit' });
  assert.deepEqual([notice().kind, notice().text], ['failed', 'rate_limit'], 'failures show even when quick');
  send('SessionEnd');
  assert.equal(notice().kind, 'failed', 'a notice outlives its session');
  sessions.dismiss();
  send('UserPromptSubmit');
  send('PermissionRequest');
  send('SessionEnd');
  assert.deepEqual(sessions.status(), { working: false, notice: null, more: 0 }, 'but nobody is waiting on an ended one');
});

test('work that goes quiet (an interrupted turn) stops counting, but a late Stop still reports', () => {
  const { sessions, send, notice, advance } = setup();
  send('UserPromptSubmit');
  send('UserPromptSubmit', {}, 'other');
  advance(STALE_MS);
  sessions.sweep();
  assert.equal(sessions.status().working, true);
  send('PostToolUse');
  advance(STALE_MS / 2 + 1);
  sessions.sweep();
  assert.equal(sessions.sessions.get('other').state, 'stale', 'only the silent session stops');
  assert.equal(sessions.sessions.get('s1').state, 'working');
  send('Stop', { last_assistant_message: 'Finally.' }, 'other');
  assert.deepEqual([notice().project, notice().text], ['other', 'Finally.']);
  advance(24 * 60 * 60 * 1000 + 1);
  sessions.sweep();
  assert.equal(sessions.sessions.size, 0, 'a session silent for a day is forgotten');
});

test('summary: first real line, plain, capped', () => {
  assert.equal(summary('```js\ncode\n```'), 'code');
  assert.equal(summary('## Done\nrest'), 'Done');
  assert.equal(summary(''), '');
  assert.equal(summary('x'.repeat(200)).length, 140);
});

test('hooks go in once, leave other hooks alone, and come out cleanly', () => {
  const other = { type: 'command', command: 'afplay done.wav' };
  const config = { model: 'opus', hooks: { Stop: [{ matcher: '', hooks: [other] }] } };
  const on = withHooks(config, true);
  assert.ok(hooksInstalled(on));
  assert.deepEqual(withHooks(on, true), on, 'installing twice changes nothing');
  assert.equal(on.hooks.Stop.length, 2);
  assert.equal(on.hooks.Stop[1].hooks[0].command, HOOK_COMMAND);
  assert.equal(on.hooks.PreToolUse[0].matcher, 'AskUserQuestion|ExitPlanMode', 'only the tools that ask');
  assert.equal(on.hooks.Stop[1].matcher, '');
  assert.deepEqual(withHooks(on, false), config);
  assert.deepEqual(withHooks({}, false), {});
  assert.equal(Object.keys(on.hooks).length, HOOK_EVENTS.length);
});

test('hooks from an older version are replaced; a hook sharing their group survives', () => {
  const old = { type: 'command', command: "curl -H 'x-deskling: 1' --data-binary @- http://127.0.0.1:1234/claude-code" };
  const mine = { type: 'command', command: 'say hi' };
  const config = { hooks: { Stop: [{ matcher: '', hooks: [old, mine] }], PreToolUse: [{ matcher: '', hooks: [old] }] } };
  assert.equal(hooksInstalled(config), false);
  const on = withHooks(config, true);
  assert.ok(hooksInstalled(on));
  assert.deepEqual(on.hooks.Stop[0], { matcher: '', hooks: [mine] });
  assert.equal(on.hooks.PreToolUse.length, 1, 'the old PreToolUse group is gone');
  assert.deepEqual(withHooks(config, false), { hooks: { Stop: [{ matcher: '', hooks: [mine] }] } });
});

test('setHooks edits the file in place, backs it up, and refuses broken JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskling-cc-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ theme: 'auto' }), { mode: 0o600 });
  setHooks(true, file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'a private file stays private');
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.theme, 'auto');
  assert.ok(hooksInstalled(written));
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.deskling-backup`, 'utf8')), { theme: 'auto' });
  // The user adds a hook after Deskling's: launching again leaves the file be.
  const edited = JSON.parse(fs.readFileSync(file, 'utf8'));
  edited.hooks.Stop.push({ matcher: '', hooks: [{ type: 'command', command: 'afplay done.wav' }] });
  fs.writeFileSync(file, JSON.stringify(edited));
  const before = fs.readFileSync(file, 'utf8');
  setHooks(true, file);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'up to date: not rewritten');
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.deskling-backup`, 'utf8')), { theme: 'auto' }, 'and the backup kept');
  setHooks(false, file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).hooks, { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'afplay done.wav' }] }] });
  fs.writeFileSync(file, JSON.stringify({ theme: 'auto' }));
  fs.writeFileSync(file, '{ // comment');
  assert.throws(() => setHooks(true, file), /isn’t valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ // comment');
  fs.rmSync(dir, { recursive: true });
});

test('a symlinked settings.json (dotfiles) stays a symlink', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskling-cc-'));
  const real = path.join(dir, 'dotfiles-settings.json');
  const link = path.join(dir, 'settings.json');
  fs.writeFileSync(real, '{"theme":"auto"}');
  fs.symlinkSync(real, link);
  setHooks(true, link);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.ok(hooksInstalled(JSON.parse(fs.readFileSync(real, 'utf8'))));
  setHooks(false, link);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.deepEqual(JSON.parse(fs.readFileSync(real, 'utf8')), { theme: 'auto' });
  fs.rmSync(dir, { recursive: true });
});

test('the server takes hook posts, and nothing without the header', async () => {
  const events = [];
  const port = 47900 + Math.floor(Math.random() * 90);
  const server = await listen((e) => events.push(e), port);
  const post = (headers) => fetch(`http://127.0.0.1:${port}/claude-code`, { method: 'POST', headers, body: '{"session_id":"s"}' });
  assert.equal((await post({ 'x-deskling': '1', 'x-terminal': 'com.mitchellh.ghostty' })).status, 204);
  assert.equal((await post({ 'x-deskling': '1', 'x-terminal': '-a Calculator' })).status, 204);
  assert.equal((await post({})).status, 404);
  assert.deepEqual(events, [{ session_id: 's', terminal: 'com.mitchellh.ghostty' }, { session_id: 's', terminal: undefined }], 'only a bundle id passes');
  await assert.rejects(listen(() => {}, port), /EADDRINUSE/);
  server.close();
});
