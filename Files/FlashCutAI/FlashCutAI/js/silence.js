/**
 * FlashCut AI — silence.js
 * Silence Remover 2.0: visual preview, per-track sensitivity, cut styles
 */

'use strict';

var SilenceModule = {
  detectedRegions: [],
  isAnalyzing:     false,
  isRemoving:      false,
  clipMap:         null,
  lastAudioBuffer: null,          // 2.0: keep decoded buffer for waveform preview
  cutStyle:        'tight',       // 'tight' | 'l-cut' | 'j-cut'
  cutOverlap:      0.5,           // seconds of overlap for L/J cuts
  perTrackEnabled: false,
  voiceThreshold:  -35,
  musicThreshold:  -50,
  voiceTrackIndex: 0
};

/* ═══════════════════════════════════════════════
   ANALYZE SILENCE
══════════════════════════════════════════════ */
async function analyzeSilence() {
  if (!requireSequence()) return;
  if (SilenceModule.isAnalyzing) return;
  SilenceModule.isAnalyzing = true;

  await batchDom(function() {
    setBtnLoading('btn-analyze-silence', true);
    setStatus('Reading sequence audio…', 'orange pulse');
  });

  try {
    var audioBuffer      = null;
    var sequenceDuration = null;
    var audioMethod      = document.getElementById('silence-audio-method').value;

    if (audioMethod === 'manual') {
      var fileInput = document.getElementById('silence-audio-file');
      if (!fileInput.files || !fileInput.files[0]) {
        showToast('Please select an audio file.', 'warning');
        resetAnalyzeBtn(); return;
      }
      var arrayBuffer = await readFileAsArrayBuffer(fileInput.files[0]);
      audioBuffer = await decodeAudioData(arrayBuffer);
    } else {
      await yieldToPaint();
      var clipsResult = await evalScript('getSequenceAudioClips()');
      if (clipsResult.error) {
        showToast(clipsResult.error === 'NO_AUDIO_CLIPS_FOUND'
          ? 'No audio clips found in the active sequence.'
          : 'Could not read sequence: ' + clipsResult.error, 'error');
        resetAnalyzeBtn(); return;
      }

      sequenceDuration = clipsResult.sequenceDuration;
      var clips = clipsResult.clips;

      var uniquePaths = [];
      var pathSeen = {};
      clips.forEach(function(c) {
        if (!pathSeen[c.path]) { pathSeen[c.path] = true; uniquePaths.push(c.path); }
      });

      setStatus('Reading ' + uniquePaths.length + ' source file(s)…', 'orange pulse');

      var decodedSources = {};
      for (var pi = 0; pi < uniquePaths.length; pi++) {
        var fpath = uniquePaths[pi];
        setStatus('Reading: ' + fpath.split('/').pop() + ' (' + (pi+1) + '/' + uniquePaths.length + ')…', 'orange pulse');
        try {
          var arrayBuf = await readMediaFileAsync(fpath);
          setStatus('Decoding: ' + fpath.split('/').pop() + '…', 'orange pulse');
          decodedSources[fpath] = await decodeAudioData(arrayBuf);
        } catch(readErr) {
          console.warn('FlashCut: could not read/decode ' + fpath + ':', readErr.message);
        }
      }

      if (Object.keys(decodedSources).length === 0) {
        showToast('Could not decode any audio from the sequence. Try Manual Upload.', 'error', 6000);
        resetAnalyzeBtn(); return;
      }

      setStatus('Compositing timeline audio…', 'orange pulse');
      var sampleRate   = Object.values(decodedSources)[0].sampleRate;
      var totalSamples = Math.ceil(sequenceDuration * sampleRate);
      var compositeMono = new Float32Array(totalSamples);

      clips.forEach(function(clip) {
        var src = decodedSources[clip.path];
        if (!src) return;
        var srcRate = src.sampleRate;
        var srcIn   = Math.floor(clip.srcInPoint  * srcRate);
        var srcOut  = Math.floor(clip.srcOutPoint * srcRate);
        var tlStart = Math.floor(clip.timelineStart * sampleRate);
        var clipLen = srcOut - srcIn;
        var numCh   = src.numberOfChannels;
        for (var s = 0; s < clipLen; s++) {
          var destIdx = tlStart + s;
          if (destIdx >= totalSamples) break;
          var sample = 0;
          for (var ch = 0; ch < numCh; ch++) sample += src.getChannelData(ch)[srcIn + s] / numCh;
          compositeMono[destIdx] += sample;
        }
      });

      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      audioBuffer = ctx.createBuffer(1, totalSamples, sampleRate);
      audioBuffer.getChannelData(0).set(compositeMono);
      ctx.close();
      SilenceModule.clipMap = null;
    }

    if (!audioBuffer) {
      showToast('No audio data available.', 'error');
      resetAnalyzeBtn(); return;
    }

    if (!sequenceDuration) {
      var seqDetails = FlashCutApp.activeSequenceData;
      sequenceDuration = seqDetails ? seqDetails.duration : audioBuffer.duration;
    }

    // Store buffer for waveform preview
    SilenceModule.lastAudioBuffer = audioBuffer;

    // ── 2.0: Per-track sensitivity ──────────────────────────────────────
    var perTrack = SilenceModule.perTrackEnabled;
    var threshold   = parseFloat(document.getElementById('silence-threshold').value);
    var minDuration = parseFloat(document.getElementById('min-silence-dur').value);
    var padding     = parseFloat(document.getElementById('silence-padding').value);

    var rawRegions;
    if (perTrack) {
      rawRegions = detectSilencePerTrack(audioBuffer, minDuration, padding);
    } else {
      rawRegions = detectSilence(audioBuffer, threshold, minDuration, padding);
    }

    SilenceModule.detectedRegions = SilenceModule.clipMap && SilenceModule.clipMap.length > 0
      ? mapRegionsToTimeline(rawRegions, SilenceModule.clipMap)
      : rawRegions;

    renderSilenceResults(SilenceModule.detectedRegions, sequenceDuration);

    // ── 2.0: Draw waveform preview with silence regions highlighted ─────
    drawSilenceWaveform(audioBuffer, SilenceModule.detectedRegions, sequenceDuration);

    setStatus(SilenceModule.detectedRegions.length + ' silence regions detected', 'orange');
    showToast(SilenceModule.detectedRegions.length + ' silence region(s) found.', 'success');
    document.getElementById('btn-preview-silence').disabled = false;

  } catch(e) {
    console.error('Silence analysis error:', e);
    showToast('Analysis failed: ' + e.message, 'error');
    setStatus('Silence analysis failed', 'red');
  }

  resetAnalyzeBtn();
}

