## **1. Architecture (MV3-aware)**

Template: https://github.com/Jonghakseo/chrome-extension-boilerplate-react-vite

- **Interaction Listener** (content script): Captures clicks/scrolls/keys/drags, filters sensitive targets, emits high-level Action events with timestamps and DOM metadata.
- **Background Orchestrator** (service worker): Manages session lifecycle, permissions, state, and messaging between contexts. Avoids owning long-lived streams (SW can suspend).
- **Recorder Host** (offscreen document or pinned extension page): Sole owner of `MediaStream`, `MediaRecorder`, and canvas screenshot pipeline so streams survive SW suspension. Communicates via typed messages.
- **Screenshot Service** (in Recorder Host): Given `MediaStream`, `ActionId`, and phase (before/after), grabs frames and produces `ScreenshotArtifact` with dual timestamps (wall + stream).
- **Video Recording Service** (in Recorder Host): Runs `MediaRecorder` with selected MIME/bitrate/timeslice, indexes emitted chunks by timecode and stream timestamp.
- **Upload Coordinator** (Recorder Host preferred): Batches uploads of actions, screenshots, and video chunks using Web Locks or a BroadcastChannel+IndexedDB mutex fallback so only one uploader runs at a time.

---

## **2. Key APIs and Policies**

### **2.1 Capture Source**
- Prefer `chrome.tabCapture` for tab-only sessions (simpler consent, narrower scope). Fall back to `chrome.desktopCapture.chooseDesktopMedia` for screen/window; show stronger warnings.
- Persist selectedSource: `{ type: "tab" | "screen" | "window", streamId, chosenAt, tabId? }`. If user cancels, keep collecting actions but skip stream-bound artifacts.

### **2.2 Stream Acquisition**
- Recorder Host calls `navigator.mediaDevices.getUserMedia` with `chromeMediaSourceId` from capture API. Handles permission denial/revocation and track `ended` events; emits `stream-dead` to UI.
- Warm up a hidden `<video>` bound to the stream and draw once to canvas before first screenshot to avoid blank frames.

### **2.3 MediaRecorder**
- Capability probe with `MediaRecorder.isTypeSupported`. Ordered candidates: `video/webm;codecs=vp9,opus`, then `vp8,opus`, then `video/webm`.
- Record with timeslices (e.g., 5–10s). Use `dataavailable.timecode` plus a shared `performance.now()` baseline to align chunk windows; store chosen MIME/bitrate and actual timeslice variance.

### **2.4 Screenshots**
- Given ActionId + phase, draw current frame from the warmed `<video>` to an offscreen `<canvas>`, encode to blob. Capture both wall-clock and stream `currentTime`; note capture latency.
- Provide redaction hooks (blur selectors, disable audio if captured).

### **2.5 Upload Coordination**
- Target `navigator.locks` when available. Detect absence and fall back to BroadcastChannel + IndexedDB CAS-based mutex with lease expiration.
- Batch uploads by size/time; mark records uploaded atomically to avoid duplicates. On failure, exponential backoff with cap and poison-pill state after N retries.

---

## **3. Data Model**

- **Session**
    - sessionId
    - createdAt, endedAt
    - source (type, streamId, tabId?, chosenAt)
    - limits (maxBytes, maxDuration)
    - actions: Action[]
    - videoChunks: VideoChunk[]
- **Action**
    - actionId
    - type (click, scroll, drag, keypress)
    - domMeta (element selectors, attributes, coords)
    - happenedAt (wall clock) and localPerf (shared perf baseline)
    - streamTimestamp (time on the stream)
    - beforeScreenshotRef
    - afterScreenshotRef
- **VideoChunk**
    - chunkId
    - sessionId
    - startStreamTime, endStreamTime
    - timecode (from MediaRecorder), wallClockCapturedAt
    - mimeType, bitrate
    - blobRef
- **ScreenshotArtifact**
    - screenshotId
    - sessionId
    - actionId, phase
    - streamTimestamp, wallClockCapturedAt, captureLatencyMs
    - blobRef
- **UploadJob**
    - jobId
    - itemRefs[]
    - status (pending, uploading, failed, done)
    - retries, lastError

---

## **4. Storage and Queueing**

- Use IndexedDB for blobs and metadata; avoid `chrome.storage` for binaries.
- Enforce quotas: max session length, total bytes, per-chunk size. When nearing limits, pause recording and prompt user or evict oldest pending artifacts (configurable).
- Maintain indexes for pending uploads and in-flight locks. Mark uploaded items atomically.

---

## **5. End-to-End Flow (Refined)**

