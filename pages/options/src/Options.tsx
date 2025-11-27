import '@src/Options.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActionPayload, CaptureSourceType, CuaMessage, SessionState } from '@extension/shared';
import { saveAction, saveSession, saveScreenshot, saveVideoChunk, enforceLimits } from './storage.js';

const VIDEO_WIDTH = 1920;
const VIDEO_HEIGHT = 1080;
const DEFAULT_TIMESLICE_MS = 5000;

const sourceOptions: CaptureSourceType[] = ['tab', 'screen'];

const Options = () => {
  const [session, setSession] = useState<SessionState>({ status: 'idle' });
  const [source, setSource] = useState<CaptureSourceType>('screen');
  const [streamId, setStreamId] = useState<string | undefined>();
  const [status, setStatus] = useState('Idle');
  const [error, setError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const startStream = useCallback(
    async (overrideStreamId?: string) => {
      setError(null);
      setStatus('Starting…');
      // Ensure any prior recorder/stream is stopped before starting a new one
      if (mediaRecorderRef.current || streamRef.current) {
        stopStream();
      }
      const idToUse = overrideStreamId ?? streamId;
      if (!idToUse) {
        setError('Select a source first');
        setStatus('Idle');
        return;
      }
      try {
        console.log('[CUA][options] starting capture with streamId', idToUse);
        const constraints = {
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: idToUse,
              maxWidth: VIDEO_WIDTH,
              maxHeight: VIDEO_HEIGHT,
              maxFrameRate: 30,
            },
          },
        } as unknown as MediaStreamConstraints;

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        console.log(
          '[CUA][options] stream acquired',
          stream.getTracks().map(t => t.kind),
        );
        streamRef.current = stream;
        const video = document.createElement('video');
        video.srcObject = stream;
        video.muted = true;
        await video.play();
        videoRef.current = video;

        const canvas = document.createElement('canvas');
        canvas.width = VIDEO_WIDTH;
        canvas.height = VIDEO_HEIGHT;
        canvasRef.current = canvas;

        const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(
          m => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m),
        );
        const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_000_000 });
        recorder.ondataavailable = async event => {
          if (!event.data || event.data.size === 0) return;
          console.log('[CUA][options] chunk available', {
            size: event.data.size,
            type: event.data.type,
            timecode: event.timecode,
          });
          await saveVideoChunk({
            chunkId: crypto.randomUUID(),
            sessionId: session.sessionId,
            wallClockCapturedAt: Date.now(),
            timecode: event.timecode,
            mimeType: event.data.type,
            data: event.data,
          });
          await enforceLimits();
        };
        recorder.onerror = evt => setError(evt.error?.message ?? 'MediaRecorder error');
        recorder.start(DEFAULT_TIMESLICE_MS);
        console.log('[CUA][options] MediaRecorder started', { mime });
        mediaRecorderRef.current = recorder;
        const sessionId = session.sessionId ?? crypto.randomUUID();
        const newState: SessionState = {
          sessionId,
          status: 'recording',
          startedAt: Date.now(),
          source: { type: 'screen', streamId: idToUse, chosenAt: Date.now() },
        };
        setSession(newState);
        await saveSession(newState);
        setStatus('Recording');
      } catch (err) {
        setError((err as Error).message);
        setStatus('Error');
        console.error('[CUA][options] startStream failed', err);
      }
    },
    [session.sessionId, streamId],
  );

  const requestStreamId = useCallback(async () => {
    setError(null);
    try {
      const sources = source === 'tab' ? ['tab'] : ['screen', 'window'];
      const id = await new Promise<string | undefined>((resolve, reject) => {
        chrome.desktopCapture.chooseDesktopMedia(sources, chosen => {
          const err = chrome.runtime.lastError;
          if (err) {
            reject(new Error(err.message));
            return;
          }
          resolve(chosen ?? undefined);
        });
      });
      if (!id) throw new Error('User cancelled capture');
      setStreamId(id);
      setStatus('Source selected');
      await startStream(id);
    } catch (err) {
      setError((err as Error).message);
      setStatus('Error');
    }
  }, [source, startStream]);

  const stopStream = () => {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    setSession(prev => ({ ...prev, status: 'ended', endedAt: Date.now() }));
    setStatus('Stopped');
  };

  const handleAction = useCallback(
    async (action: ActionPayload) => {
      if (session.status !== 'recording') return;
      const actionWithSession: ActionPayload = { ...action, sessionId: session.sessionId };
      console.log('[CUA][options] action received', { type: action.type, actionId: action.actionId });
      await saveAction(actionWithSession);
      if (!videoRef.current || !canvasRef.current) return;
      const ctx = canvasRef.current.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(videoRef.current, 0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
      const blob = await new Promise<Blob | null>(resolve => canvasRef.current?.toBlob(b => resolve(b), 'image/png'));
      if (!blob) return;
      console.log('[CUA][options] screenshot captured', { size: blob.size });
      await saveScreenshot({
        screenshotId: crypto.randomUUID(),
        sessionId: session.sessionId,
        actionId: action.actionId,
        phase: 'during',
        wallClockCapturedAt: Date.now(),
        data: blob,
      });
      await enforceLimits();
    },
    [session.sessionId, session.status],
  );

  useEffect(() => {
    const listener = (message: CuaMessage) => {
      if (message.type === 'cua/action') {
        console.log('[CUA][options] action message', message.payload?.type);
        void handleAction(message.payload);
      } else if (message.type === 'cua/recorder-start') {
        void requestStreamId();
      } else if (message.type === 'cua/recorder-stop') {
        stopStream();
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [handleAction, requestStreamId, session.status]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('auto') === '1' && session.status !== 'recording') {
      void requestStreamId();
    }
  }, [requestStreamId, session.status]);

  return (
    <div id="app-container">
      <div className="shell">
        <div className="header">
          <div
            className={`status ${session.status === 'recording' ? 'status-recording' : ''} ${status === 'Error' ? 'status-error' : ''}`}>
            {status}
          </div>
          <div className="hint">{session.sessionId ? `Session ${session.sessionId.slice(0, 6)}…` : 'No session'}</div>
        </div>

        <div className="card">
          <div className="row">
            <div className="field">
              <span className="label">Capture</span>
              <div className="toggle">
                {sourceOptions.map(option => (
                  <button
                    key={option}
                    className={`toggle-btn${source === option ? 'active' : ''}`}
                    onClick={() => setSource(option)}
                    disabled={session.status === 'recording'}>
                    {option === 'tab' ? 'Tab' : 'Screen/Window'}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <span className="label">Controls</span>
              <div className="row">
                <button className="btn btn-ghost" onClick={requestStreamId} disabled={session.status === 'recording'}>
                  {streamId ? 'Re-select source' : 'Select source'}
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => startStream(streamId)}
                  disabled={session.status === 'recording'}>
                  {session.status === 'recording' ? 'Recording…' : 'Start'}
                </button>
                <button className="btn btn-ghost" onClick={stopStream} disabled={session.status !== 'recording'}>
                  Stop
                </button>
              </div>
              {streamId ? <div className="hint">Source selected: {streamId.slice(0, 8)}…</div> : null}
            </div>
          </div>

          {error ? <div className="error">{error}</div> : null}
        </div>
      </div>
    </div>
  );
};

export default Options;
