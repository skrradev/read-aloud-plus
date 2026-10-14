// Isolated-world content script: the page-world script can't use
// chrome.storage, so settings are relayed through DOM events as JSON strings.
(() => {
  'use strict';
  const DEFAULTS = READ_ALOUD_PLUS_DEFAULTS; // from defaults.js
  const ALLOWED = new Set(Object.keys(DEFAULTS));

  function push() {
    chrome.storage.sync.get(DEFAULTS, values => {
      document.dispatchEvent(new CustomEvent('readaloudplus:settings', { detail: JSON.stringify(values) }));
    });
  }

  document.addEventListener('readaloudplus:hello', push);
  document.addEventListener('readaloudplus:save', e => {
    let patch;
    try { patch = JSON.parse(e.detail); } catch { return; }
    const clean = {};
    for (const [k, v] of Object.entries(patch)) {
      if (ALLOWED.has(k) && typeof v === typeof DEFAULTS[k]) clean[k] = v;
    }
    if (typeof clean.speed === 'number') clean.speed = Math.min(2.5, Math.max(0.5, clean.speed));
    chrome.storage.sync.set(clean);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') push();
  });
  push();
})();
