import type { CuaMessage } from '@extension/shared';
import { useState } from 'react';

export const FloatingToolbar = () => {
  const [loading, setLoading] = useState(false);

  const stopTracking = async () => {
    setLoading(true);
    try {
      const stopResponse = (await chrome.runtime.sendMessage({
        type: 'cua/recorder-stop',
      })) as CuaMessage | undefined;
      if (stopResponse?.type === 'cua/ack' && !stopResponse.payload.ok) {
        throw new Error(stopResponse.payload.message ?? 'Failed to stop recorder');
      }
      // Status update will be handled by the parent component via message listener
    } catch (err) {
      console.error('Failed to stop recording:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <style>{`
        @keyframes pulse-ring {
          0% { transform: scale(0.8); opacity: 0.5; }
          100% { transform: scale(2.4); opacity: 0; }
        }
        .cua-hover-scale:hover { transform: scale(1.05); }
        .cua-hover-bg:hover { background-color: #e2e8f0 !important; }
      `}</style>
      <div
        style={{
          position: 'fixed',
          bottom: '32px',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 2147483647,
          display: 'flex',
          alignItems: 'center',
          gap: '16px',
          padding: '12px 24px',
          backgroundColor: 'rgba(15, 23, 42, 0.3)', // slate-900 with lower opacity
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)', // Safari support
          borderRadius: '9999px',
          boxShadow: '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          transition: 'transform 0.2s',
          border: '1px solid rgba(255,255,255,0.1)',
        }}
        className="cua-hover-scale">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ position: 'relative', display: 'flex', width: '12px', height: '12px' }}>
            <span
              style={{
                position: 'absolute',
                display: 'inline-flex',
                height: '100%',
                width: '100%',
                borderRadius: '50%',
                backgroundColor: '#f87171', // red-400
                opacity: 0.75,
                animation: 'pulse-ring 1.5s cubic-bezier(0, 0, 0.2, 1) infinite',
              }}
            />
            <span
              style={{
                position: 'relative',
                display: 'inline-flex',
                height: '12px',
                width: '12px',
                borderRadius: '50%',
                backgroundColor: '#ef4444', // red-500
              }}
            />
          </div>
          <span style={{ fontSize: '14px', fontWeight: 500, color: 'white', letterSpacing: '0.025em' }}>
            Recording...
          </span>
        </div>
        <div style={{ width: '1px', height: '24px', backgroundColor: '#334155' }} />
        <button
          onClick={stopTracking}
          disabled={loading}
          className="cua-hover-bg"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '32px',
            height: '32px',
            borderRadius: '50%',
            backgroundColor: 'white',
            border: 'none',
            cursor: 'pointer',
            transition: 'background-color 0.2s',
            padding: 0,
          }}
          title="Stop recording">
          <div
            style={{
              width: '12px',
              height: '12px',
              borderRadius: '2px',
              backgroundColor: '#0f172a',
            }}
          />
        </button>
      </div>
    </>
  );
};
