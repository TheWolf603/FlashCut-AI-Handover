/**
 * FlashCut AI — stylePanel.js
 * Style My Captions: font, color, animation, position, apply to timeline
 */

'use strict';

var StyleState = {
  fontFamily: 'Arial',
  fontSize: 40,
  fontWeight: '700',
  textAlign: 'center',
  textColor: '#FFFFFF',
  bgEnabled: true,
  bgColor: '#000000',
  bgOpacity: 75,
  bgRadius: 6,
  shadow: true,
  outline: false,
  position: 'bot-center',
  vertOffset: -10,
  animation: 'none',
  animSpeed: 5
};

/* ═══════════════════════════════════════════════
   INIT
══════════════════════════════════════════════ */
function initStylePanel() {
  // Load saved state
  var saved = storeLoad('styleState', null);
  if (saved) Object.assign(StyleState, saved);

  initFontCards();
  initColorSwatches();
  initToggleSwitches();
  initPositionButtons();
  initAnimCards();
  initStyleSliders();
  initCustomFont();
  initSelectListeners();
  updatePreview();
}

/* ═══════════════════════════════════════════════
   FONT CARDS
══════════════════════════════════════════════ */
function initFontCards() {
  document.querySelectorAll('.font-card').forEach(function(card) {
    card.addEventListener('click', function() {
      document.querySelectorAll('.font-card').forEach(function(c) { c.classList.remove('active'); });
      card.classList.add('active');
      StyleState.fontFamily = card.getAttribute('data-font');
      document.getElementById('custom-font').value = '';
      saveStyleState();
      updatePreview();
    });
  });

  // Restore active font card
  document.querySelectorAll('.font-card').forEach(function(card) {
    if (card.getAttribute('data-font') === StyleState.fontFamily) {
      card.classList.add('active');
    }
  });
}

/* ═══════════════════════════════════════════════
   CUSTOM FONT INPUT
══════════════════════════════════════════════ */
function initCustomFont() {
  var presetFonts = ['Arial','Impact','Helvetica','Verdana','Tahoma','Trebuchet MS','Georgia',
    'Times New Roman','Courier New','Comic Sans MS','Palatino Linotype','Garamond','Futura',
    'Gill Sans','Optima','Calibri','Cambria','Century Gothic','Franklin Gothic Medium',
    'Oswald','Montserrat','Roboto','Open Sans','Lato','Poppins','Inter',
    'Bebas Neue','Anton','Bangers','Permanent Marker'];

  var input = document.getElementById('custom-font');
  if (!input) return;
  if (StyleState.fontFamily && presetFonts.indexOf(StyleState.fontFamily) === -1) {
    input.value = StyleState.fontFamily;
  }
  input.addEventListener('input', function() {
    if (input.value.trim()) {
      StyleState.fontFamily = input.value.trim();
      document.querySelectorAll('.font-card').forEach(function(c) { c.classList.remove('active'); });
      saveStyleState();
      updatePreview();
    }
  });
}

/* ═══════════════════════════════════════════════
   COLOR SWATCHES
══════════════════════════════════════════════ */
function initColorSwatches() {
  // Text color swatches
  document.querySelectorAll('#text-color-row .color-swatch').forEach(function(sw) {
    sw.addEventListener('click', function() {
      document.querySelectorAll('#text-color-row .color-swatch').forEach(function(s) { s.classList.remove('active'); });
      sw.classList.add('active');
      StyleState.textColor = sw.getAttribute('data-color');
      document.getElementById('text-color-picker').value = StyleState.textColor;
      saveStyleState();
      updatePreview();
    });
  });

  document.getElementById('text-color-picker').addEventListener('input', function() {
    StyleState.textColor = this.value;
    document.querySelectorAll('#text-color-row .color-swatch').forEach(function(s) { s.classList.remove('active'); });
    saveStyleState();
    updatePreview();
  });

  // BG color swatches
  document.querySelectorAll('#bg-color-row .color-swatch').forEach(function(sw) {
    sw.addEventListener('click', function() {
      document.querySelectorAll('#bg-color-row .color-swatch').forEach(function(s) { s.classList.remove('active'); });
      sw.classList.add('active');
      StyleState.bgColor = sw.getAttribute('data-color');
      saveStyleState();
      updatePreview();
    });
  });

  // Restore active swatches
  document.querySelectorAll('#text-color-row .color-swatch').forEach(function(sw) {
    if (sw.getAttribute('data-color') === StyleState.textColor) sw.classList.add('active');
    else sw.classList.remove('active');
  });
  document.querySelectorAll('#bg-color-row .color-swatch').forEach(function(sw) {
    if (sw.getAttribute('data-color') === StyleState.bgColor) sw.classList.add('active');
    else sw.classList.remove('active');
  });
}

