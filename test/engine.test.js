import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { catchUpState, isCorrectOrder, newItemBudget, newProfile, parseCustomWord, planSession, schedule, streak, updateProfile, withCustomWords } from '../public/engine.js';

const pack = JSON.parse(fs.readFileSync(new URL('../public/packs/th.json', import.meta.url)));
const NOW = Date.UTC(2026, 10, 23, 12);

test('every sentence token is taught vocabulary and has no duplicate words', () => {
  const words = new Set(pack.words.map(([w]) => w));
  assert.equal(words.size, pack.words.length);
  for (const s of pack.sentences) {
    for (const t of [...s.tokens, ...(s.alts ?? []).flat()]) assert.ok(t.startsWith('{') || words.has(t), `${s.id}: ${t}`);
  }
});

test('dialogue choices are distinct for both voices', () => {
  for (const d of pack.dialogues) for (const l of d.lines.filter((x) => x.who === 'me')) {
    assert.equal(new Set([l.ok, ...l.bad]).size, 3, d.id);
  }
});

test('questions and statements use the right polite particle', () => {
  const session = planSession(pack, {}, { ...newProfile(), skill: 3 }, 'ka', NOW, () => 0.4);
  assert.ok(session.length > 1);
  const q = pack.sentences.find((s) => s.id === 'your-name');
  assert.equal(q.tokens.at(-1), '{polq}');
  assert.equal(pack.voices.ka.tokens['{polq}'], 'คะ');
  assert.equal(pack.voices.ka.tokens['{pol}'], 'ค่ะ');
});

test('intervals grow on success and reset on failure', () => {
  let card = schedule(undefined, 2, NOW);
  assert.equal(card.interval, 1);
  card = schedule(card, 2, NOW);
  assert.equal(card.interval, 3);
  card = schedule(card, 3, NOW);
  assert.ok(card.interval > 3);
  const failed = schedule(card, 0, NOW);
  assert.equal(failed.reps, 0);
  assert.equal(failed.due, NOW + 600_000);
});

test('level rises with strong results and falls when struggling', () => {
  let up = newProfile();
  for (let i = 0; i < 30; i++) up = updateProfile(up, true);
  assert.ok(up.skill > 1.5);
  let down = { ...newProfile(), skill: 2.5 };
  for (let i = 0; i < 30; i++) down = updateProfile(down, false);
  assert.ok(down.skill < 2.5);
  assert.ok(down.skill >= 1);
});

test('review backlog stops new material', () => {
  assert.equal(newItemBudget(newProfile(), 10), 0);
  assert.equal(newItemBudget({ ...newProfile(), accuracy: 0.95 }, 0), 5);
  assert.equal(newItemBudget({ ...newProfile(), accuracy: 0.6 }, 0), 1);
});

test('first session stays within level and is playable', () => {
  const session = planSession(pack, {}, newProfile(), 'krap', NOW, () => 0.3);
  assert.ok(session.length >= 2 && session.length <= 10);
  assert.equal(session.at(-1).type, 'dialogue');
  for (const ex of session.filter((e) => e.type === 'word')) assert.ok(ex.options.includes(ex.answer));
});

test('due cards come before new material', () => {
  const cards = { 'w:กิน': { reps: 3, interval: 5, ease: 2.3, due: NOW - 1000 } };
  assert.equal(planSession(pack, cards, newProfile(), 'krap', NOW, () => 0.3)[0].key, 'w:กิน');
});

test('cards reviewed before they are due are marked as extra practice', () => {
  const cards = { 'w:กิน': { reps: 3, interval: 5, ease: 2.3, due: NOW + 86_400_000 } };
  const exercise = planSession(pack, cards, { ...newProfile(), accuracy: 0.6 }, 'krap', NOW, () => 0.3).find((e) => e.key === 'w:กิน');
  assert.equal(exercise.practice, true);
});

test('captured words enter the next session, even with a backlog', () => {
  const custom = { หิว: { word: 'หิว', meaning: 'hungry', tokens: ['ผม', 'หิว', 'ครับ'], exampleEn: "I'm hungry." } };
  const merged = withCustomWords(pack, custom);
  const backlog = Object.fromEntries(pack.words.slice(0, 20).map(([w]) => [`w:${w}`, { reps: 2, interval: 3, ease: 2.3, due: NOW - 1000 }]));
  const session = planSession(merged, backlog, newProfile(), 'krap', NOW, () => 0.3);
  assert.equal(session[0].key, 'w:หิว');
  const next = planSession(merged, { 'w:หิว': { reps: 1, interval: 1, ease: 2.3, due: NOW + 86_400_000 } }, newProfile(), 'krap', NOW, () => 0.3);
  assert.ok(next.some((e) => e.key === 's:c-หิว'));
});

test('removed captured words leave reviews', () => {
  const merged = withCustomWords(pack, { หิว: { deleted: true, word: 'หิว' } });
  const session = planSession(merged, { 'w:หิว': { reps: 1, interval: 1, ease: 2.3, due: NOW - 1000 } }, newProfile(), 'krap', NOW, () => 0.3);
  assert.ok(!session.some((e) => e.key === 'w:หิว'));
});

test('captured word input is validated', () => {
  assert.equal(parseCustomWord({ word: ' หิว น้ำ ', meaning: 'thirsty' }, '').entry.word, 'หิวน้ำ');
  assert.ok(parseCustomWord({ word: 'หิว', meaning: '' }, '').error);
  assert.ok(parseCustomWord({ word: 'หิว', meaning: 'hungry', example: 'ผมหิวครับ', exampleEn: "I'm hungry." }, '').error);
  assert.deepEqual(parseCustomWord({ word: 'หิว', meaning: 'hungry', example: 'ผม หิว ครับ', exampleEn: "I'm hungry." }, '').entry.tokens, ['ผม', 'หิว', 'ครับ']);
});

test('catch-up mode gives a short easy round after a break', () => {
  const cards = Object.fromEntries(pack.words.slice(0, 30).map(([w], i) => [`w:${w}`, { reps: 4, interval: 30 - i, ease: 2.3, due: NOW - 1000 }]));
  const state = catchUpState(pack, cards, { '2026-11-10': 1 }, '2026-11-23', NOW);
  assert.ok(state.active);
  assert.equal(state.daysAway, 13);
  const session = planSession(pack, cards, { ...newProfile(), skill: 3 }, 'krap', NOW, () => 0.3, { catchUp: true });
  assert.equal(session.length, 6);
  assert.equal(session[0].key, `w:${pack.words[29][0]}`);
  assert.ok(session.filter((e) => e.type === 'word').every((e) => e.mode === 'recognize'));
  assert.ok(session.at(-1).type === 'dialogue');
  assert.ok(!catchUpState(pack, {}, { '2026-11-10': 1 }, '2026-11-23', NOW).active);
});

test('sentence checking accepts listed alternatives only', () => {
  const ex = { accepted: [['a', 'b'], ['b', 'a']] };
  assert.ok(isCorrectOrder(ex, ['b', 'a']));
  assert.ok(!isCorrectOrder(ex, ['a']));
});

test('streak survives until today is practiced', () => {
  assert.equal(streak({ '2026-11-21': 1, '2026-11-22': 1 }, '2026-11-23'), 2);
  assert.equal(streak({ '2026-11-22': 1, '2026-11-23': 1 }, '2026-11-23'), 2);
  assert.equal(streak({ '2026-11-20': 1 }, '2026-11-23'), 0);
});
