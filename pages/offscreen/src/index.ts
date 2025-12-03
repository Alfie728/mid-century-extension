import {
  clearAll,
  enforceLimits,
  getDb,
  listRecentActions,
  saveAction,
  saveScreenshot,
  saveSession,
  saveVideoChunk,
} from './db.js';
import { exportSessionArchive } from './export.js';
import { isCuaMessage } from '@extension/shared';
import type { ActionPayload, CaptureSourceType, CuaMessage, SessionState } from '@extension/shared';

const log = (...args: unknown[]) => console.log('[CUA][offscreen]', ...args);

const BEFORE_DELAY_MS = 0;
const AFTER_DELAY_MS = 300;
const DEFAULT_TIMESLICE_MS = 5000;
const FALLBACK_VIDEO_WIDTH = 1920;
const FALLBACK_VIDEO_HEIGHT = 1080;

let sessionState: SessionState = { status: 'idle' };
let mediaRecorder: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let baseStream: MediaStream | null = null;
let videoEl: HTMLVideoElement | null = null;
let canvasEl: HTMLCanvasElement | null = null;
const pendingWrites: Promise<unknown>[] = [];
let processedActionIds = new Set<string>();
let stopping = false;

const sendMessage = (message: CuaMessage) =>
  chrome.runtime.sendMessage(message).catch(error => {
    log('sendMessage error', error);
  });

const sendStatus = () => {
  void sendMessage({ type: 'cua/status', payload: sessionState });
};

const trackWrite = <T>(work: Promise<T>): Promise<T> => {
  const tracked = work
    .catch(err => {
      log('persistence failed', err);
      throw err;
    })
    .finally(() => {
      const idx = pendingWrites.indexOf(tracked);
      if (idx >= 0) pendingWrites.splice(idx, 1);
    });
  pendingWrites.push(tracked);
  return tracked;
};

const waitForPendingWrites = async () => {
  const pending = [...pendingWrites];
  pendingWrites.length = 0;
  if (pending.length === 0) return;
  await Promise.allSettled(pending);
};

const triggerDownload = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

const ensureVideoCanvas = async (activeStream: MediaStream) => {
  if (!videoEl) {
    videoEl = document.createElement('video');
    videoEl.muted = true;
    videoEl.playsInline = true;
  }
  if (!canvasEl) {
    canvasEl = document.createElement('canvas');
  }
  const trackSettings = activeStream.getVideoTracks()[0]?.getSettings();
  const width = trackSettings?.width ?? FALLBACK_VIDEO_WIDTH;
  const height = trackSettings?.height ?? FALLBACK_VIDEO_HEIGHT;
  canvasEl.width = width;
  canvasEl.height = height;
  videoEl.width = width;
  videoEl.height = height;
  videoEl.srcObject = activeStream;
  try {
    await videoEl.play();
  } catch (error) {
    log('video play failed', error);
  }
};

const startRecording = async (payload?: { streamId?: string; source?: CaptureSourceType }) => {
  if (!payload?.streamId) throw new Error('Missing streamId for recording');

  // stop any existing stream/recorder first
  if (mediaRecorder || stream) {
    await waitForPendingWrites();
    stream?.getTracks().forEach(t => t.stop());
    mediaRecorder?.stop();
    mediaRecorder = null;
    stream = null;
    baseStream = null;
  }

  processedActionIds = new Set();

  const requestStream = async (chromeMediaSource: 'desktop' | 'tab') => {
    const mediaConstraints: MediaStreamConstraints = {
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource,
          chromeMediaSourceId: payload.streamId,
        },
      } as unknown as MediaTrackConstraints,
    };
    log('Starting capture with constraints', { streamId: payload.streamId, chromeMediaSource });
    return navigator.mediaDevices.getUserMedia(mediaConstraints);
  };

  try {
    const sourceType: 'tab' | 'desktop' = payload.source === 'tab' ? 'tab' : 'desktop';
    baseStream = await requestStream(sourceType);
  } catch (error) {
    log('getUserMedia failed', error);
    throw error;
  }

  stream = baseStream;

  stream.getTracks().forEach(track => {
    track.onended = () => {
      log('Track ended, stopping recording');
      void stopRecording('stream-ended');
    };
  });

  await ensureVideoCanvas(stream);

  const sessionId = crypto.randomUUID();
  sessionState = {
    sessionId,
    status: 'recording',
    startedAt: Date.now(),
    source: { type: payload.source ?? 'screen', streamId: payload.streamId, chosenAt: Date.now() },
  };

  await saveSession(sessionState);
  await enforceLimits();

  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(
    m => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m),
  );
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_000_000 });
  recorder.ondataavailable = event => {
    if (!event.data || event.data.size === 0) return;
    const work = (async () => {
      await saveVideoChunk({
        chunkId: crypto.randomUUID(),
        sessionId,
        wallClockCapturedAt: Date.now(),
        timecode: event.timecode,
        mimeType: event.data.type,
        data: event.data,
      });
      await enforceLimits();
    })();
    void trackWrite(work);
  };
  recorder.onerror = evt => log('MediaRecorder error', evt.error?.message ?? 'unknown error');
  recorder.onstop = () => log('MediaRecorder stopped');
  recorder.start(DEFAULT_TIMESLICE_MS);
  mediaRecorder = recorder;
  sendStatus();
  log('Recording started', sessionId);
};

