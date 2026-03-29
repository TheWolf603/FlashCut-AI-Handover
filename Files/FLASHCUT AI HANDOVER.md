# FlashCut AI — Development Handover Document
## For fresh Claude instance to continue V2.0 development

---

## 1. PROJECT OVERVIEW

**FlashCut AI** is a free Adobe Premiere Pro CEP (Common Extensibility Platform) extension.
- **Bundle ID:** `com.flashcutai.extension`
- **Extension ID:** `com.flashcutai.panel`
- **CEP Version:** 11.0 (Premiere Pro 2023+)
- **Panel size:** 460×900 (min 380×700, max 700×1400)
- **Main entry:** `index.html` → `jsx/hostscript.jsx`
- **No backend, no subscription.** Users bring their own API keys.
- **Current build:** `/home/claude/FlashCutAI/` — 72KB zipped

---

## 2. FILE STRUCTURE

```
FlashCutAI/
├── CSXS/manifest.xml          CEP manifest — bundle ID, host, panel geometry
├── index.html                 Single-page panel UI (610 lines)
├── css/styles.css             All styles (1275 lines, CEP-safe)
├── js/
│   ├── CSInterface.js         Adobe CEP communication library (DO NOT EDIT)
│   ├── app.js                 Core init, tabs, evalScript(), helpers (575 lines)
│   ├── captions.js            Auto-Captions 2.0 (1481 lines) ← MAIN FILE
│   ├── silence.js             Silence Remover 2.0 (606 lines)
│   └── stylePanel.js          Style Captions — DISABLED, not loaded (620 lines)
└── jsx/
    └── hostscript.jsx         ExtendScript bridge — Premiere Pro API (914 lines)
```

**Script load order in index.html:**
```html
<script src="js/CSInterface.js"></script>
<script src="js/app.js"></script>
<script src="js/captions.js"></script>
<script src="js/silence.js"></script>
<!-- stylePanel.js intentionally NOT loaded — feature removed in V1.0 -->
```

---

## 3. ARCHITECTURE PATTERNS

### 3.1 JS → Premiere communication
```javascript
// All Premiere API calls go through evalScript() defined in app.js
// It returns a parsed JSON object (never a raw string)
var result = await evalScript('functionName(arg1, arg2)');
if (result.error) { showToast(result.error, 'error'); return; }
```

### 3.2 Passing large data to ExtendScript
Never pass large JSON as a function argument (escaping breaks). Always use the store:
```javascript
// JS side — store first, then call
await evalScript('storeFlashcutData("captions", \'' + JSON.stringify(data).replace(/'/g, "\\'") + '\')');
var result = await evalScript('createCaptionTrack()');

// ExtendScript side — read from store
var captions = $.flashcutStore["captions"];
```

### 3.3 ExtendScript function return pattern
Every hostscript function returns `jsonStringify({...})` — never a raw value:
```javascript
function myFunction() {
    try {
        // ... work ...
        return jsonStringify({ success: true, count: 5 });
    } catch(e) {
        return jsonStringify({ error: safeStr(e.message) });
    }
}
```

### 3.4 CEP-safe CSS rules (NEVER break these)
```css
/* FORBIDDEN — causes UI glitches in CEP Chromium: */
position: fixed;       /* use position: absolute instead */
height: 100vh;         /* use height: 100% */
transform on :hover;   /* causes repaint loops */
continuous animations; /* only on .active class */
@import Google Fonts;  /* blocked by CEP security */
box-shadow in transitions; /* only color/opacity/border allowed */
```

### 3.5 DOM update batching
```javascript
// Always batch DOM changes to avoid CEP repaint glitches
await batchDom(function() {
    setBtnLoading('btn-id', true);
    setStatus('Working…', 'purple pulse');
});
await yieldToPaint(); // after status changes in long operations
```

### 3.6 Audio reading from timeline
```javascript
// getSequenceAudioClips() in hostscript returns BOTH audio tracks AND video tracks
// (because most MP4/MOV files have embedded audio on video tracks)
// srcOutPoint is DERIVED: srcOut = srcIn + (timelineEnd - timelineStart)
// DO NOT use clip.outPoint.ticks — it's unreliable in Premiere's ExtendScript
```

---

## 4. V1.0 COMPLETED FEATURES

### Auto-Captions (V1.0)
- 3 transcription engines: OpenAI Whisper, AssemblyAI, Deepgram
- All engines: auto-detect source language, NO language param sent to API
- Translation via MyMemory API (free, no key) when target language selected
- Audio compositor: reads from timeline directly (respects cuts/trims)
  - Decodes each source file at native rate
  - Slices srcInPoint→srcInPoint+clipDuration (NOT srcOutPoint from API)
  - Concatenates in timeline order → `segmentMap` for timestamp remapping
  - Encodes as WAV via `encodeWav16()`
