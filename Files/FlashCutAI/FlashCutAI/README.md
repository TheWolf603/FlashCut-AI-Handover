# FlashCut AI — Adobe Premiere Pro Extension

**Free AI-powered video editing tools inside Premiere Pro.**

Three features: Auto-Captions, Silence Remover, Style My Captions.

---

## Installation

### Step 1 — Enable unsigned extensions in Premiere

Adobe blocks unsigned extensions by default. You need to disable this check once.

**Mac:**
```bash
defaults write com.adobe.CSXS.11 PlayerDebugMode 1
```

**Windows** (run as Administrator):
```
reg add HKCU\Software\Adobe\CSXS.11 /v PlayerDebugMode /t REG_SZ /d 1 /f
```

> If you're on an older Premiere (pre-2023), try `CSXS.10` or `CSXS.9` instead of `CSXS.11`.

---

### Step 2 — Copy the extension folder

Copy the `FlashCutAI` folder to your CEP extensions directory:

| OS | Path |
|---|---|
| Mac | `~/Library/Application Support/Adobe/CEP/extensions/` |
| Windows | `%APPDATA%\Adobe\CEP\extensions\` |

The final path should look like:
- Mac: `~/Library/Application Support/Adobe/CEP/extensions/FlashCutAI/`
- Windows: `%APPDATA%\Adobe\CEP\extensions\FlashCutAI\`

---

### Step 3 — Launch Premiere Pro

1. Open Premiere Pro 2023 or later
2. Go to **Window → Extensions → FlashCut AI**
3. The panel will open — dock it wherever you like

---

## Features

### ✍️ Auto-Captions
Transcribes your sequence audio using AI and adds captions to your timeline.

**Providers (you supply the API key):**
- **OpenAI Whisper** — Best accuracy, supports 50+ languages. Get a key at [platform.openai.com](https://platform.openai.com)
- **AssemblyAI** — Fast, great for English. Get a key at [assemblyai.com](https://www.assemblyai.com)
- **Deepgram** — Low latency, competitive pricing. Get a key at [deepgram.com](https://deepgram.com)

**How to use:**
1. Select your sequence from the dropdown
2. Choose a provider and enter your API key
3. Set language and max words per caption
4. Click **Generate Captions**
5. Review/edit captions in the list
6. Click **Add to Timeline**
7. Export SRT if needed

---

### ✂️ Silence Remover
Detects and removes silent regions from your timeline using audio analysis.

**How to use:**
1. Set threshold (how quiet counts as "silence", default -40 dB)
2. Set minimum duration (shortest silence to remove, default 0.5s)
3. Set padding (buffer to keep around speech, default 0.1s)
4. Click **Analyze**
5. Review detected regions — delete any false positives
6. Click **Remove Silence from Timeline**

> ⚠️ This cuts and ripple-deletes clips. Use **Ctrl/Cmd+Z** in Premiere to undo.

**Audio source options:**
- **Auto Export** — FlashCut exports a WAV from your sequence automatically (requires Adobe Media Encoder or QT export)
- **Manual Upload** — Export your audio manually from Premiere as WAV, then upload it here

---

### 🎨 Style My Captions
Customize the look of captions already on your timeline.

Options include:
- Font family (6 presets + custom)
- Font size, weight, alignment
- Text color (swatches + color picker)
- Background color, opacity, corner radius
- Drop shadow and outline toggles
- Caption position (3×3 grid)
- Animation: None, Fade, Slide Up, Pop, Typewriter, Word-by-Word

Click **Apply Style to Captions** to push styles to the timeline.

---

## API Keys

API keys are stored **locally in your browser** (localStorage) and never sent anywhere except the transcription provider you choose. FlashCut AI has no backend server — it's entirely client-side.

---

## Troubleshooting

**Extension doesn't appear in Window → Extensions:**
- Make sure PlayerDebugMode is set correctly (Step 1)
- Restart Premiere after copying the folder
- Check the folder is named exactly `FlashCutAI` (no spaces)

**"No sequence found":**
- Open a project with at least one sequence in Premiere before using the panel

**Transcription fails:**
- Check your API key is valid and has credits
- Try the Manual Upload audio method if Auto Export fails

**Silence removal doesn't work:**
- Try lowering the threshold (e.g., -50 dB)
- Make sure you're using a WAV or MP3 file for manual upload

**Captions added as text clips instead of proper captions:**
- This happens on older Premiere versions that don't support the modern Captions API
- Use the **Export SRT** button and import it via File → Import in Premiere

---

## System Requirements

- Adobe Premiere Pro 2023 (v23.0) or later
- macOS 10.15+ or Windows 10+
- Internet connection (for transcription API calls)
- API key from OpenAI, AssemblyAI, or Deepgram

---

## License

Free to use. No warranties. Not affiliated with Adobe.
