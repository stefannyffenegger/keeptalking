// New exercises written by an LLM: either pasted back from any chat app (free) or fetched through the server's API key.
// The same prompt and the same checks are used for both paths, so a pasted reply is held to the same rules.
export const FORMAT_VERSION = 1;
const LIMITS = { words: 40, sentences: 40, dialogues: 6, lines: 12 };
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

const clean = (text) => (typeof text === 'string' ? text.normalize('NFC').trim().replace(/\s+/g, ' ') : '');
const level = (value) => ([1, 2, 3].includes(value) ? value : 2);

// A compact summary of what the learner knows, so the chat model can aim new material at it.
export function progressSummary(pack, cards, profile, voiceId) {
  const voice = pack.voices[voiceId];
  const stateOf = (key) => {
    const card = cards[key];
    if (!card) return 'new';
    if ((card.lapses ?? 0) >= 2 || (card.ease ?? 2.3) < 1.8) return 'weak';
    return card.reps >= 2 ? 'known' : 'learning';
  };
  const words = pack.words.map(([word, meaning]) => ({ word, meaning, state: stateOf(`w:${word}`) }));
  const count = (state) => words.filter((w) => w.state === state).length;
  const weakSentences = pack.sentences.filter((s) => stateOf(`s:${s.id}`) === 'weak').map((s) => s.en);
  return {
    language: pack.name,
    level: Math.min(3, Math.floor(profile.skill)),
    voice: voice?.label ?? '',
    counts: { known: count('known'), learning: count('learning'), weak: count('weak'), new: count('new') },
    words,
    weakSentences,
    sentenceTopics: pack.sentences.map((s) => s.en),
    dialogueTitles: pack.dialogues.map((d) => d.title),
  };
}

export function buildUpdatePrompt(pack, cards, profile, voiceId) {
  const p = progressSummary(pack, cards, profile, voiceId);
  const voice = pack.voices[voiceId];
  const voiceTokens = Object.entries(voice?.tokens ?? {}).map(([token, value]) => `${token} = ${value}`).join(', ');
  const byState = (state) => p.words.filter((w) => w.state === state).map((w) => `${w.word} (${w.meaning})`).join(', ') || 'none';
  const spacing = pack.joiner === ''
    ? `${p.language} is written without spaces, so "tokens" splits the sentence into the separate words a learner would drag as tiles.`
    : 'Each token is one written word as it appears in the sentence, including attached prefixes.';

  return `I'm learning ${p.language} with a small practice app. Please write new exercises for me as JSON that I can paste back into the app.

## My progress
- Level ${p.level} of 3 (1: very short everyday sentences, 3: linked clauses and natural speech).
- I speak as: ${p.voice}.
- Words I know well: ${byState('known')}
- Words I'm still learning: ${byState('learning')}
- Words I keep getting wrong: ${byState('weak')}
- Sentences I keep getting wrong: ${p.weakSentences.join(' | ') || 'none'}
- Sentences I already have: ${p.sentenceTopics.join(' | ')}
- Conversations I already have: ${p.dialogueTitles.join(' | ')}

## What to write
- 6 to 12 new everyday words that build on what I know.
- 10 to 15 new short sentences at my level. Reuse my weak words where it fits, and use every new word at least once.
- 1 or 2 short conversations (4 to 6 lines) in everyday situations I don't have yet.
- Natural spoken ${p.language}, not textbook phrasing.

## Rules the app checks
- ${spacing}
- Every sentence token must be a word from my lists above, a word in your "words" list, or one of these speaker tokens: ${voiceTokens || 'none'}. Use the speaker tokens instead of the words they stand for, so the sentence fits how I speak.
- No punctuation inside tokens.
- "alts" lists other correct word orders (optional, may be empty).
- In conversations, lines alternate between "them" (the other person) and "me". A "them" line has "text" and "en"; a "me" line has "en", the correct reply "ok", and exactly two plausible but wrong replies in "bad". Fill unused fields with "" or [].
- "me" replies may use the speaker tokens too.
- Give "pron" as a simple English-letter pronunciation for each new word${pack.code === 'th' ? ' (or leave it "")' : ''}.
- ids are lowercase words joined with hyphens.

Reply with only this JSON in one code block:

\`\`\`json
{
  "format": "keep-talking/${FORMAT_VERSION}",
  "lang": "${pack.code}",
  "words": [{ "word": "", "meaning": "", "pron": "", "level": 1 }],
  "sentences": [{ "id": "", "level": 1, "en": "", "tokens": [], "alts": [] }],
  "dialogues": [{ "id": "", "level": 1, "title": "", "lines": [
    { "who": "them", "text": "", "en": "", "ok": "", "bad": [] },
    { "who": "me", "text": "", "en": "", "ok": "", "bad": ["", ""] }
  ] }]
}
\`\`\``;
}

