/**
 * FlashCut AI — app.js
 * Core application: initialization, sequence management, tab navigation, utilities
 */

'use strict';

/* ═══════════════════════════════════════════════
   GLOBAL STATE
══════════════════════════════════════════════ */
var FlashCutApp = window.FlashCutApp = {
  csInterface: null,
  activeSequenceId: null,
  activeSequenceData: null,
  sequences: [],
  isConnected: false,
  storage: {}  // localStorage wrapper
};

/* ═══════════════════════════════════════════════
   SAFE JSON PARSE
══════════════════════════════════════════════ */
function safeParseJSON(str) {
  try { return JSON.parse(str); }
  catch(e) {
    console.error('JSON parse error:', e, '\nRaw:', str);
    return { error: 'Parse error: ' + e.message };
  }
}

/* ═══════════════════════════════════════════════
   PAINT YIELD
   CEP's Chromium shares a rendering tick with
   Premiere's window message pump. Without yielding,
   DOM mutations (spinners, status text) never paint
   before evalScript blocks the thread.
   Call `await yieldToPaint()` after every UI update
   that must be visible before the next operation.
══════════════════════════════════════════════ */
function yieldToPaint() {
  return new Promise(function(resolve) {
    // requestAnimationFrame fires after layout/paint
    // A second rAF guarantees the frame was actually composited
    requestAnimationFrame(function() {
      requestAnimationFrame(function() {
        resolve();
      });
    });
  });
}
window.yieldToPaint = yieldToPaint;

/* ═══════════════════════════════════════════════
   STORAGE (localStorage wrapper with prefix)
══════════════════════════════════════════════ */
var STORE_PREFIX = 'flashcutai_';
function storeSave(key, value) {
  try { localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value)); } catch(e) {}
}
function storeLoad(key, fallback) {
  try {
    var v = localStorage.getItem(STORE_PREFIX + key);
    return v !== null ? JSON.parse(v) : fallback;
  } catch(e) { return fallback; }
}

/* ═══════════════════════════════════════════════
   TOAST NOTIFICATIONS
══════════════════════════════════════════════ */
var toastTimeout = null;
function showToast(message, type, duration) {
  type = type || 'info';
  duration = duration || 3000;
  clearTimeout(toastTimeout);
  requestAnimationFrame(function() {
    var toast     = document.getElementById('toast');
    var toastText = document.getElementById('toast-text');
    var toastIcon = document.getElementById('toast-icon');
    var icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
    // All three writes in one frame → one repaint
    toastIcon.textContent = icons[type] || 'ℹ️';
    toastText.textContent = message;
    toast.className = 'toast ' + type + ' show';
    toastTimeout = setTimeout(function() {
      requestAnimationFrame(function() { toast.classList.remove('show'); });
    }, duration);
  });
}

/* ═══════════════════════════════════════════════
   STATUS BAR
══════════════════════════════════════════════ */
function setStatus(message, dotClass) {
  document.getElementById('status-text').textContent = message;
  var dot = document.getElementById('status-dot');
  dot.className = 'status-dot ' + (dotClass || '');
}