1. User starts tracking in popup/options page; Background sets session state to `consenting`.
2. Capture source chosen via tabCapture (preferred) or desktopCapture; store selectedSource.
3. Background instructs Recorder Host to acquire stream with constraints; Recorder warms video/canvas.
4. Recorder starts MediaRecorder (timesliced) and begins indexing chunks with timecodes.
5. Interaction Listener emits Action events to Background with wall-clock + perf baseline; Background forwards to Recorder.
6. Recorder captures before/after screenshots around the action, attaches stream/wall timestamps, and stores Action + artifacts in IndexedDB.
7. New artifacts enqueue UploadJobs; Upload Coordinator (with lock/mutex) batches uploads to backend, marking successes atomically and backing off on failures.
8. On pause/stop/user close/track end events, Recorder stops tracks/recorder, flushes queues, and Background updates session to `ended`.

---

## **6. Privacy, UX, and Safety**

- Visible recording indicator and pause/stop controls; stronger warning when capturing screen/window. Allowlist/denylist domains; auto-pause on denied domains.
- Filter sensitive inputs (password/CC fields) and avoid storing raw keystrokes unless necessary; support redaction/blur for selectors in screenshots.
- Show retention policy; offer “delete session” and auto-delete after N days. Provide storage usage in UI and warn near limits.

---

## **7. Resilience and Errors**

- Detect and surface: permission denial, stream ended (tab closed), recorder errors, upload auth failures, storage quota exceeded.
- Service worker suspension: Recorder Host keeps stream alive; Background reconnects on wake and rehydrates state from IndexedDB/session store.
- Upload retries with capped backoff; poison-pill after N failures to avoid hot loops; manual retry control in UI.

---

## **8. Testing and Validation**

- Capability tests per Chrome version: which contexts support MediaRecorder + canvas for tab/desktop streams (Recorder Host vs popup vs background).
- Performance tests on mid-tier hardware: CPU/memory for recording + screenshot cadence; tune timeslice, bitrate, screenshot frequency.
- Lock/mutex tests under multi-context races (popup close, background restart); ensure upload resumes without dupes.
- Coverage tests: iframe/shadow DOM capture; CSP blocks; permission revocation mid-session.

---

## **9. Implementation Checklist**

- [x] Manifest and permissions: confirm MV3 service worker, offscreen document (or pinned page) permissions, tabCapture/desktopCapture, scripting, storage, and host permissions; add offscreen page URL.
- [x] Message contracts: define typed message schemas (action, start/stop/pause, stream-dead, upload-status), version them, and set up routing between content ↔ background ↔ Recorder Host.
- [x] State machine: implement session states (`idle`, `consenting`, `recording`, `paused`, `stopping`, `ended`), persist current session metadata, and surface status to UI (basic in-memory only).
- [x] Recorder Host bootstrap: create offscreen/pinned page, hydrate from persisted session, wire warm video/canvas, and manage stream acquisition with constraints using selectedSource. (Offscreen scaffold exists; stream work pending.)
- [ ] MediaRecorder pipeline: capability probe for MIME/bitrate, start recorder with timeslice, capture `dataavailable` with timecodes, and persist chunk metadata + blobs.
- [ ] Screenshot service: implement before/after capture around actions, record wall/stream timestamps + latency, and apply optional redaction/blur hooks.
- [x] Interaction Listener: capture click/scroll/drag/key events, normalize coordinates/selectors, filter sensitive fields, handle iframe/shadow DOM injection where permitted, and send actions with wall + perf baselines.
- [ ] Timing alignment: establish shared `performance.now()` baseline across contexts; store wall-clock + stream `currentTime` for all artifacts; handle latency skew.
- [~] Storage layer: define IndexedDB stores for sessions, actions, screenshots, videoChunks, uploadJobs; implement atomic writes, size tracking, eviction/quota enforcement, and cleanup routines. (Stores defined; sessions/actions/screenshots/videoChunks persisted with eviction; uploadJobs wiring pending.)
- [ ] Upload coordination: detect Web Locks support; implement lock fallback via BroadcastChannel + IndexedDB mutex; batch uploads, mark success atomically, and backoff/retry with cap.
- [x] UX flows: popup/options UI for start/pause/stop, capture scope warning (tab vs screen), recording indicator, storage usage display, and error toasts (permission denied, stream ended, quota). (Basic popup implemented; errors minimal.)
- [ ] Privacy/safety: allowlist/denylist domains, auto-pause on denied domains, optional no-audio mode, retention settings (auto-delete after N days), and “delete session” control.
- [ ] Resilience: handle stream track `ended`, recorder errors, service worker suspension (rehydrate Recorder Host), re-auth for uploads, and poison-pill after repeated failures.
- [ ] Testing: capability tests per Chrome version/context, performance profiling (CPU/mem) with target cadences, race tests for lock/mutex under context churn, coverage tests for CSP/iframes/shadow DOM, and end-to-end manual run (start → actions → upload → stop).
