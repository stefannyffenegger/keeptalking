import { catchUpState, gradeAnswer, isCorrectOrder, newProfile, parseCustomWord, planSession, schedule, streak, updateProfile, withCustomWords } from './engine.js';
import { api, getToken, setToken, Store } from './store.js';

const app = document.getElementById('app');
const SCENARIOS = ['Ordering food at a street stall', 'Small talk with a neighbor', 'Taking a taxi', 'Shopping at a market', 'Talking about your day', 'Making plans with a friend'];
let pack, store, syncNote = '';
let tutorAvailable = false;
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
const cards = () => store.byPrefix('card:');
const activePack = () => withCustomWords(pack, store.byPrefix('custom:'));

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

function onboarding() {
  setNav('home', true);
  show(
    h('h1', {}, 'Welcome'),
    h('p', {}, 'Thai changes with the speaker. Choose how you want to speak, so your exercises use the right words for “I” and the right polite ending.'),
    ...Object.entries(pack.voices).map(([id, voice]) =>
      h('div', { class: 'options' }, h('button', { class: 'thai', onclick: () => { store.set('voice', id); home(); } }, voice.label))),
    h('p', { class: 'muted' }, 'You can change this any time in Settings.'),
  );
}

function home() {
  if (!voiceId()) return onboarding();
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
    : done ? 'You can stop here, or do another round.' : 'About five minutes of everyday Thai.';
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
    h('p', { class: 'muted' }, ''),
    h('p', { class: 'muted' }, `Level ${profile().skill.toFixed(1)} of 3.9. It adjusts to keep practice challenging but doable.`),
    syncNote ? h('p', { class: 'muted' }, syncNote) : null,
  );
}

function startSession(catchUp = false) {
  const queue = planSession(activePack(), cards(), profile(), voiceId(), Date.now(), Math.random, { catchUp });
  runSession({ queue, index: 0, correct: 0, total: 0 });
}

function wordsView(message = '') {
  setNav('words');
  const field = (id, label, attrs = {}) => [h('label', { for: id }, label), h('input', { id, autocomplete: 'off', ...attrs })];
  const status = h('p', { class: 'muted', role: 'status' }, message);
  const form = h('form', { onsubmit: (event) => {
    event.preventDefault();
    const value = (id) => form.querySelector(`#${id}`).value;
    const { entry, error } = parseCustomWord({ word: value('new-word'), meaning: value('new-meaning'), example: value('new-example'), exampleEn: value('new-example-en') }, pack.joiner);
    if (error) { status.textContent = error; return; }
    if (pack.words.some(([word]) => word === entry.word)) { status.textContent = 'That word is already in your course.'; return; }
    store.set(`custom:${entry.word}`, { ...entry, addedAt: Date.now() });
    store.sync();
    wordsView(`Added ${entry.word}. It will appear in your next session.`);
  } },
  field('new-word', 'Word or phrase', { class: 'thai', lang: pack.code, maxlength: 40, required: true }),
  field('new-meaning', 'Meaning', { maxlength: 80, required: true }),
  field('new-example', 'Example sentence (optional)', { class: 'thai', lang: pack.code, maxlength: 120, placeholder: 'ผม ชอบ กาแฟ ครับ' }),
  h('p', { class: 'muted' }, 'Put spaces between the words, so it can become a tile exercise.'),
  field('new-example-en', 'Example translation', { maxlength: 120 }),
  h('p'),
  h('button', { class: 'primary', type: 'submit' }, 'Add word'));

  const saved = Object.entries(store.byPrefix('custom:')).filter(([, c]) => !c.deleted).sort((a, b) => (b[1].addedAt ?? 0) - (a[1].addedAt ?? 0));
  show(h('h1', {}, 'My words'), h('p', { class: 'muted' }, 'Heard something today? Save it and it joins your reviews.'), form, status,
    h('h2', {}, `Saved (${saved.length})`),
    saved.length ? saved.map(([key, c]) => h('div', { class: 'word-row' },
      h('div', {}, h('div', { class: 'thai', lang: pack.code }, c.word), h('div', { class: 'muted' }, c.meaning)),
      h('button', { class: 'quiet', 'aria-label': `Remove ${c.word}`, onclick: () => {
        store.set(`custom:${key}`, { deleted: true, word: c.word });
        store.sync();
        wordsView(`Removed ${c.word}.`);
      } }, 'Remove'))) : h('p', { class: 'muted' }, 'No words saved yet.'));
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
  const render = { word: wordView, sentence: sentenceView, dialogue: dialogueView }[exercise.type];
  render(session, exercise, next);
}

function nextButton(next) {
  const button = h('button', { class: 'primary', onclick: next }, 'Continue');
  queueMicrotask(() => button.focus());
  return button;
}

function wordView(session, ex, next) {
  const started = performance.now();
  const after = h('div');
  const buttons = ex.options.map((option) => h('button', { class: 'choice', onclick: (e) => {
    const correct = option === ex.answer;
    buttons.forEach((b) => { b.disabled = true; if (b.textContent === ex.answer) b.classList.add('right'); });
    if (!correct) e.currentTarget.classList.add('wrong');
    record(session, ex, { correct, usedHint: false, ms: performance.now() - started });
    after.replaceChildren(h('div', { class: 'row' }, nextButton(next)));
    if (ex.mode === 'produce') after.prepend(h('p', { class: 'muted thai' }, `${ex.th} = ${ex.en}`));
  } }, option));
  frame(session, h('div', { class: 'card' },
    h('p', { class: 'muted' }, ex.mode === 'produce' ? 'Fill the gap' : 'What does this mean?'),
    h('p', { class: 'thai big', lang: pack.code }, ex.prompt),
    ex.hint ? h('p', { class: 'muted thai' }, ex.hint) : null,
    h('div', { class: 'options' }, buttons), after));
}

