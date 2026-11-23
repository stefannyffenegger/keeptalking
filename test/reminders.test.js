import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { saveSubscription, sendDueReminders, validateSubscribe } from '../server/reminders.js';

const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'key', auth: 'auth' } };
const AT_19_05_BANGKOK = Date.UTC(2026, 10, 23, 12, 5);

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE records (lang TEXT, key TEXT, value TEXT, updated_at INTEGER, seq INTEGER);
    CREATE TABLE push_subscriptions (endpoint TEXT PRIMARY KEY, subscription TEXT NOT NULL, time TEXT NOT NULL, tz TEXT NOT NULL, lang TEXT NOT NULL, last_sent TEXT);`);
  saveSubscription(db, { subscription, time: '19:00', tz: 'Asia/Bangkok', lang: 'th' });
  return db;
}

test('sends once per day at the local reminder time', async () => {
  const db = database();
  const sent = [];
  const send = async (s, payload) => sent.push(payload);
  assert.equal(await sendDueReminders(db, send, AT_19_05_BANGKOK - 3_600_000), 0);
  assert.equal(await sendDueReminders(db, send, AT_19_05_BANGKOK), 1);
  assert.equal(await sendDueReminders(db, send, AT_19_05_BANGKOK + 60_000), 0);
  assert.equal(JSON.parse(sent[0]).title, 'Keep Talking');
});

test('skips the reminder after practicing on any device', async () => {
  const db = database();
  db.prepare('INSERT INTO records VALUES (?, ?, ?, ?, ?)').run('th', 'day:2026-11-23', '1', 1, 1);
  assert.equal(await sendDueReminders(db, async () => assert.fail('should not send'), AT_19_05_BANGKOK), 0);
});

test('expired subscriptions are removed', async () => {
  const db = database();
  await sendDueReminders(db, async () => { throw Object.assign(new Error('gone'), { statusCode: 410 }); }, AT_19_05_BANGKOK);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 0);
});

test('only real push services are accepted', () => {
  const body = { subscription, time: '19:00', tz: 'Asia/Bangkok', lang: 'th' };
  assert.ok(validateSubscribe(body));
  assert.equal(validateSubscribe({ ...body, subscription: { ...subscription, endpoint: 'https://127.0.0.1/x' } }), null);
  assert.equal(validateSubscribe({ ...body, subscription: { ...subscription, endpoint: 'http://fcm.googleapis.com/x' } }), null);
  assert.equal(validateSubscribe({ ...body, tz: 'Mars/Base' }), null);
  assert.equal(validateSubscribe({ ...body, time: '25:00' }), null);
});