/* ═══════════════════════════════════════════════
   TOGGLE SWITCHES
══════════════════════════════════════════════ */
function initToggleSwitches() {
  var toggleBg = document.getElementById('toggle-bg');
  var bgOptions = document.getElementById('bg-options');
  if (toggleBg) {
    toggleBg.checked = StyleState.bgEnabled;
    bgOptions.style.display = StyleState.bgEnabled ? '' : 'none';
    toggleBg.addEventListener('change', function() {
      StyleState.bgEnabled = toggleBg.checked;
      bgOptions.style.display = toggleBg.checked ? '' : 'none';
      saveStyleState();
      updatePreview();
    });
  }

  var toggleShadow = document.getElementById('toggle-shadow');
  if (toggleShadow) {
    toggleShadow.checked = StyleState.shadow;
    toggleShadow.addEventListener('change', function() {
      StyleState.shadow = toggleShadow.checked;
      saveStyleState();
      updatePreview();
    });
  }

  var toggleOutline = document.getElementById('toggle-outline');
  if (toggleOutline) {
    toggleOutline.checked = StyleState.outline;
    toggleOutline.addEventListener('change', function() {
      StyleState.outline = toggleOutline.checked;
      saveStyleState();
      updatePreview();
    });
  }
}

/* ═══════════════════════════════════════════════
   POSITION BUTTONS
══════════════════════════════════════════════ */
function initPositionButtons() {
  document.querySelectorAll('.position-btn').forEach(function(btn) {
    if (btn.getAttribute('data-pos') === StyleState.position) btn.classList.add('active');
    btn.addEventListener('click', function() {
      document.querySelectorAll('.position-btn').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      StyleState.position = btn.getAttribute('data-pos');
      saveStyleState();
      updatePreview();
    });
  });
}

/* ═══════════════════════════════════════════════
   ANIMATION CARDS
══════════════════════════════════════════════ */
function initAnimCards() {
  document.querySelectorAll('.anim-card').forEach(function(card) {
    if (card.getAttribute('data-anim') === StyleState.animation) card.classList.add('active');
    card.addEventListener('click', function() {
      document.querySelectorAll('.anim-card').forEach(function(c) { c.classList.remove('active'); });
      card.classList.add('active');
      StyleState.animation = card.getAttribute('data-anim');
      saveStyleState();
      demoAnimation(StyleState.animation);
    });
  });

  // Preview text input
  var previewInput = document.getElementById('anim-preview-text');
  if (previewInput) {
    previewInput.addEventListener('input', function() {
      var previewEl = document.getElementById('preview-caption-text');
      if (previewEl) {
        previewEl.setAttribute('data-text', this.value || 'Your caption text here');
        previewEl.textContent = this.value || 'Your caption text here';
      }
      demoAnimation(StyleState.animation);
    });
  }

  // Replay button
  var replayBtn = document.getElementById('btn-replay-anim');
  if (replayBtn) {
    replayBtn.addEventListener('click', function() {
      demoAnimation(StyleState.animation);
    });
  }
}

