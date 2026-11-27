import { buildChatTutorPrompt, buildUpdatePrompt, parseContentUpdate, withUpdates } from './content.js';
import { catchUpState, gradeAnswer, isCorrectOrder, lineText, newProfile, parseCustomWord, planSession, schedule, streak, updateProfile, withCustomWords } from './engine.js';
import { speak } from './speech.js';
import { api, getToken, setToken, Store } from './store.js';

const app = document.getElementById('app');
const SCENARIOS = ['Ordering food at a street stall', 'Small talk with a neighbor', 'Taking a taxi', 'Shopping at a market', 'Talking about your day', 'Making plans with a friend'];
let pack, store, syncNote = '';
let packs = [], tutorAvailable = false, generateAvailable = false;
let chat = null;

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (value === true) el.setAttribute(key, '');
    else if (value !== false && value != null) el.setAttribute(key, value);
  }
  el.append(...children.flat().filter((c) => c != null));
  return el;
}

const show = (...nodes) => { app.replaceChildren(...nodes.flat().filter((node) => node != null)); window.scrollTo(0, 0); };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const profile = () => store.get('profile', newProfile());
const voiceId = () => store.get('voice', null);
const levelOf = () => Math.min(3, Math.floor(profile().skill));
// Only the whole level changes what you practice; the fraction is progress toward the next one.
function levelCard({ skill, accuracy, answers }) {
  const level = Math.min(3, Math.floor(skill));
  const top = level >= 3;
  const progress = Math.round((skill - level) * 100);
  const fill = (step) => (step < level || top ? 100 : step === level ? progress : 0);
  const right = Math.round(accuracy * 100);
  const status = top
    ? 'Top level: all sentences and conversations are open. New exercises keep stretching you from here.'
    : `${progress}% of the way to level ${level + 1}.`;
  const recent = answers < 8
    ? 'Answer a few more and it starts adjusting.'
    : `Lately you get about ${right}% right. ${right >= 90 ? (top ? 'You’re steady here.' : 'That moves you up.') : right < 72 ? 'That moves you down a little, to make practice easier.' : 'That keeps you where you are.'}`;
  return h('div', { class: 'card level' },
    h('div', { class: 'level-head' }, h('b', {}, `Level ${level} of 3`), h('span', { class: 'muted' }, status)),
    h('div', { class: 'level-bar', role: 'img', 'aria-label': top ? 'Level 3 of 3, top level' : `Level ${level} of 3, ${progress}% to level ${level + 1}` },
      ...[1, 2, 3].map((step) => {
        const bar = h('i');
        bar.style.width = `${fill(step)}%`; // set via CSSOM: the CSP forbids inline style attributes
        return h('span', {}, bar);
      })),
    h('div', { class: 'level-steps muted', 'aria-hidden': 'true' }, h('span', {}, '1 Short phrases'), h('span', {}, '2 Everyday sentences'), h('span', {}, '3 Natural speech')),
    h('p', { class: 'muted' }, recent),
    h('details', {},
      h('summary', {}, 'How levels work'),
      h('p', { class: 'muted' }, 'Your level follows how you do. Get about 9 in 10 right and it rises; drop below about 7 in 10 and it eases off, so practice stays challenging but doable.'),
      h('p', { class: 'muted' }, 'Each level opens longer sentences and conversations, and adds extra wrong words to the word tiles. Words you already have stay in your reviews.'),
      h('p', { class: 'muted' }, 'Level 3 is the top. From there, Get new exercises asks for material a step harder, based on the words you know.')));
}
const cards = () => store.byPrefix('card:');
const lettersOn = () => Boolean(pack.letters?.length) && store.get('letters', false) === true;
// The course as practiced: the shipped pack, plus the learner's own words and any imported exercises.
const activePack = () => {
  const merged = withUpdates(withCustomWords(pack, store.byPrefix('custom:')), store.byPrefix('update:'));
  return lettersOn() ? merged : { ...merged, letters: [] };
};
const savedLang = () => { try { return localStorage.getItem('dm:lang'); } catch { return null; } };
const native = (tag, props, ...children) => h(tag, { lang: pack.code, dir: pack.dir ?? 'auto', ...props, class: `native ${props?.class ?? ''}`.trim() }, ...children);