// JSON schema for the API path's structured output. Lengths and counts are checked in parseContentUpdate.
export const UPDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['format', 'lang', 'words', 'sentences', 'dialogues'],
  properties: {
    format: { type: 'string' },
    lang: { type: 'string' },
    words: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['word', 'meaning', 'pron', 'level'],
      properties: { word: { type: 'string' }, meaning: { type: 'string' }, pron: { type: 'string' }, level: { type: 'integer', enum: [1, 2, 3] } } } },
    sentences: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'level', 'en', 'tokens', 'alts'],
      properties: { id: { type: 'string' }, level: { type: 'integer', enum: [1, 2, 3] }, en: { type: 'string' },
        tokens: { type: 'array', items: { type: 'string' } }, alts: { type: 'array', items: { type: 'array', items: { type: 'string' } } } } } },
    dialogues: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'level', 'title', 'lines'],
      properties: { id: { type: 'string' }, level: { type: 'integer', enum: [1, 2, 3] }, title: { type: 'string' },
        lines: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['who', 'text', 'en', 'ok', 'bad'],
          properties: { who: { type: 'string', enum: ['them', 'me'] }, text: { type: 'string' }, en: { type: 'string' }, ok: { type: 'string' }, bad: { type: 'array', items: { type: 'string' } } } } } } } },
  },
};

// Accepts a raw chat reply: a fenced code block, or JSON with text around it.
export function extractJson(text) {
  if (typeof text !== 'string' || text.length > 200_000) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

// Checks a reply against the pack. Bad items are dropped with a note instead of rejecting the whole reply.
export function parseContentUpdate(input, pack, now = Date.now()) {
  const data = typeof input === 'string' ? extractJson(input) : input;
  if (!data || typeof data !== 'object') return { error: 'No exercises found. Paste the whole reply, including the JSON block.' };
  if (data.lang && data.lang !== pack.code) return { error: `These exercises are for "${data.lang}", but you're practicing ${pack.name}.` };
  const warnings = [];
  const skip = (message) => { if (warnings.length < 20) warnings.push(message); };
  const voiceTokens = new Set(Object.values(pack.voices).flatMap((v) => Object.keys(v.tokens)));
  const existingWords = new Set(pack.words.map(([w]) => w));
  const words = [];
  const pron = {};

  for (const raw of (Array.isArray(data.words) ? data.words : []).slice(0, LIMITS.words)) {
    let word = clean(raw?.word);
    const meaning = clean(raw?.meaning);
    if (pack.joiner === '') word = word.replaceAll(' ', '');
    if (!word || !meaning || word.length > 40 || meaning.length > 80 || word.startsWith('{')) { skip(`Skipped a word: ${word || '(empty)'}`); continue; }
    if (existingWords.has(word)) continue;
    existingWords.add(word);
    words.push([word, meaning, level(raw.level)]);
    const p = clean(raw.pron);
    if (p && p.length <= 60) pron[word] = p;
  }

  const known = (token) => existingWords.has(token) || voiceTokens.has(token);
  const tokenList = (list) => (Array.isArray(list) ? list.map(clean) : []);
  const sentenceIds = new Set(pack.sentences.map((s) => s.id));
  const sentences = [];
  for (const raw of (Array.isArray(data.sentences) ? data.sentences : []).slice(0, LIMITS.sentences)) {
    const id = `x-${clean(raw?.id).toLowerCase()}`;
    const en = clean(raw?.en);
    const tokens = tokenList(raw?.tokens);
    const alts = (Array.isArray(raw?.alts) ? raw.alts : []).map(tokenList).filter((alt) => alt.length);
    if (!ID.test(id.slice(2)) || sentenceIds.has(id) || !en || en.length > 160) { skip(`Skipped a sentence: ${en || id}`); continue; }
    if (tokens.length < 2 || tokens.length > 14) { skip(`Skipped "${en}": it needs 2 to 14 words.`); continue; }
    const unknown = [...tokens, ...alts.flat()].filter((t) => !known(t));
    if (unknown.length) { skip(`Skipped "${en}": unknown word ${unknown[0]}.`); continue; }
    const sameWords = (alt) => alt.length === tokens.length && [...alt].sort().join('\u0000') === [...tokens].sort().join('\u0000');
    sentenceIds.add(id);
    sentences.push({ id, level: level(raw.level), en, tokens, ...(alts.some(sameWords) ? { alts: alts.filter(sameWords) } : {}) });
  }

  const placeholders = (text) => (text.match(/\{[^}]*\}/g) ?? []).every((t) => voiceTokens.has(t));
  const dialogueIds = new Set(pack.dialogues.map((d) => d.id));
  const dialogues = [];
  for (const raw of (Array.isArray(data.dialogues) ? data.dialogues : []).slice(0, LIMITS.dialogues)) {
    const id = `x-${clean(raw?.id).toLowerCase()}`;
    const title = clean(raw?.title);
    const lines = [];
    let valid = ID.test(id.slice(2)) && !dialogueIds.has(id) && title && title.length <= 60 && Array.isArray(raw?.lines) && raw.lines.length <= LIMITS.lines;
    for (const line of valid ? raw.lines : []) {
      const en = clean(line?.en);
      if (line?.who === 'them') {
        const text = clean(line.text);
        if (!text || !en || text.length > 200 || en.length > 200 || text.includes('{')) { valid = false; break; }
        lines.push({ who: 'them', text, en });
      } else if (line?.who === 'me') {
        const ok = clean(line.ok);
        const bad = (Array.isArray(line.bad) ? line.bad : []).map(clean).filter(Boolean);
        const all = [ok, ...bad];
        if (!ok || !en || bad.length !== 2 || new Set(all).size !== 3 || all.some((t) => t.length > 200 || !placeholders(t))) { valid = false; break; }
        lines.push({ who: 'me', en, ok, bad });
      } else { valid = false; break; }
    }
    if (!valid || !lines.some((l) => l.who === 'me') || lines.length < 2) { skip(`Skipped the conversation "${title || id}".`); continue; }
    dialogueIds.add(id);
    dialogues.push({ id, level: level(raw.level), title, lines });
  }

  // Words only enter practice through a sentence, so keep just the ones that are used.
  const used = new Set(sentences.flatMap((s) => s.tokens));
  const usedWords = words.filter(([w]) => used.has(w));
  if (usedWords.length < words.length) skip(`${words.length - usedWords.length} new word(s) were not used in any sentence and were left out.`);
  if (!usedWords.length && !sentences.length && !dialogues.length) return { error: 'Nothing new could be used from this reply.', warnings };

  const batchId = now.toString(36);
  return {
    update: { id: batchId, addedAt: now, words: usedWords, pron: Object.fromEntries(usedWords.filter(([w]) => pron[w]).map(([w]) => [w, pron[w]])), sentences, dialogues },
    warnings,
  };
}

