const DB_NAME = 'article-screener';
const DB_VERSION = 1;
const STORE = 'articles';

let dbPromise = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('status', 'decision', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getDB() {
  if (!dbPromise) dbPromise = openDB();
  return dbPromise;
}

export async function clearArticles() {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function addArticles(rows) {
  const db = await getDB();
  const CHUNK = 1000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      chunk.forEach((r, j) => {
        store.add({
          rowNum: i + j + 1,
          title: r.title || '',
          link: r.link || '',
          doi: r.doi || '',
          abstract: r.abstract || '',
          decision: 'pending',
          score: null,
          reason: ''
        });
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

// ranges: массив пар [from, to] (включительно) или null/пусто — тогда ограничения нет
function inRanges(rowNum, ranges) {
  if (!ranges || ranges.length === 0) return true;
  return ranges.some(([from, to]) => rowNum >= from && rowNum <= to);
}

export async function countAll() {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function countByStatus(status) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const idx = tx.objectStore(STORE).index('status');
    const req = idx.count(IDBKeyRange.only(status));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getCounts(ranges) {
  if (!ranges || ranges.length === 0) {
    const statuses = ['pending', 'include', 'maybe', 'exclude', 'error'];
    const counts = {};
    for (const s of statuses) counts[s] = await countByStatus(s);
    return counts;
  }
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).openCursor();
    const counts = { pending: 0, include: 0, maybe: 0, exclude: 0, error: 0 };
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        const v = cursor.value;
        if (inRanges(v.rowNum, ranges)) counts[v.decision] = (counts[v.decision] || 0) + 1;
        cursor.continue();
      } else {
        resolve(counts);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getNextPending(limit, ranges) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const idx = tx.objectStore(STORE).index('status');
    const req = idx.openCursor(IDBKeyRange.only('pending'));
    const results = [];
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor && results.length < limit) {
        if (inRanges(cursor.value.rowNum, ranges)) results.push(cursor.value);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

const DOI_RE = /10\.\d{4,9}\/\S+/i;

export async function getMissingAbstractItems() {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).openCursor();
    const results = [];
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        const v = cursor.value;
        if ((!v.abstract || !v.abstract.trim()) && DOI_RE.test(v.doi || '')) {
          results.push({ id: v.id, doi: v.doi });
        }
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function updateArticle(id, patch) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const v = getReq.result;
      if (!v) return;
      Object.assign(v, patch);
      store.put(v);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function updateMany(idPatchPairs) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const [id, patch] of idPatchPairs) {
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const v = getReq.result;
        if (!v) return;
        Object.assign(v, patch);
        store.put(v);
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAll() {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getPage({ decision = 'all', search = '', ranges = null, offset = 0, limit = 50 }) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).openCursor();
    const matches = [];
    const q = search.trim().toLowerCase();
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        const v = cursor.value;
        const okDecision = decision === 'all' || v.decision === decision;
        const okSearch = !q || (v.title || '').toLowerCase().includes(q);
        const okRange = inRanges(v.rowNum, ranges);
        if (okDecision && okSearch && okRange) matches.push(v);
        cursor.continue();
      } else {
        resolve({ total: matches.length, rows: matches.slice(offset, offset + limit) });
      }
    };
    req.onerror = () => reject(req.error);
  });
}
