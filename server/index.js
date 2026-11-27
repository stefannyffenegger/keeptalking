import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createSender, loadVapid, removeSubscription, saveSubscription, sendDueReminders, validateSubscribe } from './reminders.js';
import { createGenerator, createTutor, tutorErrorResponse, validateGenerateRequest, validateTutorRequest } from './tutor.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const publicDir = path.join(root, 'public');
const MAX_BODY = 1_000_000;
const MAX_RECORDS = 2000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg' };
const HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; media-src 'self'; base-uri 'none'; frame-ancestors 'none'" };

function loadToken(dataDir) {
  if (process.env.APP_TOKEN) return process.env.APP_TOKEN;
  const file = path.join(dataDir, 'token');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const token = randomBytes(24).toString('base64url');
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  console.log(`Created access token in ${file}`);
  return token;
}

const digest = (value) => createHash('sha256').update(value).digest();

function openDb(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'app.db'));
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS records (lang TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (lang, key));
    CREATE INDEX IF NOT EXISTS records_seq ON records (lang, seq);
    CREATE TABLE IF NOT EXISTS tutor_usage (day TEXT PRIMARY KEY, count INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY, subscription TEXT NOT NULL, time TEXT NOT NULL, tz TEXT NOT NULL, lang TEXT NOT NULL, last_sent TEXT);`);
  return db;
}

export function syncRecords(db, { lang, since, records }) {
  const get = db.prepare('SELECT value, updated_at FROM records WHERE lang = ? AND key = ?');
  const put = db.prepare(`INSERT INTO records (lang, key, value, updated_at, seq) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (lang, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, seq = excluded.seq`);
  const stale = new Map();
  db.exec('BEGIN IMMEDIATE');
  try {
    let seq = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM records').get().seq;
    for (const { key, value, updatedAt } of records) {
      const existing = get.get(lang, key);
      if (!existing || updatedAt > existing.updated_at) put.run(lang, key, JSON.stringify(value), updatedAt, ++seq);
      else if (existing.updated_at > updatedAt) stale.set(key, { key, value: JSON.parse(existing.value), updatedAt: existing.updated_at });
    }
    db.exec('COMMIT');
    const changed = db.prepare('SELECT key, value, updated_at FROM records WHERE lang = ? AND seq > ?').all(lang, since)
      .map((row) => ({ key: row.key, value: JSON.parse(row.value), updatedAt: row.updated_at }));
    const merged = new Map(stale);
    for (const record of changed) merged.set(record.key, record);
    return { cursor: seq, records: [...merged.values()] };
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

function validSync(body) {
  if (!body || !/^[a-z]{2,8}$/.test(body.lang ?? '') || !Number.isSafeInteger(body.since) || body.since < 0) return false;
  if (!Array.isArray(body.records) || body.records.length > MAX_RECORDS) return false;
  const latest = Date.now() + 86_400_000;
  return body.records.every((r) => typeof r?.key === 'string' && /^\S(?:[\S ]{0,158}\S)?$/u.test(r.key) && r.value !== undefined && Number.isSafeInteger(r.updatedAt) && r.updatedAt > 0 && r.updatedAt <= latest);
}

const readJson = (req) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on('end', () => {
    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); }
  });
  req.on('error', reject);
});

const sendJson = (res, status, body) => {
  res.writeHead(status, { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

function serveStatic(req, res, pathname) {
  let relative;
  try { relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname); }
  catch { res.writeHead(400, HEADERS).end(); return; }
  const file = path.resolve(publicDir, `.${relative}`);
  if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, HEADERS).end('Not found');
    return;
  }
  res.writeHead(200, { ...HEADERS, 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(file).pipe(res);
}

export function createApp({ dataDir, token, tutor = createTutor(), generator = createGenerator(), tutorDailyLimit = Number(process.env.TUTOR_DAILY_LIMIT) || 100, sendPush, runReminders = false }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = openDb(dataDir);
  const vapid = loadVapid(dataDir);
  const push = sendPush ?? createSender(vapid);
  const reminderTimer = runReminders
    ? setInterval(() => sendDueReminders(db, push).catch((error) => console.error('Reminder run failed:', error.message)), 60_000)
    : null;
  const secret = digest(token ?? loadToken(dataDir));
  const authorized = (req) => {
    const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    return Boolean(match) && timingSafeEqual(digest(match[1]), secret);
  };
  const takeTutorCredit = () => {
    const day = new Date().toISOString().slice(0, 10);
    const used = db.prepare('SELECT count FROM tutor_usage WHERE day = ?').get(day)?.count ?? 0;
    if (used >= tutorDailyLimit) return false;
    db.prepare('INSERT INTO tutor_usage (day, count) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET count = count + 1').run(day);
    return true;
  };

  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    try {
      if (!pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, HEADERS).end(); return; }
        serveStatic(req, res, pathname);
        return;
      }
      if (!authorized(req)) return sendJson(res, 401, { error: 'Invalid access token.' });
      if (req.method === 'GET' && pathname === '/api/config') return sendJson(res, 200, { tutor: Boolean(tutor), generate: Boolean(generator) });
      if (req.method === 'POST' && pathname === '/api/sync') {
        const body = await readJson(req);
        if (!validSync(body)) return sendJson(res, 400, { error: 'Invalid sync request.' });
        return sendJson(res, 200, syncRecords(db, body));
      }
      if (req.method === 'GET' && pathname === '/api/push/key') return sendJson(res, 200, { publicKey: vapid.publicKey });
      if (req.method === 'POST' && pathname === '/api/push/subscribe') {
        const request = validateSubscribe(await readJson(req));
        if (!request) return sendJson(res, 400, { error: 'Invalid reminder request.' });
        saveSubscription(db, request);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && pathname === '/api/push/unsubscribe') {
        const { endpoint } = await readJson(req);
        if (typeof endpoint !== 'string') return sendJson(res, 400, { error: 'Invalid reminder request.' });
        removeSubscription(db, endpoint);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && pathname === '/api/tutor') {
        if (!tutor) return sendJson(res, 503, { error: 'The AI tutor is not configured.' });
        const request = validateTutorRequest(await readJson(req));
        if (!request) return sendJson(res, 400, { error: 'Invalid tutor request.' });
        if (!takeTutorCredit()) return sendJson(res, 429, { error: 'Daily tutor limit reached.' });
        try {
          return sendJson(res, 200, await tutor(request));
        } catch (error) {
          console.error('Tutor error:', error.message);
          const { status, message } = tutorErrorResponse(error);
          return sendJson(res, status, { error: message });
        }
      }
      if (req.method === 'POST' && pathname === '/api/generate') {
        if (!generator) return sendJson(res, 503, { error: 'No API key is set on the server.' });
        const request = validateGenerateRequest(await readJson(req));
        if (!request) return sendJson(res, 400, { error: 'Invalid request.' });
        if (!takeTutorCredit()) return sendJson(res, 429, { error: 'Daily API limit reached.' });
        try {
          return sendJson(res, 200, await generator(request));
        } catch (error) {
          console.error('Generate error:', error.message);
          const { status, message } = tutorErrorResponse(error);
          return sendJson(res, status, { error: message });
        }
      }
      return sendJson(res, 404, { error: 'Not found.' });
    } catch (error) {
      if (!error.status) console.error(error);
      if (!res.headersSent) sendJson(res, error.status ?? 500, { error: error.status ? error.message : 'Server error.' });
    }
  });
  reminderTimer?.unref();
  server.on('close', () => { clearInterval(reminderTimer); db.close(); });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dataDir = process.env.DATA_DIR || path.join(root, 'data');
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT) || 8787;
  fs.mkdirSync(dataDir, { recursive: true });
  createApp({ dataDir, token: loadToken(dataDir), runReminders: true }).listen(port, host, () => console.log(`Running on http://${host}:${port}`));
}