function resetAnalyzeBtn() {
  setBtnLoading('btn-analyze-silence', false);
  SilenceModule.isAnalyzing = false;
}

/* ═══════════════════════════════════════════════
   DECODE AUDIO FROM ARRAYBUFFER
══════════════════════════════════════════════ */
function decodeAudioData(arrayBuffer) {
  return new Promise(function(resolve, reject) {
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctx.decodeAudioData(arrayBuffer, function(buffer) {
      ctx.close(); resolve(buffer);
    }, function(err) {
      ctx.close(); reject(new Error('Could not decode audio: ' + (err ? err.message || err : 'decode error')));
    });
  });
}

/* ═══════════════════════════════════════════════
   MAP SOURCE-FILE REGIONS → SEQUENCE TIMELINE TIME
══════════════════════════════════════════════ */
function mapRegionsToTimeline(rawRegions, clipMap) {
  var mapped = [];
  rawRegions.forEach(function(region) {
    var mid = (region.start + region.end) / 2;
    for (var i = 0; i < clipMap.length; i++) {
      var clip = clipMap[i];
      if (mid >= clip.srcInPoint && mid <= clip.srcOutPoint) {
        var offset  = clip.timelineStart - clip.srcInPoint;
        var tlStart = Math.max(clip.timelineStart, region.start + offset);
        var tlEnd   = Math.min(clip.timelineEnd,   region.end   + offset);
        if (tlEnd - tlStart > 0.05) {
          mapped.push({ start: roundTo3(tlStart), end: roundTo3(tlEnd), duration: roundTo3(tlEnd - tlStart) });
        }
        break;
      }
    }
  });
  return mapped;
}

