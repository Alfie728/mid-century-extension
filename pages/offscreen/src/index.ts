import { isCuaMessage } from '@extension/shared';
import type { ActionPayload, CuaMessage, SessionState } from '@extension/shared';

const log = (...args: unknown[]) => console.log('[CUA][offscreen]', ...args);

let sessionState: SessionState = { status: 'idle' };
const actionBuffer: ActionPayload[] = [];

const sendMessage = (message: CuaMessage) =>
  chrome.runtime.sendMessage(message).catch(error => {
    log('sendMessage error', error);
  });

const handleStart = async (message: CuaMessage, sendResponse?: (response: CuaMessage) => void) => {
  if (sessionState.status === 'recording' && sessionState.sessionId) {
    sendResponse?.({
      type: 'cua/ack',
      payload: { ok: true, session: sessionState, message: 'Already recording' },
    });
    return;
  }

  const now = Date.now();
  const sessionId = sessionState.sessionId ?? crypto.randomUUID();
  const incomingSession =
    'payload' in message && typeof message.payload === 'object'
      ? (message.payload as { session?: SessionState }).session
      : undefined;
  sessionState = {
    sessionId,
    status: 'recording',
    startedAt: incomingSession?.startedAt ?? now,
    source: incomingSession?.source,
  };
  actionBuffer.length = 0;
  log('Session started', sessionId);
  sendResponse?.({ type: 'cua/ack', payload: { ok: true, session: sessionState } });
};

const handleStop = (message: CuaMessage, sendResponse?: (response: CuaMessage) => void) => {
  if (!sessionState.sessionId) {
    sendResponse?.({ type: 'cua/ack', payload: { ok: true, message: 'No active session' } });
    return;
  }

  sessionState = {
    ...sessionState,
    status: 'ended',
    endedAt: Date.now(),
    reason: 'payload' in message ? (message.payload as { reason?: string }).reason : undefined,
  };
  log('Session stopped', sessionState.sessionId);
  actionBuffer.length = 0;
  sendResponse?.({ type: 'cua/ack', payload: { ok: true, session: sessionState } });
};

const handleAction = (payload: ActionPayload) => {
  if (sessionState.status !== 'recording') return;
  actionBuffer.push(payload);
  // TODO: persist to IndexedDB once storage layer is in place
};

const handleStatusRequest = (sendResponse?: (response: CuaMessage) => void) => {
  sendResponse?.({ type: 'cua/status', payload: sessionState });
};

chrome.runtime.onMessage.addListener((message: CuaMessage, _sender, sendResponse) => {
  if (!isCuaMessage(message)) return;

  switch (message.type) {
    case 'cua/offscreen/start':
      void handleStart(message, sendResponse);
      return true;
    case 'cua/offscreen/stop':
      handleStop(message, sendResponse);
      return true;
    case 'cua/offscreen/action':
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
log('Offscreen recorder host ready');
