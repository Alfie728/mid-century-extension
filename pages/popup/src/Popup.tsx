import '@src/Popup.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CuaMessage, SessionState } from '@extension/shared';

const Popup = () => {
  const [session, setSession] = useState<SessionState>({ status: 'idle' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recorderTabIdRef = useRef<number | null>(null);

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
      const { tabId } = await ensureRecorderTab();
      recorderTabIdRef.current = tabId;
      chrome.tabs.update(tabId, { active: true });
      setSession({ status: 'recording', source: { type: 'screen', chosenAt: Date.now() } });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const stopTracking = async () => {
    setLoading(true);
    try {
      await chrome.runtime.sendMessage({ type: 'cua/recorder-stop' } satisfies CuaMessage);
      setSession({ status: 'ended' });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const ensureRecorderTab = async (): Promise<{ tabId: number; created: boolean }> => {
    if (recorderTabIdRef.current) {
      try {
        const tab = await chrome.tabs.get(recorderTabIdRef.current);
        if (tab?.id) return { tabId: tab.id, created: false };
      } catch {
        recorderTabIdRef.current = null;
      }
    }
    const tab = await chrome.tabs.create({
      url: chrome.runtime.getURL('options/index.html?auto=1'),
      active: true,
    });
    return { tabId: tab.id!, created: true };
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
          <div className="actions">
            <button className="primary wide" onClick={startTracking} disabled={loading}>
              Open recorder
            </button>
            <button className="ghost wide" onClick={stopTracking} disabled={loading}>
              Stop recording
            </button>
          </div>
          {error ? <div className="error">{error}</div> : null}
        </div>
      </header>
    </div>
  );
};

export default Popup;
