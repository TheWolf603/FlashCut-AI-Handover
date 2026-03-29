/**
 * FlashCut AI — captions.js
 * Auto-Captions 2.0: transcription, speaker detection, confidence scores,
 * chapter markers, batch sequences, translation, timeline insertion.
 */

'use strict';

var CaptionsModule = {
  captions:       [],     // [{start, end, text, id, speaker, confidence}, ...]
  isProcessing:   false,
  segmentMap:     null,
  speakers:       {},     // { 'A': '#FF6B6B', 'B': '#4ECDC4', ... }
  chapters:       [],     // [{start, end, headline, gist}, ...]
  hasSpeakers:    false,
  hasConfidence:  false
};

/* ═══════════════════════════════════════════════
   MAIN GENERATE CAPTIONS FLOW
══════════════════════════════════════════════ */
async function generateCaptions() {
  if (!requireSequence()) return;
  if (CaptionsModule.isProcessing) return;
  CaptionsModule.isProcessing = true;

  // Clear ALL state from any previous run before starting fresh
  CaptionsModule.captions      = [];
  CaptionsModule.segmentMap    = null;
  CaptionsModule.speakers      = {};
  CaptionsModule.chapters      = [];
  CaptionsModule.hasSpeakers   = false;
  CaptionsModule.hasConfidence = false;
  document.getElementById('caption-results').style.display = 'none';
  document.getElementById('caption-list').innerHTML = '';

  // Batch ALL opening UI changes into one rAF frame → single repaint
  await batchDom(function() {
    setBtnLoading('btn-generate-captions', true);
    activateWaveformViz(true);
    setStatus('Preparing audio…', 'purple pulse');
  });

  try {
    var audioMethod = document.getElementById('audio-method').value;
    var audioBlob = null;
    var audioFilename = 'sequence_audio.wav';

    if (audioMethod === 'manual') {
      // User-provided audio file
      var fileInput = document.getElementById('audio-file-input');
      if (!fileInput.files || !fileInput.files[0]) {
        showToast('Please select an audio file to upload.', 'warning');
        resetGenerateBtn();
        return;
      }
      audioBlob = fileInput.files[0];
      audioFilename = audioBlob.name;
      setStatus('Using uploaded audio file…', 'purple pulse');
    } else {
      // ── Auto path: direct concatenation of timeline clips ────────────────
      // Decode each source at native rate, slice srcInPoint→srcOutPoint,
      // concatenate in timeline order. AssemblyAI accepts any sample rate.
      // Build a segmentMap so timestamps remap to correct sequence positions.
      setStatus('Reading sequence audio…', 'purple pulse');
      await yieldToPaint();

      var clipsResult = await evalScript('getSequenceAudioClips()');
      if (clipsResult.error) {
        showToast(clipsResult.error === 'NO_AUDIO_CLIPS_FOUND'
          ? 'No audio clips on the timeline.' : 'Could not read sequence: ' + clipsResult.error, 'error');
        resetGenerateBtn();
        return;
      }

      var clips = clipsResult.clips; // sorted by timelineStart
      var uniquePaths = [];
      var pathSeen = {};
      clips.forEach(function(c) {
        if (!pathSeen[c.path]) { pathSeen[c.path] = true; uniquePaths.push(c.path); }
      });

      // Decode each source file once at its native sample rate
      var decodedSources = {};
      for (var pi = 0; pi < uniquePaths.length; pi++) {
        var fp = uniquePaths[pi];
        setStatus('Decoding ' + fp.split('/').pop() + ' (' + (pi+1) + '/' + uniquePaths.length + ')…', 'purple pulse');
        await yieldToPaint();
        try {
          var rawBuf = await readMediaFileAsync(fp);
          decodedSources[fp] = await new Promise(function(res, rej) {
            var ctx = new (window.AudioContext || window.webkitAudioContext)();
            ctx.decodeAudioData(rawBuf,
              function(b) { ctx.close(); res(b); },
              function(e) { ctx.close(); rej(new Error('Decode: ' + (e && e.message ? e.message : e))); }
            );
          });
        } catch(decErr) {
          console.warn('Could not decode', fp, decErr.message);
        }
      }

      if (Object.keys(decodedSources).length === 0) {
        showToast('Could not decode audio. Try Manual Upload.', 'error', 7000);
        resetGenerateBtn();
        return;
      }

      // Extract each clip's used portion and mix to mono at native rate
      setStatus('Extracting timeline audio…', 'purple pulse');
      await yieldToPaint();

      var segments   = [];   // {pcm: Float32Array, rate: number}
      var segmentMap = [];   // {audioStart, audioEnd, timelineStart} in seconds
      var audioCursor = 0;   // seconds elapsed in concatenated audio

      clips.forEach(function(clip) {
        var src = decodedSources[clip.path];
        if (!src) return;
        var rate  = src.sampleRate;
        var numCh = src.numberOfChannels;
        var sS    = Math.max(0, Math.floor(clip.srcInPoint  * rate));
        var sE    = Math.min(src.length, Math.ceil(clip.srcOutPoint * rate));
        if (sE <= sS) return;

        // Mix all channels to mono
        var mono = new Float32Array(sE - sS);
        for (var ch = 0; ch < numCh; ch++) {
          var chData = src.getChannelData(ch);
          for (var s = 0; s < mono.length; s++) mono[s] += chData[sS + s] / numCh;
        }

        var durSec = mono.length / rate;
        segmentMap.push({
          audioStart:    audioCursor,
          audioEnd:      audioCursor + durSec,
          timelineStart: clip.timelineStart
        });
        segments.push({ pcm: mono, rate: rate });
        audioCursor += durSec;
      });

      if (segments.length === 0) {
        showToast('No audio segments found. Try Manual Upload.', 'error', 7000);
        resetGenerateBtn();
        return;
      }

      // Use the sample rate of the first segment for the WAV header
      var RATE = segments[0].rate;

      // Concatenate all mono PCM segments into one buffer
      var totalLen = 0;
      segments.forEach(function(s) { totalLen += s.pcm.length; });
      var combined = new Float32Array(totalLen);
      var writePos = 0;
      segments.forEach(function(s) { combined.set(s.pcm, writePos); writePos += s.pcm.length; });

      // Store segment map so we can remap AssemblyAI timestamps after transcription
      CaptionsModule.segmentMap = segmentMap;

      audioBlob     = new Blob([encodeWav16(combined, RATE)], { type: 'audio/wav' });
      audioFilename = 'timeline_audio.wav';
      setStatus('Audio ready (' + (audioBlob.size/1024/1024).toFixed(1) + ' MB) — sending to API…', 'purple pulse');
      await yieldToPaint();
    }
    if (!audioBlob) {
      showToast('No audio to process.', 'error');
      resetGenerateBtn();
      return;
    }

    setStatus('Sending audio for transcription…', 'purple pulse');

    // Determine active provider
    var activeProvider = storeLoad('activeProvider', 'whisper');
    var transcriptData = null;

    if (activeProvider === 'whisper') {
      transcriptData = await transcribeWithWhisper(audioBlob, audioFilename);
    } else if (activeProvider === 'assemblyai') {
      transcriptData = await transcribeWithAssemblyAI(audioBlob);
    } else if (activeProvider === 'deepgram') {
      transcriptData = await transcribeWithDeeepgram(audioBlob, audioFilename);
    }

    if (!transcriptData || transcriptData.error) {
      showToast('Transcription failed: ' + (transcriptData ? transcriptData.error : 'Unknown error'), 'error', 10000);
      resetGenerateBtn();
      return;
    }

    // Remap API timestamps: concatenated-audio time → sequence timeline time
    var rawSegs = transcriptData.segments || [];
    if (CaptionsModule.segmentMap && CaptionsModule.segmentMap.length > 0) {
      rawSegs = rawSegs.map(function(seg) {
        return {
          start:      remapToTimeline(seg.start, CaptionsModule.segmentMap),
          end:        remapToTimeline(seg.end,   CaptionsModule.segmentMap),
          text:       seg.text,
          speaker:    seg.speaker    || null,
          confidence: seg.confidence != null ? seg.confidence : 1
        };
      });
      // Remap chapter timestamps too
      if (transcriptData.chapters) {
        transcriptData.chapters = transcriptData.chapters.map(function(ch) {
          return {
            start:    remapToTimeline(ch.start, CaptionsModule.segmentMap),
            end:      remapToTimeline(ch.end,   CaptionsModule.segmentMap),
            headline: ch.headline,
            gist:     ch.gist
          };
        });
      }
      CaptionsModule.segmentMap = null;
    }

    // Build captions (carries speaker + confidence)
    var maxWords = parseInt(document.getElementById('max-words').value) || 6;
    CaptionsModule.captions = buildCaptionsFromSegments(rawSegs, maxWords);
    CaptionsModule.chapters  = transcriptData.chapters || [];

    renderCaptionList(CaptionsModule.captions);
    document.getElementById('caption-results').style.display = 'block';

    // Build caption count label with speaker info
    var countLabel = CaptionsModule.captions.length + ' captions';
    if (CaptionsModule.hasSpeakers) {
      countLabel += ' · ' + Object.keys(CaptionsModule.speakers).length + ' speakers';
    }
    if (CaptionsModule.chapters.length > 0) {
      countLabel += ' · ' + CaptionsModule.chapters.length + ' chapters';
    }
    document.getElementById('caption-count').textContent = countLabel;

    // Add chapter markers to timeline if we have any
    if (CaptionsModule.chapters.length > 0) {
      setStatus('Adding chapter markers…', 'purple pulse');
      await yieldToPaint();
      var chaptersJSON = JSON.stringify(CaptionsModule.chapters);
      await evalScript('storeFlashcutData("chapters", \'' + chaptersJSON.replace(/'/g, "\\'") + '\')');
      var markerResult = await evalScript('addChapterMarkers()');
      if (markerResult && !markerResult.error) {
        showToast('✓ ' + CaptionsModule.chapters.length + ' chapter markers added to timeline!', 'info', 4000);
      }
    }

    // Auto-add captions to timeline
    setStatus('Adding captions to timeline…', 'purple pulse');
    await yieldToPaint();
    var style = getCaptionStyleData();
    await evalScript('storeFlashcutData("captions", \'' + JSON.stringify(CaptionsModule.captions).replace(/'/g, "\\'") + '\')');
    await evalScript('storeFlashcutData("captionStyle", \'' + JSON.stringify(style).replace(/'/g, "\\'") + '\')');
    var addResult = await evalScript('createCaptionTrack()');

    var placed = addResult && !addResult.error &&
                 (addResult.method === 'caption_track' ||
                  addResult.method === 'srt_placed');

    if (placed) {
      setStatus('✓ ' + CaptionsModule.captions.length + ' captions on the timeline!', 'green');
      showToast('✓ ' + CaptionsModule.captions.length + ' captions added to your timeline!', 'success', 5000);
    } else if (addResult && addResult.method === 'srt_export') {
      // ExtendScript wrote the SRT — let user know where it is
      setStatus('✓ ' + CaptionsModule.captions.length + ' captions ready — import SRT to finish', 'green');
      showToast('Captions ready! Go to File → Import in Premiere and import: ' + addResult.srtPath, 'info', 12000);
    } else {
      setStatus('✓ ' + CaptionsModule.captions.length + ' captions ready', 'green');
      showToast('Captions ready! Click "Add to Timeline" to place them.', 'info', 7000);
    }


  } catch(e) {
    console.error('Caption generation error:', e);
    showToast('Error: ' + e.message, 'error');
    setStatus('Error during transcription', 'red');
  }

  activateWaveformViz(false);
  setBtnLoading('btn-generate-captions', false);
  CaptionsModule.isProcessing = false;
}

function resetGenerateBtn() {
  setBtnLoading('btn-generate-captions', false);
  CaptionsModule.isProcessing = false;
}

/* ═══════════════════════════════════════════════
   WHISPER API TRANSCRIPTION
══════════════════════════════════════════════ */
async function transcribeWithWhisper(audioBlob, filename) {
  var apiKey = document.getElementById('openai-key').value.trim();
  if (!apiKey) {
    showToast('Please enter your OpenAI API key.', 'warning');
    return { error: 'No API key provided.' };
  }
  storeSave('openai-key', apiKey);

  var language = document.getElementById('caption-language').value;
  var wantTranslation = language && language !== 'auto';
  var temperature = parseFloat(document.getElementById('whisper-temp').value) || 0;
  var modelEl = document.getElementById('whisper-model');
  var model = modelEl ? modelEl.value : 'whisper-1';

  // Whisper: always auto-detect source language for transcription.
  // If user chose a specific language, transcribe first then translate via MyMemory.
  var formData = new FormData();
  formData.append('file', audioBlob, filename || 'audio.wav');
  formData.append('model', model);
  formData.append('response_format', 'verbose_json');
  formData.append('timestamp_granularities[]', 'word');
  formData.append('timestamp_granularities[]', 'segment');
  // Do NOT pass language param — let Whisper auto-detect so we get accurate transcription
  if (temperature !== 0) formData.append('temperature', temperature.toString());

  try {
    setStatus('Sending audio to Whisper…', 'purple pulse');
    await yieldToPaint();

    var response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey },
      body: formData
    });

    if (!response.ok) {
      var errData = await response.json().catch(function(){ return {}; });
      return { error: 'Whisper error ' + response.status + ': ' + (errData.error && errData.error.message ? errData.error.message : response.statusText) };
    }

    var data = await response.json();

    // Build word-level segments
    var srcSegments = [];
    if (data.words && data.words.length > 0) {
      srcSegments = data.words.map(function(w) {
        return { start: w.start, end: w.end, text: w.word.trim() };
      });
    } else if (data.segments && data.segments.length > 0) {
      srcSegments = data.segments.map(function(s) {
        return { start: s.start, end: s.end, text: s.text.trim() };
      });
    } else {
      var totalDur = FlashCutApp.activeSequenceData ? FlashCutApp.activeSequenceData.duration : 60;
      var words = (data.text || '').trim().split(/\s+/);
      var dur = totalDur / Math.max(words.length, 1);
      srcSegments = words.map(function(w, i) {
        return { start: i * dur, end: (i + 1) * dur, text: w };
      });
    }

    // If a target language was chosen, translate via MyMemory
    if (wantTranslation && data.text) {
      setStatus('Translating to ' + language + '…', 'purple pulse');
      await yieldToPaint();
      var maxWords = parseInt(document.getElementById('max-words').value) || 6;
      var captionGroups = buildCaptionsFromSegments(srcSegments, maxWords);
      var translated = await translateCaptionGroups(captionGroups, data.language || 'auto', language);
      if (translated && translated.length > 0) {
        return { segments: translated.map(function(c) {
          return { start: c.start, end: c.end, text: c.text };
        }), text: translated.map(function(c) { return c.text; }).join(' ') };
      }
      showToast('Translation failed, showing original transcription.', 'warning', 5000);
    }

    return { segments: srcSegments, text: data.text };
  } catch(e) {
    return { error: 'Network error: ' + e.message };
  }
}

/* ═══════════════════════════════════════════════
   ASSEMBLYAI TRANSCRIPTION
══════════════════════════════════════════════ */
async function transcribeWithAssemblyAI(audioBlob) {
  var apiKey = document.getElementById('assemblyai-key').value.trim();
  if (!apiKey) {
    showToast('Please enter your AssemblyAI API key.', 'warning');
    return { error: 'No API key provided.' };
  }
  storeSave('assemblyai-key', apiKey);

  var language        = document.getElementById('caption-language').value;
  var wantTranslation = language && language !== 'auto';
  var wantSpeakers    = !!(document.getElementById('toggle-speakers')   && document.getElementById('toggle-speakers').checked);
  var wantChapters    = !!(document.getElementById('toggle-chapters')   && document.getElementById('toggle-chapters').checked);

  try {
    // \u2500\u2500 Step 1: Upload ─────────────────────────────────────────────────────
    setStatus('Uploading audio to AssemblyAI\u2026', 'purple pulse');
    await yieldToPaint();

    var uploadResp = await fetch('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: { 'Authorization': apiKey, 'Content-Type': 'application/octet-stream' },
      body: audioBlob
    });
    if (!uploadResp.ok) {
      var ue = ''; try { ue = JSON.stringify(await uploadResp.json()); } catch(e) { ue = uploadResp.statusText; }
      return { error: 'Upload failed (' + uploadResp.status + '): ' + ue };
    }
    var audioUrl = (await uploadResp.json()).upload_url;
    if (!audioUrl) return { error: 'No upload URL returned' };

    // \u2500\u2500 Step 2: Submit transcription request ─────────────────────────────
    setStatus('Submitting transcription\u2026', 'purple pulse');
    await yieldToPaint();

    var reqBody = {
      audio_url:          audioUrl,
      speech_models:      ['universal-2'],
      punctuate:          true,
      format_text:        true,
      language_detection: true
    };
    if (wantSpeakers) reqBody.speaker_labels = true;
    if (wantChapters) reqBody.auto_chapters  = true;

    var transcriptResp = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody)
    });
    if (!transcriptResp.ok) {
      var te = ''; try { te = JSON.stringify(await transcriptResp.json()); } catch(e) { te = transcriptResp.statusText; }
      return { error: 'Transcript request failed (' + transcriptResp.status + '): ' + te };
    }
    var transcriptId = (await transcriptResp.json()).id;
    if (!transcriptId) return { error: 'No transcript ID returned' };

    // \u2500\u2500 Step 3: Poll until complete ──────────────────────────────────────────
    var pollData = null;
    for (var attempt = 0; attempt < 120; attempt++) {
      await new Promise(function(r) { setTimeout(r, 3000); });
      setStatus('Transcribing\u2026 ' + ((attempt + 1) * 3) + 's', 'purple pulse');
      var pr = await fetch('https://api.assemblyai.com/v2/transcript/' + transcriptId, {
        headers: { 'Authorization': apiKey }
      });
      if (!pr.ok) continue;
      pollData = await pr.json();
      if (pollData.status === 'completed') break;
      if (pollData.status === 'error') return { error: 'AssemblyAI: ' + (pollData.error || 'processing failed') };
    }
    if (!pollData || pollData.status !== 'completed') {
      return { error: 'Timed out. Try a shorter clip or Manual Upload.' };
    }

    // \u2500\u2500 Step 4: Build word-level segments ────────────────────────────────────
    //
    // SPEAKER DETECTION STRATEGY (correct approach):
    // When speaker_labels is requested, AssemblyAI returns pollData.utterances[]
    // Each utterance has: { speaker: "A", words: [{text, start, end, confidence}] }
    // We use utterance words DIRECTLY as the source of truth — they already carry
    // the speaker label on every word and are perfectly aligned.
    // We do NOT use pollData.words for the speaker path because those are separate
    // objects whose timestamps may differ by ±1ms from utterance word timestamps.
    //
    var srcSegments = [];

    if (wantSpeakers && pollData.utterances && pollData.utterances.length > 0) {
      // ── Automatic speaker consistency fix ──────────────────────────────
      // AssemblyAI sometimes splits one person into two speaker labels when
      // they pause, change mic distance, or vary their tone.
      // Fix: if a short utterance (<3s) is surrounded on both sides by the
      // same speaker, re-label it to that speaker (likely a mis-attribution).
      var utts = pollData.utterances.slice(); // shallow copy
      for (var ui = 1; ui < utts.length - 1; ui++) {
        var prev = utts[ui - 1];
        var curr = utts[ui];
        var next = utts[ui + 1];
        var currDur = (curr.end - curr.start) / 1000; // ms → seconds
        // If this utterance is short AND its neighbours both belong to the
        // same different speaker → it is almost certainly mis-labeled
        if (prev.speaker === next.speaker &&
            curr.speaker !== prev.speaker &&
            currDur < 3.0) {
          curr.speaker = prev.speaker;
        }
      }

      // ── Build segments from corrected utterances ──────────────────────
      utts.forEach(function(utt) {
        var uttWords = utt.words || [];
        uttWords.forEach(function(w) {
          srcSegments.push({
            start:      w.start      / 1000,
            end:        w.end        / 1000,
            text:       w.text       || '',
            confidence: (typeof w.confidence === 'number') ? w.confidence : 1,
            speaker:    utt.speaker  || null   // corrected speaker label
          });
        });
      });
      // Sort by start time — utterances are in order but be defensive
      srcSegments.sort(function(a, b) { return a.start - b.start; });

    } else {
      // No speaker detection — use pollData.words (standard path)
      var rawWords = pollData.words || [];
      if (rawWords.length > 0) {
        srcSegments = rawWords.map(function(w) {
          return {
            start:      w.start      / 1000,
            end:        w.end        / 1000,
            text:       w.text       || '',
            confidence: (typeof w.confidence === 'number') ? w.confidence : 1,
            speaker:    null
          };
        });
      } else {
        // No word timestamps — single block
        srcSegments = [{
          start:      0,
          end:        pollData.audio_duration || 30,
          text:       pollData.text || '',
          confidence: 1,
          speaker:    null
        }];
      }
    }

    // \u2500\u2500 Step 5: Chapter markers ──────────────────────────────────────────────
    var chapters = [];
    if (wantChapters && pollData.chapters && pollData.chapters.length > 0) {
      chapters = pollData.chapters.map(function(ch) {
        return {
          start:    ch.start / 1000,
          end:      ch.end   / 1000,
          headline: ch.headline || ch.gist || 'Chapter',
          gist:     ch.gist    || ''
        };
      });
    }

    // \u2500\u2500 Step 6: Translate if needed ─────────────────────────────────────────
    if (wantTranslation && pollData.text) {
      setStatus('Translating to ' + language + '\u2026', 'purple pulse');
      await yieldToPaint();
      var maxW = parseInt(document.getElementById('max-words').value) || 6;
      var captionGroups = buildCaptionsFromSegments(srcSegments, maxW);
      var translated = await translateCaptionGroups(captionGroups, pollData.language_code || 'auto', language);
      if (translated && translated.length > 0) {
        return {
          segments: translated.map(function(c) { return { start: c.start, end: c.end, text: c.text }; }),
          text:     translated.map(function(c) { return c.text; }).join(' '),
          chapters: chapters
        };
      }
      showToast('Translation failed, showing original.', 'warning', 5000);
    }

    return { segments: srcSegments, text: pollData.text, chapters: chapters };

  } catch(e) {
    return { error: 'Network error: ' + e.message };
  }
}

