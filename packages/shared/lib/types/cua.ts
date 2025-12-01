export type CaptureSourceType = 'tab' | 'screen' | 'window';

export interface SelectedSource {
  type: CaptureSourceType;
  streamId?: string;
  tabId?: number;
  chosenAt?: number;
  audio?: boolean;
}

export type SessionStatus = 'idle' | 'consenting' | 'recording' | 'paused' | 'stopping' | 'ended';

export interface SessionState {
  sessionId?: string;
  status: SessionStatus;
  source?: SelectedSource;
  startedAt?: number;
  endedAt?: number;
  reason?: string;
}

export type ActionType = 'click' | 'scroll' | 'drag' | 'keypress';

export interface DomMeta {
  tag: string;
  id?: string;
  classList?: string[];
  name?: string;
  type?: string;
  selectors: string[];
  textSample?: string;
  inputType?: string;
  coords: {
    clientX?: number;
    clientY?: number;
    pageX?: number;
    pageY?: number;
    screenX?: number;
    screenY?: number;
    scrollX: number;
    scrollY: number;
  };
}

export interface ActionPayload {
  actionId: string;
  sessionId?: string;
  type: ActionType;
  domMeta: DomMeta;
  happenedAt: number;
  perfTime: number;
  streamTimestamp?: number;
  keyMeta?: {
    key: string;
    code: string;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  };
  pointerMeta?: {
    button?: number;
    buttons?: number;
  };
}

export interface ScreenshotArtifact {
  screenshotId: string;
  sessionId?: string;
  actionId?: string;
  phase?: 'before' | 'after' | 'during';
  streamTimestamp?: number;
  wallClockCapturedAt: number;
  captureLatencyMs?: number;
  blobRef?: string;
  data?: Blob;
}

export interface VideoChunk {
  chunkId: string;
  sessionId?: string;
  startStreamTime?: number;
  endStreamTime?: number;
  timecode?: number;
  wallClockCapturedAt: number;
  mimeType?: string;
  bitrate?: number;
  blobRef?: string;
  data?: Blob;
}

export interface UploadJob {
  jobId: string;
  itemRefs: string[];
  status: 'pending' | 'uploading' | 'failed' | 'done';
  retries: number;
  lastError?: string;
  createdAt: number;
}

export type CuaMessage =
  | { type: 'cua/start'; payload: { source: CaptureSourceType; requestedAt: number } }
  | { type: 'cua/stop'; payload?: { reason?: string } }
  | { type: 'cua/pause'; payload?: { reason?: string } }
  | { type: 'cua/resume' }
  | { type: 'cua/status-request' }
  | { type: 'cua/status'; payload: SessionState }
  | { type: 'cua/action'; payload: ActionPayload }
  | { type: 'cua/offscreen/start'; payload: { session: SessionState } }
  | { type: 'cua/offscreen/stop'; payload?: { reason?: string } }
  | { type: 'cua/offscreen/action'; payload: ActionPayload }
  | { type: 'cua/offscreen-ready'; payload?: { sessionId?: string } }
  | { type: 'cua/stream-request'; payload: { sources: CaptureSourceType[] } }
  | { type: 'cua/stream-response'; payload: { streamId?: string; error?: string; source?: CaptureSourceType } }
  | { type: 'cua/recorder-start'; payload?: { streamId?: string; source?: CaptureSourceType; requestedAt?: number } }
  | { type: 'cua/recorder-stop' }
  | { type: 'cua/stream-dead'; payload?: { sessionId?: string; reason?: string } }
  | { type: 'cua/ack'; payload: { ok: boolean; message?: string; session?: SessionState } };

export const isCuaMessage = (message: unknown): message is CuaMessage =>
  Boolean(
    message &&
      typeof message === 'object' &&
      'type' in message &&
      typeof (message as { type: unknown }).type === 'string' &&
      (message as { type: string }).type.startsWith('cua/'),
  );