/* ═══════════════════════════════════════════════
   SILENCE DETECTION — STANDARD (global threshold)
══════════════════════════════════════════════ */
function detectSilence(audioBuffer, thresholdDB, minDuration, padding) {
  var sampleRate   = audioBuffer.sampleRate;
  var numChannels  = audioBuffer.numberOfChannels;
  var totalSamples = audioBuffer.length;

  var monoData = new Float32Array(totalSamples);
  for (var ch = 0; ch < numChannels; ch++) {
    var channelData = audioBuffer.getChannelData(ch);
    for (var i = 0; i < totalSamples; i++) monoData[i] += channelData[i] / numChannels;
  }

  return _findSilenceRegions(monoData, sampleRate, thresholdDB, minDuration, padding);
}

/* ═══════════════════════════════════════════════
   2.0: SILENCE DETECTION — PER-TRACK
   Uses voice threshold on the designated voice track,
   music threshold on all others. A moment is only
   considered silence if ALL tracks are silent at that time.
══════════════════════════════════════════════ */
function detectSilencePerTrack(audioBuffer, minDuration, padding) {
  var sampleRate   = audioBuffer.sampleRate;
  var numChannels  = audioBuffer.numberOfChannels;
  var totalSamples = audioBuffer.length;
  var chunkSize    = Math.floor(sampleRate * 0.01); // 10ms chunks
  var numChunks    = Math.floor(totalSamples / chunkSize);

  var voiceTrack    = SilenceModule.voiceTrackIndex;
  var voiceThresh   = dbToLinear(SilenceModule.voiceThreshold);
  var musicThresh   = dbToLinear(SilenceModule.musicThreshold);
  var skipMusic     = SilenceModule.musicThreshold >= 0; // 0 dB = skip music tracks

  // Build per-chunk silence map — true if ALL relevant tracks are silent in that chunk
  var silenceMap = new Array(numChunks).fill(true);

  for (var ch = 0; ch < numChannels; ch++) {
    var data      = audioBuffer.getChannelData(ch);
    var isVoice   = (ch === voiceTrack);
    var threshold = isVoice ? voiceThresh : musicThresh;
    if (!isVoice && skipMusic) continue; // skip music track analysis

    for (var c = 0; c < numChunks; c++) {
      if (!silenceMap[c]) continue; // already marked as not-silent
      var start = c * chunkSize;
      var end   = Math.min(start + chunkSize, totalSamples);
      var rms   = calcRMS(data, start, end);
      if (rms >= threshold) silenceMap[c] = false;
    }
  }

  return _buildRegionsFromMap(silenceMap, minDuration, padding);
}

/* ─── shared helpers ─────────────────────────── */
function _findSilenceRegions(monoData, sampleRate, thresholdDB, minDuration, padding) {
  var chunkSize       = Math.floor(sampleRate * 0.01);
  var thresholdLinear = dbToLinear(thresholdDB);
  var numChunks       = Math.floor(monoData.length / chunkSize);

  var silenceMap = new Array(numChunks);
  for (var c = 0; c < numChunks; c++) {
    var s = c * chunkSize;
    var e = Math.min(s + chunkSize, monoData.length);
    silenceMap[c] = calcRMS(monoData, s, e) < thresholdLinear;
  }
  return _buildRegionsFromMap(silenceMap, minDuration, padding);
}

function _buildRegionsFromMap(silenceMap, minDuration, padding) {
  var regions    = [];
  var inSilence  = false;
  var silStart   = 0;

  for (var ci = 0; ci < silenceMap.length; ci++) {
    var timeSec = ci * 0.01;
    if (silenceMap[ci] && !inSilence) {
      inSilence = true; silStart = timeSec;
    } else if (!silenceMap[ci] && inSilence) {
      inSilence = false;
      var dur = timeSec - silStart;
      if (dur >= minDuration) {
        var rs = Math.max(0, silStart + padding);
        var re = Math.max(rs,  timeSec - padding);
        if (re - rs > 0.05) {
          regions.push({ start: roundTo3(rs), end: roundTo3(re), duration: roundTo3(re - rs) });
        }
      }
    }
  }
  if (inSilence) {
    var endSec = silenceMap.length * 0.01;
    var dur2   = endSec - silStart;
    if (dur2 >= minDuration) {
      var rs2 = Math.max(0, silStart + padding);
      var re2 = Math.max(rs2, endSec - padding);
      if (re2 - rs2 > 0.05) {
        regions.push({ start: roundTo3(rs2), end: roundTo3(re2), duration: roundTo3(re2 - rs2) });
      }
    }
  }
  return regions;
}