/* ═══════════════════════════════════════════════
   BUTTON LOADING STATE
   Toggles CSS class instead of mutating innerHTML —
   avoids the subtree re-parse + repaint that innerHTML
   causes in CEP's Chromium.
══════════════════════════════════════════════ */
function setBtnLoading(btnId, loading) {
  var btn = document.getElementById(btnId);
  if (!btn) return;
  if (loading) {
    btn.classList.add('loading');
    btn.disabled = true;
  } else {
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}
window.setBtnLoading = setBtnLoading;

/* ═══════════════════════════════════════════════
   BATCH DOM UPDATE
   Queues all UI changes into a single rAF frame so
   CEP does one repaint instead of N separate ones.
══════════════════════════════════════════════ */
function batchDom(fn) {
  return new Promise(function(resolve) {
    requestAnimationFrame(function() {
      fn();
      resolve();
    });
  });
}
window.batchDom = batchDom;

/* ═══════════════════════════════════════════════
   EVALSCRIPT WRAPPER (promise-based)
══════════════════════════════════════════════ */
function evalScript(script) {
  return new Promise(function(resolve, reject) {
    if (!FlashCutApp.csInterface) {
      resolve({ error: 'Not connected to Premiere Pro' });
      return;
    }
    FlashCutApp.csInterface.evalScript(script, function(result) {
      if (!result || result === 'undefined') {
        resolve({ error: 'No result from ExtendScript' });
        return;
      }
      var parsed = safeParseJSON(result);
      resolve(parsed);
    });
  });
}

/* ═══════════════════════════════════════════════
   SEQUENCE MANAGEMENT
══════════════════════════════════════════════ */
async function refreshSequences() {
  var refreshBtn = document.getElementById('btn-refresh-seqs');
  refreshBtn.classList.add('spinning');
  setStatus('Scanning for sequences…', 'purple pulse');

  try {
    var result = await evalScript('getSequences()');

    if (result.error === 'NO_SEQUENCES' || result.error === 'No project open.') {
      showNoSequenceOverlay(result.error);
      setStatus('No sequences found', 'red');
      refreshBtn.classList.remove('spinning');
      return;
    }

    if (result.error) {
      setStatus('Error: ' + result.error, 'red');
      showToast(result.error, 'error');
      refreshBtn.classList.remove('spinning');
      return;
    }

    FlashCutApp.sequences = result.sequences || [];
    populateSequenceDropdown(FlashCutApp.sequences);
    hideNoSequenceOverlay();
    setStatus(FlashCutApp.sequences.length + ' sequence(s) found', 'green');

    // Auto-select active sequence
    var active = await evalScript('getActiveSequence()');
    if (active && !active.error) {
      document.getElementById('sequence-select').value = active.id;
      onSequenceSelected(active.id);
    } else if (FlashCutApp.sequences.length > 0) {
      // Auto-select first sequence
      document.getElementById('sequence-select').value = FlashCutApp.sequences[0].id;
      onSequenceSelected(FlashCutApp.sequences[0].id);
    }

  } catch(e) {
    setStatus('Connection error', 'red');
    showToast('Could not connect to Premiere Pro', 'error');
  }

  refreshBtn.classList.remove('spinning');
}

function populateSequenceDropdown(sequences) {
  var select = document.getElementById('sequence-select');
  select.innerHTML = '<option value="">— Select Sequence —</option>';
  sequences.forEach(function(seq) {
    var opt = document.createElement('option');
    opt.value = seq.id;
    opt.textContent = seq.name + ' (' + formatDuration(seq.duration) + ')';
    select.appendChild(opt);
  });
}

async function onSequenceSelected(seqId) {
  if (!seqId) {
    clearSeqInfo();
    return;
  }

  var result = await evalScript('setActiveSequenceById("' + seqId + '")');
  if (result.error) {
    showToast('Could not activate sequence: ' + result.error, 'error');
    return;
  }

  var details = await evalScript('getSequenceDetails("' + seqId + '")');
  if (details.error) return;

  FlashCutApp.activeSequenceId = seqId;
  FlashCutApp.activeSequenceData = details;
  updateSeqInfoStrip(details);
  setStatus('Sequence: ' + details.name, 'green');
}

function updateSeqInfoStrip(details) {
  var strip = document.getElementById('seq-info-strip');
  strip.style.display = 'flex';
  document.getElementById('chip-duration').textContent = formatDuration(details.duration);
  document.getElementById('chip-vtracks').textContent = details.videoTracks;
  document.getElementById('chip-atracks').textContent = details.audioTracks;
  document.getElementById('chip-fps').textContent = details.frameRate || '?';
}

function clearSeqInfo() {
  document.getElementById('seq-info-strip').style.display = 'none';
  FlashCutApp.activeSequenceId = null;
  FlashCutApp.activeSequenceData = null;
}

/* ═══════════════════════════════════════════════
   NO SEQUENCE OVERLAY
══════════════════════════════════════════════ */
function showNoSequenceOverlay(errorMsg) {
  var overlay = document.getElementById('no-seq-overlay');
  var content = document.getElementById('tab-content');
  overlay.classList.add('visible');
  content.style.display = 'none';

  if (errorMsg === 'No project open.') {
    overlay.querySelector('.no-seq-title').textContent = 'No Project Open';
    overlay.querySelector('.no-seq-desc').innerHTML =
      'Open a project in Adobe Premiere Pro,<br>then click refresh.';
  } else {
    overlay.querySelector('.no-seq-title').textContent = 'No Sequence Found';
    overlay.querySelector('.no-seq-desc').innerHTML =
      'Your project has no sequences yet.<br>Create a sequence in Premiere Pro first,<br>then click <strong>refresh</strong>.';
  }
}

function hideNoSequenceOverlay() {
  document.getElementById('no-seq-overlay').classList.remove('visible');
  document.getElementById('tab-content').style.display = '';
}

/* ═══════════════════════════════════════════════
   TAB NAVIGATION
══════════════════════════════════════════════ */
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var tab = btn.getAttribute('data-tab');
      document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
      document.querySelectorAll('.tab-panel').forEach(function(p) { p.classList.remove('active'); });
      btn.classList.add('active');
      document.getElementById('panel-' + tab).classList.add('active');
    });
  });
}

