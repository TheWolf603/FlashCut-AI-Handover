/**
 * CSInterface.js — Adobe CEP Communication Library
 * Minimal but complete implementation for FlashCut AI
 */

var SystemPath = {
  APP: 'app',
  APP_SYSTEM_JS: 'appSystemJs',
  EXTENSION: 'extension',
  HOST_APPLICATION: 'hostApplication',
  USER_DATA: 'userData',
  USER_DOCUMENTS: 'userDocuments',
  DESKTOP: 'desktop',
  EXTENSION_STORAGE: 'extensionStorage'
};

var ColorType = { CUSTOM: 'custom', THEME: 'theme' };

function Color(red, green, blue, alpha) {
  this.red = red; this.green = green; this.blue = blue; this.alpha = alpha;
}

function Theme(baseFontSize, baseFontColor, disabled, warning, error, hlText, selectedText, bgColor) {
  this.baseFontSize = baseFontSize;
}

function CSEvent(type, scope, appId, extensionId) {
  this.type = type; this.scope = scope; this.appId = appId; this.extensionId = extensionId;
  this.data = '';
}

function CSInterface() {
  this._hsObj = null;
}

CSInterface.prototype = {
  getSystemPath: function(pathType) {
    try { return window.__adobe_cep__.getSystemPath(pathType); } catch(e) { return ''; }
  },
  evalScript: function(script, callback) {
    try {
      if (window.__adobe_cep__) {
        window.__adobe_cep__.evalScript(script, callback || function(){});
      } else {
        // Dev mode fallback
        console.log('[CSInterface.evalScript] Dev mode:', script.substring(0, 120));
        if (callback) setTimeout(function(){ callback('{"error":"Dev mode – Premiere Pro not connected"}'); }, 300);
      }
    } catch(e) {
      console.error('[CSInterface.evalScript]', e);
      if (callback) callback('{"error":"' + e.message + '"}');
    }
  },
  addEventListener: function(type, listener, obj) {
    try {
      if (window.__adobe_cep__) window.__adobe_cep__.addEventListener(type, listener, obj);
    } catch(e) {}
  },
  removeEventListener: function(type, listener, obj) {
    try {
      if (window.__adobe_cep__) window.__adobe_cep__.removeEventListener(type, listener, obj);
    } catch(e) {}
  },
  dispatchEvent: function(event) {
    try {
      if (window.__adobe_cep__) window.__adobe_cep__.dispatchEvent(JSON.stringify(event));
    } catch(e) {}
  },
  getApplicationID: function() {
    try { return window.__adobe_cep__.getApplicationID(); } catch(e) { return 'PPRO'; }
  },
  getHostEnvironment: function() {
    try { return JSON.parse(window.__adobe_cep__.getHostEnvironment()); } catch(e) { return {}; }
  },
  closeExtension: function() {
    try { window.__adobe_cep__.closeExtension(); } catch(e) {}
  },
  getExtensionID: function() {
    try { return window.__adobe_cep__.getExtensionID(); } catch(e) { return 'com.flashcutai.panel'; }
  },
  openURLInDefaultBrowser: function(url) {
    try { window.__adobe_cep__.openURLInDefaultBrowser(url); } catch(e) {
      try { require('openurl').open(url); } catch(e2) {}
    }
  }
};

// Expose globally
window.CSInterface = CSInterface;
window.SystemPath = SystemPath;