function dbToLinear(db) { return Math.pow(10, db / 20); }
function calcRMS(data, start, end) {
  var sum = 0;
  for (var i = start; i < end; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / (end - start));
}
function roundTo3(n) { return Math.round(n * 1000) / 1000; }

/* ═══════════════════════════════════════════════
   2.0: DRAW WAVEFORM PREVIEW CANVAS
   Shows the audio waveform with silence regions
   highlighted in red so the user can see exactly
   what will be cut before pressing Apply.
══════════════════════════════════════════════ */
function drawSilenceWaveform(audioBuffer, regions, totalDuration) {
  var wrap   = document.getElementById('silence-waveform-wrap');
  var canvas = document.getElementById('silence-waveform-canvas');
  if (!wrap || !canvas) return;

  // Size canvas to its CSS width
  var W = canvas.parentElement.clientWidth || 400;
  var H = 48;
  canvas.width  = W;
  canvas.height = H;
  wrap.style.display = '';

  var ctx    = canvas.getContext('2d');
  var data   = audioBuffer.getChannelData(0);
  var dur    = totalDuration || audioBuffer.duration;
  var step   = Math.max(1, Math.floor(data.length / W));

  // Draw waveform
  ctx.clearRect(0, 0, W, H);

  // Background
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.fillRect(0, 0, W, H);

  // Silence regions (draw first, behind waveform)
  ctx.fillStyle = 'rgba(255,70,70,0.25)';
  regions.forEach(function(r) {
    var x1 = Math.floor((r.start / dur) * W);
    var x2 = Math.ceil((r.end   / dur) * W);
    ctx.fillRect(x1, 0, Math.max(1, x2 - x1), H);
  });

  // Waveform bars
  ctx.fillStyle = 'rgba(255,160,50,0.85)';
  for (var x = 0; x < W; x++) {
    var sampleStart = x * step;
    var sampleEnd   = Math.min(sampleStart + step, data.length);
    var max = 0;
    for (var s = sampleStart; s < sampleEnd; s++) {
      var abs = Math.abs(data[s]);
      if (abs > max) max = abs;
    }
    var barH = Math.max(1, max * H * 0.9);
    ctx.fillRect(x, (H - barH) / 2, 1, barH);
  }

  // Silence region outlines
  ctx.strokeStyle = 'rgba(255,70,70,0.7)';
  ctx.lineWidth = 1;
  regions.forEach(function(r) {
    var x1 = Math.floor((r.start / dur) * W);
    var x2 = Math.ceil((r.end   / dur) * W);
    ctx.strokeRect(x1 + 0.5, 0.5, Math.max(1, x2 - x1 - 1), H - 1);
  });
}

/* ═══════════════════════════════════════════════
   RENDER SILENCE RESULTS
══════════════════════════════════════════════ */
function renderSilenceResults(regions, totalDuration) {
  requestAnimationFrame(function() {
    var resultsEl = document.getElementById('silence-results');
    var statsEl   = document.getElementById('silence-stats');
    var listEl    = document.getElementById('silence-list');

    if (regions.length === 0) {
      showToast('No silence regions found. Try lowering the threshold.', 'info');
      resultsEl.style.display = 'none';
      statsEl.style.display   = 'none';
      return;
    }

    var totalSilenceDur = regions.reduce(function(acc, r) { return acc + r.duration; }, 0);
    var savedPercent    = totalDuration > 0 ? (totalSilenceDur / totalDuration * 100).toFixed(1) : 0;

    var frag = document.createDocumentFragment();
    regions.forEach(function(r, idx) {
      var item    = document.createElement('div');
      item.className = 'silence-item';
      var timeSpan = document.createElement('span');
      timeSpan.className   = 'silence-item-time';
      timeSpan.textContent = secToTimeStr(r.start) + ' → ' + secToTimeStr(r.end);
      var durSpan = document.createElement('span');
      durSpan.className   = 'silence-item-dur';
      durSpan.textContent = r.duration.toFixed(2) + 's';
      var delBtn = document.createElement('button');
      delBtn.className = 'silence-item-del';
      delBtn.setAttribute('data-idx', idx);
      delBtn.title     = 'Remove from list';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', function() {
        SilenceModule.detectedRegions.splice(parseInt(this.getAttribute('data-idx')), 1);
        renderSilenceResults(SilenceModule.detectedRegions, totalDuration);
        if (SilenceModule.lastAudioBuffer) {
          drawSilenceWaveform(SilenceModule.lastAudioBuffer, SilenceModule.detectedRegions, totalDuration);
        }
      });
      item.appendChild(timeSpan);
      item.appendChild(durSpan);
      item.appendChild(delBtn);
      frag.appendChild(item);
    });

    document.getElementById('stat-regions').textContent   = regions.length;
    document.getElementById('stat-total-dur').textContent = totalSilenceDur.toFixed(1) + 's';
    document.getElementById('stat-saved-dur').textContent = savedPercent + '%';
    statsEl.style.display   = 'flex';
    listEl.innerHTML        = '';
    listEl.appendChild(frag);
    resultsEl.style.display = 'block';
  });
}