/* ═══════════════════════════════════════════════
   TRANSLATE CAPTION GROUPS
   Uses MyMemory free translation API (no key needed).
   Batches captions into chunks to stay under URL limits.
══════════════════════════════════════════════ */
async function translateCaptionGroups(captionGroups, sourceLang, targetLang) {
  if (!captionGroups || captionGroups.length === 0) return null;

  // MyMemory language pair format: "ar|en", "fr|en", etc.
  // If source language detection returned a code, use it; else use 'auto' → MyMemory handles it
  var fromLang = (sourceLang && sourceLang !== 'auto' && sourceLang.length === 2) ? sourceLang : '';
  var langPair = (fromLang ? fromLang : 'auto') + '|' + targetLang;

  var translated = [];

  // Translate in small batches of 3 captions at a time to stay under 500 char URL limit
  var BATCH = 3;
  for (var i = 0; i < captionGroups.length; i += BATCH) {
    var batch = captionGroups.slice(i, i + BATCH);
    var batchText = batch.map(function(c) { return c.text; }).join(' ||| ');

    try {
      var url = 'https://api.mymemory.translated.net/get?q=' +
                encodeURIComponent(batchText) + '&langpair=' + langPair;
      var resp = await fetch(url);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var data = await resp.json();

      if (data.responseStatus === 200 && data.responseData && data.responseData.translatedText) {
        var translatedBatch = data.responseData.translatedText.split(' ||| ');
        batch.forEach(function(cap, bi) {
          translated.push({
            id:    cap.id,
            start: cap.start,
            end:   cap.end,
            text:  (translatedBatch[bi] || cap.text).trim()
          });
        });
      } else {
        // API returned error — keep originals for this batch
        batch.forEach(function(cap) { translated.push(cap); });
      }
    } catch(e) {
      // Network error — keep originals
      batch.forEach(function(cap) { translated.push(cap); });
    }

    // Small pause between requests to avoid rate limiting
    if (i + BATCH < captionGroups.length) {
      await new Promise(function(r) { setTimeout(r, 300); });
    }
  }

  return translated.length > 0 ? translated : null;
}

