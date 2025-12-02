import { strToU8, zipSync } from 'fflate';
import type { ActionPayload, ScreenshotArtifact, SessionState, VideoChunk } from '@extension/shared';

type StoreName = 'sessions' | 'actions' | 'screenshots' | 'videoChunks' | 'uploadJobs';
const DB_NAME = 'cua-recorder';
const DB_VERSION = 2;
const STORE_KEYS: StoreName[] = ['sessions', 'actions', 'screenshots', 'videoChunks', 'uploadJobs'];

export type StoredAction = ActionPayload & { createdAt: number };
export type StoredScreenshot = ScreenshotArtifact & { createdAt: number };
export type StoredVideoChunk = VideoChunk & { createdAt: number };
export type StoredSession = SessionState & { createdAt: number };

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

const getBySession = async <T>(storeName: Exclude<StoreName, 'uploadJobs' | 'sessions'>, sessionId: string) => {
  const db = await getDb();
  return new Promise<T[]>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const index = tx.objectStore(storeName).index('sessionId');
    const results: T[] = [];
    const cursorReq = index.openCursor(IDBKeyRange.only(sessionId));
    cursorReq.onerror = () => reject(cursorReq.error);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) {
        resolve(results);
        return;
      }
      results.push(cursor.value as T);
      cursor.continue();
    };
  });
};

const getSessionRecord = async (sessionId: string): Promise<StoredSession | undefined> => {
  const db = await getDb();
  return new Promise<StoredSession | undefined>((resolve, reject) => {
    const tx = db.transaction('sessions', 'readonly');
    const request = tx.objectStore('sessions').get(sessionId);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result as StoredSession | undefined);
  });
};

export type SessionExportBundle = {
  session?: StoredSession;
  actions: StoredAction[];
  screenshots: StoredScreenshot[];
  videoChunks: StoredVideoChunk[];
};

export const loadSessionBundle = async (sessionId: string): Promise<SessionExportBundle> => {
  const [session, actions, screenshots, videoChunks] = await Promise.all([
    getSessionRecord(sessionId),
    getBySession<StoredAction>('actions', sessionId),
    getBySession<StoredScreenshot>('screenshots', sessionId),
    getBySession<StoredVideoChunk>('videoChunks', sessionId),
  ]);
  return {
    session,
    actions: actions.sort((a, b) => a.happenedAt - b.happenedAt),
    screenshots: screenshots.sort((a, b) => a.wallClockCapturedAt - b.wallClockCapturedAt),
    videoChunks: videoChunks.sort((a, b) => a.createdAt - b.createdAt),
  };
};

const blobToU8 = async (blob?: Blob) => (blob ? new Uint8Array(await blob.arrayBuffer()) : undefined);

export const buildSessionArchive = async (sessionId: string) => {
  const { session, actions, screenshots, videoChunks } = await loadSessionBundle(sessionId);
  if (!session) throw new Error('No session found to export');

  const files: Record<string, Uint8Array> = {};

  for (const shot of screenshots) {
    const data = await blobToU8(shot.data);
    if (!data) continue;
    const ext = shot.data?.type?.includes('png') ? 'png' : 'bin';
    const path = `screenshots/${shot.screenshotId}.${ext}`;
    files[path] = data;
    (shot as { blobPath?: string }).blobPath = path;
    delete (shot as { data?: Blob }).data;
  }

  for (const chunk of videoChunks) {
    const data = await blobToU8(chunk.data);
    if (!data) continue;
    const ext = chunk.mimeType?.includes('webm') ? 'webm' : 'bin';
    const path = `video/${chunk.chunkId}.${ext}`;
    files[path] = data;
    (chunk as { blobPath?: string }).blobPath = path;
    delete (chunk as { data?: Blob }).data;
  }

  const manifest = {
    exportedAt: new Date().toISOString(),
    sessionId,
    counts: {
      actions: actions.length,
      screenshots: screenshots.length,
      videoChunks: videoChunks.length,
    },
    session,
    actions,
    screenshots,
    videoChunks,
  };

  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));

  const archive = zipSync(files, { level: 6 });
  const archiveBytes = archive instanceof Uint8Array ? archive : new Uint8Array(archive);
  const archiveBuffer =
    archiveBytes.buffer instanceof ArrayBuffer
      ? archiveBytes.buffer.slice(archiveBytes.byteOffset, archiveBytes.byteOffset + archiveBytes.byteLength)
      : (() => {
          const buffer = new ArrayBuffer(archiveBytes.byteLength);
          new Uint8Array(buffer).set(archiveBytes);
          return buffer;
        })();

  return new Blob([archiveBuffer], { type: 'application/zip' });
};

export const exportSessionArchive = async (sessionId: string) => {
  const blob = await buildSessionArchive(sessionId);
  const safeId = sessionId.slice(0, 8);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `cua-session-${safeId}-${stamp}.zip`;
  return { blob, filename };
};