function secToTimeStr(s) {
  var m   = Math.floor(s / 60);
  var sec = (s % 60).toFixed(2);
  return m + ':' + (sec < 10 ? '0' : '') + sec;
}

/* ═══════════════════════════════════════════════
   PREVIEW SILENCE
══════════════════════════════════════════════ */
function previewSilence() {
  if (SilenceModule.detectedRegions.length === 0) {
    showToast('Run Analyze first.', 'warning'); return;
  }
  // Flash the silence items in the list
  document.querySelectorAll('.silence-item').forEach(function(el, idx) {
    setTimeout(function() { el.classList.add('flash'); }, idx * 60);
    setTimeout(function() { el.classList.remove('flash'); }, idx * 60 + 500);
  });
  showToast(SilenceModule.detectedRegions.length + ' regions highlighted in the waveform above.', 'info', 3000);
}

/* ═══════════════════════════════════════════════
   APPLY SILENCE REMOVAL
══════════════════════════════════════════════ */
async function applySilenceRemoval() {
  if (!requireSequence()) return;
  if (SilenceModule.detectedRegions.length === 0) {
    showToast('No silence regions to remove. Run Analyze first.', 'warning'); return;
  }
  if (SilenceModule.isRemoving) return;

  var cutStyle = SilenceModule.cutStyle;
  var overlap  = SilenceModule.cutOverlap;

  // For L/J cuts, adjust the regions to leave overlap
  var regionsToApply = SilenceModule.detectedRegions;
  if (cutStyle === 'l-cut') {
    regionsToApply = regionsToApply.map(function(r) {
      return { start: r.start + overlap, end: r.end, duration: r.end - (r.start + overlap) };
    }).filter(function(r) { return r.duration > 0.05; });
  } else if (cutStyle === 'j-cut') {
    regionsToApply = regionsToApply.map(function(r) {
      return { start: r.start, end: r.end - overlap, duration: (r.end - overlap) - r.start };
    }).filter(function(r) { return r.duration > 0.05; });
  }

  var totalRemoved = regionsToApply.reduce(function(a, r) { return a + r.duration; }, 0);
  var confirmed = confirm(
    'This will permanently cut and delete ' + regionsToApply.length + ' silence region(s).\n\n' +
    'Cut style: ' + cutStyle.toUpperCase() + '\n' +
    'Total time removed: ' + totalRemoved.toFixed(2) + 's\n\n' +
    'You can undo in Premiere Pro (Ctrl/Cmd+Z).\n\nContinue?'
  );
  if (!confirmed) return;

  SilenceModule.isRemoving = true;
  await batchDom(function() {
    setBtnLoading('btn-apply-silence', true);
    setStatus('Removing silence from timeline…', 'orange pulse');
  });

  try {
    var regionsJSON = JSON.stringify(regionsToApply);
    await evalScript('storeFlashcutData("silenceRegions", \'' + regionsJSON.replace(/'/g, "\\'") + '\')');
    var result = await evalScript('removeSilentRegions()');

    if (result.error) {
      showToast('Error: ' + result.error, 'error', 7000);
      setStatus('Silence removal failed', 'red');
    } else if (result.removed === 0) {
      showToast('Cuts made but 0 clips removed — try increasing padding or check your sequence has audio clips.', 'warning', 8000);
      setStatus('Silence removal complete (0 clips)', 'orange');
    } else {
      showToast('✓ Done! ' + result.removed + ' silent segment(s) removed.', 'success', 5000);
      setStatus('Silence removed — ' + result.removed + ' cuts made', 'green');
      SilenceModule.detectedRegions = [];
      SilenceModule.lastAudioBuffer = null;
      document.getElementById('silence-results').style.display       = 'none';
      document.getElementById('silence-stats').style.display         = 'none';
      document.getElementById('silence-waveform-wrap').style.display = 'none';
    }
  } catch(e) {
    showToast('Failed: ' + e.message, 'error');
  }

  setBtnLoading('btn-apply-silence', false);
  SilenceModule.isRemoving = false;
}

/* ═══════════════════════════════════════════════
   INIT SLIDERS + 2.0 CONTROLS
══════════════════════════════════════════════ */
function initSilenceSliders() {
  // Standard sliders
  var sliders = [
    { id: 'silence-threshold', valId: 'threshold-val',    fmt: function(v) { return v + ' dB'; } },
    { id: 'min-silence-dur',   valId: 'min-dur-val',      fmt: function(v) { return parseFloat(v).toFixed(1) + 's'; } },
    { id: 'silence-padding',   valId: 'padding-val',      fmt: function(v) { return parseFloat(v).toFixed(2) + 's'; } },
    { id: 'voice-threshold',   valId: 'voice-threshold-val', fmt: function(v) { return v + ' dB'; } },
    { id: 'music-threshold',   valId: 'music-threshold-val', fmt: function(v) { return v === '0' ? 'Skip' : v + ' dB'; } },
    { id: 'cut-overlap',       valId: 'cut-overlap-val',  fmt: function(v) { return parseFloat(v).toFixed(1) + 's'; } }
  ];
  sliders.forEach(function(sl) {
    var el    = document.getElementById(sl.id);
    var valEl = document.getElementById(sl.valId);
    if (!el || !valEl) return;
    valEl.textContent = sl.fmt(el.value);
    el.addEventListener('input', function() { valEl.textContent = sl.fmt(this.value); });
  });

  // Voice/music threshold → update SilenceModule
  var voiceEl = document.getElementById('voice-threshold');
  var musicEl = document.getElementById('music-threshold');
  if (voiceEl) voiceEl.addEventListener('input', function() { SilenceModule.voiceThreshold = parseFloat(this.value); });
  if (musicEl) musicEl.addEventListener('input', function() { SilenceModule.musicThreshold = parseFloat(this.value); });

  var voiceTrackEl = document.getElementById('voice-track-index');
  if (voiceTrackEl) voiceTrackEl.addEventListener('input', function() { SilenceModule.voiceTrackIndex = parseInt(this.value) || 0; });

  // Per-track toggle
  var perTrackToggle = document.getElementById('toggle-per-track');
  var perTrackOpts   = document.getElementById('per-track-options');
  if (perTrackToggle && perTrackOpts) {
    perTrackToggle.addEventListener('change', function() {
      SilenceModule.perTrackEnabled = this.checked;
      perTrackOpts.style.display    = this.checked ? '' : 'none';
    });
  }

  // Cut style cards
  document.querySelectorAll('.cut-style-card').forEach(function(card) {
    card.addEventListener('click', function() {
      document.querySelectorAll('.cut-style-card').forEach(function(c) { c.classList.remove('active'); });
      card.classList.add('active');
      SilenceModule.cutStyle = card.getAttribute('data-style');
      var overlapWrap = document.getElementById('cut-overlap-wrap');
      if (overlapWrap) {
        overlapWrap.style.display = (SilenceModule.cutStyle !== 'tight') ? '' : 'none';
      }
    });
  });

  // Cut overlap slider
  var overlapEl = document.getElementById('cut-overlap');
  if (overlapEl) overlapEl.addEventListener('input', function() { SilenceModule.cutOverlap = parseFloat(this.value); });

  // Manual upload toggle
  var audioMethodEl = document.getElementById('silence-audio-method');
  var uploadWrapEl  = document.getElementById('silence-upload-wrap');
  if (audioMethodEl && uploadWrapEl) {
    audioMethodEl.addEventListener('change', function() {
      uploadWrapEl.style.display = (this.value === 'manual') ? '' : 'none';
    });
  }
}

/* ═══════════════════════════════════════════════
   EVENT LISTENERS
══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', function() {
  initSilenceSliders();
  document.getElementById('btn-analyze-silence').addEventListener('click', analyzeSilence);
  document.getElementById('btn-preview-silence').addEventListener('click', previewSilence);
  document.getElementById('btn-apply-silence').addEventListener('click', applySilenceRemoval);
});

window.SilenceModule = SilenceModule;
