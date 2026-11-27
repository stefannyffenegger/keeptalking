// Plays a recording when the pack has one, otherwise uses the device's own text-to-speech voice.
const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
let voices = [];
const loadVoices = () => { voices = synth?.getVoices() ?? []; };
loadVoices();
synth?.addEventListener?.('voiceschanged', loadVoices);

const voiceFor = (lang) => {
  const base = lang.split('-')[0].toLowerCase();
  return voices.find((v) => v.lang.toLowerCase() === lang.toLowerCase()) ?? voices.find((v) => v.lang.toLowerCase().split(/[-_]/)[0] === base);
};

export const canSpeak = (lang) => Boolean(synth && lang && voiceFor(lang));

export function speak(text, lang, { audio, rate = 0.8 } = {}) {
  if (audio) {
    new Audio(audio).play().catch(() => speak(text, lang, { rate }));
    return true;
  }
  const voice = canSpeak(lang) && voiceFor(lang);
  if (!voice || !text) return false;
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.voice = voice;
  utterance.lang = voice.lang;
  utterance.rate = rate;
  synth.speak(utterance);
  return true;
}

// Voices often load after the page, so callers can re-render once they arrive.
export const onVoicesReady = (callback) => synth?.addEventListener?.('voiceschanged', callback, { once: true });