// Merges saved updates into the pack, oldest first. Removed updates are kept as tombstones for sync.
export function withUpdates(pack, updates) {
  const batches = Object.values(updates).filter((u) => u && !u.deleted).sort((a, b) => a.addedAt - b.addedAt);
  if (!batches.length) return pack;
  const words = new Set(pack.words.map(([w]) => w));
  const sentenceIds = new Set(pack.sentences.map((s) => s.id));
  const dialogueIds = new Set(pack.dialogues.map((d) => d.id));
  const out = { ...pack, words: [...pack.words], sentences: [...pack.sentences], dialogues: [...pack.dialogues], pron: { ...pack.pron } };
  for (const batch of batches) {
    for (const word of batch.words ?? []) if (!words.has(word[0])) { words.add(word[0]); out.words.push(word); }
    Object.assign(out.pron, batch.pron);
    for (const s of batch.sentences ?? []) if (!sentenceIds.has(s.id)) { sentenceIds.add(s.id); out.sentences.push(s); }
    for (const d of batch.dialogues ?? []) if (!dialogueIds.has(d.id)) { dialogueIds.add(d.id); out.dialogues.push(d); }
  }
  // A sentence whose words came from a removed update can't be practiced any more.
  out.sentences = out.sentences.filter((s) => [...s.tokens, ...(s.alts ?? []).flat()].every((t) => words.has(t) || t.startsWith('{')));
  return out;
}

// The conversation tutor as a prompt for any chat app, matching the built-in tutor's behavior.
export const buildChatTutorPrompt = ({ language, scenario, level, voice }) => `Be my ${language} conversation partner. I'm an adult learner practicing everyday speech and sentence building.

Situation: ${scenario}
My level: ${level} of 3. At level 1 use very short, common sentences. At level 3 use natural everyday speech with linked clauses.
I speak using these forms: ${voice}. Correct my sentences to fit them.

Stay in the situation. Keep each reply to one or two short sentences of natural spoken ${language}, ending so I have something easy to answer. Put the English translation on the next line.

When my message has a real error, or something a native speaker wouldn't say, first show the corrected sentence and one short English explanation, then continue the conversation. Leave style preferences alone. If I write in English, show me how to say it in ${language}.

Start with a simple opening line.`;
