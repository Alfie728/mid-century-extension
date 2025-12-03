import 'webextension-polyfill';
import { isCuaMessage } from '@extension/shared';
import type { CaptureSourceType, CuaMessage } from '@extension/shared';

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen/index.html');
const log = (...args: unknown[]) => console.log('[CUA][background]', ...args);

const ensureOffscreenDocument = async () => {
  // chrome.offscreen.hasDocument is a newer API not yet in chrome-types
  const offscreenApi = chrome.offscreen as typeof chrome.offscreen & { hasDocument?: () => Promise<boolean> };
  try {
    if (await offscreenApi?.hasDocument?.()) return;
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

const handleStreamRequest = async (
  sources: CaptureSourceType[] | undefined,
  requestId: string | undefined,
  sendResponse: (msg: CuaMessage) => void,
) => {
  if (!chrome.tabCapture || typeof chrome.tabCapture.getMediaStreamId !== 'function') {
    const resp: CuaMessage = {
      type: 'cua/stream-response',
      payload: { error: 'tabCapture API unavailable', requestId },
    };
    sendResponse(resp);
    void chrome.runtime.sendMessage(resp).catch(error => log('stream-response send error', error));
    return;
  }

  const [targetTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' });
  if (!targetTab?.id) {
    const resp: CuaMessage = {
      type: 'cua/stream-response',
      payload: { error: 'No active tab found for capture', requestId },
    };
    sendResponse(resp);
    void chrome.runtime.sendMessage(resp).catch(error => log('stream-response send error', error));
    return;
  }

  await ensureOffscreenDocument();

  // Acknowledge early to keep the message channel happy; send real result separately.
  sendResponse({ type: 'cua/ack', payload: { ok: true } });

  chrome.tabCapture.getMediaStreamId({ targetTabId: targetTab.id }, streamId => {
    // chrome.runtime.lastError is deprecated but still used in callback-based APIs
    const err = (chrome.runtime as typeof chrome.runtime & { lastError?: { message?: string } }).lastError;
    if (err) {
      const resp: CuaMessage = { type: 'cua/stream-response', payload: { error: err.message, requestId } };
      void chrome.runtime.sendMessage(resp).catch(error => log('stream-response send error', error));
      return;
    }
    if (!streamId) {
      const resp: CuaMessage = { type: 'cua/stream-response', payload: { error: 'User cancelled', requestId } };
      void chrome.runtime.sendMessage(resp).catch(error => log('stream-response send error', error));
      return;
    }
    const resp: CuaMessage = { type: 'cua/stream-response', payload: { streamId, source: 'tab', requestId } };
    void chrome.runtime.sendMessage(resp).catch(error => log('stream-response send error', error));
  });
};

chrome.runtime.onMessage.addListener(
  (message: CuaMessage, _sender: chrome.runtime.MessageSender, sendResponse: (response?: CuaMessage) => void) => {
    if (!isCuaMessage(message)) return;

    switch (message.type) {
      case 'cua/stream-request':
        void handleStreamRequest(message.payload?.sources, message.payload?.requestId, sendResponse);
        return true;
      case 'cua/recorder-start':
        void ensureOffscreenDocument()
          .then(() => chrome.runtime.sendMessage(message))
          .catch(error => log('Failed to start recorder (offscreen)', error));
        sendResponse({ type: 'cua/ack', payload: { ok: true } });
        return true;
      case 'cua/recorder-stop':
        void chrome.runtime.sendMessage(message).catch(error => log('Failed to forward recorder-stop', error));
        sendResponse({ type: 'cua/ack', payload: { ok: true } });
        return true;
      case 'cua/action':
        log('Forwarding action', message.payload.type);
        void chrome.runtime
          .sendMessage({ type: 'cua/action', payload: message.payload })
          .catch(error => log('Failed to forward action', error));
        break;
      case 'cua/status-request':
        // Forward status request to offscreen and relay the response back
        log('Forwarding status request to offscreen');
        void chrome.runtime
          .sendMessage(message)
          .then(response => {
            log('Status request response from offscreen:', response);
            sendResponse(response);
          })
          .catch(error => {
            log('Failed to forward status request', error);
            sendResponse({ type: 'cua/status', payload: { status: 'idle' } });
          });
        return true; // Keep channel open for async response
      case 'cua/status':
        // Broadcast status to all tabs
        log('Received status update:', message.payload);
        void (async () => {
          try {
            const tabs = await chrome.tabs.query({});
            log(`Broadcasting status to ${tabs.length} tabs`);
            for (const tab of tabs) {
              if (tab.id) {
                log(`Sending status to tab ${tab.id}: ${tab.url?.slice(0, 50)}`);
                chrome.tabs.sendMessage(tab.id, message).catch(err => {
                  log(`Failed to send to tab ${tab.id}:`, err?.message);
                });
              }
            }
          } catch (error) {
            log('Failed to broadcast status', error);
          }
        })();
        break;
      default:
        break;
    }

    return false;
  },
);

log('Background ready');
