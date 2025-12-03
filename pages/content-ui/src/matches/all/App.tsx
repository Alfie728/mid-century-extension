import type { CuaMessage, SessionState } from '@extension/shared';
import { useCallback, useEffect, useState } from 'react';
import { FloatingToolbar } from './FloatingToolbar';

export default function App() {
  const [session, setSession] = useState<SessionState>({ status: 'idle' });

  const requestStatus = useCallback(async () => {
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'cua/status-request',
      })) as CuaMessage | undefined;
      if (response?.type === 'cua/status') {
        setSession(response.payload);
      }
    } catch {
      // Ignore errors if background script is not ready
    }
  }, []);

  useEffect(() => {
    void requestStatus();
  }, [requestStatus]);

  useEffect(() => {
    const handleMessage = (message: CuaMessage) => {
      if (message.type === 'cua/status') {
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
