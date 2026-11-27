import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { buildUpdatePrompt, extractJson, parseContentUpdate, withUpdates } from '../public/content.js';
import { newProfile, planSession } from '../public/engine.js';

const load = (code) => JSON.parse(fs.readFileSync(new URL(`../public/packs/${code}.json`, import.meta.url)));
const th = { ...load('th'), letters: [] };
const he = { ...load('he'), letters: [] };
const NOW = Date.UTC(2026, 10, 27, 12);

const reply = {
  format: 'keep-talking/1',
  lang: 'th',
  words: [{ word: 'หิว', meaning: 'hungry', pron: 'hiu', level: 1 }, { word: 'ไม่ใช้', meaning: 'unused', pron: '', level: 1 }],
  sentences: [
    { id: 'hungry', level: 1, en: "I'm hungry.", tokens: ['{I}', 'หิว', '{pol}'], alts: [] },
    { id: 'hungry-now', level: 2, en: "I'm hungry today.", tokens: ['วันนี้', '{I}', 'หิว', '{pol}'], alts: [['{I}', 'หิว', 'วันนี้', '{pol}']] },
    { id: 'bad', level: 1, en: 'Uses an unknown word.', tokens: ['{I}', 'บิน', '{pol}'], alts: [] },
  ],
  dialogues: [{ id: 'food-stall', level: 1, title: 'At a food stall', lines: [
    { who: 'them', text: 'หิวไหม', en: 'Hungry?', ok: '', bad: [] },
    { who: 'me', text: '', en: 'Yes, very.', ok: 'หิวมาก{pol}', bad: ['ไม่ดื่ม{pol}', 'ไปตลาด{pol}'] },
  ] }],
};

test('the prompt carries progress, speaker tokens and the reply format', () => {
  const cards = { 'w:กิน': { reps: 3, ease: 2.3, lapses: 0 }, 'w:ไป': { reps: 1, ease: 1.5, lapses: 3 } };
  const prompt = buildUpdatePrompt(th, cards, newProfile(), 'ka');
  assert.match(prompt, /Words I know well: กิน \(eat\)/);
  assert.match(prompt, /keep getting wrong: ไป \(go\)/);
  assert.match(prompt, /\{pol\} = ค่ะ/);
  assert.match(prompt, /"lang": "th"/);
});

test('a pasted chat reply is found inside surrounding text', () => {
  const text = `Sure! Here you go:\n\n\`\`\`json\n${JSON.stringify(reply)}\n\`\`\`\nEnjoy.`;
  assert.equal(extractJson(text).lang, 'th');
  assert.equal(extractJson('no json here'), null);
});

test('valid items are kept and invalid ones dropped with a note', () => {
  const { update, warnings } = parseContentUpdate(JSON.stringify(reply), th, NOW);
  assert.deepEqual(update.words, [['หิว', 'hungry', 1]]);
  assert.deepEqual(update.sentences.map((s) => s.id), ['x-hungry', 'x-hungry-now']);
  assert.equal(update.dialogues.length, 1);
  assert.equal(update.pron['หิว'], 'hiu');
  assert.ok(warnings.some((w) => w.includes('unknown word')));
  assert.ok(warnings.some((w) => w.includes('not used')));
});

test('replies for another language or without content are refused', () => {
  assert.ok(parseContentUpdate({ ...reply, lang: 'he' }, th).error);
  assert.ok(parseContentUpdate({ lang: 'th', words: [], sentences: [], dialogues: [] }, th).error);
  assert.ok(parseContentUpdate('garbage', th).error);
});

test('a dialogue with a broken line or unknown placeholder is skipped', () => {
  const broken = { ...reply, dialogues: [{ ...reply.dialogues[0], lines: [reply.dialogues[0].lines[0], { ...reply.dialogues[0].lines[1], ok: '{nope}' }] }] };
  const { update } = parseContentUpdate(broken, th, NOW);
  assert.equal(update.dialogues.length, 0);
});

test('imported exercises enter practice and leave when removed', () => {
  const { update } = parseContentUpdate(reply, th, NOW);
  const merged = withUpdates(th, { [update.id]: update });
  assert.ok(merged.words.some(([w]) => w === 'หิว'));
  const cards = Object.fromEntries(th.sentences.map((s) => [`s:${s.id}`, { reps: 3, interval: 30, ease: 2.3, due: NOW + 1e9 }]));
  for (const [w] of th.words) cards[`w:${w}`] = { reps: 3, interval: 30, ease: 2.3, due: NOW + 1e9 };
  const session = planSession(merged, cards, { ...newProfile(), accuracy: 0.95 }, 'krap', NOW, () => 0.3);
  assert.ok(session.some((e) => e.key === 'w:หิว'));
  const removed = withUpdates(th, { [update.id]: { deleted: true, addedAt: update.addedAt } });
  assert.equal(removed, th);
});

test('Hebrew replies keep speaker-dependent words as tokens', () => {
  const hebrew = { lang: 'he', words: [{ word: 'תה', meaning: 'tea', pron: 'te', level: 1 }],
    sentences: [{ id: 'like-tea', level: 1, en: 'I like tea.', tokens: ['אני', '{like}', 'תה'], alts: [] }], dialogues: [] };
  const { update } = parseContentUpdate(hebrew, he, NOW);
  const merged = withUpdates(he, { [update.id]: update });
  const ex = planSession(merged, { 's:x-like-tea': { reps: 1, interval: 1, ease: 2.3, due: NOW - 1 } }, newProfile(), 'f', NOW, () => 0.3).find((e) => e.key === 's:x-like-tea');
  assert.deepEqual(ex.answer, ['אני', 'אוהבת', 'תה']);
  assert.equal(merged.pron['תה'], 'te');
});
