import { strToU8, zipSync } from 'fflate';
import { getDb } from './db.js';
import type { StoredAction, StoredScreenshot, StoredSession, StoredVideoChunk } from './db.js';

type StoreName = 'sessions' | 'actions' | 'screenshots' | 'videoChunks' | 'uploadJobs';

export type SessionExportBundle = {
  session?: StoredSession;
  actions: StoredAction[];
  screenshots: StoredScreenshot[];
  videoChunks: StoredVideoChunk[];
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