/* ═══════════════════════════════════════════════
   PASSWORD TOGGLE BUTTONS
══════════════════════════════════════════════ */
function initPasswordToggles() {
  document.querySelectorAll('.btn-toggle-pw').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var targetId = btn.getAttribute('data-target');
      var input = document.getElementById(targetId);
      if (!input) return;
      if (input.type === 'password') {
        input.type = 'text';
        btn.textContent = '🙈';
      } else {
        input.type = 'password';
        btn.textContent = '👁';
      }
    });
  });
}

/* ═══════════════════════════════════════════════
   API PROVIDER TABS
══════════════════════════════════════════════ */
function initProviderTabs() {
  document.querySelectorAll('.api-tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var provider = btn.getAttribute('data-provider');
      document.querySelectorAll('.api-tab-btn').forEach(function(b) { b.classList.remove('active'); });
      document.querySelectorAll('.api-config-panel').forEach(function(p) { p.classList.remove('active'); });
      btn.classList.add('active');
      var panel = document.getElementById('config-' + provider);
      if (panel) panel.classList.add('active');
      storeSave('activeProvider', provider);
    });
  });

  // Restore saved provider
  var savedProvider = storeLoad('activeProvider', 'whisper');
  var savedBtn = document.querySelector('.api-tab-btn[data-provider="' + savedProvider + '"]');
  if (savedBtn) savedBtn.click();
}

/* ═══════════════════════════════════════════════
   RESTORE SAVED API KEYS
══════════════════════════════════════════════ */
function restoreAPIKeys() {
  var keys = ['openai-key', 'assemblyai-key', 'deepgram-key'];
  keys.forEach(function(keyId) {
    var saved = storeLoad(keyId, '');
    if (saved) {
      var el = document.getElementById(keyId);
      if (el) el.value = saved;
    }
  });
}

function saveAPIKey(keyId) {
  var el = document.getElementById(keyId);
  if (el && el.value) storeSave(keyId, el.value);
}

/* ═══════════════════════════════════════════════
   AUDIO METHOD SELECT WIRING
══════════════════════════════════════════════ */
function initAudioMethodSelects() {
  var methodSelect = document.getElementById('audio-method');
  var uploadArea = document.getElementById('manual-upload-area');
  if (methodSelect) {
    methodSelect.addEventListener('change', function() {
      uploadArea.style.display = methodSelect.value === 'manual' ? 'block' : 'none';
    });
  }

  var silenceMethodSelect = document.getElementById('silence-audio-method');
  var silenceUploadWrap = document.getElementById('silence-upload-wrap');
  if (silenceMethodSelect) {
    silenceMethodSelect.addEventListener('change', function() {
      silenceUploadWrap.style.display = silenceMethodSelect.value === 'manual' ? 'block' : 'none';
    });
  }
}

/* ═══════════════════════════════════════════════
   UTILITIES
══════════════════════════════════════════════ */
function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '—';
  var h = Math.floor(seconds / 3600);
  var m = Math.floor((seconds % 3600) / 60);
  var s = Math.floor(seconds % 60);
  if (h > 0) return h + 'h ' + m + 'm ' + s + 's';
  if (m > 0) return m + 'm ' + s + 's';
  return s + 's';
}

function formatTime(seconds) {
  if (seconds === undefined || seconds === null || isNaN(seconds)) return '0:00';
  var m = Math.floor(seconds / 60);
  var s = seconds - m * 60;
  return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
}

/* ════════════════════════════════════════════
   BUTTON LOADING HELPER
   Uses data-loading attribute + CSS — never touches innerHTML
════════════════════════════════════════════ */
function setButtonLoading(btnId, loading, loadingText) {
  var btn = typeof btnId === 'string' ? document.getElementById(btnId) : btnId;
  if (!btn) return;
  if (loading) {
    btn.dataset.loading = '1';
    btn.disabled = true;
    // Update label text without injecting HTML
    if (loadingText) {
      var labelEl = btn.querySelector('.btn-label');
      if (labelEl) labelEl.textContent = loadingText;
    }
  } else {
    delete btn.dataset.loading;
    btn.disabled = false;
  }
}

function requireSequence() {
  if (!FlashCutApp.activeSequenceId) {
    showToast('Please select a sequence first', 'warning');
    return false;
  }
  return true;
}

function readFileAsArrayBuffer(file) {
  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onload = function(e) { resolve(e.target.result); };
    reader.onerror = function(e) { reject(e); };
    reader.readAsArrayBuffer(file);
  });
}