/* ═══════════════════════════════════════════════
   DEEPGRAM TRANSCRIPTION
══════════════════════════════════════════════ */
async function transcribeWithDeeepgram(audioBlob, filename) {
  var apiKey = document.getElementById('deepgram-key').value.trim();
  if (!apiKey) {
    showToast('Please enter your Deepgram API key.', 'warning');
    return { error: 'No API key provided.' };
  }
  storeSave('deepgram-key', apiKey);

  var language = document.getElementById('caption-language').value;
  var wantTranslation = language && language !== 'auto';

  // Deepgram: always auto-detect, then translate if needed
  // Do NOT pass language param — let Deepgram detect so transcription is accurate
  var url = 'https://api.deepgram.com/v1/listen?model=nova-2&punctuate=true&words=true&detect_language=true';

  try {
    setStatus('Sending audio to Deepgram…', 'purple pulse');
    await yieldToPaint();

    var resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Token ' + apiKey,
        'Content-Type': audioBlob.type || 'audio/wav'
      },
      body: audioBlob
    });

    if (!resp.ok) {
      var errData = await resp.json().catch(function(){ return {}; });
      return { error: 'Deepgram error ' + resp.status + ': ' + JSON.stringify(errData) };
    }

    var data = await resp.json();
    var alt = data.results &&
              data.results.channels &&
              data.results.channels[0] &&
              data.results.channels[0].alternatives &&
              data.results.channels[0].alternatives[0];

    if (!alt) return { error: 'Deepgram returned no results' };

    var words = alt.words || [];
    var srcSegments = words.map(function(w) {
      return { start: w.start, end: w.end, text: w.punctuated_word || w.word };
    });

    var transcript = alt.transcript || '';

    // Translate if a target language was chosen
    if (wantTranslation && transcript) {
      setStatus('Translating to ' + language + '…', 'purple pulse');
      await yieldToPaint();
      var detectedLang = (data.results.channels[0].detected_language || 'auto');
      var maxWords = parseInt(document.getElementById('max-words').value) || 6;
      var captionGroups = buildCaptionsFromSegments(srcSegments, maxWords);
      var translated = await translateCaptionGroups(captionGroups, detectedLang, language);
      if (translated && translated.length > 0) {
        return { segments: translated.map(function(c) {
          return { start: c.start, end: c.end, text: c.text };
        }), text: translated.map(function(c) { return c.text; }).join(' ') };
      }
      showToast('Translation failed, showing original transcription.', 'warning', 5000);
    }

    return { segments: srcSegments, text: transcript };
  } catch(e) {
    return { error: 'Network error: ' + e.message };
  }
}