// A small play button. Uses a recording when the pack has one, otherwise the device's voice.
function listen(text, { audio, label = 'Listen' } = {}) {
  if (!text && !audio) return null;
  if (!audio && !('speechSynthesis' in window)) return null;
  const button = h('button', { class: 'quiet listen', type: 'button', 'aria-label': `${label}: ${text}`, onclick: () => {
    if (!speak(text, pack.speech ?? pack.code, { audio })) button.textContent = `No ${pack.name} voice on this device`;
  } }, `🔊 ${label}`);
  return button;
}

function setNav(view, focus = false) {
  document.body.classList.toggle('focus', focus);
  document.querySelectorAll('#nav button').forEach((b) => {
    if (b.dataset.view === view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
}

async function syncNow() {
  const result = await store.sync();
  syncNote = result.ok ? `Synced ${new Date(result.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : result.reason;
  return result;
}

function languagePicker() {
  setNav('home', true);
  show(h('h1', {}, 'What are you learning?'),
    h('div', { class: 'options' }, packs.map((p) => h('button', { onclick: () => switchLanguage(p.code) }, h('span', { lang: p.code }, p.nativeName), ` · ${p.name}`))),
    h('p', { class: 'muted' }, 'Each language keeps its own progress. You can switch in Settings.'));
}

function onboarding() {
  setNav('home', true);
  if (!voiceId()) {
    return show(
      h('h1', {}, 'Welcome'),
      h('p', {}, pack.voicePrompt ?? 'Choose how you want to speak.'),
      ...Object.entries(pack.voices).map(([id, voice]) =>
        h('div', { class: 'options' }, h('button', { class: 'native', lang: pack.code, dir: 'auto', onclick: () => { store.set('voice', id); home(); } }, voice.label))),
      h('p', { class: 'muted' }, 'You can change this any time in Settings.'),
    );
  }
  const choose = (on) => { store.set('letters', on); home(); };
  show(
    h('h1', {}, `Can you read ${pack.script ?? pack.name} yet?`),
    h('p', {}, 'If not, your first sessions teach the letters and their sounds before any words.'),
    h('div', { class: 'options' },
      h('button', { onclick: () => choose(true) }, 'Not yet, start with the letters'),
      h('button', { onclick: () => choose(false) }, 'Yes, go straight to words')),
    h('p', { class: 'muted' }, 'You can change this any time in Settings.'),
  );
}

function home() {
  const fresh = !Object.keys(cards()).length;
  if (!voiceId() || (pack.letters?.length && fresh && store.get('letters', null) === null)) return onboarding();
  setNav('home');
  const all = cards();
  const now = Date.now();
  const learned = Object.values(all).filter((c) => c.reps >= 2).length;
  const days = store.byPrefix('day:');
  const done = days[today()];
  const catchUp = catchUpState(activePack(), all, days, today(), now);
  const title = catchUp.active ? (done ? 'Nice, you’re getting back into it' : 'Welcome back') : done ? 'Nice work today' : 'Today’s practice';
  const intro = catchUp.active
    ? 'A short, easy round first. The rest can wait, and one round is enough for today.'
    : done ? 'You can stop here, or do another round.' : `About five minutes of everyday ${pack.name}.`;
  show(
    h('h1', {}, title),
    h('p', { class: 'muted' }, intro),
    h('div', { class: 'stats' },
      catchUp.active
        ? h('div', { class: 'stat' }, h('b', {}, String(Object.keys(days).length)), h('span', {}, 'days practiced'))
        : h('div', { class: 'stat' }, h('b', {}, String(streak(days, today()))), h('span', {}, 'day streak')),
      h('div', { class: 'stat' }, h('b', {}, String(catchUp.due)), h('span', {}, catchUp.active ? 'to refresh' : 'due now')),
      h('div', { class: 'stat' }, h('b', {}, String(learned)), h('span', {}, 'remembered'))),
    h('button', { class: 'primary', onclick: () => startSession(catchUp.active) }, catchUp.active ? 'Start easy round' : done ? 'Practice again' : 'Start'),
    h('button', { class: 'quiet', onclick: () => wordsView('', true) }, 'Get new exercises'),
    levelCard(profile()),
    syncNote ? h('p', { class: 'muted' }, syncNote) : null,
  );
}

function startSession(catchUp = false) {
  const queue = planSession(activePack(), cards(), profile(), voiceId(), Date.now(), Math.random, { catchUp });
  runSession({ queue, index: 0, correct: 0, total: 0 });
}

function wordsView(message = '', jumpToUpdates = false) {
  setNav('words');
  const field = (id, label, attrs = {}) => [h('label', { for: id }, label), h('input', { id, autocomplete: 'off', ...attrs })];
  const status = h('p', { class: 'muted', role: 'status' }, message);
  const form = h('form', { onsubmit: (event) => {
    event.preventDefault();
    const value = (id) => form.querySelector(`#${id}`).value;
    const { entry, error } = parseCustomWord({ word: value('new-word'), meaning: value('new-meaning'), example: value('new-example'), exampleEn: value('new-example-en') }, pack.joiner);
    if (error) { status.textContent = error; return; }
    if (activePack().words.some(([word]) => word === entry.word)) { status.textContent = 'That word is already in your course.'; return; }
    store.set(`custom:${entry.word}`, { ...entry, addedAt: Date.now() });
    store.sync();
    wordsView(`Added ${entry.word}. It will appear in your next session.`);
  } },
  field('new-word', 'Word or phrase', { class: 'native', lang: pack.code, dir: pack.dir ?? 'auto', maxlength: 40, required: true }),
  field('new-meaning', 'Meaning', { maxlength: 80, required: true }),
  field('new-example', 'Example sentence (optional)', { class: 'native', lang: pack.code, dir: pack.dir ?? 'auto', maxlength: 120, placeholder: pack.examplePlaceholder ?? '' }),
  h('p', { class: 'muted' }, 'Put spaces between the words, so it can become a tile exercise.'),
  field('new-example-en', 'Example translation', { maxlength: 120 }),
  h('p'),
  h('button', { class: 'primary', type: 'submit' }, 'Add word'));

  const saved = Object.entries(store.byPrefix('custom:')).filter(([, c]) => !c.deleted).sort((a, b) => (b[1].addedAt ?? 0) - (a[1].addedAt ?? 0));
  const updates = updatesSection();
  show(h('h1', {}, 'My words'), h('p', { class: 'muted' }, 'Heard something today? Save it and it joins your reviews.'), form, status,
    h('h2', {}, `Saved (${saved.length})`),
    saved.length ? saved.map(([key, c]) => h('div', { class: 'word-row' },
      h('div', {}, native('div', {}, c.word), h('div', { class: 'muted' }, c.meaning)),
      h('button', { class: 'quiet', 'aria-label': `Remove ${c.word}`, onclick: () => {
        store.set(`custom:${key}`, { deleted: true, word: c.word });
        store.sync();
        wordsView(`Removed ${c.word}.`);
      } }, 'Remove'))) : h('p', { class: 'muted' }, 'No words saved yet.'), updates);
  if (jumpToUpdates) updates.scrollIntoView();
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const counted = (u) => [plural(u.words.length, 'word'), plural(u.sentences.length, 'sentence'), plural(u.dialogues.length, 'conversation')].join(', ');

async function copyText(text, fallbackField) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* needs HTTPS; fall back to selecting */ }
  fallbackField.hidden = false;
  fallbackField.value = text;
  fallbackField.select();
  try { return document.execCommand('copy'); } catch { return false; }
}

