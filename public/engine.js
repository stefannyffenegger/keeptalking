// Language-independent learning logic. Pure functions, shared by the app and tests.
const DAY = 86_400_000;
const MINUTE = 60_000;
export const SESSION_SIZE = 10;
export const CATCH_UP_SIZE = 6;
const CATCH_UP_BACKLOG = 15;
const CATCH_UP_DAYS = 3;
const MAX_NEW_CUSTOM = 2;

export const newProfile = () => ({ skill: 1.5, accuracy: 0.82, answers: 0 });

export function applyVoice(text, voice) {
  return Object.entries(voice.tokens).reduce((out, [key, value]) => out.replaceAll(key, value), text);
}

export const resolveTokens = (tokens, voice) => tokens.map((token) => voice.tokens[token] ?? token);

const shuffle = (items, rng) => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

// grade: 0 wrong, 1 correct with help, 2 correct, 3 correct and fast
export function schedule(card = {}, grade, now) {
  const prev = { reps: 0, interval: 0, ease: 2.3, lapses: 0, ...card };
  if (grade === 0) {
    return { ...prev, reps: 0, interval: 0, ease: Math.max(1.3, prev.ease - 0.2), lapses: prev.lapses + 1, due: now + 10 * MINUTE, seen: now };
  }
  const reps = prev.reps + 1;
  const ease = Math.min(2.8, Math.max(1.3, prev.ease + (grade === 1 ? -0.1 : grade === 3 ? 0.05 : 0)));
  const factor = grade === 1 ? 0.7 : grade === 3 ? 1.15 : 1;
  const interval = reps === 1 ? 1 : reps === 2 ? 3 : Math.max(prev.interval + 1, Math.round(prev.interval * ease * factor));
  return { ...prev, reps, ease, interval, due: now + interval * DAY, seen: now };
}

// Keeps success near 80-90%: strong runs raise the level, struggling lowers it.
export function updateProfile(profile, correct) {
  const accuracy = profile.accuracy * 0.88 + (correct ? 0.12 : 0);
  const answers = profile.answers + 1;
  let skill = profile.skill;
  if (answers >= 8 && accuracy >= 0.9) skill += 0.06;
  if (answers >= 8 && accuracy < 0.72) skill -= 0.08;
  return { accuracy, answers, skill: Math.min(3.99, Math.max(1, skill)) };
}

export const newItemBudget = (profile, dueCount, size = SESSION_SIZE) => {
  if (dueCount >= size) return 0;
  const wanted = profile.accuracy >= 0.88 ? 5 : profile.accuracy >= 0.75 ? 3 : 1;
  return Math.min(wanted, size - dueCount);
};

// Adds the learner's own words and example sentences to a language pack.
export function withCustomWords(pack, customRecords) {
  const existing = new Set(pack.words.map(([word]) => word));
  const custom = Object.values(customRecords).filter((c) => !c.deleted && c.word && c.meaning && !existing.has(c.word));
  const sentences = custom
    .filter((c) => c.tokens?.length >= 2 && c.exampleEn)
    .map((c) => ({ id: `c-${c.word}`, level: 1, en: c.exampleEn, tokens: c.tokens, custom: true }));
  return {
    ...pack,
    words: [...pack.words, ...custom.map((c) => [c.word, c.meaning, 2, true])],
    sentences: [...sentences, ...pack.sentences],
  };
}

