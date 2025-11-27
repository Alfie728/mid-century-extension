import type { ActionPayload, ScreenshotArtifact, SessionState, VideoChunk } from '@extension/shared';

type StoreName = 'sessions' | 'actions' | 'screenshots' | 'videoChunks' | 'uploadJobs';
const DB_NAME = 'cua-recorder';
const DB_VERSION = 2;
const STORE_KEYS: StoreName[] = ['sessions', 'actions', 'screenshots', 'videoChunks', 'uploadJobs'];

export type StoredAction = ActionPayload & { createdAt: number };

let dbPromise: Promise<IDBDatabase> | null = null;

const openDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      STORE_KEYS.forEach(storeName => {
        if (db.objectStoreNames.contains(storeName)) return;
        const keyPath =
          storeName === 'actions'
            ? 'actionId'
            : storeName === 'sessions'
              ? 'sessionId'
              : storeName === 'screenshots'
                ? 'screenshotId'
                : storeName === 'videoChunks'
                  ? 'chunkId'
                  : 'jobId';
        const store = db.createObjectStore(storeName, { keyPath });
        if (storeName === 'actions') {
          store.createIndex('sessionId', 'sessionId', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (storeName === 'sessions') {
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (storeName === 'screenshots') {
          store.createIndex('sessionId', 'sessionId', { unique: false });
          store.createIndex('actionId', 'actionId', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (storeName === 'videoChunks') {
          store.createIndex('sessionId', 'sessionId', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (storeName === 'uploadJobs') {
          store.createIndex('status', 'status', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
      });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });

const getDb = () => {
  if (!dbPromise) dbPromise = openDb();
  return dbPromise;
};

const runTx = async <T>(
  store: StoreName,
  mode: IDBTransactionMode,
  fn: (objectStore: IDBObjectStore) => Promise<T>,
): Promise<T> => {
  const db = await getDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const objectStore = tx.objectStore(store);
    fn(objectStore)
      .then(result => resolve(result))
      .catch(reject);
    tx.onerror = () => reject(tx.error);
  });
};

export const saveSession = async (session: SessionState) =>
  runTx('sessions', 'readwrite', store => {
    const record = { ...session, createdAt: session.startedAt ?? Date.now() };
    return new Promise<void>((resolve, reject) => {
      const request = store.put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  });

export const saveAction = async (action: ActionPayload) =>
  runTx('actions', 'readwrite', store => {
    const record: StoredAction = { ...action, createdAt: Date.now() };
    return new Promise<void>((resolve, reject) => {
      const request = store.put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  });

export const saveScreenshot = async (artifact: ScreenshotArtifact) =>
  runTx('screenshots', 'readwrite', store => {
    const record = { ...artifact, createdAt: Date.now() };
    return new Promise<void>((resolve, reject) => {
      const request = store.put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  });

export const saveVideoChunk = async (chunk: VideoChunk) =>
  runTx('videoChunks', 'readwrite', store => {
    const record = { ...chunk, createdAt: Date.now() };
    return new Promise<void>((resolve, reject) => {
      const request = store.put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  });

const countStore = async (storeName: StoreName): Promise<number> => {
  const db = await getDb();
  return new Promise<number>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const countReq = store.count();
    countReq.onsuccess = () => resolve(countReq.result);
    countReq.onerror = () => reject(countReq.error);
  });
};

const trimOldest = async (storeName: StoreName, max: number) => {
  const db = await getDb();
  const toRemove = (await countStore(storeName)) - max;
  if (toRemove <= 0) return;
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const index = tx.objectStore(storeName).index('createdAt');
    let removed = 0;
    const cursorReq = index.openCursor();
    cursorReq.onerror = () => reject(cursorReq.error);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor || removed >= toRemove) {
        resolve();
        return;
      }
      cursor.delete();
      removed += 1;
      cursor.continue();
    };
  });
};

export const enforceLimits = async () => {
  const limits: Partial<Record<StoreName, number>> = {
    actions: 500,
    screenshots: 200,
    videoChunks: 200,
    uploadJobs: 200,
    sessions: 50,
  };
  await Promise.all(
    Object.entries(limits).map(async ([storeName, max]) => {
      if (!max) return;
      await trimOldest(storeName as StoreName, max);
    }),
  );
};
