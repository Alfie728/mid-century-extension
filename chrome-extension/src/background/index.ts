import 'webextension-polyfill';
import { isCuaMessage } from '@extension/shared';
import type { ActionPayload, CaptureSourceType, CuaMessage, SessionState } from '@extension/shared';

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen/index.html');
const log = (...args: unknown[]) => console.log('[CUA][background]', ...args);

let sessionState: SessionState = { status: 'idle' };
let offscreenReady = false;
const offscreenQueue: CuaMessage[] = [];

const ensureOffscreenDocument = async () => {
  try {
    if (await chrome.offscreen?.hasDocument?.()) return;
  } catch (error) {
    log('offscreen.hasDocument unavailable', error);
  }

  if (!chrome.offscreen) {
    log('offscreen API not available');
    return;
  }

  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['BLOBS'],
      justification: 'Keep recorder and uploader alive for CUA capture.',
    });
    log('Offscreen document created');
  } catch (error) {
    const message = (error as Error)?.message ?? '';
    if (!message.includes('Already exists')) {
      log('Failed to create offscreen document', error);
    }
  }
};

const flushOffscreenQueue = async () => {
  if (!offscreenReady) return;
  while (offscreenQueue.length) {
    const msg = offscreenQueue.shift();
    if (!msg) break;
    await chrome.runtime.sendMessage(msg).catch(error => {
      log('sendToOffscreen error (flush)', error);
      offscreenQueue.unshift(msg);
    });
  }
};

const sendToOffscreen = async (message: CuaMessage) => {
  if (!offscreenReady) {
    offscreenQueue.push(message);
  } else {
    offscreenQueue.push(message);
    await flushOffscreenQueue();
  }
};

const sendToOptions = (message: CuaMessage) =>
  chrome.runtime.sendMessage(message).catch(error => log('sendToOptions error', error));

const setSessionState = (updates: Partial<SessionState>) => {
  sessionState = { ...sessionState, ...updates };
  return sessionState;
};

const getActiveTabId = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
};

const handleStartRequest = async (payload: { source: CaptureSourceType; streamId?: string }) => {
  if (sessionState.status === 'recording' && sessionState.sessionId) {
    return sessionState;
  }

  const now = Date.now();
  const sessionId = sessionState.sessionId ?? crypto.randomUUID();
  const tabId = await getActiveTabId();
  const nextState: SessionState = {
    sessionId,
    status: 'recording',
    startedAt: now,
    source: { type: payload.source, chosenAt: now, tabId, streamId: payload.streamId },
  };
  setSessionState(nextState);
  await ensureOffscreenDocument();
  await sendToOffscreen({ type: 'cua/offscreen/start', payload: { session: nextState } });
  return nextState;
};

const handleStopRequest = async (reason?: string) => {
  if (!sessionState.sessionId) return sessionState;

  const nextState = setSessionState({ status: 'ended', reason, endedAt: Date.now() });
  await sendToOffscreen({ type: 'cua/offscreen/stop', payload: { reason } });
  return nextState;
};

const handleActionEvent = async (payload: ActionPayload) => {
  log('Forwarding action', payload.type);
  await sendToOffscreen({
    type: 'cua/offscreen/action',
    payload,
  });
  await sendToOptions({
    type: 'cua/action',
    payload,
  });
};

const handleStreamRequest = async (sendResponse: (msg: CuaMessage) => void) => {
  if (!chrome.desktopCapture || typeof chrome.desktopCapture.chooseDesktopMedia !== 'function') {
    sendResponse({
      type: 'cua/stream-response',
      payload: { error: 'desktopCapture API unavailable' },
    });
    return;
  }

  chrome.desktopCapture.chooseDesktopMedia(['tab', 'window', 'screen'], streamId => {
    const err = chrome.runtime.lastError;
    if (err) {
      sendResponse({ type: 'cua/stream-response', payload: { error: err.message } });
      return;
    }
    if (!streamId) {
      sendResponse({ type: 'cua/stream-response', payload: { error: 'User cancelled' } });
      return;
    }
    sendResponse({ type: 'cua/stream-response', payload: { streamId, source: 'screen' } });
  });
};

chrome.runtime.onMessage.addListener((message: CuaMessage, _sender, sendResponse) => {
  if (!isCuaMessage(message)) return;

  switch (message.type) {
    case 'cua/start':
      void handleStartRequest(message.payload).then(session => {
        sendResponse({ type: 'cua/status', payload: session });
      });
      return true;
    case 'cua/stop':
      void handleStopRequest(message.payload?.reason).then(session => {
        sendResponse({ type: 'cua/status', payload: session });
      });
      return true;
    case 'cua/status-request':
      sendResponse({ type: 'cua/status', payload: sessionState });
      return true;
    case 'cua/action':
      void handleActionEvent(message.payload);
      break;
    case 'cua/offscreen-ready':
      offscreenReady = true;
      void flushOffscreenQueue();
      sendResponse({ type: 'cua/status', payload: sessionState });
      return true;
    case 'cua/stream-request':
      handleStreamRequest(sendResponse);
      return true;
    default:
      break;
  }

  return false;
});

log('Background ready');
