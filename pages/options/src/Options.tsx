import '@src/Options.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActionPayload, CaptureSourceType, CuaMessage, SessionState } from '@extension/shared';
import {
  saveAction,
  saveSession,
  saveScreenshot,
  saveVideoChunk,
  enforceLimits,
  exportSessionArchive,
} from './storage.js';

const VIDEO_WIDTH = 1920;
const VIDEO_HEIGHT = 1080;
const DEFAULT_TIMESLICE_MS = 5000;

const sourceOptions: CaptureSourceType[] = ['tab', 'screen'];

const Options = () => {
  const [session, setSession] = useState<SessionState>({ status: 'idle' });
  const [source, setSource] = useState<CaptureSourceType>('tab');
  const [streamId, setStreamId] = useState<string | undefined>();
  const [status, setStatus] = useState('Idle');
  const [error, setError] = useState<string | null>(null);
  const [exportedFile, setExportedFile] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionIdRef = useRef<string | undefined>(undefined);
  const pendingWritesRef = useRef<Promise<unknown>[]>([]);
  const processedActionIdsRef = useRef<Set<string>>(new Set());
  const BEFORE_DELAY_MS = 0; // best-effort "before" capture; we can't time-travel pre-event
  const AFTER_DELAY_MS = 300; // capture after UI settles

  const trackWrite = useCallback(<T,>(work: Promise<T>): Promise<T> => {
    const tracked = work
      .catch(err => {
        console.error('[CUA][options] persistence failed', err);
        throw err;
      })
      .finally(() => {
        const idx = pendingWritesRef.current.indexOf(tracked);
        if (idx >= 0) pendingWritesRef.current.splice(idx, 1);
      });
    pendingWritesRef.current.push(tracked);
    return tracked;
  }, []);

  const waitForPendingWrites = useCallback(async () => {
    const pending = [...pendingWritesRef.current];
    pendingWritesRef.current.length = 0;
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
  }, []);

  const triggerDownload = useCallback((blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }, []);

  const exportRecording = useCallback(
    async (sessionId: string) => {
      setStatus('Exporting…');
      setExportedFile(null);
      try {
        const { blob, filename } = await exportSessionArchive(sessionId);
        triggerDownload(blob, filename);
        setExportedFile(filename);
        setStatus('Exported');
      } catch (err) {
        setError(`Failed to export recording: ${(err as Error).message}`);
        setStatus('Error');
      }
    },
    [triggerDownload],
  );

  const stopStream = useCallback(async () => {
    if (session.status !== 'recording' && !mediaRecorderRef.current && !streamRef.current) {
      return;
    }
    const currentSessionId = sessionIdRef.current ?? session.sessionId;
    setStatus('Stopping…');
    const recorder = mediaRecorderRef.current;
    const waitForStop =
      recorder && recorder.state !== 'inactive'
        ? new Promise<void>(resolve => recorder.addEventListener('stop', () => resolve(), { once: true }))
        : Promise.resolve();

    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    mediaRecorderRef.current = null;

    await waitForStop;
    await waitForPendingWrites();

    setSession(prev => ({ ...prev, status: 'ended', endedAt: Date.now() }));
    setStatus('Stopped');

    if (currentSessionId) {
      await exportRecording(currentSessionId);
    }
    sessionIdRef.current = undefined;
  }, [exportRecording, session.sessionId, session.status, waitForPendingWrites]);

  const startStream = useCallback(
    async (overrideStreamId?: string) => {
      setError(null);
      setStatus('Starting…');
      setExportedFile(null);
      // Ensure any prior recorder/stream is stopped before starting a new one
      if (mediaRecorderRef.current || streamRef.current) {
        await stopStream();
      }
      const idToUse = overrideStreamId ?? streamId;
      if (!idToUse) {
        setError('Select a source first');
        setStatus('Idle');
        return;
      }
      try {
        console.log('[CUA][options] starting capture', { streamId: idToUse, source });
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

        console.log('[CUA][options] constraints', constraints);
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        console.log(
          '[CUA][options] stream acquired',
          stream.getTracks().map(t => t.kind),
        );
        streamRef.current = stream;
        stream.getTracks().forEach(track => {
          track.onended = () => {
            console.log('[CUA][options] track ended');
            void stopStream();
          };
        });
        const video = document.createElement('video');
        video.srcObject = stream;
        video.muted = true;
        await video.play();
        videoRef.current = video;

        const canvas = document.createElement('canvas');
        canvas.width = VIDEO_WIDTH;
        canvas.height = VIDEO_HEIGHT;
        canvasRef.current = canvas;

        const sessionId = crypto.randomUUID();
        sessionIdRef.current = sessionId;
        processedActionIdsRef.current = new Set();
        const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(
          m => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m),
        );
        const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_000_000 });
        recorder.ondataavailable = event => {
          if (!event.data || event.data.size === 0) return;
          const work = (async () => {
            console.log('[CUA][options] chunk available', {
              size: event.data.size,
              type: event.data.type,
              timecode: event.timecode,
            });
            await saveVideoChunk({
              chunkId: crypto.randomUUID(),
              sessionId,
              wallClockCapturedAt: Date.now(),
              timecode: event.timecode,
              mimeType: event.data.type,
              data: event.data,
            });
            await enforceLimits();
          })();
          void trackWrite(work);
        };
        recorder.onerror = evt => setError(evt.error?.message ?? 'MediaRecorder error');
        recorder.onstop = () => {
          console.log('[CUA][options] MediaRecorder stopped');
        };
        recorder.start(DEFAULT_TIMESLICE_MS);
        console.log('[CUA][options] MediaRecorder started', { mime });
        mediaRecorderRef.current = recorder;
        const newState: SessionState = {
          sessionId,
          status: 'recording',
          startedAt: Date.now(),
          source: { type: source, streamId: idToUse, chosenAt: Date.now() },
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
    [session.sessionId, source, stopStream, streamId, trackWrite],
  );

  const requestStreamId = useCallback(async () => {
    setError(null);
    try {
      const sources = source === 'tab' ? ['tab'] : ['screen', 'window'];
      console.log('[CUA][options] prompting capture', { source, sources });
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

  const handleAction = useCallback(
    (action: ActionPayload) => {
      if (session.status !== 'recording' || !session.sessionId) return;
      if (processedActionIdsRef.current.has(action.actionId)) return;
      processedActionIdsRef.current.add(action.actionId);
      const actionWithSession: ActionPayload = { ...action, sessionId: session.sessionId };
      console.log('[CUA][options] action received', { type: action.type, actionId: action.actionId });
      void trackWrite(saveAction(actionWithSession));
      if (!videoRef.current || !canvasRef.current) return;
      const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
      const capture = async (phase: 'before' | 'after', delayMs: number) => {
        if (delayMs > 0) await sleep(delayMs);
        const ctx = canvasRef.current?.getContext('2d');
        if (!ctx || !videoRef.current) return;
        ctx.drawImage(videoRef.current, 0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
        const blob = await new Promise<Blob | null>(resolve => canvasRef.current?.toBlob(b => resolve(b), 'image/png'));
        if (!blob) return;
        const capturedAt = Date.now();
        console.log('[CUA][options] screenshot captured', { size: blob.size, phase });
        await saveScreenshot({
          screenshotId: crypto.randomUUID(),
          sessionId: session.sessionId,
          actionId: action.actionId,
          phase,
          wallClockCapturedAt: capturedAt,
          captureLatencyMs: capturedAt - action.happenedAt,
          streamTimestamp: typeof videoRef.current.currentTime === 'number' ? videoRef.current.currentTime : undefined,
          data: blob,
        });
        await enforceLimits();
      };
      void trackWrite(capture('before', BEFORE_DELAY_MS));
      void trackWrite(capture('after', AFTER_DELAY_MS));
    },
    [session.sessionId, session.status, trackWrite],
  );

  useEffect(() => {
    const listener = (message: CuaMessage) => {
      if (message.type === 'cua/action') {
        console.log('[CUA][options] action message', message.payload?.type);
        void handleAction(message.payload);
      } else if (message.type === 'cua/recorder-start') {
        void requestStreamId();
      } else if (message.type === 'cua/recorder-stop') {
        void stopStream();
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [handleAction, requestStreamId, session.status, stopStream]);

  // Auto prompt removed; user must click "Select source"

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
                <button
                  className="btn btn-ghost"
                  onClick={() => void stopStream()}
                  disabled={session.status !== 'recording'}>
                  Stop
                </button>
              </div>
              {streamId ? <div className="hint">Source selected: {streamId.slice(0, 8)}…</div> : null}
              {exportedFile ? <div className="hint">Exported: {exportedFile}</div> : null}
            </div>
          </div>

          {error ? <div className="error">{error}</div> : null}
        </div>
      </div>
    </div>
  );
};

export default Options;