/* ═══════════════════════════════════════════════
   BUILD CAPTIONS FROM WORD SEGMENTS
   Groups words into caption blocks by maxWords
══════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════
   REMAP AUDIO TIME → SEQUENCE TIMELINE TIME
   segmentMap: [{audioStart, audioEnd, timelineStart}, ...]
   audioTime: seconds in the concatenated audio blob
   returns: the corresponding sequence timeline time in seconds
══════════════════════════════════════════════ */
function remapToTimeline(audioTime, segmentMap) {
  for (var i = 0; i < segmentMap.length; i++) {
    var seg = segmentMap[i];
    if (audioTime >= seg.audioStart && audioTime <= seg.audioEnd) {
      var offsetWithinSeg = audioTime - seg.audioStart;
      return seg.timelineStart + offsetWithinSeg;
    }
  }
  // Past the last segment — clamp to last segment end
  if (segmentMap.length > 0) {
    var last = segmentMap[segmentMap.length - 1];
    return last.timelineStart + (last.audioEnd - last.audioStart);
  }
  return audioTime;
}

function buildCaptionsFromSegments(segments, maxWords) {
  if (!segments || segments.length === 0) return [];

  var captions = [];
  var currentGroup = [];
  var groupId = 0;

  function flushGroup() {
    if (currentGroup.length === 0) return;
    var text = currentGroup.map(function(s) { return s.text.trim(); }).join(' ');
    text = text.replace(/\s+([,.!?;:])/g, '$1');
    captions.push({
      id:         'cap_' + (++groupId),
      start:      currentGroup[0].start,
      end:        currentGroup[currentGroup.length - 1].end,
      text:       text,
      speaker:    getMajoritySpeaker(currentGroup),
      confidence: getAvgConfidence(currentGroup)
    });
    currentGroup = [];
  }

  for (var i = 0; i < segments.length; i++) {
    var seg = segments[i];
    if (!seg.text || !seg.text.trim()) continue;

    // SPEAKER BREAK: if the speaker changes, flush the current group first.
    // This ensures every speaker's words form their own caption block —
    // Speaker B's first word is never merged with Speaker A's last caption.
    if (currentGroup.length > 0 && seg.speaker && currentGroup[0].speaker &&
        seg.speaker !== currentGroup[0].speaker) {
      flushGroup();
    }

    currentGroup.push(seg);

    var wordCount = currentGroup.reduce(function(acc, s) {
      return acc + s.text.trim().split(/\s+/).length;
    }, 0);

    var isLastSeg           = (i === segments.length - 1);
    var endsWithPunctuation = /[.!?…]$/.test(seg.text.trim());
    var nextSeg             = !isLastSeg ? segments[i + 1] : null;
    var nextSegGap          = nextSeg ? (nextSeg.start - seg.end) : Infinity;
    // Also break if next word belongs to a different speaker
    var nextSpeakerChange   = nextSeg && nextSeg.speaker && seg.speaker &&
                              nextSeg.speaker !== seg.speaker;

    if (wordCount >= maxWords || endsWithPunctuation || nextSegGap > 1.2 ||
        nextSpeakerChange || isLastSeg) {
      flushGroup();
    }
  }

  return captions;
}