// New exercises from an LLM: copy a prompt into any chat app and paste the reply back, or use the server's API key.
function updatesSection() {
  const status = h('p', { class: 'muted', role: 'status' });
  const promptField = h('textarea', { rows: 6, readonly: true, hidden: true, 'aria-label': 'Prompt to copy' });
  const reply = h('textarea', { id: 'llm-reply', rows: 6, placeholder: 'Paste the whole reply here' });
  const prompt = () => buildUpdatePrompt(activePack(), cards(), profile(), voiceId());
  const apply = (text) => {
    const { update, warnings = [], error } = parseContentUpdate(text, activePack());
    if (error) { status.replaceChildren(error, ...warnings.map((w) => h('div', {}, w))); return; }
    store.set(`update:${update.id}`, update);
    store.sync();
    const summary = `Added ${counted(update)}. They join your next sessions.`;
    wordsView(warnings.length ? `${summary} ${warnings.join(' ')}` : summary, true);
  };
  const generate = h('button', { hidden: !generateAvailable, onclick: async () => {
    generate.disabled = true;
    status.textContent = 'Writing exercises… this can take a minute.';
    try {
      const res = await api('/api/generate', { method: 'POST', body: JSON.stringify({ lang: pack.code, prompt: prompt() }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      apply(body.text);
    } catch (error) { status.textContent = error.message || 'Could not reach the server.'; }
    generate.disabled = false;
  } }, 'Generate with API (uses credit)');

  const imported = Object.entries(store.byPrefix('update:')).filter(([, u]) => !u.deleted).sort((a, b) => b[1].addedAt - a[1].addedAt);
  return h('section', { id: 'updates' },
    h('h2', {}, 'New exercises'),
    h('p', { class: 'muted' }, 'Free with any AI chat app: copy a prompt with your progress, paste it into the chat, then paste the reply back here.'),
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: async () => {
      status.textContent = (await copyText(prompt(), promptField)) ? 'Prompt copied. Paste it into your chat app.' : 'Select the prompt below and copy it.';
    } }, '1. Copy prompt')),
    promptField,
    h('label', { for: 'llm-reply' }, '2. Paste the reply'), reply,
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => apply(reply.value) }, 'Add exercises'), generate),
    status,
    imported.length ? h('h3', {}, `Imported (${imported.length})`) : null,
    imported.map(([id, u]) => h('div', { class: 'word-row' },
      h('div', {}, h('div', {}, new Date(u.addedAt).toLocaleDateString()), h('div', { class: 'muted' }, counted(u))),
      h('button', { class: 'quiet', onclick: () => {
        store.set(`update:${id}`, { deleted: true, addedAt: u.addedAt });
        store.sync();
        wordsView('Removed those exercises.', true);
      } }, 'Remove'))));
}

