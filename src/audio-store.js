/* Persistent audio cache.

   Every sentence Vox speaks costs real inference — and on the CPU path that is
   sustained multi-core WASM, which is what makes a laptop hot. Nothing about a
   given sentence changes between plays, so it should be synthesised exactly
   once, ever: not again when you seek backwards, not again when you reopen the
   article tomorrow.

   IndexedDB rather than CacheStorage because these are keyed binary blobs with
   metadata (word timings, last-used stamps) and we need an index to evict by
   age. CacheStorage would mean fabricating Request/Response pairs around data
   that was never an HTTP resource.

   Audio is stored as Int16 rather than Float32: half the bytes, and the
   quantisation error sits ~90 dB below full scale, which is inaudible for
   24 kHz speech. */

const DB_NAME = "vox-audio";
const DB_VERSION = 1;
const STORE = "clips";
const BUDGET_BYTES = 600 * 1024 * 1024;   // generous; the extension has unlimitedStorage
const EVICT_TO = 0.8;                     // after eviction, sit at 80% of budget

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex("used", "used");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((err) => {
    // Private windows and blocked storage land here. Degrade to no cache
    // rather than breaking playback.
    console.warn("[vox] audio cache unavailable", err);
    dbPromise = null;
    return null;
  });
  return dbPromise;
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/* ------------------------------------------------------------------- keys */

// The key has to cover everything that changes the waveform: the words, the
// voice, the rate, and the weights doing the talking.
export async function keyFor({ text, voice, speed, profile, device }) {
  const material = `${profile}|${device}|${voice}|${Number(speed).toFixed(3)}|${text}`;
  const bytes = new TextEncoder().encode(material);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ------------------------------------------------------------------ codec */

function toInt16(pcm) {
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const clamped = pcm[i] < -1 ? -1 : pcm[i] > 1 ? 1 : pcm[i];
    out[i] = Math.round(clamped * 32767);
  }
  return out;
}

function toFloat32(int16) {
  const out = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) out[i] = int16[i] / 32767;
  return out;
}

/* ------------------------------------------------------------------- api */

export async function get(key) {
  const db = await open();
  if (!db) return null;
  try {
    const row = await wrap(tx(db, "readonly").get(key));
    if (!row) return null;
    // Touch asynchronously; a cache read must not wait on a write.
    void touch(key);
    return {
      pcm: toFloat32(row.audio),
      words: row.words || null,
      sampleRate: row.sampleRate,
    };
  } catch (err) {
    console.warn("[vox] cache read failed", err);
    return null;
  }
}

async function touch(key) {
  const db = await open();
  if (!db) return;
  try {
    const store = tx(db, "readwrite");
    const row = await wrap(store.get(key));
    if (row) {
      row.used = Date.now();
      store.put(row);
    }
  } catch { /* best effort */ }
}

// Cheap existence probe: no need to pull megabytes of PCM back just to know
// whether a sentence has already been rendered.
export async function has(key) {
  const db = await open();
  if (!db) return false;
  try {
    return (await wrap(tx(db, "readonly").getKey(key))) !== undefined;
  } catch {
    return false;
  }
}

export async function put(key, { pcm, words, sampleRate }) {
  const db = await open();
  if (!db) return false;
  const audio = toInt16(pcm);
  try {
    await wrap(tx(db, "readwrite").put({
      key,
      audio,
      words: words || null,
      sampleRate,
      bytes: audio.byteLength,
      used: Date.now(),
    }));
    return true;
  } catch (err) {
    // Almost always a quota error. Make room and try once more.
    console.warn("[vox] cache write failed, evicting", err);
    await evict(BUDGET_BYTES * EVICT_TO);
    try {
      await wrap(tx(db, "readwrite").put({
        key, audio, words: words || null, sampleRate,
        bytes: audio.byteLength, used: Date.now(),
      }));
      return true;
    } catch {
      return false;
    }
  }
}

export async function totalBytes() {
  const db = await open();
  if (!db) return 0;
  try {
    let total = 0;
    await new Promise((resolve, reject) => {
      const cursor = tx(db, "readonly").openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) return resolve();
        total += c.value.bytes || 0;
        c.continue();
      };
      cursor.onerror = () => reject(cursor.error);
    });
    return total;
  } catch {
    return 0;
  }
}

// Oldest-used first, until we are back under the target.
async function evict(targetBytes) {
  const db = await open();
  if (!db) return;
  let total = await totalBytes();
  if (total <= targetBytes) return;
  try {
    await new Promise((resolve, reject) => {
      const store = tx(db, "readwrite");
      const cursor = store.index("used").openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c || total <= targetBytes) return resolve();
        total -= c.value.bytes || 0;
        c.delete();
        c.continue();
      };
      cursor.onerror = () => reject(cursor.error);
    });
  } catch (err) {
    console.warn("[vox] eviction failed", err);
  }
}

export async function enforceBudget() {
  const total = await totalBytes();
  if (total > BUDGET_BYTES) await evict(BUDGET_BYTES * EVICT_TO);
}

export async function clear() {
  const db = await open();
  if (!db) return;
  try {
    await wrap(tx(db, "readwrite").clear());
  } catch (err) {
    console.warn("[vox] cache clear failed", err);
  }
}
