import '@src/Popup.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CaptureSourceType, CuaMessage, SessionState } from '@extension/shared';

const sourceOptions: CaptureSourceType[] = ['tab', 'screen'];

const Popup = () => {
  const [session, setSession] = useState<SessionState>({ status: 'idle' });
  const [source, setSource] = useState<CaptureSourceType>('tab');
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
    setLoading(true);
    setError(null);
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'cua/start',
        payload: { source, requestedAt: Date.now() },
      })) as CuaMessage | undefined;
      if (response?.type === 'cua/status') {
        setSession(response.payload);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const stopTracking = async () => {
    setLoading(true);
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'cua/stop',
      })) as CuaMessage | undefined;
      if (response?.type === 'cua/status') {
        setSession(response.payload);
      }
    } catch (err) {
      setError((err as Error).message);
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
          <div className="field">
            <span className="label">Capture</span>
            <div className="toggle">
              {sourceOptions.map(option => (
                <button
                  key={option}
                  className={`toggle-btn${source === option ? 'active' : ''}`}
                  onClick={() => setSource(option)}
                  disabled={loading || session.status === 'recording'}>
                  {option === 'tab' ? 'This tab' : 'Screen'}
                </button>
              ))}
            </div>
          </div>

          <div className="actions">
            <button className="primary" onClick={startTracking} disabled={loading || session.status === 'recording'}>
              {session.status === 'recording' ? 'Recording...' : 'Start tracking'}
            </button>
            <button className="ghost" onClick={stopTracking} disabled={loading || session.status === 'idle'}>
              Stop
            </button>
          </div>
          {error ? <div className="error">{error}</div> : null}
        </div>
      </header>
    </div>
  );
};

export default Popup;