/* ═══════════════════════════════════════════════
   RENDER CAPTION LIST
══════════════════════════════════════════════ */
// Returns the most common speaker in a group of word segments
function getMajoritySpeaker(words) {
  var counts = {};
  words.forEach(function(w) { if (w.speaker) counts[w.speaker] = (counts[w.speaker] || 0) + 1; });
  var best = null, bestCount = 0;
  Object.keys(counts).forEach(function(k) { if (counts[k] > bestCount) { best = k; bestCount = counts[k]; } });
  return best;
}

// Returns the average confidence across a group of word segments
function getAvgConfidence(words) {
  var total = 0, count = 0;
  words.forEach(function(w) { if (typeof w.confidence === 'number') { total += w.confidence; count++; } });
  return count > 0 ? total / count : 1;
}
function renderCaptionList(captions) {
  var list = document.getElementById('caption-list');
  list.innerHTML = '';

  // Build speaker colour map
  var speakerColors = ['#FF6B6B','#4ECDC4','#FFD93D','#6BCB77','#4D96FF','#FF6FC8','#A855F7'];
  var colorIdx = 0;
  captions.forEach(function(cap) {
    if (cap.speaker && !CaptionsModule.speakers[cap.speaker]) {
      CaptionsModule.speakers[cap.speaker] = speakerColors[colorIdx % speakerColors.length];
      colorIdx++;
    }
  });

  var hasSpeakers   = Object.keys(CaptionsModule.speakers).length > 0;
  var hasConfidence = captions.some(function(c) { return typeof c.confidence === 'number' && c.confidence < 1; });
  CaptionsModule.hasSpeakers   = hasSpeakers;
  CaptionsModule.hasConfidence = hasConfidence;

  // Show/hide the confidence legend
  var legend = document.getElementById('caption-confidence-legend');
  if (legend) legend.style.display = hasConfidence ? '' : 'none';

  // Update the speaker legend
  updateSpeakerLegend();

  captions.forEach(function(cap, idx) {
    var item = document.createElement('div');
    item.className = 'caption-item';
    item.setAttribute('data-id', cap.id);

    // Confidence-based border colour
    var conf = typeof cap.confidence === 'number' ? cap.confidence : 1;
    var confClass = conf < 0.6 ? ' conf-low' : (conf < 0.85 ? ' conf-mid' : '');
    if (confClass) item.classList.add(confClass.trim());

    // Speaker badge
    var speakerBadge = '';
    if (hasSpeakers && cap.speaker) {
      var col = CaptionsModule.speakers[cap.speaker] || '#888';
      speakerBadge = '<span class="speaker-badge" style="background:' + col + '">Speaker ' + cap.speaker + '</span>';
    }

    // Confidence indicator
    var confIndicator = '';
    if (hasConfidence && conf < 0.85) {
      var confPct = Math.round(conf * 100);
      confIndicator = '<span class="conf-badge" title="' + confPct + '% confidence">' +
        (conf < 0.6 ? '⚠' : '~') + confPct + '%</span>';
    }

    item.innerHTML =
      '<div class="caption-meta">' + speakerBadge + confIndicator +
        '<span class="caption-time">' + formatSRTTime(cap.start) + ' → ' + formatSRTTime(cap.end) + '</span>' +
      '</div>' +
      '<div class="caption-text-display">' + escapeHTML(cap.text) + '</div>' +
      '<div class="caption-actions" style="display:none">' +
        '<button class="btn btn-sm btn-ghost caption-btn-edit">✎ Edit</button>' +
        '<button class="btn btn-sm btn-danger caption-btn-delete">✕</button>' +
      '</div>';

    // Click to expand / edit
    item.addEventListener('click', function(e) {
      if (e.target.closest('.caption-btn-edit')) return;
      if (e.target.closest('.caption-btn-delete')) return;
      var actions = item.querySelector('.caption-actions');
      var isExpanded = item.classList.contains('editing');
      // Close all
      document.querySelectorAll('.caption-item').forEach(function(ci) {
        ci.classList.remove('editing');
        ci.querySelector('.caption-actions').style.display = 'none';
      });
      if (!isExpanded) {
        item.classList.add('editing');
        actions.style.display = 'flex';
      }
    });

    // Edit button
    item.querySelector('.caption-btn-edit').addEventListener('click', function(e) {
      e.stopPropagation();
      startEditCaption(item, cap, idx);
    });

    // Delete button
    item.querySelector('.caption-btn-delete').addEventListener('click', function(e) {
      e.stopPropagation();
      CaptionsModule.captions.splice(idx, 1);
      renderCaptionList(CaptionsModule.captions);
      document.getElementById('caption-count').textContent = CaptionsModule.captions.length + ' captions';
      showToast('Caption removed', 'info');
    });

    list.appendChild(item);
  });
}

