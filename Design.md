## **1. Overall architecture**

Template: https://github.com/Jonghakseo/chrome-extension-boilerplate-react-vite

1. **Interaction Listener** (content script)
    - Watches clicks, scrolls, key events, drags.
    - Emits high level Action events (with timestamps and metadata).
2. **Capture Orchestrator** (background or extension page)
    - Uses `chrome.desktopCapture.chooseDesktopMedia` once to get consent and a stream id.
    - Uses `navigator.mediaDevices.getUserMedia` with that id to create a MediaStream of the chosen tab.
    - Hands that stream to:
        - Screenshot service
        - Video recording service
3. **Screenshot Service**
    - Given `MediaStream` and an `ActionId` plus phase (before or after), grabs a still frame from the stream.
    - Produces `ScreenshotArtifact` that can be attached to the action.
4. **Video Recording Service**
    - Uses `MediaRecorder` on the same `MediaStream`.
    - Records the stream into small chunks (for example every N seconds) and indexes them by time.
5. **Upload Coordinator**
    - Manages upload of screenshots plus video chunks to your backend.
    - Uses navigator.locks so only one uploader runs at a time across all extension contexts.
    

---

## **2. API Designs**

### **2.1 Tab selection - `chrome.desktopCapture.chooseDesktopMedia`**

**Responsibility**

- Let the user pick which tab or screen to record.
- Provides a streamId that can be used with getUserMedia.

**Design**

- Triggered once per session from your background or popup:
    - For example, when user presses “Start tracking” in the popup.
- Store in extension state:
    - selectedSource: { type: "tab" | "screen", streamId, chosenAt }.
- If the user cancels or closes, you keep tracking events but simply do not create a stream.

---

### **2.2 Stream acquisition - `navigator.mediaDevices.getUserMedia`**

**Responsibility**

- Turn the streamId from desktopCapture into a real MediaStream object.

**Design**

- The Capture Orchestrator calls getUserMedia with Chrome constraints that reference the streamId.
- Once the MediaStream is available, it becomes the single source of truth for visuals.
- The stream is passed to:
    - Screenshot Service (for stills).
    - MediaRecorder (for video).

---

### **2.3 Video recording - `MediaRecorder`**

**Responsibility**

- Continuously record the MediaStream into time stamped binary chunks.

**Design**

- Video Recording Service owns one MediaRecorder per active stream.
- It records in small timeslices, e.g. 5 or 10 seconds, so you get many chunks instead of one massive file.
- For each emitted chunk you store:
    - chunkId
    - startTime and endTime on the stream timeline
    - a reference to the session it belongs to

Later we can map actions to video segments based on timestamps (for example, all actions that happened between startTime and endTime share that chunk).

---

### **2.4 Screenshots - built on top of the stream**

**Responsibility**

- Give you “before” and “after” still frames without calling tab capture every time.

**Design**

- Screenshot Service is given:
    - The shared MediaStream
    - An ActionId and a phase (before, after)
- It:
    - Renders the stream to an offscreen <video> element.
    - Draws the current video frame to an offscreen <canvas>.
    - Encodes that canvas to a blob or data URL.
- Produces small `ScreenshotArtifacts` like:
    - (actionId, phase, timestampOnStream, blobRef)

These get attached to the corresponding Action object that the Interaction Listener defined.

So for each action we have:

- Rich event metadata from the DOM.
- Two precise frames from the shared stream.

---

### **2.5 Upload coordination - `navigator.locks`**

**Responsibility**

- Make sure only one “upload worker” runs at a time even if you have:
    - background script,
    - popup page,
    - options page,
        
        and possibly an offscreen document.
        

**Design**

- You maintain a local queue of pending artifacts:
    - Action JSON
    - Screenshot blobs
    - Video chunks
- Whenever new items are added, you request a lock:
    - `navigator.locks.request("agent-upload", async lock => { ... })`
- Inside the lock:
    - Read a batch from the queue.
    - Upload to your backend.
    - Mark them as uploaded or retry on failure.
- Because of the lock name "agent-upload", only one context at a time will run the critical section.
- If the popup is closed mid upload, the next context that gets a lock can resume from the queue.

This keeps your upload reliable and avoids races without needing your own distributed mutex.

---

## **3. Data model around these APIs**

- **Session**
    - sessionId
    - createdAt, endedAt
    - source (tab/screen selection metadata)
    - actions: Action[]
    - videoChunks: VideoChunk[]
- **Action**
    - actionId
    - type (click, scroll, drag, keypress)
    - domMeta (element data, coordinates, etc)
    - happenedAt (wall clock)
    - streamTimestamp (time on the stream timeline)
    - beforeScreenshotRef
    - afterScreenshotRef
- **VideoChunk**
    - chunkId
    - sessionId
    - startStreamTime, endStreamTime
    - blobRef
- **ScreenshotArtifact**
    - screenshotId
    - sessionId
    - actionId and phase
    - streamTimestamp
    - blobRef

---

## **4. End to end flow**

1. User starts tracking in the extension UI.
2. Capture Orchestrator uses chooseDesktopMedia to let the user pick a tab.
3. It uses getUserMedia with the returned id to create a MediaStream.
4. Video Recording Service starts a MediaRecorder on that stream to produce continuous timed chunks.
5. Interaction Listener on each page observes actions and sends abstract Action events to the background.
6. For each action:
    - Background asks Screenshot Service to capture a frame for phase before.
    - After the action finishes, it captures another for phase after.
    - The action is stored with both screenshots and a pointer into the video timeline.
7. All artifacts (actions, screenshots, video chunks) are pushed into a local queue.
8. Upload Coordinator, protected by navigator.locks, uploads them to your backend in batches.