function demoAnimation(anim) {
  var previewEl = document.getElementById('preview-caption-text');
  if (!previewEl) return;

  var speed = StyleState.animSpeed || 5;
  // Speed 1=slow(1000ms), 5=normal(400ms), 10=fast(100ms)
  var dur = Math.round(1000 - (speed - 1) * 90); // 1000ms → 190ms

  // Reset
  previewEl.style.transition = 'none';
  previewEl.style.opacity = '0';
  previewEl.style.transform = '';
  previewEl.style.filter = '';
  previewEl.style.letterSpacing = '';
  var text = previewEl.getAttribute('data-text') || 'Your caption text here';
  previewEl.textContent = text;

  var animFns = {
    'none': function() {
      previewEl.style.opacity = '1';
    },
    'fade': function() {
      previewEl.style.transition = 'opacity ' + dur + 'ms ease';
      setTimeout(function() { previewEl.style.opacity = '1'; }, 30);
    },
    'slide-up': function() {
      previewEl.style.transform = 'translateY(22px)';
      previewEl.style.transition = 'opacity ' + dur + 'ms ease, transform ' + dur + 'ms ease';
      setTimeout(function() {
        previewEl.style.opacity = '1';
        previewEl.style.transform = 'translateY(0)';
      }, 30);
    },
    'slide-down': function() {
      previewEl.style.transform = 'translateY(-22px)';
      previewEl.style.transition = 'opacity ' + dur + 'ms ease, transform ' + dur + 'ms ease';
      setTimeout(function() {
        previewEl.style.opacity = '1';
        previewEl.style.transform = 'translateY(0)';
      }, 30);
    },
    'pop': function() {
      previewEl.style.transform = 'scale(0.4)';
      previewEl.style.transition = 'opacity ' + Math.round(dur*0.6) + 'ms ease, transform ' + dur + 'ms cubic-bezier(0.34, 1.56, 0.64, 1)';
      setTimeout(function() {
        previewEl.style.opacity = '1';
        previewEl.style.transform = 'scale(1)';
      }, 30);
    },
    'zoom': function() {
      previewEl.style.transform = 'scale(0)';
      previewEl.style.transition = 'opacity ' + dur + 'ms ease, transform ' + dur + 'ms ease';
      setTimeout(function() {
        previewEl.style.opacity = '1';
        previewEl.style.transform = 'scale(1)';
      }, 30);
    },
    'bounce': function() {
      previewEl.style.transform = 'translateY(-30px)';
      previewEl.style.transition = 'opacity ' + Math.round(dur*0.4) + 'ms ease, transform ' + dur + 'ms cubic-bezier(0.22, 1, 0.36, 1)';
      setTimeout(function() {
        previewEl.style.opacity = '1';
        previewEl.style.transform = 'translateY(0)';
      }, 30);
    },
    'blur-in': function() {
      previewEl.style.filter = 'blur(8px)';
      previewEl.style.transition = 'opacity ' + dur + 'ms ease, filter ' + dur + 'ms ease';
      setTimeout(function() {
        previewEl.style.opacity = '1';
        previewEl.style.filter = 'blur(0)';
      }, 30);
    },
    'flicker': function() {
      previewEl.style.opacity = '1';
      var count = 0;
      var flickerInterval = setInterval(function() {
        previewEl.style.opacity = count % 2 === 0 ? '0.1' : '1';
        count++;
        if (count > 6) {
          clearInterval(flickerInterval);
          previewEl.style.opacity = '1';
        }
      }, Math.round(dur / 7));
    },
    'typewriter': function() {
      previewEl.textContent = '';
      previewEl.style.opacity = '1';
      var i = 0;
      var charSpeed = Math.round(dur / Math.max(text.length, 1));
      charSpeed = Math.max(charSpeed, 20);
      function type() {
        if (i < text.length) {
          previewEl.textContent += text[i++];
          setTimeout(type, charSpeed);
        }
      }
      type();
    },
    'word-by-word': function() {
      var words = text.split(' ');
      previewEl.textContent = '';
      previewEl.style.opacity = '1';
      var i = 0;
      var wSpeed = Math.round(dur / Math.max(words.length, 1));
      wSpeed = Math.max(wSpeed, 80);
      function showWord() {
        if (i < words.length) {
          previewEl.textContent = (i > 0 ? previewEl.textContent + ' ' : '') + words[i++];
          setTimeout(showWord, wSpeed);
        }
      }
      showWord();
    },
    'karaoke': function() {
      var words = text.split(' ');
      previewEl.style.opacity = '1';
      var i = 0;
      var wSpeed = Math.round(dur / Math.max(words.length, 1));
      wSpeed = Math.max(wSpeed, 100);
      function highlightWord() {
        if (i < words.length) {
          var html = words.map(function(w, idx) {
            return idx === i
              ? '<span style="color:' + (StyleState.textColor === '#FFDD00' ? '#FF4466' : '#FFDD00') + '">' + w + '</span>'
              : w;
          }).join(' ');
          previewEl.innerHTML = html;
          i++;
          setTimeout(highlightWord, wSpeed);
        } else {
          previewEl.textContent = text;
        }
      }
      highlightWord();
    }
  };

  var fn = animFns[anim] || animFns['none'];
  setTimeout(fn, 80);
}

