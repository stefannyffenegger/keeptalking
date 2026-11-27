import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server/index.js';
import { createGenerator, createTutor } from '../server/tutor.js';

async function withServer(options, run) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-'));
  const server = createApp({ dataDir, token: 'secret', tutor: null, generator: null, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (url, body, token = 'secret') => fetch(base + url, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  try { await run(call, base); } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test('API requires the token', () => withServer({}, async (call) => {
  assert.equal((await call('/api/config', null, 'wrong')).status, 401);
  assert.equal((await call('/api/config')).status, 200);
}));

test('static files cannot escape the public folder', () => withServer({}, async (_call, base) => {
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/..%2fpackage.json`)).status, 404);
}));

test('two devices converge and the newest write wins', () => withServer({}, async (call) => {
  const sync = async (body) => (await call('/api/sync', { lang: 'th', ...body })).json();
  const a = await sync({ since: 0, records: [{ key: 'card:w:กิน', value: { reps: 1 }, updatedAt: 100 }] });
  const b = await sync({ since: 0, records: [] });
  assert.deepEqual(b.records[0].value, { reps: 1 });
  await sync({ since: b.cursor, records: [{ key: 'card:w:กิน', value: { reps: 2 }, updatedAt: 200 }] });
  const stale = await sync({ since: a.cursor, records: [{ key: 'card:w:กิน', value: { reps: 9 }, updatedAt: 150 }] });
  assert.deepEqual(stale.records.find((r) => r.key === 'card:w:กิน').value, { reps: 2 });
}));

test('tutor sends a valid request and enforces the daily limit', async () => {
  let sent;
  const client = { beta: { messages: { create: async (request) => {
    sent = request;
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ reply: 'สวัสดี', translation: 'Hello', correction: { needed: false, corrected: '', explanation: '' } }) }] };
  } } } };
  await withServer({ tutor: createTutor(client), tutorDailyLimit: 1 }, async (call) => {
    const body = { language: 'Thai', scenario: 'Taxi', level: 1, voice: 'ผม / ครับ', messages: [] };
    const res = await call('/api/tutor', body);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).reply, 'สวัสดี');
    assert.equal(sent.model, 'claude-opus-5-5');
    assert.equal(sent.messages[0].role, 'user');
    assert.equal((await call('/api/tutor', body)).status, 429);
  });
});

test('exercise generation uses structured output and shares the daily limit', async () => {
  let sent;
  const client = { beta: { messages: { stream: (request) => {
    sent = request;
    return { finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"lang":"th"}' }] }) };
  } } } };
  await withServer({ generator: createGenerator(client), tutorDailyLimit: 1 }, async (call) => {
    const config = await (await call('/api/config')).json();
    assert.equal(config.generate, true);
    assert.equal((await call('/api/generate', { lang: 'th', prompt: '' })).status, 400);
    const res = await call('/api/generate', { lang: 'th', prompt: 'Write exercises' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).text, '{"lang":"th"}');
    assert.equal(sent.output_config.format.type, 'json_schema');
    assert.equal(sent.messages[0].content, 'Write exercises');
    assert.equal((await call('/api/generate', { lang: 'th', prompt: 'Again' })).status, 429);
  });
});

test('exercise generation reports when no API key is set', () => withServer({}, async (call) => {
  assert.equal((await (await call('/api/config')).json()).generate, false);
  assert.equal((await call('/api/generate', { lang: 'th', prompt: 'x' })).status, 503);
}));
