// Local-first record store with last-write-wins sync to the server.
const tokenKey = 'dm:token';

const safeGet = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const safeSet = (key, value) => { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } };

export const getToken = () => safeGet(tokenKey) ?? '';
export const setToken = (token) => safeSet(tokenKey, token);

export function api(path, options = {}) {
  return fetch(path, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` } });
}

export class Store {
  constructor(lang) {
    this.lang = lang;
    this.storageKey = `dm:data:${lang}`;
    const saved = JSON.parse(safeGet(this.storageKey) ?? 'null');
    this.records = saved?.records ?? {};
    this.dirty = saved?.dirty ?? {};
    this.cursor = saved?.cursor ?? 0;
  }

  persist() {
    safeSet(this.storageKey, JSON.stringify({ records: this.records, dirty: this.dirty, cursor: this.cursor }));
  }

  get(key, fallback) {
    return this.records[key]?.value ?? fallback;
  }

  set(key, value) {
    const updatedAt = Math.max(Date.now(), (this.records[key]?.updatedAt ?? 0) + 1);
    this.records[key] = { value, updatedAt };
    this.dirty[key] = updatedAt;
    this.persist();
  }

  byPrefix(prefix) {
    const out = {};
    for (const [key, record] of Object.entries(this.records)) {
      if (key.startsWith(prefix)) out[key.slice(prefix.length)] = record.value;
    }
    return out;
  }

  async sync() {
    if (!getToken()) return { ok: false, reason: 'No access token set.' };
    if (this.syncing) return this.syncing;
    this.syncing = this.runSync().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  async runSync() {
    const sent = Object.entries(this.dirty).slice(0, 2000).map(([key, updatedAt]) => ({ key, updatedAt, value: this.records[key].value }));
    try {
      const res = await api('/api/sync', { method: 'POST', body: JSON.stringify({ lang: this.lang, since: this.cursor, records: sent }) });
      if (res.status === 401) return { ok: false, reason: 'The access token was rejected.' };
      if (!res.ok) return { ok: false, reason: 'The server could not sync.' };
      const { cursor, records } = await res.json();
      for (const { key, updatedAt } of sent) if (this.dirty[key] === updatedAt) delete this.dirty[key];
      for (const { key, value, updatedAt } of records) {
        if (updatedAt > (this.records[key]?.updatedAt ?? 0)) {
          this.records[key] = { value, updatedAt };
          delete this.dirty[key];
        }
      }
      this.cursor = cursor;
      this.persist();
      return { ok: true, at: Date.now() };
    } catch {
      return { ok: false, reason: 'Offline. Progress is saved on this device.' };
    }
  }
}
