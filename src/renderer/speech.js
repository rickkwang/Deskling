// "Speech" setting: reads replies aloud with the system voices (Web Speech API).
// speak() resolves when the utterance finishes or is cancelled, so the caller
// can hold the character in its speaking state for as long as it talks.

const synth = window.speechSynthesis;
// Chromium drops `end` events for utterances that get garbage-collected, so
// keep the active one referenced; the watchdog covers voices that never report.
let current = null;

function voices() {
  const list = synth.getVoices();
  if (list.length) return Promise.resolve(list);
  return new Promise((resolve) => {
    synth.addEventListener('voiceschanged', () => resolve(synth.getVoices()), { once: true });
    setTimeout(() => resolve(synth.getVoices()), 1000);
  });
}

function languageOf(text) {
  if (/[぀-ヿ]/.test(text)) return 'ja';
  if (/[一-鿿]/.test(text)) return 'zh';
  if (/[가-힯]/.test(text)) return 'ko';
  return 'en';
}

export async function speak(text) {
  cancelSpeech();
  const lang = languageOf(text);
  const all = await voices();
  const matches = all.filter((v) => v.lang.toLowerCase().startsWith(lang));
  const voice = matches.find((v) => v.localService && v.default) || matches.find((v) => v.localService) || matches[0];
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    current = u;
    if (voice) u.voice = voice;
    u.lang = voice?.lang || lang;
    u.rate = 1.05;
    const watchdog = setTimeout(() => finish('timeout'), 4000 + text.length * 150);
    function finish(result) {
      clearTimeout(watchdog);
      if (current === u) current = null;
      resolve(result);
    }
    u.onend = () => finish('done');
    u.onerror = (e) => finish(e.error === 'interrupted' || e.error === 'canceled' ? 'cancelled' : 'error');
    synth.speak(u);
  });
}

export function cancelSpeech() {
  if (synth.speaking || synth.pending) synth.cancel();
}