/* ═══════════════════════════════════════════════
   SLIDERS
══════════════════════════════════════════════ */
function initStyleSliders() {
  var sliders = [
    { id: 'font-size', valId: 'font-size-val', key: 'fontSize', format: function(v) { return v; }, parse: parseInt },
    { id: 'bg-opacity', valId: 'bg-opacity-val', key: 'bgOpacity', format: function(v) { return v + '%'; }, parse: parseInt },
    { id: 'bg-radius', valId: 'bg-radius-val', key: 'bgRadius', format: function(v) { return v + 'px'; }, parse: parseInt },
    { id: 'vert-offset', valId: 'vert-offset-val', key: 'vertOffset', format: function(v) { return v + '%'; }, parse: parseInt },
    { id: 'anim-speed', valId: 'anim-speed-val', key: 'animSpeed', format: function(v) { return v; }, parse: parseInt }
  ];

  sliders.forEach(function(sl) {
    var el = document.getElementById(sl.id);
    var valEl = document.getElementById(sl.valId);
    if (!el || !valEl) return;

    // Restore value
    el.value = StyleState[sl.key] !== undefined ? StyleState[sl.key] : el.value;
    valEl.textContent = sl.format(el.value);

    el.addEventListener('input', function() {
      StyleState[sl.key] = sl.parse(this.value);
      valEl.textContent = sl.format(this.value);
      saveStyleState();
      updatePreview();
    });
  });
}

/* ═══════════════════════════════════════════════
   SELECT LISTENERS (font-weight, text-align)
══════════════════════════════════════════════ */
function initSelectListeners() {
  var fontWeightSel = document.getElementById('font-weight');
  if (fontWeightSel) {
    fontWeightSel.value = StyleState.fontWeight || '700';
    fontWeightSel.addEventListener('change', function() {
      StyleState.fontWeight = this.value;
      saveStyleState();
      updatePreview();
    });
  }

  var textAlignSel = document.getElementById('text-align');
  if (textAlignSel) {
    textAlignSel.value = StyleState.textAlign || 'center';
    textAlignSel.addEventListener('change', function() {
      StyleState.textAlign = this.value;
      saveStyleState();
      updatePreview();
    });
  }
}

/* ═══════════════════════════════════════════════
   UPDATE PREVIEW
══════════════════════════════════════════════ */
function updatePreview() {
  var previewEl = document.getElementById('preview-caption-text');
  if (!previewEl) return;

  var text = 'Your caption text here';
  previewEl.setAttribute('data-text', text);
  previewEl.textContent = text;

  // Font
  previewEl.style.fontFamily = StyleState.fontFamily || 'Arial';
  previewEl.style.fontSize = StyleState.fontSize + 'px';
  previewEl.style.fontWeight = StyleState.fontWeight || '700';
  previewEl.style.textAlign = StyleState.textAlign || 'center';
  previewEl.style.color = StyleState.textColor || '#FFFFFF';

  // Background
  if (StyleState.bgEnabled) {
    var r = hexToRGB(StyleState.bgColor || '#000000');
    var alpha = (StyleState.bgOpacity || 75) / 100;
    previewEl.style.background = 'rgba(' + r.r + ',' + r.g + ',' + r.b + ',' + alpha + ')';
    previewEl.style.borderRadius = (StyleState.bgRadius || 0) + 'px';
    previewEl.style.padding = '4px 12px';
  } else {
    previewEl.style.background = 'transparent';
    previewEl.style.padding = '0';
    previewEl.style.borderRadius = '0';
  }

  // Shadow
  if (StyleState.shadow) {
    previewEl.style.textShadow = '0 2px 8px rgba(0,0,0,0.9), 0 1px 2px rgba(0,0,0,0.8)';
  } else {
    previewEl.style.textShadow = 'none';
  }

  // Outline
  if (StyleState.outline) {
    previewEl.style.webkitTextStroke = '1.5px #000000';
  } else {
    previewEl.style.webkitTextStroke = '';
  }

  // Position (simplified in preview)
  var pos = StyleState.position || 'bot-center';
  var previewWrapper = document.getElementById('style-preview');
  if (previewWrapper) {
    previewWrapper.style.alignItems = pos.startsWith('top') ? 'flex-start' : (pos.startsWith('mid') ? 'center' : 'flex-end');
    previewWrapper.style.justifyContent = pos.endsWith('left') ? 'flex-start' : (pos.endsWith('right') ? 'flex-end' : 'center');
    previewWrapper.style.paddingBottom = pos.startsWith('bot') ? '14px' : '0';
    previewWrapper.style.paddingTop = pos.startsWith('top') ? '10px' : '0';
  }
}

function hexToRGB(hex) {
  var result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : { r: 0, g: 0, b: 0 };
}

/* ═══════════════════════════════════════════════
   SAVE STYLE STATE
══════════════════════════════════════════════ */
function saveStyleState() {
  storeSave('styleState', StyleState);
  // Also save individual keys for captions module
  storeSave('style-font', StyleState.fontFamily);
  storeSave('style-fontSize', StyleState.fontSize);
  storeSave('style-fontWeight', StyleState.fontWeight);
  storeSave('style-textColor', StyleState.textColor);
  storeSave('style-bgColor', StyleState.bgColor);
  storeSave('style-bgOpacity', StyleState.bgOpacity);
  storeSave('style-bgEnabled', StyleState.bgEnabled);
  storeSave('style-shadow', StyleState.shadow);
  storeSave('style-outline', StyleState.outline);
  storeSave('style-position', StyleState.position);
  storeSave('style-animation', StyleState.animation);
}