- Captions auto-placed on timeline after generation
- `nukeExistingCaptions()` called BEFORE every placement to prevent stacking
- `placeSubtitleFile()` tries: importCaptions → QE DOM → insertClip → appendClip
- Captions editable in plugin → `updateCaptionSegment()` for surgical updates
- 2-second polling sync: Premiere Essential Graphics → plugin
- SRT export

### Silence Remover (V1.0)
- RMS amplitude analysis, 10ms chunks
- QE DOM timecode-based razor cuts: `qeSeq.razor("HH:MM:SS:FF")`
- Ripple delete: `clip.remove(true, false)`
- `secondsToTimecode(seconds, fps)` converts seconds to QE format

---

## 5. V2.0 FEATURES — COMPLETED ✅

### Auto-Captions 2.0
**File:** `js/captions.js`

#### 5.1 Speaker Detection (AssemblyAI only)
- Toggle: `#toggle-speakers` checkbox
- Request: `reqBody.speaker_labels = true` → AssemblyAI returns `pollData.utterances[]`
- **Critical:** Uses utterance words as source of truth, NOT `pollData.words`
  - Utterance words already have `speaker` on every word — no timestamp lookup needed
  - `pollData.words` and utterance words are separate objects with ±1ms timestamp drift
- **Auto consistency pass** (runs before building segments):
  ```javascript
  // If utterance[i] is short (<3s) AND surrounded by same speaker → re-label
  if (prev.speaker === next.speaker && curr.speaker !== prev.speaker && currDur < 3.0) {
      curr.speaker = prev.speaker;
  }
  ```
- **Manual merge:** `⇌ Merge Speakers` button in speaker legend
  - `openMergeSpeakersDialog()` uses `prompt()` for CEP compatibility
  - Re-labels all captions from removed speaker, deletes from colour map
- `buildCaptionsFromSegments()` forces group flush on speaker change:
  ```javascript
  // Before pushing a word — if speaker changes, flush current group first
  if (currentGroup.length > 0 && seg.speaker && currentGroup[0].speaker &&
      seg.speaker !== currentGroup[0].speaker) { flushGroup(); }
  ```
- Speaker colours: `['#FF6B6B','#4ECDC4','#FFD93D','#6BCB77','#4D96FF','#FF6FC8','#A855F7']`
- `CaptionsModule.speakers` = `{ 'A': '#FF6B6B', 'B': '#4ECDC4' }`

#### 5.2 Chapter Markers (AssemblyAI only)
- Toggle: `#toggle-chapters` checkbox
- Request: `reqBody.auto_chapters = true`
- Response: `pollData.chapters[{start_ms, end_ms, headline, gist}]`
- ExtendScript: `addChapterMarkers()` → `seq.markers.createMarker(seconds)` → `marker.name = headline`
- Called automatically after transcription completes

#### 5.3 Confidence Scores
- Toggle: `#toggle-confidence` (on by default)
- Per-word confidence from AssemblyAI: `w.confidence` (0.0–1.0)
- Carried through `buildCaptionsFromSegments` via `getAvgConfidence(wordGroup)`
- Visual: `conf < 0.6` → red left border + `⚠60%` badge; `conf < 0.85` → yellow border + `~82%`
- Legend shown at top of caption list when low-confidence captions exist

#### 5.4 Batch Sequences
- `getAllSequenceIds()` in hostscript → returns all sequences in project
- UI: Load Sequences → checklist → Batch Caption button + progress bar
- `runBatchCaption(seqList)` → loops, calls `setActiveSequenceById()` then `generateCaptionsForActiveSequence()`
- Progress bar: `#batch-progress-fill` (width%) + `#batch-progress-label` (text)

### Silence Remover 2.0
**File:** `js/silence.js`

#### 5.5 Visual Waveform Preview
- Canvas element: `#silence-waveform-canvas` (height: 48px, full width)
- `drawSilenceWaveform(audioBuffer, regions, totalDuration)` — draws after analyze
- Orange waveform bars + red transparent silence region overlays + red outlines
- Redraws when user deletes a region from the list
- `SilenceModule.lastAudioBuffer` stores the decoded buffer for redraws

