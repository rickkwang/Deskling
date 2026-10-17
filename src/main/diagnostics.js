// "Report a Problem…": the facts about this Deskling that go on the clipboard
// for a GitHub issue. The loop is deliberate, not automatic: the user pastes
// (and can edit) what the clipboard holds, so nothing is ever sent on its own.
//
// A report carries no paths, no conversation text and no file names — only
// machine-level facts the app already knows. Paths could still sneak in inside
// an error message or a log line, so they are scrubbed out at this last step.

export const NEW_BUG_URL = 'https://github.com/rickkwang/Deskling/issues/new?template=bug_report.yml';

// Anything this Mac calls home is replaced: given paths, and the real ones
// behind a symlink or a `/private` prefix, longest first so the data folder's
// path cannot reappear inside its parent's.
export function scrub(text, paths = []) {
  let out = String(text ?? '');
  const known = [...new Set(paths.flat().filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const p of known) out = out.split(p).join('~');
  return out;
}

const JOIN = ' · ';

// The Chat line as the probe actually sees it (`ai` is an Assistant info
// object). The probe never waits on or starts Ollama (a ~2.5s reachable check
// at most), so a report taken while it is still starting reads "unreachable" —
// a snapshot the next look in Settings corrects. Main keeps no copy of this
// mapping, so wording drift is seen by the tests.
export function chatFacts(ollamaOn = true, ai = {}) {
  if (!ollamaOn) return { chat: 'off', ollama: null, ollamaError: null };
  if (!ai.available) return { chat: 'on', ollama: 'Ollama unreachable', ollamaError: ai.error || null };
  if (!ai.model) return { chat: 'on', ollama: 'no local model installed', ollamaError: null };
  return { chat: `on · ${ai.model}`, ollama: null, ollamaError: null };
}

// `facts` (all optional; empty ones leave no trace), each plain and local:
// versions of the app and its engine, the machine, settings as the user has
// them, whether Chat's Ollama answers right now, whether Claude Code's hooks
// are installed, and the last lines of the pet's own log. `paths` is the list
// scrub() is fed on every line that ends up here.
export function buildReport(facts = {}) {
  const { paths = [], logTail = '' } = facts;
  const safe = (text) => scrub(text, paths);

  const app = [];
  if (facts.version) app.push(`Deskling ${facts.version}`);
  if (facts.now) app.push(String(facts.now.toISOString?.() ?? facts.now).slice(0, 10));
  if (facts.electron) app.push(`Electron ${facts.electron}`);
  if (facts.mac) app.push(`macOS ${facts.mac}`);
  if (facts.arch) app.push(facts.arch);
  if (facts.locale) app.push(facts.locale);

  const pet = [];
  if (facts.character) pet.push(facts.character);
  if (facts.balloon) pet.push(`${facts.balloon} balloon`);
  if (facts.scale) pet.push(`size ${facts.scale}%`);
  if (facts.showPet != null) pet.push(facts.showPet ? 'shown' : 'Show Pet off');

  const chat = facts.chat ? [facts.chat] : [];
  if (facts.ollama) chat.push(facts.ollama);
  if (facts.ollamaError) chat.push(`(${facts.ollamaError})`);

  const lines = [safe(app.join(JOIN))];
  if (pet.length) lines.push(safe(`Pet: ${pet.join(JOIN)}`));
  lines.push(safe(`Chat: ${chat.join(JOIN) || 'off'}`));
  if (facts.claudeHooks || facts.claudeError) { // hooks off still belongs in a Claude Code bug
    lines.push(safe(`Claude Code hooks: ${facts.claudeHooks ? 'on' : 'off'}${facts.claudeError ? ` (${safe(facts.claudeError)})` : ''}`));
  }

  if (logTail) {
    lines.push(
      '',
      safe(logTail),
      '',
      'No settings, names, files or anything typed are in this report. Please read it before sending.',
    );
  }
  return `${lines.join('\n')}`;
}