const urlKey = (base64) => Uint8Array.from(atob(base64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64.length % 4)) % 4)), (c) => c.charCodeAt(0));

async function currentPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return null;
  const registration = await navigator.serviceWorker.ready;
  return { registration, subscription: await registration.pushManager.getSubscription() };
}

async function saveReminder(time) {
  const push = await currentPush();
  if (!push) throw new Error('This browser can’t show reminders here. It needs HTTPS, and on iPhone the app must be on the Home Screen.');
  if (!getToken()) throw new Error('Add your access token first.');
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are blocked for this app in your browser settings.');
  const keyRes = await api('/api/push/key');
  if (!keyRes.ok) throw new Error('The server rejected the access token.');
  const { publicKey } = await keyRes.json();
  const subscription = push.subscription ?? await push.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlKey(publicKey) });
  const res = await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: subscription.toJSON(), time, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, lang: pack.code }) });
  if (!res.ok) throw new Error('The server could not save the reminder.');
}

async function clearReminder() {
  const push = await currentPush();
  if (!push?.subscription) return;
  await api('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: push.subscription.endpoint }) });
  await push.subscription.unsubscribe();
}

function reminderControls() {
  const storedTime = () => { try { return localStorage.getItem('dm:reminder'); } catch { return null; } };
  const remember = (value) => { try { value ? localStorage.setItem('dm:reminder', value) : localStorage.removeItem('dm:reminder'); } catch { /* storage unavailable */ } };
  const time = h('input', { id: 'reminder-time', type: 'time', value: storedTime() ?? '19:00' });
  const status = h('p', { class: 'muted', role: 'status' }, storedTime() ? `On at ${storedTime()}. Skipped on days you’ve practiced.` : 'Off');
  const off = h('button', { hidden: !storedTime(), onclick: async () => {
    try { await clearReminder(); remember(null); off.hidden = true; status.textContent = 'Off'; }
    catch { status.textContent = 'Could not turn the reminder off. Try again when online.'; }
  } }, 'Turn off');
  const on = h('button', { class: 'primary', onclick: async () => {
    status.textContent = 'Saving…';
    try { await saveReminder(time.value); remember(time.value); off.hidden = false; status.textContent = `On at ${time.value}. Skipped on days you’ve practiced.`; }
    catch (error) { status.textContent = error.message; }
  } }, 'Save reminder');
  return [h('h2', {}, 'Daily reminder'), h('label', { for: 'reminder-time' }, 'Remind me at'), time, h('div', { class: 'row' }, on, off), status];
}

function record(session, exercise, result) {
  if (!exercise.retry) {
    const key = `card:${exercise.key}`;
    const grade = gradeAnswer(exercise, result);
    if (!exercise.practice || grade === 0) store.set(key, schedule(store.get(key), grade, Date.now()));
    store.set('profile', updateProfile(profile(), result.correct));
    session.total++;
    if (result.correct) session.correct++;
  }
  if (!result.correct && !exercise.retry) session.queue.push({ ...exercise, retry: true });
}

function frame(session, ...body) {
  setNav('home', true);
  show(
    h('progress', { max: session.queue.length, value: session.index, 'aria-label': 'Session progress' }),
    ...body,
    h('button', { class: 'quiet', onclick: () => { syncNow(); home(); } }, 'End session'),
  );
}

function runSession(session) {
  const exercise = session.queue[session.index];
  if (!exercise) return finish(session);
  const next = () => { session.index++; runSession(session); };
  const render = { word: wordView, sentence: sentenceView, dialogue: dialogueView, letter: letterView }[exercise.type];
  render(session, exercise, next);
}

function nextButton(next) {
  const button = h('button', { class: 'primary', onclick: next }, 'Continue');
  queueMicrotask(() => button.focus());
  return button;
}

function letterInfo(letter) {
  return h('div', { class: 'letter-info' },
    h('p', {}, native('span', { class: 'big' }, letter.char), ` ${letter.name} · `, h('b', {}, letter.sound)),
    h('p', {}, 'As in ', native('span', {}, letter.word), ` (${letter.wordPron}) – ${letter.wordEn}`),
    letter.note ? h('p', { class: 'muted' }, letter.note) : null,
    h('div', { class: 'row' }, listen(letter.say, { audio: letter.audio, label: 'Name' }), listen(letter.word, { audio: letter.wordAudio, label: 'Word' })));
}

function letterView(session, ex, next) {
  const started = performance.now();
  const after = h('div');
  const produce = ex.mode === 'produce';
  const buttons = ex.options.map((option) => (produce ? native : h)('button', { class: `choice${produce ? ' big' : ''}`, onclick: (e) => {
    const correct = option === ex.answer;
    buttons.forEach((b) => { b.disabled = true; if (b.textContent === ex.answer) b.classList.add('right'); });
    if (!correct) e.currentTarget.classList.add('wrong');
    record(session, ex, { correct, usedHint: false, ms: performance.now() - started });
    after.replaceChildren(letterInfo(ex.letter), h('div', { class: 'row' }, nextButton(next)));
  } }, option));
  frame(session, h('div', { class: 'card' },
    h('p', { class: 'muted' }, produce ? 'Which letter makes this sound?' : 'What sound does this letter make?'),
    produce ? h('p', { class: 'big' }, `“${ex.prompt}”`, h('span', { class: 'muted' }, ` as in ${ex.hint}`)) : native('p', { class: 'huge' }, ex.prompt),
    h('div', { class: produce ? 'options letters' : 'options' }, buttons), after));
}

function wordView(session, ex, next) {
  const started = performance.now();
  const after = h('div');
  const buttons = ex.options.map((option) => (ex.mode === 'produce' ? native : h)('button', { class: 'choice', onclick: (e) => {
    const correct = option === ex.answer;
    buttons.forEach((b) => { b.disabled = true; if (b.textContent === ex.answer) b.classList.add('right'); });
    if (!correct) e.currentTarget.classList.add('wrong');
    record(session, ex, { correct, usedHint: false, ms: performance.now() - started });
    after.replaceChildren(
      h('p', { class: 'muted' }, native('span', {}, ex.th), ex.pron ? ` (${ex.pron})` : '', ` = ${ex.en}`, listen(ex.th)),
      h('div', { class: 'row' }, nextButton(next)));
  } }, option));
  frame(session, h('div', { class: 'card' },
    h('p', { class: 'muted' }, ex.mode === 'produce' ? 'Fill the gap' : 'What does this mean?'),
    native('p', { class: 'big' }, ex.prompt),
    ex.hint ? (ex.mode === 'produce' ? h('p', { class: 'muted' }, ex.hint) : native('p', { class: 'muted' }, ex.hint)) : null,
    h('div', { class: 'options' }, buttons), after));
}

function sentenceView(session, ex, next) {
  const started = performance.now();
  const pool = ex.tiles.map((text, id) => ({ text, id }));
  let chosen = [], usedHint = false, checked = false;
  const answerEl = h('div', { class: 'answer tiles', dir: pack.dir ?? 'auto', 'aria-label': 'Your sentence' });
  const poolEl = h('div', { class: 'tiles', dir: pack.dir ?? 'auto' });
  const actions = h('div');

  const paint = () => {
    answerEl.replaceChildren(...chosen.map((tile) => h('button', { lang: pack.code, disabled: checked, onclick: () => { chosen = chosen.filter((t) => t !== tile); paint(); } }, tile.text)));
    poolEl.replaceChildren(...pool.filter((t) => !chosen.includes(t)).map((tile) => h('button', { lang: pack.code, disabled: checked, onclick: () => { chosen.push(tile); paint(); } }, tile.text)));
    if (checked) return;
    actions.replaceChildren(h('div', { class: 'row' },
      h('button', { onclick: hint }, 'Hint'),
      h('button', { class: 'primary', disabled: chosen.length === 0, onclick: check }, 'Check')));
  };
  const hint = () => {
    usedHint = true;
    const prefix = chosen.findIndex((tile, i) => tile.text !== ex.answer[i]);
    chosen = prefix === -1 ? chosen : chosen.slice(0, prefix);
    if (chosen.length >= ex.answer.length) return paint();
    const tile = pool.find((t) => t.text === ex.answer[chosen.length] && !chosen.includes(t));
    if (tile) chosen.push(tile);
    paint();
  };
  const check = () => {
    const correct = isCorrectOrder(ex, chosen.map((t) => t.text));
    checked = true;
    record(session, ex, { correct, usedHint, ms: performance.now() - started });
    paint();
    actions.replaceChildren(
      h('div', { class: `feedback ${correct ? 'right' : 'wrong'}` }, correct ? 'Correct' : ['Correct answer: ', native('span', {}, ex.answer.join(ex.joiner))], listen(ex.answer.join(ex.joiner))),
      h('div', { class: 'row' }, nextButton(next)));
  };
  paint();
  frame(session, h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Build this sentence'), h('p', { class: 'big' }, ex.en), answerEl, poolEl, actions));
}

function dialogueView(session, ex, next) {
  const started = performance.now();
  const log = h('div');
  const prompt = h('div');
  let lineIndex = 0, mistakes = 0;
  const advance = () => {
    while (ex.lines[lineIndex]?.who === 'them') {
      const line = ex.lines[lineIndex++];
      log.append(h('div', { class: 'bubble' }, native('span', {}, lineText(line)), h('small', {}, line.en), listen(lineText(line))));
    }
    const line = ex.lines[lineIndex];
    if (!line) {
      record(session, ex, { correct: mistakes === 0, usedHint: mistakes === 1, ms: 60000 });
      prompt.replaceChildren(h('div', { class: 'row' }, nextButton(next)));
      return;
    }
    const buttons = line.options.map((option) => native('button', { onclick: (e) => {
      if (option !== line.ok) { mistakes++; e.currentTarget.classList.add('wrong'); e.currentTarget.disabled = true; return; }
      log.append(h('div', { class: 'bubble me' }, native('span', {}, line.ok), h('small', {}, line.en)));
      lineIndex++;
      advance();
    } }, option));
    prompt.replaceChildren(h('p', { class: 'muted' }, `Say: ${line.en}`), h('div', { class: 'options' }, buttons));
  };
  frame(session, h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Conversation'), h('h1', {}, ex.title), log, prompt));
  advance();
}

async function finish(session) {
  store.set(`day:${today()}`, (store.get(`day:${today()}`, 0)) + 1);
  setNav('home');
  show(
    h('h1', {}, 'Session complete'),
    h('p', {}, `${session.correct} of ${session.total} right the first time.`),
    h('p', { class: 'muted' }, 'Anything you missed will come back soon.'),
    h('button', { class: 'primary', onclick: home }, 'Done'),
  );
  await syncNow();
}

function tutorView() {
  setNav('tutor');
  if (!chat || !tutorAvailable) {
    const select = h('select', { id: 'scenario' }, SCENARIOS.map((s) => h('option', {}, s)));
    const status = h('p', { class: 'muted', role: 'status' });
    const promptField = h('textarea', { rows: 6, readonly: true, hidden: true, 'aria-label': 'Prompt to copy' });
    const copy = h('button', { class: tutorAvailable ? '' : 'primary', onclick: async () => {
      const text = buildChatTutorPrompt({ language: pack.name, scenario: select.value, level: levelOf(), voice: pack.voices[voiceId()].label });
      status.textContent = (await copyText(text, promptField)) ? 'Copied. Paste it into ChatGPT, Claude, Gemini or another chat app and reply there.' : 'Select the prompt below and copy it.';
    } }, 'Copy prompt for a chat app (free)');
    const start = tutorAvailable
      ? h('button', { class: 'primary', onclick: () => { chat = { scenario: select.value, messages: [], view: [] }; tutorView(); sendTutor(); } }, 'Start here (uses API credit)')
      : null;
    return show(h('h1', {}, 'Conversation tutor'),
      h('p', { class: 'muted' }, 'Free conversation with gentle corrections. Use any AI chat app for free, or the built-in tutor when the server has an API key.'),
      h('label', { for: 'scenario' }, 'Situation'), select,
      h('div', { class: 'row' }, start, copy), promptField, status,
      tutorAvailable ? null : h('p', { class: 'muted' }, getToken() ? 'The built-in tutor is off. Set ANTHROPIC_API_KEY on the server to turn it on.' : 'For the built-in tutor, add your access token in Settings.'));
  }
  const input = native('textarea', { rows: 2, id: 'reply', maxlength: 500, 'aria-label': 'Your reply' });
  const log = h('div', { id: 'chatlog' }, chat.view.map(renderBubble));
  const send = h('button', { class: 'primary', disabled: chat.busy, onclick: () => { const text = input.value.trim(); if (text) sendTutor(text); } }, chat.busy ? 'Thinking…' : 'Send');
  show(h('h1', {}, chat.scenario), log, chat.error ? h('div', { class: 'feedback wrong' }, chat.error) : null, input, h('div', { class: 'row' }, send, h('button', { onclick: () => { chat = null; tutorView(); } }, 'New')));
}

function renderBubble(item) {
  if (item.me) return native('div', { class: 'bubble me' }, item.text);
  return h('div', {},
    item.fix ? h('div', { class: 'fix' }, native('div', {}, item.fix.corrected), h('div', { class: 'muted' }, item.fix.explanation)) : null,
    h('div', { class: 'bubble' }, native('span', {}, item.text), h('small', {}, item.translation), listen(item.text)));
}

async function sendTutor(text) {
  const current = chat;
  if (text) { current.messages.push({ role: 'user', content: text }); current.view.push({ me: true, text }); }
  current.messages = current.messages.slice(-19);
  while (current.messages[0]?.role === 'assistant') current.messages.shift();
  current.busy = true; current.error = '';
  tutorView();
  try {
    const res = await api('/api/tutor', { method: 'POST', body: JSON.stringify({ language: pack.name, scenario: current.scenario, level: levelOf(), voice: pack.voices[voiceId()].label, messages: current.messages }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    if (!current.messages.length) current.messages.push({ role: 'user', content: 'Please start the conversation.' });
    current.messages.push({ role: 'assistant', content: body.reply });
    current.view.push({ text: body.reply, translation: body.translation, fix: body.correction.needed ? body.correction : null });
  } catch (error) {
    current.error = error.message || 'Could not reach the tutor.';
    if (text) { current.messages.pop(); current.view.pop(); }
  }
  current.busy = false;
  if (chat === current && document.querySelector('#nav [aria-current]')?.dataset.view === 'tutor') tutorView();
}

function settings() {
  setNav('settings');
  const voice = h('select', { id: 'voice', class: 'native', dir: 'auto', onchange: (e) => store.set('voice', e.target.value) },
    Object.entries(pack.voices).map(([id, v]) => h('option', { value: id, selected: id === voiceId() }, v.label)));
  const token = h('input', { id: 'token', type: 'password', value: getToken(), autocomplete: 'off' });
  const status = h('p', { class: 'muted' }, syncNote);
  const language = packs.length > 1 ? [h('label', { for: 'language' }, 'Language'),
    h('select', { id: 'language', onchange: (e) => switchLanguage(e.target.value) }, packs.map((p) => h('option', { value: p.code, selected: p.code === pack.code }, `${p.name} · ${p.nativeName}`)))] : [];
  const letters = pack.letters?.length ? [h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: lettersOn(), onchange: (e) => store.set('letters', e.target.checked) }), `Practice ${pack.script ?? 'letters'} in sessions`)] : [];
  show(h('h1', {}, 'Settings'),
    ...language,
    h('label', { for: 'voice' }, 'How you speak'), voice,
    ...letters,
    h('label', { for: 'token' }, 'Access token'), token,
    h('p', { class: 'muted' }, 'Use the same token on each device to sync progress.'),
    h('button', { class: 'primary', onclick: async () => {
      setToken(token.value.trim());
      status.textContent = 'Syncing…';
      const result = await syncNow();
      await loadConfig();
      status.textContent = result.ok ? syncNote : result.reason;
    } }, 'Save and sync'), status, ...reminderControls());
}

async function loadConfig() {
  if (!getToken()) { tutorAvailable = false; return; }
  try {
    const res = await api('/api/config');
    const config = res.ok ? await res.json() : {};
    tutorAvailable = Boolean(config.tutor);
    generateAvailable = Boolean(config.generate);
  } catch { tutorAvailable = false; generateAvailable = false; }
}

// The alphabet as a reference: tap a letter to hear it and its example word.
function lettersView() {
  setNav('letters');
  const all = cards();
  const detail = h('div', { class: 'card', hidden: true });
  const pick = (letter) => { detail.hidden = false; detail.replaceChildren(letterInfo(letter)); speak(letter.say, pack.speech ?? pack.code, { audio: letter.audio }); detail.scrollIntoView({ block: 'nearest' }); };
  show(h('h1', {}, pack.script ?? 'Letters'),
    h('p', { class: 'muted' }, pack.lettersIntro ?? ''),
    lettersOn() ? null : h('p', { class: 'muted' }, 'Letters are not in your sessions. Turn them on in Settings to practice them.'),
    detail,
    h('div', { class: 'letter-grid', dir: pack.dir ?? 'auto' }, pack.letters.map((letter) => {
      const card = all[`l:${letter.id}`];
      return h('button', { class: card?.reps >= 2 ? 'known' : card ? 'seen' : '', 'aria-label': `${letter.name}, ${letter.sound}`, onclick: () => pick(letter) },
        native('span', { class: 'glyph' }, letter.char), h('small', {}, letter.sound));
    })));
}

document.querySelectorAll('#nav button').forEach((b) => b.addEventListener('click', () => ({ home, words: () => wordsView(), letters: lettersView, tutor: tutorView, settings })[b.dataset.view]()));

async function switchLanguage(code) {
  const entry = packs.find((p) => p.code === code) ?? packs[0];
  pack = await (await fetch(`/packs/${entry.code}.json`)).json();
  store = new Store(pack.code);
  chat = null;
  try { localStorage.setItem('dm:lang', pack.code); } catch { /* storage unavailable */ }
  document.documentElement.dataset.lang = pack.code;
  document.querySelector('#nav [data-view="letters"]').hidden = !pack.letters?.length;
  home();
  if (getToken()) syncNow();
}

async function boot() {
  packs = await (await fetch('/packs/index.json')).json();
  // Learners from before the language picker already have progress in one pack; keep them there.
  const hasData = (code) => { try { return localStorage.getItem(`dm:data:${code}`) !== null; } catch { return false; } };
  const chosen = packs.find((p) => p.code === savedLang()) ?? packs.find((p) => hasData(p.code));
  if (chosen || packs.length === 1) await switchLanguage((chosen ?? packs[0]).code);
  else languagePicker();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  await loadConfig();
  if (getToken() && store) { await syncNow(); if (!document.body.classList.contains('focus') && document.querySelector('#nav [aria-current]')?.dataset.view === 'home') home(); }
  window.addEventListener('online', () => store?.sync());
}

boot().catch(() => show(h('h1', {}, 'Could not load'), h('p', {}, 'Check your connection and reload the page.')));