const stopRecording = async (reason?: string) => {
  if (stopping) return;
  if (sessionState.status !== 'recording' && !mediaRecorder && !stream) return;
  stopping = true;
  const currentSessionId = sessionState.sessionId;
  const recorder = mediaRecorder;

  if (sessionState.status === 'recording') {
    sessionState = { ...sessionState, status: 'stopping', reason };
    sendStatus();
  }

  const waitForStop =
    recorder && recorder.state !== 'inactive'
      ? new Promise<void>(resolve => recorder.addEventListener('stop', () => resolve(), { once: true }))
      : Promise.resolve();

  if (recorder && recorder.state !== 'inactive') {
    recorder.stop();
  }

  stream?.getTracks().forEach(t => t.stop());
  baseStream?.getTracks().forEach(t => t.stop());
  stream = null;
  baseStream = null;
  mediaRecorder = null;

  await waitForStop;
  await waitForPendingWrites();

  sessionState = { ...sessionState, status: 'ended', endedAt: Date.now(), reason };
  await saveSession(sessionState);
  sendStatus();

  if (currentSessionId) {
    try {
      const { blob, filename } = await exportSessionArchive(currentSessionId);
      triggerDownload(blob, filename);
    } catch (error) {
      log('Failed to export recording', error);
    }
  }
  stopping = false;
};

const captureScreenshot = async (action: ActionPayload, phase: 'before' | 'after', delayMs: number) => {
  if (!canvasEl || !videoEl) return;
  if (delayMs > 0) {
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  const ctx = canvasEl.getContext('2d');
  if (!ctx) return;
  ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
  const blob = await new Promise<Blob | null>(resolve => canvasEl?.toBlob(b => resolve(b), 'image/png'));
  if (!blob) return;
  const capturedAt = Date.now();
  await saveScreenshot({
    screenshotId: crypto.randomUUID(),
    sessionId: sessionState.sessionId,
    actionId: action.actionId,
    phase,
    wallClockCapturedAt: capturedAt,
    captureLatencyMs: capturedAt - action.happenedAt,
    streamTimestamp: typeof videoEl.currentTime === 'number' ? videoEl.currentTime : undefined,
    data: blob,
  });
  await enforceLimits();
};

const handleAction = (payload: ActionPayload) => {
  if (sessionState.status !== 'recording' || !sessionState.sessionId) return;
  if (processedActionIds.has(payload.actionId)) return;
  processedActionIds.add(payload.actionId);
  const action: ActionPayload = { ...payload, sessionId: sessionState.sessionId };
  void trackWrite(
    saveAction(action)
      .then(() => enforceLimits())
      .catch(error => log('Failed to save action', error)),
  );
  void trackWrite(captureScreenshot(action, 'before', BEFORE_DELAY_MS));
  void trackWrite(captureScreenshot(action, 'after', AFTER_DELAY_MS));
};

type MessageResponse = (response: CuaMessage) => void;

const handleStatusRequest = (sendResponse: MessageResponse) => {
  sendResponse({ type: 'cua/status', payload: sessionState });
};

chrome.runtime.onMessage.addListener((message: CuaMessage, _, sendResponse: MessageResponse) => {
  if (!isCuaMessage(message)) return;

  switch (message.type) {
    case 'cua/recorder-start':
      void startRecording(message.payload)
        .then(() => sendResponse({ type: 'cua/ack', payload: { ok: true, session: sessionState } }))
        .catch((error: Error) => sendResponse({ type: 'cua/ack', payload: { ok: false, message: error?.message } }));
      return true;
    case 'cua/recorder-stop':
      void stopRecording(message.payload?.reason).then(() =>
        sendResponse({ type: 'cua/ack', payload: { ok: true, session: sessionState } }),
      );
      return true;
    case 'cua/stream-response':
      console.log('Stream response received', message);
      if (message.payload?.streamId) {
        void startRecording({ streamId: message.payload.streamId, source: message.payload.source }).catch(error =>
          log('Failed to start recording from stream-response', error),
        );
      } else if (message.payload?.error) {
        log('Stream selection failed', message.payload.error);
        sessionState = { status: 'idle', reason: message.payload.error };
        sendStatus();
      }
      break;
    case 'cua/action':
      handleAction(message.payload);
      break;
    case 'cua/status-request':
      handleStatusRequest(sendResponse);
      return true;
    default:
      break;
  }

  return false;
});

void sendMessage({ type: 'cua/offscreen-ready', payload: { sessionId: sessionState.sessionId } });
declare global {
  var __cuaDebug: { listRecentActions: typeof listRecentActions; clearAll: typeof clearAll } | undefined;
}

void getDb()
  .then(async () => {
    globalThis.__cuaDebug = { listRecentActions, clearAll };
    void sendMessage({ type: 'cua/offscreen-ready', payload: { sessionId: sessionState.sessionId } });
    log('Offscreen recorder host ready');
  })
  .catch(error => {
    log('Failed to open IndexedDB', error);
    void sendMessage({ type: 'cua/offscreen-ready', payload: { sessionId: sessionState.sessionId } });
  });
