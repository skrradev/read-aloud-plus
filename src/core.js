// Site-independent part of the page script: settings, the highlight loop,
// the floating speed control and keyboard shortcuts. Each site adapter
// (sites/claude.js, sites/chatgpt.js) creates a Session subclass that knows
// how to get audio and timing for that site, and hands it to ReadAloudCore.
(() => {
  'use strict';
  if (window.ReadAloudCore) return;

  const { BRK_SENTENCE } = window.ReadAloudAligner;
  const { MessageText, Highlighter, mappedRatio } = window.ReadAloudText;

  const SPEEDS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1, 1.1, 1.2, 1.25, 1.3, 1.4, 1.5, 1.6, 1.75, 2, 2.25, 2.5];
  const formatSpeed = x => `${x.toFixed(Math.round(x * 100) % 10 ? 2 : 1)}×`;

  // ---------------------------------------------------------------- settings
  const settings = {
    smartSpeed: true,
    speed: 1,
    highlightWord: true,
    highlightSentence: true,
    autoScroll: true,
    showControls: true,
    wordColor: '#ffd54a',
    wordText: '#1a1a1a',
    sentenceColor: 'rgba(255, 213, 74, 0.22)',
    debug: false,
  };
  const log = (...a) => { if (settings.debug) console.debug('[ReadAloud+]', ...a); };

  let current = null;
  let highlighter = null;

  function applySettings(patch) {
    Object.assign(settings, patch);
    highlighter?.setColors(settings);
    if (current) {
      current.setRate(settings.speed);
      current.lastWord = -2; // force repaint
    }
    ui.render();
  }
  function saveSettings(patch) {
    applySettings(patch);
    document.dispatchEvent(new CustomEvent('readaloudplus:save', { detail: JSON.stringify(patch) }));
  }
  document.addEventListener('readaloudplus:settings', e => {
    try { applySettings(JSON.parse(e.detail)); } catch (err) { console.warn('[ReadAloud+] bad settings', err); }
  });

  // ---------------------------------------------------------------- session
  // Subclasses implement:
  //   audibleSec()        seconds into the audio (aligner timeline) now heard, or -1
  //   isPaused()
  //   canChangeSpeed()
  //   setRate(r)
  //   candidateMessages() elements likely to hold the text being read, best first
  //   allMessages()       every message element on the page (fallback search)
  class Session {
    constructor() {
      this.active = true;
      this.aligner = null;
      this.message = null;
      this.messageEl = null;
      this.wordMap = null;
      this.lastWord = -2;
      this.lastAlignAt = 0;
    }

    setRate() {}
    canChangeSpeed() { return false; }
    isPaused() { return false; }
    candidateMessages() { return []; }
    allMessages() { return []; }

    ensureMessage() {
      if (this.message && !this.message.isStale()) return true;
      const words = this.aligner.words;
      if (!words.length || performance.now() - (this.matchFailedAt || -1e9) < 2000) return false;
      const candidates = this.candidateMessages().filter(el => el && el.isConnected);
      if (this.messageEl?.isConnected) candidates.unshift(this.messageEl);
      let best = null;
      const consider = el => {
        const mt = new MessageText(el);
        const map = mt.mapSpoken(words);
        const r = mappedRatio(map);
        if (!best || r > best.r) best = { mt, map, r, el };
      };
      for (const el of candidates) consider(el);
      if (!best || best.r < 0.5) {
        for (const el of this.allMessages()) if (!candidates.includes(el)) consider(el);
      }
      if (!best || best.r < 0.3) { this.matchFailedAt = performance.now(); return false; }
      this.message = best.mt;
      this.messageEl = best.el;
      this.wordMap = best.map;
      this.sentenceOf = new Int32Array(words.length);
      let start = 0;
      for (let i = 0; i < words.length; i++) {
        this.sentenceOf[i] = start;
        if (words[i].brk === BRK_SENTENCE) start = i + 1;
      }
      log('message matched', Math.round(best.r * 100) + '% of words');
      return true;
    }

    tick() {
      if (!this.active || !this.aligner) return;
      const now = performance.now();
      if (this.aligner.dirty && now - this.lastAlignAt > 400) {
        this.lastAlignAt = now;
        this.aligner.align();
      }
      if (!this.aligner.wordTimes) return;
      const t = this.audibleSec();
      const w = t < 0 ? -1 : this.aligner.wordAt(t);
      if (w === this.lastWord) return;
      this.lastWord = w;
      if (w < 0 || !this.ensureMessage()) { highlighter.clear(); return; }
      const domIdx = this.wordMap[w];
      let wordRange = null;
      let sentenceRange = null;
      if (domIdx >= 0 && settings.highlightWord) wordRange = this.message.rangeFor(domIdx, domIdx);
      if (settings.highlightSentence) {
        const s0 = this.sentenceOf[w];
        let s1 = s0;
        while (s1 + 1 < this.wordMap.length && this.sentenceOf[s1 + 1] === s0) s1++;
        let a = -1, b = -1;
        for (let i = s0; i <= s1; i++) if (this.wordMap[i] >= 0) { a = this.wordMap[i]; break; }
        for (let i = s1; i >= s0; i--) if (this.wordMap[i] >= 0) { b = this.wordMap[i]; break; }
        if (a >= 0 && b >= a) sentenceRange = this.message.rangeFor(a, b);
      }
      highlighter.show(wordRange, sentenceRange);
      if (settings.autoScroll) highlighter.scrollIntoView(wordRange || sentenceRange);
    }

    // Remember the speaking rate for the next read with this voice.
    rememberRate(key) {
      const a = this.aligner;
      if (a && a.audioDuration > 25 && a.lastRho) {
        try { localStorage.setItem(key, String(a.lastRho)); } catch {}
      }
    }
    recallRate(key) {
      try {
        const prior = parseFloat(localStorage.getItem(key));
        if (prior > 0.02 && prior < 0.2) this.aligner.priorSecPerUnit = this.aligner.secPerUnit = prior;
      } catch {}
    }
  }

  function start(session) {
    if (current && current !== session) current.end('superseded');
    current = session;
    session.setRate(settings.speed);
    ui.show();
    startFrameLoop();
  }

  function finish(session) {
    if (current !== session) return;
    current = null;
    highlighter.clear();
    ui.hide();
  }

  // ------------------------------------------------------------ frame loop
  let loopRunning = false;
  function startFrameLoop() {
    if (loopRunning) return;
    loopRunning = true;
    const step = () => {
      if (!current) { loopRunning = false; return; }
      try { current.tick(); ui.syncPaused(); } catch (err) { console.warn('[ReadAloud+]', err); }
      if (document.hidden) setTimeout(step, 250); else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---------------------------------------------------------- speed control
  function stepSpeed(dir) {
    const cur = settings.speed;
    let i = SPEEDS.findIndex(x => x >= cur - 1e-6);
    if (i < 0) i = SPEEDS.length - 1;
    if (dir > 0) i = SPEEDS[i] > cur + 1e-6 ? i : Math.min(SPEEDS.length - 1, i + 1);
    else i = Math.max(0, SPEEDS[i] < cur - 1e-6 ? i : i - 1);
    saveSettings({ speed: SPEEDS[i] });
  }

  // On window, capture phase, registered before the site's own scripts: sites
  // like ChatGPT send any typing outside a text field into their composer.
  window.addEventListener('keydown', e => {
    if (!current || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key !== '>' && e.key !== '<') return;
    const t = e.target;
    if (t instanceof Element && t.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')) return;
    stepSpeed(e.key === '>' ? 1 : -1);
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  // --------------------------------------------------------------------- ui
  const ui = {
    host: null,
    root: null,
    build() {
      const host = document.createElement('readaloudplus-controls');
      host.style.cssText = 'position:fixed;z-index:2147483646;left:50%;top:60px;transform:translateX(-50%);display:none;';
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `
        <style>
          :host { all: initial; }
          .bar { display:flex; align-items:center; gap:2px; padding:4px; border-radius:999px;
            font: 500 13px/1 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
            background: #2b2a27; color:#f5f4ef; box-shadow: 0 4px 18px rgba(0,0,0,.25); user-select:none; }
          @media (prefers-color-scheme: light) { .bar { background:#ffffff; color:#1f1e1d; border:1px solid rgba(0,0,0,.12); } }
          button { all:unset; cursor:pointer; min-width:28px; height:28px; padding:0 6px; border-radius:999px;
            display:inline-flex; align-items:center; justify-content:center; box-sizing:border-box; }
          button:hover { background: rgba(127,127,127,.18); }
          button:focus-visible { outline:2px solid #d97757; outline-offset:1px; }
          button[disabled] { opacity:.4; cursor:default; }
          .speed { min-width:52px; font-variant-numeric: tabular-nums; }
          .icon { width:16px; height:16px; }
          .state { padding:0 8px 0 6px; opacity:.75; font-size:12px; }
          .on { color:#d97757; }
        </style>
        <div class="bar" role="toolbar" aria-label="Read aloud speed">
          <span class="state" aria-live="polite"></span>
          <button class="slower" title="Slower (Shift+,)" aria-label="Slower">
            <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3.5 8h9"/></svg>
          </button>
          <button class="speed" title="Reset to 1×" aria-label="Playback speed"></button>
          <button class="faster" title="Faster (Shift+.)" aria-label="Faster">
            <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3.5 8h9M8 3.5v9"/></svg>
          </button>
          <button class="hl" title="Toggle word highlighting" aria-label="Toggle word highlighting">
            <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M2.5 13.5h11"/><path d="M4.5 10.5 9.8 3.2a1 1 0 0 1 1.4-.2l1 .8a1 1 0 0 1 .2 1.4L7.3 12.5H4.5z"/></svg>
          </button>
        </div>`;
      root.querySelector('.slower').addEventListener('click', () => stepSpeed(-1));
      root.querySelector('.faster').addEventListener('click', () => stepSpeed(1));
      root.querySelector('.speed').addEventListener('click', () => saveSettings({ speed: 1 }));
      root.querySelector('.hl').addEventListener('click', () => saveSettings({ highlightWord: !settings.highlightWord }));
      this.root = root;
      this.host = host;
      (document.body || document.documentElement).appendChild(host);
    },
    show() {
      if (!settings.showControls) return;
      if (!this.host || !this.host.isConnected) this.build();
      this.host.style.display = 'block';
      this.render();
    },
    hide() { if (this.host) this.host.style.display = 'none'; },
    render() {
      if (!this.root) return;
      const canSpeed = current ? current.canChangeSpeed() : true;
      const sp = this.root.querySelector('.speed');
      sp.textContent = canSpeed ? formatSpeed(settings.speed) : '1.0×';
      this.root.querySelector('.slower').disabled = !canSpeed || settings.speed <= SPEEDS[0];
      this.root.querySelector('.faster').disabled = !canSpeed || settings.speed >= SPEEDS[SPEEDS.length - 1];
      sp.disabled = !canSpeed;
      sp.title = canSpeed ? 'Reset to 1×' : 'Turn on "Smart speed" in the extension settings to change speed';
      this.root.querySelector('.hl').classList.toggle('on', settings.highlightWord);
      if (!settings.showControls) this.hide();
    },
    syncPaused() {
      if (!this.root || !current) return;
      const label = current.isPaused() ? 'Paused' : 'Reading';
      const el = this.root.querySelector('.state');
      if (el.textContent !== label) el.textContent = label;
    },
  };

  highlighter = new Highlighter();
  highlighter.setColors(settings);

  window.ReadAloudCore = {
    settings,
    log,
    Session,
    start,
    finish,
    get current() { return current; },
  };
  // Small debugging handle for the console.
  window.__readAloudPlus = { get session() { return current; }, settings };

  // Ask the isolated-world bridge for stored settings.
  queueMicrotask(() => document.dispatchEvent(new CustomEvent('readaloudplus:hello')));
})();