function startEditCaption(item, cap, idx) {
  var displayEl = item.querySelector('.caption-text-display');
  var currentText = cap.text;

  displayEl.style.display = 'none';

  var textarea = document.createElement('textarea');
  textarea.className = 'caption-text-edit';
  textarea.value = currentText;
  textarea.rows = Math.ceil(currentText.length / 40) + 1;
  item.insertBefore(textarea, displayEl);
  textarea.focus();

  // Also add time editors
  var timeEl = item.querySelector('.caption-time');
  var originalTime = timeEl.textContent;

  function saveEdit() {
    var newText = textarea.value.trim() || cap.text;
    cap.text = newText;
    CaptionsModule.captions[idx] = cap;
    textarea.remove();
    displayEl.textContent = cap.text;
    displayEl.style.display = '';
    item.classList.remove('editing');
    item.querySelector('.caption-actions').style.display = 'none';

    // Step 1: Store the FULL updated captions array into ExtendScript
    // Use a fresh JSON stringify of the entire array — guarantees the edited
    // text is in the store before createCaptionTrack() reads it.
    var updatedJSON = JSON.stringify(CaptionsModule.captions);
    var styleJSON   = JSON.stringify(getCaptionStyleData());

    evalScript('storeFlashcutData("captions", \'' + updatedJSON.replace(/'/g, "\\'") + '\')')
      .then(function() {
        return evalScript('storeFlashcutData("captionStyle", \'' + styleJSON.replace(/'/g, "\\'") + '\')')
      })
      .then(function() {
        // Step 2: Try surgical single-segment update first
        var esc = newText.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        return evalScript('updateCaptionSegment(' + idx + ', \'' + esc + '\')');
      })
      .then(function(result) {
        if (result && result.success) {
          showToast('\u2713 Caption updated in timeline', 'success');
        } else {
          // Step 3: Surgical failed — createCaptionTrack now reads the updated store
          return evalScript('createCaptionTrack()').then(function(r) {
            showToast(r && !r.error ? '\u2713 Caption updated on timeline' : 'Caption saved locally', 'success');
          });
        }
      })
      .catch(function(e) {
        showToast('Caption saved locally', 'info');
      });
  }

  var saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn-sm btn-primary';
  saveBtn.textContent = '✓ Save';
  saveBtn.addEventListener('click', function(e) { e.stopPropagation(); saveEdit(); });
  item.querySelector('.caption-actions').prepend(saveBtn);

  textarea.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(); }
    if (e.key === 'Escape') {
      textarea.remove(); saveBtn.remove();
      displayEl.style.display = '';
      item.classList.remove('editing');
      item.querySelector('.caption-actions').style.display = 'none';
    }
  });
}

/* ═══════════════════════════════════════════════
   EXPORT SRT
══════════════════════════════════════════════ */
async function exportSRT() {
  if (CaptionsModule.captions.length === 0) {
    showToast('No captions to export', 'warning');
    return;
  }

  var srt = generateSRTContent(CaptionsModule.captions);
  var blob = new Blob([srt], { type: 'text/plain;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'FlashCutAI_captions.srt';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('SRT downloaded!', 'success');

  // Also save to temp folder via ExtendScript (non-blocking — evalScript is async)
  try {
    var tempResult = await evalScript('getTempPath()');
    var tempDir = (tempResult && tempResult.path) ? tempResult.path : '';
    if (tempDir) {
      var srtPath = tempDir + '/FlashCutAI_captions.srt';
      // Store SRT content and write via ExtendScript to avoid blocking the UI
      await evalScript('storeFlashcutData("srtContent", \'' + srt.replace(/'/g, "\\'").replace(/\n/g, '\\n') + '\')');
      await evalScript('(function(){ var d=$.flashcutStore&&$.flashcutStore["srtContent"]||""; var f=new File("' + srtPath.replace(/\\/g,'\\\\') + '"); f.open("w"); f.encoding="UTF-8"; f.write(d); f.close(); return "ok"; })()');
      showToast('SRT also saved to temp folder', 'info', 4000);
    }
  } catch(e) { /* non-critical — download already worked */ }
}

function generateSRTContent(captions) {
  var srt = '';
  captions.forEach(function(cap, i) {
    srt += (i + 1) + '\n';
    srt += formatSRTTime(cap.start) + ' --> ' + formatSRTTime(cap.end) + '\n';
    srt += cap.text + '\n\n';
  });
  return srt;
}

function formatSRTTime(seconds) {
  seconds = parseFloat(seconds) || 0;
  var h = Math.floor(seconds / 3600);
  var m = Math.floor((seconds % 3600) / 60);
  var s = Math.floor(seconds % 60);
  var ms = Math.round((seconds - Math.floor(seconds)) * 1000);
  return pad2(h) + ':' + pad2(m) + ':' + pad2(s) + ',' + pad3(ms);
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }
function pad3(n) { return n < 10 ? '00' + n : (n < 100 ? '0' + n : String(n)); }

/* ═══════════════════════════════════════════════
   ADD CAPTIONS TO TIMELINE
══════════════════════════════════════════════ */
async function addCaptionsToTimeline() {
  if (!requireSequence()) return;
  if (CaptionsModule.captions.length === 0) {
    showToast('No captions to add', 'warning');
    return;
  }

  await batchDom(function() {
    setBtnLoading('btn-add-to-timeline', true);
    setStatus('Adding captions to timeline…', 'purple pulse');
  });
  try {
    // Store captions + style via the global store (no JSON-escaping fragility)
    var style = getCaptionStyleData();
    var captionsJSON = JSON.stringify(CaptionsModule.captions);
    var styleJSON    = JSON.stringify(style);

    await evalScript('storeFlashcutData("captions", \'' + captionsJSON.replace(/'/g, "\\'") + '\')');
    await evalScript('storeFlashcutData("captionStyle", \'' + styleJSON.replace(/'/g, "\\'") + '\')');

    var result = await evalScript('createCaptionTrack()');

    if (result.error) {
      showToast('Error: ' + result.error, 'error');
      setStatus('Failed to add captions', 'red');
    } else if (result.method === 'caption_track' || result.method === 'srt_placed') {
      showToast('✓ ' + result.count + ' captions updated on timeline!', 'success', 5000);
      setStatus('✓ ' + result.count + ' captions on timeline', 'green');
    } else if (result.method === 'srt_export') {
      showToast('Captions saved as SRT — import via File → Import: ' + result.srtPath, 'info', 10000);
      await evalScript('revealFileInOS("' + result.srtPath.replace(/\\/g, '\\\\') + '")');
      setStatus('SRT ready — import into Premiere Pro', 'orange');
    } else {
      showToast('✓ ' + result.count + ' captions on timeline!', 'success');
      setStatus('✓ ' + result.count + ' captions on timeline', 'green');
    }
  } catch(e) {
    showToast('Failed: ' + e.message, 'error');
  }

  setBtnLoading('btn-add-to-timeline', false);
}

function getCaptionStyleData() {
  // Prefer the live StyleState object (set by stylePanel.js) over localStorage
  if (window.StyleState) return window.StyleState;
  return {
    fontFamily: storeLoad('style-font', 'Arial'),
    fontSize: parseInt(storeLoad('style-fontSize', '40')),
    fontWeight: storeLoad('style-fontWeight', '700'),
    textColor: storeLoad('style-textColor', '#FFFFFF'),
    bgColor: storeLoad('style-bgColor', '#000000'),
    bgOpacity: parseInt(storeLoad('style-bgOpacity', '75')),
    bgEnabled: storeLoad('style-bgEnabled', true),
    shadow: storeLoad('style-shadow', true),
    outline: storeLoad('style-outline', false),
    position: storeLoad('style-position', 'bot-center'),
    animation: storeLoad('style-animation', 'none')
  };
}

/* ═══════════════════════════════════════════════
   WAVEFORM VIZ
══════════════════════════════════════════════ */
function activateWaveformViz(active) {
  var viz = document.getElementById('waveform-viz');
  if (active) {
    viz.classList.add('active');
    viz.querySelector('span').textContent = 'Analyzing audio…';
  } else {
    viz.classList.remove('active');
    viz.querySelector('span').textContent = 'Ready to analyze audio…';
  }
}

/* ═══════════════════════════════════════════════
   UTILITIES
══════════════════════════════════════════════ */
function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ═══════════════════════════════════════════════
   AUDIO COMPRESSION
   Decodes any audio/video buffer, resamples to
   16kHz mono, encodes as 16-bit PCM WAV.
   Reduces a 100MB MP4 to ~10-15MB — well under
   Whisper's 25MB limit for typical recordings.
══════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════
   CHUNKED TRANSCRIPTION
   Splits audio into ≤10 min chunks, transcribes each,
   offsets timestamps, merges into one caption list.
   Removes the 25MB file size limit entirely.
══════════════════════════════════════════════ */
async function transcribeInChunks(arrayBuffer, filename, provider, maxWords) {
  var CHUNK_SECONDS = 600; // 10 minutes per chunk
  var TARGET_RATE   = 16000;

  // Decode the full audio to float PCM
  setStatus('Decoding full audio for chunking…', 'purple pulse');
  await yieldToPaint();
  var srcBuffer = await new Promise(function(resolve, reject) {
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctx.decodeAudioData(arrayBuffer,
      function(buf) { ctx.close(); resolve(buf); },
      function(err) { ctx.close(); reject(new Error('Decode: ' + (err && err.message || err))); }
    );
  });

  // Resample entire buffer to 16kHz mono
  var totalFrames = Math.ceil(srcBuffer.duration * TARGET_RATE);
  var offCtx = new OfflineAudioContext(1, totalFrames, TARGET_RATE);
  var src = offCtx.createBufferSource();
  src.buffer = srcBuffer;
  src.connect(offCtx.destination);
  src.start(0);
  var monoBuffer = await offCtx.startRendering();
  var monoPcm = monoBuffer.getChannelData(0);

  var totalDuration = srcBuffer.duration;
  var numChunks = Math.ceil(totalDuration / CHUNK_SECONDS);
  var allSegments = [];

  for (var ci = 0; ci < numChunks; ci++) {
    var chunkStart   = ci * CHUNK_SECONDS;
    var chunkEnd     = Math.min(chunkStart + CHUNK_SECONDS, totalDuration);
    var chunkOffset  = chunkStart; // seconds to add to all timestamps in this chunk

    setStatus('Transcribing chunk ' + (ci+1) + '/' + numChunks + '…', 'purple pulse');
    await yieldToPaint();

    // Slice PCM samples for this chunk
    var startSample = Math.floor(chunkStart * TARGET_RATE);
    var endSample   = Math.floor(chunkEnd   * TARGET_RATE);
    var chunkPcm    = monoPcm.slice(startSample, endSample);

    // Encode chunk as 16-bit WAV
    var chunkWav  = encodeWav16(chunkPcm, TARGET_RATE);
    var chunkBlob = new Blob([chunkWav], { type: 'audio/wav' });
    var chunkName = filename.replace(/\.[^.]+$/, '') + '_chunk' + (ci+1) + '.wav';

    try {
      var transcriptData = null;
      if (provider === 'whisper') {
        transcriptData = await transcribeWithWhisper(chunkBlob, chunkName);
      } else if (provider === 'assemblyai') {
        transcriptData = await transcribeWithAssemblyAI(chunkBlob);
      } else {
        transcriptData = await transcribeWithDeeepgram(chunkBlob, chunkName);
      }

      if (transcriptData && transcriptData.segments) {
        // Offset each segment's timestamps by the chunk's start time
        transcriptData.segments.forEach(function(seg) {
          allSegments.push({
            start: seg.start + chunkOffset,
            end:   seg.end   + chunkOffset,
            text:  seg.text
          });
        });
      }
    } catch(chunkErr) {
      console.warn('Chunk ' + (ci+1) + ' failed:', chunkErr.message);
      // Continue with remaining chunks
    }
  }

  if (allSegments.length === 0) return [];
  return buildCaptionsFromSegments(allSegments, maxWords || 6);
}

async function compressAudioTo16kWav(arrayBuffer) {
  var TARGET_RATE = 16000; // 16kHz — Whisper's native input rate

  // Decode the source (handles MP4, MOV, WAV, MP3, AAC, etc.)
  var srcBuffer = await new Promise(function(resolve, reject) {
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctx.decodeAudioData(arrayBuffer,
      function(buf) { ctx.close(); resolve(buf); },
      function(err) { ctx.close(); reject(new Error('Decode failed: ' + (err && err.message || err))); }
    );
  });

  // Resample: mix down to mono at 16kHz using OfflineAudioContext
  var numFrames = Math.ceil(srcBuffer.duration * TARGET_RATE);
  var offCtx = new OfflineAudioContext(1, numFrames, TARGET_RATE);
  var src = offCtx.createBufferSource();
  src.buffer = srcBuffer;
  src.connect(offCtx.destination);
  src.start(0);
  var resampled = await offCtx.startRendering();

  // Encode as 16-bit PCM WAV
  var pcm = resampled.getChannelData(0); // Float32 mono
  var wavBuf = encodeWav16(pcm, TARGET_RATE);
  return new Blob([wavBuf], { type: 'audio/wav' });
}

function encodeWav16(float32Samples, sampleRate) {
  var numSamples = float32Samples.length;
  var bytesPerSample = 2; // 16-bit
  var dataBytes = numSamples * bytesPerSample;
  var buffer = new ArrayBuffer(44 + dataBytes);
  var view = new DataView(buffer);

  function writeStr(off, str) {
    for (var i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  }
  writeStr(0, 'RIFF');
  view.setUint32(4,  36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);          // PCM chunk size
  view.setUint16(20, 1, true);           // PCM format
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);          // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);

  // Convert Float32 [-1,1] → Int16 with clipping
  var off = 44;
  for (var i = 0; i < numSamples; i++) {
    var s = Math.max(-1, Math.min(1, float32Samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    off += 2;
  }
  return buffer;
}

/* ═══════════════════════════════════════════════
   EVENT LISTENERS
══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', function() {
  document.getElementById('btn-generate-captions').addEventListener('click', generateCaptions);
  document.getElementById('btn-export-srt').addEventListener('click', exportSRT);
  document.getElementById('btn-add-to-timeline').addEventListener('click', addCaptionsToTimeline);
  document.getElementById('btn-clear-captions').addEventListener('click', function() {
    CaptionsModule.captions = [];
    CaptionsModule.speakers = {};
    CaptionsModule.chapters = [];
    document.getElementById('caption-results').style.display = 'none';
    document.getElementById('caption-list').innerHTML = '';
    showToast('Captions cleared', 'info');
  });

  // ── Batch Sequences ───────────────────────────────────────────────────
  document.getElementById('btn-load-sequences').addEventListener('click', async function() {
    var result = await evalScript('getAllSequenceIds()');
    if (result.error || !result.sequences) {
      showToast('Could not load sequences: ' + (result.error || 'unknown'), 'error');
      return;
    }
    var seqs = result.sequences;
    var list = document.getElementById('batch-sequence-list');
    list.innerHTML = '';
    if (seqs.length === 0) {
      list.innerHTML = '<div style="font-size:11px;color:var(--text-muted)">No sequences found in project.</div>';
      return;
    }
    seqs.forEach(function(seq) {
      var row = document.createElement('div');
      row.className = 'batch-seq-row';
      var dur = seq.duration ? ' (' + Math.round(seq.duration) + 's)' : '';
      row.innerHTML =
        '<label style="display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer">' +
          '<input type="checkbox" class="batch-seq-check" data-id="' + seq.id + '" data-name="' + escapeHTML(seq.name) + '" checked/>' +
          '<span>' + escapeHTML(seq.name) + '</span>' +
          '<span style="color:var(--text-muted)">' + dur + '</span>' +
        '</label>';
      list.appendChild(row);
    });
    document.getElementById('btn-batch-caption').style.display = '';
    showToast(seqs.length + ' sequence(s) loaded. Check which to caption.', 'info', 4000);
  });

  document.getElementById('btn-batch-caption').addEventListener('click', async function() {
    var checks = document.querySelectorAll('.batch-seq-check:checked');
    if (checks.length === 0) {
      showToast('Select at least one sequence to batch caption.', 'warning');
      return;
    }
    var seqIds = [];
    checks.forEach(function(c) { seqIds.push({ id: c.getAttribute('data-id'), name: c.getAttribute('data-name') }); });
    await runBatchCaption(seqIds);
  });

  // ── Premiere → Plugin sync ────────────────────────────────────────────
  setInterval(function() {
    var captionsPanel  = document.getElementById('panel-captions');
    var captionResults = document.getElementById('caption-results');
    var isEditing      = document.querySelector('.caption-item.editing');
    var isBusy         = CaptionsModule.isProcessing;

    if (!captionsPanel || !captionsPanel.classList.contains('active')) return;
    if (!captionResults || captionResults.style.display === 'none') return;
    if (isEditing || isBusy) return;
    if (CaptionsModule.captions.length === 0) return;

    evalScript('getCaptionSegments()').then(function(result) {
      if (!result || result.error || !result.segments || result.segments.length === 0) return;
      var premiereCaps = result.segments;
      var changed = false;
      premiereCaps.forEach(function(seg) {
        var idx = seg.index;
        if (idx >= 0 && idx < CaptionsModule.captions.length) {
          var pluginText   = CaptionsModule.captions[idx].text;
          var premiereText = (seg.text || '').trim();
          if (premiereText && premiereText !== pluginText) {
            CaptionsModule.captions[idx].text = premiereText;
            changed = true;
            var items = document.querySelectorAll('.caption-item');
            if (items[idx]) {
              var display = items[idx].querySelector('.caption-text-display');
              if (display) display.textContent = premiereText;
            }
          }
        }
      });
      if (changed) setStatus('Synced from Premiere Essential Graphics', 'green');
    }).catch(function() {});

  }, 2000);
});

/* ═══════════════════════════════════════════════
   BATCH CAPTION — process multiple sequences
══════════════════════════════════════════════ */
async function runBatchCaption(seqList) {
  if (CaptionsModule.isProcessing) return;
  CaptionsModule.isProcessing = true;

  setBtnLoading('btn-batch-caption', true);
  var progressBar   = document.getElementById('batch-progress');
  var progressFill  = document.getElementById('batch-progress-fill');
  var progressLabel = document.getElementById('batch-progress-label');
  progressBar.style.display = '';

  for (var i = 0; i < seqList.length; i++) {
    var seq = seqList[i];
    var pct = Math.round((i / seqList.length) * 100);
    progressFill.style.width  = pct + '%';
    progressLabel.textContent = 'Processing ' + (i + 1) + '/' + seqList.length + ': ' + seq.name;

    // Switch active sequence
    await evalScript('setActiveSequenceById("' + seq.id + '")');
    await yieldToPaint();

    // Run the full generate flow for this sequence
    try {
      await generateCaptionsForActiveSequence();
    } catch(e) {
      showToast('Error on "' + seq.name + '": ' + e.message, 'error', 5000);
    }
    await new Promise(function(r) { setTimeout(r, 500); }); // brief pause between sequences
  }

  progressFill.style.width  = '100%';
  progressLabel.textContent = 'Done! ' + seqList.length + ' sequences captioned.';
  showToast('\u2713 Batch complete: ' + seqList.length + ' sequences captioned!', 'success', 6000);
  setStatus('\u2713 Batch captioning complete', 'green');
  setBtnLoading('btn-batch-caption', false);
  CaptionsModule.isProcessing = false;
}

// Thin wrapper — runs the full caption pipeline on whatever sequence is currently active
async function generateCaptionsForActiveSequence() {
  // Reuse the full generateCaptions flow but without the isProcessing guard
  var saved = CaptionsModule.isProcessing;
  CaptionsModule.isProcessing = false;
  await generateCaptions();
  CaptionsModule.isProcessing = saved;
}

/* ═══════════════════════════════════════════════
   UPDATE SPEAKER LEGEND IN UI
══════════════════════════════════════════════ */
function updateSpeakerLegend() {
  var legend = document.getElementById('speaker-legend');
  if (!legend) return;
  var speakers = CaptionsModule.speakers;
  var keys = Object.keys(speakers);
  if (keys.length === 0) {
    legend.style.display = 'none';
    return;
  }
  legend.style.display = '';

  // Build speaker chips
  var chipsHTML = keys.map(function(sp) {
    return '<span class="speaker-legend-item" style="border-color:' + speakers[sp] + '">' +
             '<span class="speaker-dot" style="background:' + speakers[sp] + '"></span>' +
             'Speaker ' + sp +
           '</span>';
  }).join('');

  // Add Merge button only when there are 2+ speakers
  var mergeHTML = '';
  if (keys.length >= 2) {
    mergeHTML = '<button class="btn btn-sm btn-ghost" id="btn-merge-speakers" ' +
      'style="font-size:10px;padding:2px 8px;margin-left:6px" title="Merge two speakers into one">' +
      '⇌ Merge Speakers</button>';
  }

  legend.innerHTML = chipsHTML + mergeHTML;

  var mergeBtn = document.getElementById('btn-merge-speakers');
  if (mergeBtn) {
    mergeBtn.addEventListener('click', function() {
      openMergeSpeakersDialog(keys);
    });
  }
}

function openMergeSpeakersDialog(speakerKeys) {
  // Simple prompt-based merge — works reliably in CEP without modal DOM complexity
  var keepList   = speakerKeys.join(', ');
  var removeStr  = prompt(
    'Speaker labels detected: ' + keepList + '\n\n' +
    'Type the label to REMOVE (e.g. "B").\n' +
    'All captions from that speaker will be re-labeled to the other speaker.',
    speakerKeys[1] || speakerKeys[0]
  );
  if (!removeStr) return;
  var removeKey = removeStr.trim().toUpperCase();
  if (!CaptionsModule.speakers[removeKey]) {
    showToast('Speaker "' + removeKey + '" not found. Check the label and try again.', 'warning');
    return;
  }

  // Find which speaker to keep (the other one — if only 2, easy; if more, keep all except removed)
  var keepKey = speakerKeys.find(function(k) { return k !== removeKey; });
  if (!keepKey) { showToast('Cannot merge — only one speaker.', 'warning'); return; }

  var count = 0;
  CaptionsModule.captions.forEach(function(cap) {
    if (cap.speaker === removeKey) {
      cap.speaker = keepKey;
      count++;
    }
  });

  // Remove the merged speaker from the colour map
  delete CaptionsModule.speakers[removeKey];

  renderCaptionList(CaptionsModule.captions);
  showToast('\u2713 Merged Speaker ' + removeKey + ' into Speaker ' + keepKey + ' (' + count + ' captions updated)', 'success', 5000);
}

window.CaptionsModule = CaptionsModule;
window.getCaptionStyleData = getCaptionStyleData;
