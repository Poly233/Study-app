// Tiny IndexedDB wrapper. Everything lives on the phone; nothing is uploaded
// except the photos/text you explicitly send to the AI.

const DB_NAME = 'studyquest';
const DB_VERSION = 2;
export const STORES = ['cards', 'problems', 'images', 'sources', 'feynman', 'meta'];

let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: name === 'meta' ? 'key' : 'id' });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const db = {
  get: (store, id) => tx(store, 'readonly', s => reqP(s.get(id))),
  all: (store) => tx(store, 'readonly', s => reqP(s.getAll())),
  put: (store, obj) => tx(store, 'readwrite', s => reqP(s.put(obj))),
  putMany: (store, objs) => tx(store, 'readwrite', s => Promise.all(objs.map(o => reqP(s.put(o))))),
  del: (store, id) => tx(store, 'readwrite', s => reqP(s.delete(id))),
  clear: (store) => tx(store, 'readwrite', s => reqP(s.clear())),
  async getMeta(key, fallback) {
    const row = await db.get('meta', key);
    return row ? row.value : fallback;
  },
  setMeta: (key, value) => db.put('meta', { key, value }),
};

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------- backup ----------

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function dataURLToBlob(url) {
  const res = await fetch(url);
  return res.blob();
}

export async function exportAll({ includeImages = true } = {}) {
  const out = { app: 'studyquest', version: 1, exportedAt: new Date().toISOString() };
  for (const name of STORES) {
    let rows = await db.all(name);
    if (name === 'images') {
      if (!includeImages) { rows = []; }
      else rows = await Promise.all(rows.map(async r => ({ id: r.id, data: await blobToDataURL(r.blob) })));
    }
    if (name === 'meta') rows = rows.map(r => r.key === 'settings' ? { ...r, value: { ...r.value, apiKey: '' } } : r);
    out[name] = rows;
  }
  return out;
}

export async function importAll(data) {
  if (!data || data.app !== 'studyquest') throw new Error('不是本 App 的备份文件');
  for (const name of STORES) {
    const rows = data[name];
    if (!Array.isArray(rows)) continue;
    if (name === 'images') {
      const imgs = await Promise.all(rows.map(async r => ({ id: r.id, blob: await dataURLToBlob(r.data) })));
      await db.putMany('images', imgs);
    } else if (name === 'meta') {
      // keep the current API key
      const current = await db.getMeta('settings', {});
      await db.putMany('meta', rows.map(r => r.key === 'settings'
        ? { ...r, value: { ...r.value, apiKey: current.apiKey || '' } } : r));
    } else {
      await db.putMany(name, rows);
    }
  }
}
