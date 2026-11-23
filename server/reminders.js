import fs from 'node:fs';
import path from 'node:path';
import { generateVAPIDKeys, sendNotification } from 'web-push';

const REMINDER_WINDOW_MINUTES = 180;
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^[a-z0-9.-]+\.push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /^[a-z0-9.-]+\.notify\.windows\.com$/];
const MESSAGE = JSON.stringify({ title: 'Keep Talking', body: 'Got a few minutes to keep talking?' });

export function loadVapid(dataDir) {
  const file = path.join(dataDir, 'vapid.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const keys = generateVAPIDKeys();
  fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}

export function createSender({ publicKey, privateKey }, subject = process.env.VAPID_SUBJECT || 'https://example.com') {
  return (subscription, payload) => sendNotification(subscription, payload, {
    TTL: 3600,
    vapidDetails: { subject, publicKey, privateKey },
  });
}

const validZone = (tz) => {
  if (typeof tz !== 'string' || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
};

export function validateSubscribe(body) {
  const { subscription, time, tz, lang } = body ?? {};
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time ?? '') || !validZone(tz) || !/^[a-z]{2,8}$/.test(lang ?? '')) return null;
  const { endpoint, keys } = subscription ?? {};
  if (typeof endpoint !== 'string' || endpoint.length > 1024) return null;
  if (typeof keys?.p256dh !== 'string' || typeof keys?.auth !== 'string' || keys.p256dh.length > 256 || keys.auth.length > 128) return null;
  let url;
  try { url = new URL(endpoint); } catch { return null; }
  if (url.protocol !== 'https:' || url.port || !PUSH_HOSTS.some((host) => host.test(url.hostname))) return null;
  return { subscription: { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }, time, tz, lang };
}

export function saveSubscription(db, { subscription, time, tz, lang }) {
  db.prepare(`INSERT INTO push_subscriptions (endpoint, subscription, time, tz, lang) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (endpoint) DO UPDATE SET subscription = excluded.subscription, time = excluded.time, tz = excluded.tz, lang = excluded.lang`)
    .run(subscription.endpoint, JSON.stringify(subscription), time, tz, lang);
}

export const removeSubscription = (db, endpoint) => db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);

export function localClock(now, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

// At most one reminder per device per day, and none once any device has practiced.
export async function sendDueReminders(db, send, now = Date.now()) {
  const rows = db.prepare('SELECT endpoint, subscription, time, tz, lang, last_sent FROM push_subscriptions').all();
  const practiced = db.prepare('SELECT 1 FROM records WHERE lang = ? AND key = ?');
  const markSent = db.prepare('UPDATE push_subscriptions SET last_sent = ? WHERE endpoint = ?');
  let sent = 0;
  for (const row of rows) {
    const { date, minutes } = localClock(now, row.tz);
    const [hour, minute] = row.time.split(':').map(Number);
    const late = minutes - (hour * 60 + minute);
    if (late < 0 || late > REMINDER_WINDOW_MINUTES || row.last_sent === date) continue;
    if (practiced.get(row.lang, `day:${date}`)) continue;
    markSent.run(date, row.endpoint);
    try {
      await send(JSON.parse(row.subscription), MESSAGE);
      sent++;
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) removeSubscription(db, row.endpoint);
      else console.error('Reminder failed with status', error.statusCode ?? 'unknown');
    }
  }
  return sent;
}