function readFileAsBase64(file) {
  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onload = function(e) {
      var base64 = e.target.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ═══════════════════════════════════════════════
   INIT
══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', function() {
  try {
    FlashCutApp.csInterface = new CSInterface();
  } catch(csiErr) {
    console.warn('[FlashCut] CSInterface not available:', csiErr.message);
    FlashCutApp.csInterface = null;
  }

  initTabs();
  initPasswordToggles();
  initProviderTabs();
  restoreAPIKeys();
  initAudioMethodSelects();

  // Sequence selector change
  document.getElementById('sequence-select').addEventListener('change', function() {
    onSequenceSelected(this.value);
  });

  // Refresh button
  document.getElementById('btn-refresh-seqs').addEventListener('click', function() {
    refreshSequences();
  });

  // Help button
  document.getElementById('btn-help').addEventListener('click', function() {
    showToast('FlashCut AI v1.0 — Free forever. Export audio as WAV from Premiere for best results.', 'info', 5000);
  });

  // Create sequence hint
  document.getElementById('btn-create-hint').addEventListener('click', function() {
    showToast('In Premiere: File → New → Sequence (Ctrl/Cmd+N)', 'info', 5000);
  });

  // Settings
  document.getElementById('btn-settings').addEventListener('click', function() {
    showToast('API keys are saved locally and never shared.', 'info', 4000);
  });

  // Auto-save API keys on input
  ['openai-key', 'assemblyai-key', 'deepgram-key'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', function() { storeSave(id, el.value); });
    }
  });

  // Connect to Premiere
  setStatus('Connecting to Premiere Pro…', 'purple pulse');
  evalScript('init()').then(function(result) {
    if (result && result.ready) {
      FlashCutApp.isConnected = true;
      setStatus('Connected — scanning sequences…', 'green');
      setTimeout(refreshSequences, 400);
    } else if (result && result.error === 'Not connected to Premiere Pro') {
      setStatus('Premiere Pro not detected', 'red');
      showNoSequenceOverlay('No project open.');
    } else {
      // Connected but init returned something unexpected — still try to refresh
      FlashCutApp.isConnected = true;
      setStatus('Connected', 'green');
      setTimeout(refreshSequences, 400);
    }
  }).catch(function(e) {
    setStatus('Not connected to Premiere Pro', 'red');
    hideNoSequenceOverlay();
  });
});

/* ═══════════════════════════════════════════════
   ASYNC FILE READER
   Uses XHR with file:// instead of the synchronous
   cep.fs.readFile which blocks the render thread.
══════════════════════════════════════════════ */
function readMediaFileAsync(filePath) {
  return new Promise(function(resolve, reject) {
    // Normalise path → file:// URL
    var url = filePath;
    if (!url.startsWith('file://')) {
      // Windows: C:\foo\bar → file:///C:/foo/bar
      // Mac:     /foo/bar   → file:///foo/bar
      url = 'file:///' + filePath.replace(/\\/g, '/').replace(/^\/\/\//, '');
    }

    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);        // true = async
    xhr.responseType = 'arraybuffer';

    xhr.onload = function() {
      if (xhr.status === 0 || xhr.status === 200) {
        resolve(xhr.response);
      } else {
        reject(new Error('XHR status ' + xhr.status + ' reading ' + filePath));
      }
    };

    xhr.onerror = function() {
      // Fallback: try synchronous cep.fs if XHR failed (e.g. special characters in path)
      try {
      // cep.fs fallback (only if XHR failed — e.g. path with special chars)
      var r = window.cep.fs.readFile(filePath, window.cep.encoding.Base64); // fallback-only
        if (r.err !== 0) {
          reject(new Error('cep.fs error ' + r.err + ' reading ' + filePath));
          return;
        }
        var bin = atob(r.data);
        var buf = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        resolve(buf.buffer);
      } catch(e2) {
        reject(new Error('Cannot read file: ' + filePath + ' — ' + e2.message));
      }
    };

    xhr.send();
  });
}

// Expose helpers globally
window.evalScript = evalScript;
window.showToast = showToast;
window.setStatus = setStatus;
window.setButtonLoading = setButtonLoading;
window.formatDuration = formatDuration;
window.formatTime = formatTime;
window.requireSequence = requireSequence;
window.storeSave = storeSave;
window.storeLoad = storeLoad;
window.safeParseJSON = safeParseJSON;
window.readFileAsArrayBuffer = readFileAsArrayBuffer;
window.readFileAsBase64 = readFileAsBase64;
window.readMediaFileAsync = readMediaFileAsync;