#### 5.6 Per-Track Sensitivity
- Toggle: `#toggle-per-track` → shows `#per-track-options`
- `SilenceModule.voiceTrackIndex` — which audio track is the voice (0-based)
- `SilenceModule.voiceThreshold` / `SilenceModule.musicThreshold` (dB values)
- Setting musicThreshold to 0 skips music tracks entirely
- `detectSilencePerTrack()` — checks per-channel, moment is silence only if ALL tracks are quiet
- Standard single-threshold path still available via `detectSilence()`

#### 5.7 Cut Style Selector
```
Tight Cut  = full silence removed (V1 behavior)
L-Cut      = region.start += overlap (audio bleeds before cut)
J-Cut      = region.end   -= overlap (audio starts before next video)
```
- `SilenceModule.cutStyle` + `SilenceModule.cutOverlap`
- Applied in `applySilenceRemoval()` BEFORE sending regions to ExtendScript
- Overlap slider `#cut-overlap` shown only for L/J cut styles
- Confirm dialog shows which cut style was selected

---

## 6. V2.0 FEATURES — NEXT TO BUILD 🔴

From the approved V2.0 roadmap, in priority order:

### 6.1 Filler Word Remover (NEXT — LOW COMPLEXITY)
**What it does:** Detect "um", "uh", "like", "you know", "basically", "literally" + custom words.
Show list of every occurrence with timestamp + checkbox. Remove selected with ripple delete.

**Implementation plan:**
- Uses the same audio pipeline as Auto-Captions (AssemblyAI with `word_boost`)
- After transcription, filter `pollData.words` for filler words
- Show in a new UI list with checkboxes and timecodes
- "Remove Selected" calls a new `removeFillerWords()` in hostscript
- `removeFillerWords()` reuses `removeSilentRegions()` logic — same QE DOM razor approach
- New tab OR sub-section inside the Silence Remover panel

**Key API fields:**
```javascript
// AssemblyAI — boost detection of specific words
reqBody.word_boost = ['um', 'uh', 'like', 'you know', ...customWords];
reqBody.boost_param = 'high';
// Then filter pollData.words by text match
```

### 6.2 Beat Sync Cuts (MEDIUM COMPLEXITY)
**What it does:** Import a music track → detect beats via Web Audio peak analysis → snap existing edit points to nearest beat.

**Implementation plan:**
- New section in Silence tab OR new tab
- User selects the music track index
- Read that track's audio (same `readMediaFileAsync` + `decodeAudioData` pattern)
- Beat detection: onset detection on the audio buffer (peak picking algorithm)
- Get all current cut points from `seq.videoTracks[0].clips` in ExtendScript
- Snap each cut point to nearest beat: new `snapCutsToBeat(beats)` in hostscript
- Uses QE DOM `qeSeq.razor()` + adjust clip in/out points

### 6.3 Style Captions (REBUILT FROM SCRATCH — HIGH COMPLEXITY)
**What it does:** Full visual styling of captions — font, color, size, animation, background.

**Why V1 failed:** Premiere's ExtendScript API has NO methods to set font/color/size on caption tracks. `importCaptions(path, 2)` for WebVTT styling doesn't work. `seq.captionTracks[i].fontFamily` doesn't exist.

**The correct V2 approach — burn-in via FFmpeg:**
1. CEP has access to Node.js (`require('child_process')`)
2. Bundle a static FFmpeg binary with the extension
3. Export audio/video from sequence using AME or QE DOM
4. Apply styled captions as a filter: `ffmpeg -vf subtitles=captions.ass:force_style='...'`
5. Import the rendered clip back into Premiere as a new video layer
6. This gives 100% control over font, color, size, background, animations

**Alternative (simpler but less control):** Generate an After Effects script (.jsx) that creates a text layer with keyframes for each caption. User runs it in AE.

### 6.4 Audio Enhancer (HIGH COMPLEXITY)
**What it does:** Noise reduction, auto-leveling (LUFS normalization), de-essing.

**Implementation plan:**
- Web Audio API + AudioWorklet for processing
- Noise reduction: spectral subtraction on frequency bins
- LUFS normalization: measure integrated loudness, apply gain
- Export processed audio as WAV, import back to Premiere

### 6.5 Social Export Presets (MEDIUM COMPLEXITY)
**What it does:** One-click 9:16 reframe + duration-limited versions for TikTok/Reels/Shorts.

**Implementation plan:**
- New tab or section
- Uses Auto Reframe sequence preset via QE DOM
- `qe.project.newSequence()` with vertical dimensions
- Copy clips from original sequence, apply scale/position adjustment

---

## 7. KEY EXTENDSCRIPT FUNCTIONS (hostscript.jsx)

