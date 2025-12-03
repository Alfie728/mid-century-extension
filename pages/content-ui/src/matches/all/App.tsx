import type { CuaMessage, SessionState } from '@extension/shared';
import { useCallback, useEffect, useState } from 'react';
import { FloatingToolbar } from './FloatingToolbar';

export default function App() {
  const [session, setSession] = useState<SessionState>({ status: 'idle' });

  console.log('[CUA][content-ui] App rendered, status:', session.status);

  const requestStatus = useCallback(async () => {
    console.log('[CUA][content-ui] Requesting status...');
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'cua/status-request',
      })) as CuaMessage | undefined;
      console.log('[CUA][content-ui] Status response:', response);
      if (response?.type === 'cua/status') {
        setSession(response.payload);
      }
    } catch (e) {
      // Ignore errors if background script is not ready
      console.debug('[CUA][content-ui] Failed to request status', e);
    }
  }, []);

  useEffect(() => {
    void requestStatus();
  }, [requestStatus]);

  useEffect(() => {
    const handleMessage = (message: CuaMessage) => {
      console.log('[CUA][content-ui] Received message:', message);
      if (message.type === 'cua/status') {
        console.log('[CUA][content-ui] Setting session to:', message.payload);
        setSession(message.payload);
      }
      return undefined;
    };
    chrome.runtime.onMessage.addListener(handleMessage);
    return () => chrome.runtime.onMessage.removeListener(handleMessage);
  }, []);

  if (session.status !== 'recording') {
    return null;
  }

  return <FloatingToolbar />;
}