export function parseCustomWord({ word, meaning, example, exampleEn }, joiner) {
  const clean = (text) => (text ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');
  const entry = { word: clean(word), meaning: clean(meaning) };
  if (joiner === '') entry.word = entry.word.replaceAll(' ', '');
  if (!entry.word || !entry.meaning) return { error: 'Add the word and what it means.' };
  if (entry.word.length > 40 || entry.meaning.length > 80) return { error: 'Keep the word and meaning short.' };
  const sentence = clean(example);
  const translation = clean(exampleEn);
  if (!sentence && !translation) return { entry };
  const tokens = sentence.split(' ').filter(Boolean);
  if (tokens.length < 2 || !translation) return { error: 'For an example, put spaces between its words and add a translation.' };
  if (tokens.length > 12 || sentence.length > 120 || translation.length > 120) return { error: 'Keep the example under 12 words.' };
  return { entry: { ...entry, tokens, exampleEn: translation } };
}

const reviewable = (pack) => {
  const words = new Set(pack.words.map(([word]) => word));
  const sentences = new Set(pack.sentences.map((s) => s.id));
  return (key) => (key.startsWith('w:') && words.has(key.slice(2))) || (key.startsWith('s:') && sentences.has(key.slice(2)));
};

export const dueKeys = (pack, cards, now) => {
  const valid = reviewable(pack);
  return Object.entries(cards)
    .filter(([key, card]) => valid(key) && card.due <= now)
    .sort((a, b) => a[1].due - b[1].due)
    .map(([key]) => key);
};

// After a break, practice comes in small, easy rounds instead of a wall of reviews.
export function catchUpState(pack, cards, days, today, now) {
  const due = dueKeys(pack, cards, now).length;
  const last = Object.keys(days).sort().at(-1);
  const daysAway = last ? Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${last}T12:00:00Z`)) / DAY) : 0;
  return { active: due >= CATCH_UP_BACKLOG || (daysAway >= CATCH_UP_DAYS && due > 0), due, daysAway };
}

function pickNew(pack, cards, profile, budget) {
  const maxLevel = Math.floor(profile.skill);
  const vocabulary = new Set(pack.words.map(([th]) => th));
  const known = new Set(pack.words.filter(([th]) => cards[`w:${th}`]).map(([th]) => th));
  const picks = [];
  const planned = new Set();
  const missing = (s) => s.tokens.filter((t) => vocabulary.has(t) && !known.has(t) && !planned.has(t));
  const sentences = pack.sentences
    .filter((s) => s.level <= maxLevel && !cards[`s:${s.id}`])
    .sort((a, b) => Number(Boolean(b.custom)) - Number(Boolean(a.custom)) || a.level - b.level || missing(a).length - missing(b).length);

  for (const sentence of sentences) {
    if (picks.length >= budget) break;
    for (const th of missing(sentence)) {
      if (picks.length >= budget) break;
      picks.push(`w:${th}`);
      planned.add(th);
    }
    if (picks.length < budget && missing(sentence).length === 0) picks.push(`s:${sentence.id}`);
  }
  return picks;
}

function wordExercise(pack, th, card, voice, rng, easy = false) {
  const word = pack.words.find(([w]) => w === th);
  const [, en, level] = word;
  const peers = pack.words.filter(([w, e, l]) => w !== th && e !== en && Math.abs(l - level) <= 1);
  const others = shuffle(peers, rng).filter(([, e], i, list) => list.findIndex(([, x]) => x === e) === i).slice(0, 3);
  const context = pack.sentences.find((s) => s.tokens.includes(th));
  const production = !easy && (card?.reps ?? 0) >= 2;
  const base = { key: `w:${th}`, type: 'word', th, en };
  if (production && context) {
    const blank = resolveTokens(context.tokens, voice).map((t, i) => (context.tokens[i] === th ? '____' : t)).join(pack.joiner);
    return { ...base, mode: 'produce', prompt: blank, hint: context.en, answer: th, options: shuffle([th, ...others.map(([w]) => w)], rng) };
  }
  return { ...base, mode: 'recognize', prompt: th, hint: context ? resolveTokens(context.tokens, voice).join(pack.joiner) : '', answer: en, options: shuffle([en, ...others.map(([, e]) => e)], rng) };
}

function sentenceExercise(pack, sentence, card, profile, voice, rng, easy = false) {
  const answer = resolveTokens(sentence.tokens, voice);
  const accepted = [answer, ...(sentence.alts ?? []).map((alt) => resolveTokens(alt, voice))];
  const decoyCount = easy ? 0 : Math.min(3, Math.floor(profile.skill) - 1 + ((card?.reps ?? 0) >= 3 ? 1 : 0));
  const decoys = shuffle(pack.words.map(([w]) => w).filter((w) => !answer.includes(w)), rng).slice(0, decoyCount);
  return { key: `s:${sentence.id}`, type: 'sentence', en: sentence.en, answer, accepted, tiles: shuffle([...answer, ...decoys], rng), joiner: pack.joiner };
}

function dialogueExercise(pack, dialogue, voice, rng) {
  const lines = dialogue.lines.map((line) => {
    if (line.who === 'them') return line;
    const ok = applyVoice(line.ok, voice);
    return { who: 'me', en: line.en, ok, options: shuffle([ok, ...line.bad.map((b) => applyVoice(b, voice))], rng) };
  });
  return { key: `d:${dialogue.id}`, type: 'dialogue', title: dialogue.title, lines };
}

export const isCorrectOrder = (exercise, chosen) =>
  exercise.accepted.some((option) => option.length === chosen.length && option.every((t, i) => t === chosen[i]));

export function planSession(pack, cards, profile, voiceId, now, rng = Math.random, { catchUp = false, size = catchUp ? CATCH_UP_SIZE : SESSION_SIZE } = {}) {
  const voice = pack.voices[voiceId];
  const valid = reviewable(pack);
  let due = dueKeys(pack, cards, now);
  // Shortest intervals are the most fragile memories, so they come back first.
  if (catchUp) due = [...due].sort((a, b) => (cards[a].interval ?? 0) - (cards[b].interval ?? 0) || cards[a].due - cards[b].due);

  const slots = size - 1; // one slot is reserved for a dialogue
  const captured = pack.words.filter(([th, , , custom]) => custom && !cards[`w:${th}`]).slice(0, catchUp ? 1 : MAX_NEW_CUSTOM).map(([th]) => `w:${th}`);
  const reviews = due.slice(0, slots);
  const budget = catchUp ? 0 : Math.max(0, newItemBudget(profile, due.length, slots) - captured.length);
  const planned = Object.fromEntries(captured.map((key) => [key, {}]));
  const fresh = pickNew(pack, { ...cards, ...planned }, profile, budget);
  let keys = [...new Set([...captured, ...reviews, ...fresh])].slice(0, slots);

  if (!catchUp && keys.length < slots) {
    const extra = Object.entries(cards)
      .filter(([key]) => valid(key) && !keys.includes(key))
      .sort((a, b) => a[1].due - b[1].due)
      .map(([key]) => key);
    keys = [...keys, ...extra].slice(0, slots);
  }

  const exercises = keys.map((key) => {
    const id = key.slice(2);
    if (key.startsWith('w:')) return wordExercise(pack, id, cards[key], voice, rng, catchUp);
    return sentenceExercise(pack, pack.sentences.find((s) => s.id === id), cards[key], profile, voice, rng, catchUp);
  });

  const dialogueLevel = Math.max(1, Math.floor(profile.skill) - (catchUp ? 1 : 0));
  const dialogues = pack.dialogues
    .filter((d) => d.level <= dialogueLevel)
    .sort((a, b) => (cards[`d:${a.id}`]?.due ?? 0) - (cards[`d:${b.id}`]?.due ?? 0));
  if (dialogues[0]) exercises.push(dialogueExercise(pack, dialogues[0], voice, rng));
  // Early extra practice must not stretch a card's review interval.
  return exercises.map((exercise) => ({ ...exercise, practice: (cards[exercise.key]?.due ?? 0) > now }));
}

export function gradeAnswer(exercise, { correct, usedHint, ms }) {
  if (!correct) return 0;
  if (usedHint) return 1;
  const tiles = exercise.type === 'sentence' ? exercise.answer.length : 2;
  return ms < 3000 + tiles * 1500 ? 3 : 2;
}

export function streak(days, today) {
  let count = 0;
  const cursor = new Date(`${today}T12:00:00Z`);
  if (!days[today]) cursor.setUTCDate(cursor.getUTCDate() - 1);
  while (days[cursor.toISOString().slice(0, 10)]) {
    count++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return count;
}