| Function | Purpose |
|---|---|
| `getSequenceAudioClips()` | Returns clips from BOTH audio AND video tracks |
| `storeFlashcutData(key, json)` | Stores data in `$.flashcutStore` — use before any large-data call |
| `createCaptionTrack()` | Nukes old captions → writes SRT → places on timeline |
| `nukeExistingCaptions(seq)` | Removes all existing captions via 4 strategies |
| `placeSubtitleFile(seq, path, fmt)` | importCaptions → QE → insertClip → appendClip |
| `removeSilentRegions()` | QE DOM timecode razor + ripple delete |
| `addChapterMarkers()` | Reads `$.flashcutStore["chapters"]`, creates sequence markers |
| `getAllSequenceIds()` | Returns all sequences for batch processing |
| `setActiveSequenceById(id)` | Switches active sequence |
| `updateCaptionSegment(idx, text)` | Surgical single-segment text update |
| `getCaptionSegments()` | Reads back caption text from Premiere's track |
| `generateASS(captions, style)` | Builds ASS subtitle file with full styling |
| `generateSRT(captions)` | Builds plain SRT string |
| `generateStyledVTT(captions, style)` | Builds WebVTT with ::cue{} CSS block |

**Critical bugs fixed (never repeat):**
- `clip.outPoint.ticks` is unreliable → always use `srcIn + (tlEnd - tlStart)`
- `seq.razor()` doesn't exist → use QE DOM `qeSeq.razor("HH:MM:SS:FF")` timecode string
- `seq.captionTracks` doesn't exist in older Premiere → always try/catch with fallbacks
- `pollData.words` and utterance words have ±1ms drift → use utterance words for speaker path
- `storeFlashcutData` uses `eval()` internally → escape single quotes: `.replace(/'/g, "\\'")`

---

## 8. CRITICAL ASSEMBLYAI API NOTES

```javascript
// ALWAYS send speech_models — it's now required
reqBody.speech_models = ['universal-2'];

// ALWAYS send language_detection: true — never send language_code
// (language_code conflicts with universal-2 and causes wrong language output)
reqBody.language_detection = true;

// For translation: use MyMemory API AFTER transcription (AssemblyAI has no translation endpoint)
// POST https://api.mymemory.translated.net/get?q={text}&langpair={from}|{to}
// Batch 3 captions at a time, separated by ' ||| '
// Free tier: ~10k chars/day, no key needed

// Speaker labels — use utterances, NOT words
// pollData.utterances[{speaker, words:[{text, start, end, confidence}]}]
```

---

## 9. SILENCE REMOVER — CRITICAL QE DOM PATTERN

```javascript
// The ONLY way to razor-cut in Premiere via ExtendScript:
app.enableQE();
var qeSeq = qe.project.getActiveSequence();

// Convert seconds to "HH:MM:SS:FF" timecode
var fps = Math.round(254016000000 / parseFloat(seq.timebase));
var startTC = secondsToTimecode(startSec, fps);
qeSeq.razor(startTC);   // ← string timecode, NOT ticks, NOT seconds

// Ripple delete a clip:
clip.remove(true, false);  // (ripple=true, alignToVideo=false)
```

---

## 10. CSS VARIABLES & DESIGN TOKENS

```css
--accent-cyan:    #00D4FF
--accent-purple:  #7C5CFC
--accent-orange:  #FFA032
--accent-green:   #00E5A0
--bg-primary:     #0D0D1A
--bg-card:        #151526
--bg-track:       #1A1A2E
--border:         rgba(255,255,255,0.08)
--border-bright:  rgba(255,255,255,0.15)
--text-primary:   #E8E8F0
--text-secondary: #9898B0
--text-muted:     #5C5C7A
--radius-sm:      6px
--radius-md:      10px
--transition:     background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease, opacity 0.15s ease
/* NO box-shadow in transitions — causes CEP repaint loops */
```

---

## 11. HTML PANEL STRUCTURE

