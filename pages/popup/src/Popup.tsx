import '@src/Popup.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CuaMessage, SessionState } from '@extension/shared';

const Popup = () => {
  const [session, setSession] = useState<SessionState>({ status: 'idle' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const statusLabel = useMemo(() => {
    switch (session.status) {
      case 'recording':
        return 'Recording';
      case 'paused':
        return 'Paused';
      case 'ended':
        return 'Ended';
      default:
        return 'Idle';
    }
  }, [session.status]);

  const requestStatus = useCallback(async () => {
    const response = (await chrome.runtime.sendMessage({
      type: 'cua/status-request',
    })) as CuaMessage | undefined;
    if (response?.type === 'cua/status') {
      setSession(response.payload);
    }
  }, []);

  const startTracking = async () => {
    console.log('startTracking');
    setLoading(true);
    setError(null);
    try {
      const requestId = crypto.randomUUID();
      const immediateResponse = (await chrome.runtime.sendMessage({
        type: 'cua/stream-request',
        payload: { sources: ['tab', 'window', 'screen'], requestId },
      })) as CuaMessage | undefined;
      if (immediateResponse?.type === 'cua/stream-response' && immediateResponse.payload?.error) {
        throw new Error(immediateResponse.payload.error);
      }
      // Offscreen will receive the stream-response directly and start recording; we just wait for status updates.
      setSession(prev => ({ ...prev, status: 'consenting' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

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

  return (
    <div className="App">
      <header className="App-header">
        <div className="header-row">
          <div className={`pill pill-${session.status}`}>{statusLabel}</div>
          <span className="session-id">{session.sessionId ?? 'no session yet'}</span>
        </div>

        <div className="card">
          <div className="actions">
            {session.status !== 'recording' && (
              <button className="primary wide" onClick={startTracking} disabled={loading}>
                Start recording
              </button>
            )}
          </div>
          {error ? <div className="error">{error}</div> : null}
        </div>
      </header>
    </div>
  );
};

export default Popup;
