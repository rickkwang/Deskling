// End-to-end self test (npm run selftest): drives the real UI against the real
// local Ollama model and checks the core state flow
//   show -> idle -> click -> listening -> type -> thinking -> reply -> speaking -> idle
// then plays every one-shot action. Screenshots go to ./qa/.

const QUESTION = 'In one short sentence: what is a paperclip for?';

export async function runSelftest({ runtime, petEl, api, greeted, log, quiet }) {
  const { capture: shot, done } = window.pet.selftest;
  // Every checkpoint also asserts the character is on screen (not a blank frame).
  const vanished = [];
  const capture = async (name) => {
    if (name !== '0-greeting' && petEl.style.backgroundImage === 'none') vanished.push(name);
    return shot(name);
  };
  const states = [runtime().state];
  const rt = runtime();
  rt.addEventListener('state', (e) => states.push(e.detail.to));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (pred, ms, label) => {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
      await wait(50);
    }
  };

  try {
    await wait(900);
    await capture('0-greeting');
    await greeted;
    await wait(300);
    log(`step: startup finished, state=${rt.state}`);
    const place = async (label) => {
      const g = await window.pet.selftest.geometry();
      const off = Math.hypot(g.got.x - g.want.x, g.got.y - g.want.y);
      log(`geometry ${label}: feet want ${g.want.x},${g.want.y} got ${g.got.x},${g.got.y} window ${g.bounds.width}x${g.bounds.height}@${g.bounds.y} balloon=${g.balloon ? g.side : 'closed'} ${off <= 1 ? 'PASS' : 'FAIL'}`);
      if (off > 1) vanished.push(`geometry-${label}`);
    };
    await place('startup');
    await capture('1-idle');

    // Click the pet (pointer down/up without movement = click, not drag).
    const r = petEl.getBoundingClientRect();
    const at = { clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, screenX: 0, screenY: 0, pointerId: 1, button: 0, bubbles: true };
    petEl.dispatchEvent(new PointerEvent('pointerdown', at));
    petEl.dispatchEvent(new PointerEvent('pointerup', at));
    await until(() => rt.state === 'listening', 2000, 'listening');
    await wait(600);
    await capture('2-listening');

    const t0 = performance.now();
    api.type(QUESTION);
    await until(() => rt.state === 'thinking', 2000, 'thinking');
    await wait(400);
    await capture('3-thinking');
    await until(() => rt.state === 'speaking', 90000, 'speaking (first token)');
    log(`step: first token after ${Math.round(performance.now() - t0)} ms`);
    await capture('4-speaking');
    await until(() => rt.state === 'idle', 90000, 'idle after reply');
    log(`step: reply complete after ${Math.round(performance.now() - t0)} ms: "${api.text()}"`);
    await wait(1600);
    await capture('5-reply-idle');
    await place('reply');

    const expected = ['idle', 'listening', 'thinking', 'speaking', 'idle'];
    const ok = expected.every((s, i) => states[i] === s);
    log(`flow: ${states.join(' -> ')}  ${ok ? 'PASS' : `FAIL (expected ${expected.join(' -> ')})`}`);

    // Behavior settings: Instructions + Response Style reach the model, and with
    // Speech on the character stays in `speaking` until the voice finishes.
    window.pet.setSettings({ responseStyle: 'concise', instructions: 'Always address the user as Captain.', speech: !quiet });
    await wait(300);
    api.type('Say hi to me.');
    await until(() => rt.state === 'speaking', 90000, 'speaking (behavior)');
    const ts = performance.now();
    await until(() => rt.state === 'idle', 90000, 'idle (behavior)');
    const reply = api.text();
    const captain = /captain|船长/i.test(reply);
    log(`behavior: "${reply}" — instructions ${captain ? 'PASS' : 'FAIL'}; speaking held ${Math.round(performance.now() - ts)} ms${quiet ? "" : " with speech on"}`);
    window.pet.setSettings({ responseStyle: 'normal', instructions: '', speech: false });

    for (const action of ['confused', 'acknowledge', 'getAttention', 'explain', 'hide', 'show']) {
      const res = await rt.act(action);
      log(`action ${action}: ${res}`);
      if (action === 'confused') await capture('6-confused');
    }
    await wait(300);
    await capture('7-after-show');
    log(`visible at every checkpoint: ${vanished.length ? `FAIL (blank at ${vanished.join(', ')})` : 'PASS'}`);
    done(ok && captain && !vanished.length ? 0 : 1);
  } catch (e) {
    log(`FAIL: ${e.message}; states so far: ${states.join(' -> ')}`);
    await capture('fail');
    done(1);
  }
}