```
#panel-captions (Tab 1 — Auto-Captions 2.0)
  ├── api-provider-tabs (whisper / assemblyai / deepgram)
  ├── config panels (config-whisper, config-assemblyai, config-deepgram)
  ├── Language & Settings card
  │   ├── #caption-language (translate-to dropdown, 60+ languages)
  │   ├── #max-words (4/6/8/10/12)
  │   ├── #audio-method (auto / manual)
  │   └── #audio-file-input (manual upload)
  ├── 2.0 Features card
  │   ├── #toggle-speakers (Speaker Detection)
  │   ├── #toggle-chapters (Chapter Markers)
  │   └── #toggle-confidence (Confidence Scores — checked by default)
  ├── Batch Sequences card
  │   ├── #batch-sequence-list (checkboxes)
  │   ├── #btn-load-sequences
  │   ├── #btn-batch-caption
  │   └── #batch-progress / #batch-progress-fill / #batch-progress-label
  ├── #waveform-viz (animated bars during processing)
  ├── #btn-generate-captions
  └── #caption-results (hidden until generated)
      ├── #speaker-legend (color-coded speaker chips + ⇌ Merge button)
      ├── #caption-confidence-legend (shown when low-confidence exists)
      ├── #caption-list (caption items with meta/text/actions)
      └── action buttons (Export SRT / Clear / Add to Timeline)

#panel-silence (Tab 2 — Silence Remover 2.0)
  ├── Detection Settings card (threshold, min-dur, padding, audio-method)
  ├── Per-Track Sensitivity card (toggle + voice/music thresholds)
  ├── Cut Style card (tight / l-cut / j-cut + overlap slider)
  ├── #silence-stats (regions / to-remove / saved)
  ├── Analyze + Preview buttons
  ├── #silence-waveform-wrap > #silence-waveform-canvas (visual preview)
  └── #silence-results > #silence-list + Apply button
```

---

## 12. V2.0 ROADMAP STATUS

| Feature | Status | Complexity |
|---|---|---|
| Auto-Captions 2.0 — Speaker Detection | ✅ DONE | — |
| Auto-Captions 2.0 — Chapter Markers | ✅ DONE | — |
| Auto-Captions 2.0 — Confidence Scores | ✅ DONE | — |
| Auto-Captions 2.0 — Batch Sequences | ✅ DONE | — |
| Auto-Captions 2.0 — Speaker confusion fix | ✅ DONE | — |
| Silence 2.0 — Visual Waveform Preview | ✅ DONE | — |
| Silence 2.0 — Per-Track Sensitivity | ✅ DONE | — |
| Silence 2.0 — Cut Style (L/J/Tight) | ✅ DONE | — |
| **Filler Word Remover** | 🔴 NEXT | Low |
| Beat Sync Cuts | 🔴 TODO | Medium |
| Style Captions (burn-in rebuild) | 🔴 TODO | High |
| Audio Enhancer | 🔴 TODO | High |
| Social Export Presets | 🔴 TODO | Medium |

---

## 13. HOW TO CONTINUE

### To start the next session:
1. The project lives at `/home/claude/FlashCutAI/`
2. The latest zip is at `/mnt/user-data/outputs/FlashCutAI.zip`
3. Read this document first, then read the specific files you'll be editing
4. Always run the audit after changes:

```javascript
// Quick sanity check pattern
node -e "
const c = require('fs').readFileSync('/home/claude/FlashCutAI/js/captions.js','utf8');
const h = require('fs').readFileSync('/home/claude/FlashCutAI/jsx/hostscript.jsx','utf8');
console.log('captions.js balanced:', c.split('{').length === c.split('}').length);
console.log('hostscript balanced:',  h.split('{').length === h.split('}').length);
"
```

5. Always package with:
```bash
cd /home/claude && rm -f FlashCutAI.zip
zip -r FlashCutAI.zip FlashCutAI/ --exclude "*.DS_Store" --exclude "*__pycache__*" -q
cp FlashCutAI.zip /mnt/user-data/outputs/FlashCutAI.zip
```

### Start the Filler Word Remover (recommended next task):

The filler word remover needs:
1. A new card in the Captions panel (below the 2.0 features card)
2. A custom filler words input + preset toggle
3. AssemblyAI `word_boost` + `boost_param: 'high'` in the request
4. Post-transcription: filter `pollData.words` by text match against filler list
5. Show results in a checkable list with timestamps
6. "Remove Selected" button → new `removeFillerWords()` in hostscript
7. `removeFillerWords()` uses the same QE DOM razor approach as `removeSilentRegions()`
   but targets specific word-level time ranges instead of RMS-detected silence

---

## 14. INSTALLATION (for testing)

**Mac:**
```bash
defaults write com.adobe.CSXS.11 PlayerDebugMode 1
# Copy FlashCutAI/ to ~/Library/Application Support/Adobe/CEP/extensions/
```

**Windows:**
```
reg add HKCU\Software\Adobe\CSXS.11 /v PlayerDebugMode /t REG_SZ /d 1 /f
# Copy FlashCutAI/ to %APPDATA%\Adobe\CEP\extensions\
```

Then: Premiere Pro → Window → Extensions → FlashCut AI

---

*Generated at end of V2.0 development session — Auto-Captions 2.0 + Silence 2.0 complete.*