/* ═══════════════════════════════════════════════
   APPLY STYLE TO CAPTIONS IN TIMELINE
══════════════════════════════════════════════ */
async function applyStyleToTimeline() {
  if (!requireSequence()) return;

  var hasCaptions = window.CaptionsModule &&
                    window.CaptionsModule.captions &&
                    window.CaptionsModule.captions.length > 0;
  if (!hasCaptions) {
    showToast('Generate captions first, then apply style.', 'warning', 5000);
    return;
  }

  await batchDom(function() {
    setBtnLoading('btn-apply-style', true);
    setStatus('Applying styles to all captions\u2026', 'purple pulse');
  });

  try {
    var anim  = StyleState.animation || 'none';
    var speed = StyleState.animSpeed || 5;
    var wps   = 1 + (speed - 1) * 0.5;

    // Word-by-word: split into per-word SRT entries
    var captionsToUse = window.CaptionsModule.captions;
    if (anim === 'word-by-word') {
      captionsToUse = splitCaptionsWordByWord(window.CaptionsModule.captions, wps);
    }

    // Push everything to ExtendScript store
    var styleJSON    = JSON.stringify(StyleState);
    var captionsJSON = JSON.stringify(captionsToUse);
    await evalScript('storeFlashcutData("captionStyle", \'' + styleJSON.replace(/'/g, "\\'") + '\')');
    await evalScript('storeFlashcutData("captions",     \'' + captionsJSON.replace(/'/g, "\\'") + '\')');

    setStatus('Writing styled captions to timeline\u2026', 'purple pulse');
    await yieldToPaint();

    var result = await evalScript('applyCaptionStyles()');

    if (result && result.error) {
      showToast('\u26a0 ' + result.error, 'error', 8000);
      setStatus('Style apply failed', 'red');
      return;
    }

    var method = (result && result.method) || '';
    var count  = (result && result.count)  || captionsToUse.length;

    if (method.indexOf('ass') !== -1) {
      setStatus('\u2713 Styled captions on timeline (' + count + ')', 'green');
      showToast('\u2713 ' + count + ' captions styled with font, color & animation!', 'success', 6000);
    } else if (method) {
      setStatus('\u2713 Captions updated (' + count + ')', 'green');
      showToast('\u2713 ' + count + ' captions placed. For full font/color control open Premiere \u2192 Essential Graphics.', 'info', 7000);
    } else {
      setStatus('\u2713 Done', 'green');
      showToast('\u2713 Captions applied to timeline.', 'success', 5000);
    }

  } catch(e) {
    showToast('Failed: ' + e.message, 'error');
    setStatus('Error', 'red');
  }

  setBtnLoading('btn-apply-style', false);
}

// Split caption blocks into one-word-per-clip entries, evenly distributed in time
function splitCaptionsWordByWord(captions, wordsPerSec) {
  var result = [];
  var idCounter = 0;
  captions.forEach(function(cap) {
    var words = (cap.text || '').trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return;
    var totalDur = cap.end - cap.start;
    var wDur = Math.min(totalDur / words.length, 1 / wordsPerSec);
    wDur = Math.max(wDur, 0.05);
    words.forEach(function(word, wi) {
      var wStart = cap.start + wi * wDur;
      var wEnd   = Math.min(wStart + wDur, cap.end);
      result.push({ id: 'w' + (idCounter++), start: wStart, end: wEnd, text: word });
    });
  });
  return result;
}

function buildStyleGuide() {
  var parts = [];
  parts.push(StyleState.fontFamily + ' ' + StyleState.fontSize + 'px');
  if (StyleState.fontWeight === '700' || StyleState.fontWeight === '900') parts.push('Bold');
  parts.push('Color ' + StyleState.textColor);
  if (StyleState.bgEnabled) parts.push('BG ' + StyleState.bgOpacity + '%');
  return parts.join(' \u2022 ');
}



/* ═══════════════════════════════════════════════
   EVENT LISTENERS
══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', function() {
  // Run after app.js and other modules
  setTimeout(initStylePanel, 100);

  document.getElementById('btn-apply-style').addEventListener('click', applyStyleToTimeline);
});

window.StyleState = StyleState;
window.updatePreview = updatePreview;