function sentenceView(session, ex, next) {
  const started = performance.now();
  const pool = ex.tiles.map((text, id) => ({ text, id }));
  let chosen = [], usedHint = false, checked = false;
  const answerEl = h('div', { class: 'answer tiles', 'aria-label': 'Your sentence' });
  const poolEl = h('div', { class: 'tiles' });
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
      h('div', { class: `feedback ${correct ? 'right' : 'wrong'}` }, correct ? 'Correct' : h('span', { class: 'thai' }, `Correct answer: ${ex.answer.join(ex.joiner)}`)),
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
      log.append(h('div', { class: 'bubble' }, h('span', { class: 'thai', lang: pack.code }, line.th), h('small', {}, line.en)));
    }
    const line = ex.lines[lineIndex];
    if (!line) {
      record(session, ex, { correct: mistakes === 0, usedHint: mistakes === 1, ms: 60000 });
      prompt.replaceChildren(h('div', { class: 'row' }, nextButton(next)));
      return;
    }
    const buttons = line.options.map((option) => h('button', { lang: pack.code, onclick: (e) => {
      if (option !== line.ok) { mistakes++; e.currentTarget.classList.add('wrong'); e.currentTarget.disabled = true; return; }
      log.append(h('div', { class: 'bubble me' }, h('span', { class: 'thai', lang: pack.code }, line.ok), h('small', {}, line.en)));
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
  if (!tutorAvailable) {
    return show(h('h1', {}, 'AI tutor'), h('p', {}, 'The tutor is optional and is off right now.'),
      h('p', { class: 'muted' }, getToken() ? 'Set ANTHROPIC_API_KEY on the server and restart it to turn it on.' : 'Add your access token in Settings first.'));
  }
  if (!chat) {
    const select = h('select', { id: 'scenario' }, SCENARIOS.map((s) => h('option', {}, s)));
    return show(h('h1', {}, 'AI tutor'), h('p', { class: 'muted' }, 'Free conversation with gentle corrections. Each reply uses your API credit.'),
      h('label', { for: 'scenario' }, 'Situation'), select, h('p'),
      h('button', { class: 'primary', onclick: () => { chat = { scenario: select.value, messages: [], view: [] }; tutorView(); sendTutor(); } }, 'Start conversation'));
  }
  const input = h('textarea', { rows: 2, id: 'reply', lang: pack.code, maxlength: 500, 'aria-label': 'Your reply' });
  const log = h('div', { id: 'chatlog' }, chat.view.map(renderBubble));
  const send = h('button', { class: 'primary', disabled: chat.busy, onclick: () => { const text = input.value.trim(); if (text) sendTutor(text); } }, chat.busy ? 'Thinking…' : 'Send');
  show(h('h1', {}, chat.scenario), log, chat.error ? h('div', { class: 'feedback wrong' }, chat.error) : null, input, h('div', { class: 'row' }, send, h('button', { onclick: () => { chat = null; tutorView(); } }, 'New')));
}

function renderBubble(item) {
  if (item.me) return h('div', { class: 'bubble me thai', lang: pack.code }, item.text);
  return h('div', {},
    item.fix ? h('div', { class: 'fix' }, h('div', { class: 'thai', lang: pack.code }, item.fix.corrected), h('div', { class: 'muted' }, item.fix.explanation)) : null,
    h('div', { class: 'bubble' }, h('span', { class: 'thai', lang: pack.code }, item.text), h('small', {}, item.translation)));
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
  const voice = h('select', { id: 'voice', class: 'thai', onchange: (e) => store.set('voice', e.target.value) },
    Object.entries(pack.voices).map(([id, v]) => h('option', { value: id, selected: id === voiceId() }, v.label)));
  const token = h('input', { id: 'token', type: 'password', value: getToken(), autocomplete: 'off' });
  const status = h('p', { class: 'muted' }, syncNote);
  show(h('h1', {}, 'Settings'),
    h('label', { for: 'voice' }, 'How you speak'), voice,
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
    tutorAvailable = res.ok && (await res.json()).tutor;
  } catch { tutorAvailable = false; }
}

document.querySelectorAll('#nav button').forEach((b) => b.addEventListener('click', () => ({ home, words: wordsView, tutor: tutorView, settings })[b.dataset.view]()));

async function boot() {
  const packs = await (await fetch('/packs/index.json')).json();
  pack = await (await fetch(`/packs/${packs[0].code}.json`)).json();
  store = new Store(pack.code);
  home();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  await loadConfig();
  if (getToken()) { await syncNow(); if (!document.body.classList.contains('focus') && document.querySelector('#nav [aria-current]')?.dataset.view === 'home') home(); }
  window.addEventListener('online', () => store.sync());
}

boot().catch(() => show(h('h1', {}, 'Could not load'), h('p', {}, 'Check your connection and reload the page.')));
