// Runs in the page's own JS world on claude.ai, before Claude's scripts.
//
// How Claude's "Read aloud" works (observed): the message text is sent over a
// WebSocket to /api/ws/text_to_speech/text_stream, audio comes back (PCM or
// Opus), gets decoded, and is played as a chain of AudioBufferSourceNodes
// scheduled back-to-back on an AudioContext. Pause = context.suspend().
// Stop = .stop() on every scheduled node.
//
// What we do:
//  - read the text it sends (so we know the words),
//  - intercept each audio chunk as it is scheduled, feed it to the word
//    aligner, and (in "smart speed" mode) play it ourselves through a
//    pitch-preserving time stretcher instead,
//  - tell Claude's player its chunks "ended" when *our* playback finishes
//    them, and show it a matching clock, so its own buffering logic,
//    pause/stop buttons and end-of-read detection keep working,
//  - highlight the word being spoken in the message.
(() => {
  'use strict';
  if (window.__readAloudPlusLoaded) return;
  window.__readAloudPlusLoaded = true;

  const { Aligner, BRK_SENTENCE } = window.ReadAloudAligner;
  const { Stretcher } = window.ReadAloudStretcher;
  const { MessageText, Highlighter, mappedRatio } = window.ReadAloudText;

  const SPEEDS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1, 1.1, 1.2, 1.25, 1.3, 1.4, 1.5, 1.6, 1.75, 2, 2.25, 2.5];

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

  function applySettings(patch) {
    Object.assign(settings, patch);
    highlighter?.setColors(settings);
    if (current?.engine) current.engine.setRate(settings.speed);
    ui?.render();
    if (current) current.lastWord = -2; // force repaint
  }
  function saveSettings(patch) {
    applySettings(patch);
    document.dispatchEvent(new CustomEvent('readaloudplus:save', { detail: JSON.stringify(patch) }));
  }
  document.addEventListener('readaloudplus:settings', e => {
    try { applySettings(JSON.parse(e.detail)); } catch (err) { console.warn('[ReadAloud+] bad settings', err); }
  });

  // ------------------------------------------------------------ audio hooks
  const AC = window.BaseAudioContext || window.AudioContext;
  const ctDesc = Object.getOwnPropertyDescriptor(AC.prototype, 'currentTime');
  const realTime = ctx => ctDesc.get.call(ctx);
  const origStart = AudioBufferSourceNode.prototype.start;
  const origStop = AudioScheduledSourceNode.prototype.stop;
  const origConnect = AudioNode.prototype.connect;

  const destOf = new WeakMap(); // source node -> node it was connected to
  const chunkOwner = new WeakMap(); // Claude's source node -> Session
  const sessionByCtx = new WeakMap();
  const ctxOffset = new WeakMap(); // clock offset left behind by finished sessions
  let pending = null; // session whose WebSocket opened but has no audio yet
  let current = null; // session being played/highlighted

  AudioNode.prototype.connect = function (dest, ...rest) {
    if (this instanceof AudioBufferSourceNode && dest instanceof AudioNode) destOf.set(this, dest);
    return origConnect.call(this, dest, ...rest);
  };

  Object.defineProperty(AC.prototype, 'currentTime', {
    configurable: true,
    enumerable: ctDesc.enumerable,
    get() {
      const real = ctDesc.get.call(this);
      try {
        const s = sessionByCtx.get(this);
        if (s) return s.virtualTime(real);
        const off = ctxOffset.get(this);
        return off ? real + off : real;
      } catch (err) {
        return real;
      }
    },
  });

  AudioBufferSourceNode.prototype.start = function (when = 0, ...rest) {
    try {
      const s = sessionForNode(this);
      if (s && s.onChunk(this, when)) return undefined;
    } catch (err) {
      console.warn('[ReadAloud+] chunk handling failed, falling back to normal playback', err);
    }
    return origStart.call(this, when, ...rest);
  };

  AudioScheduledSourceNode.prototype.stop = function (...args) {
    const s = chunkOwner.get(this);
    if (s) {
      s.onChunkStopped();
      if (s.mode === 'smart') return undefined; // never actually started
    }
    return origStop.apply(this, args);
  };

  function sessionForNode(node) {
    const ctx = node.context;
    const s = sessionByCtx.get(ctx);
    if (s && s.active) return s;
    const p = pending;
    if (p && !p.ctx && node.buffer && node.buffer.numberOfChannels === 1 &&
        node.buffer.sampleRate === p.sampleRate && ctx.sampleRate === p.sampleRate) {
      pending = null;
      p.bind(ctx, destOf.get(node) || ctx.destination);
      return p;
    }
    return null;
  }

  // -------------------------------------------------------- websocket hook
  const OrigWS = window.WebSocket;
  window.WebSocket = new Proxy(OrigWS, {
    construct(target, args, newTarget) {
      const ws = Reflect.construct(target, args, newTarget);
      try { onSocket(ws, String(args[0])); } catch (err) { console.warn('[ReadAloud+]', err); }
      return ws;
    },
  });

  function onSocket(ws, url) {
    if (!/\/api\/ws\/text_to_speech\//.test(url)) return;
    const q = new URL(url, location.href).searchParams;
    if (q.has('resume_token')) {
      // Claude reconnecting mid-read; same audio stream continues.
      const s = current || pending;
      if (s) { s.sockets++; ws.addEventListener('close', () => s.onSocketClosed()); }
      return;
    }
    const s = new Session({
      format: q.get('output_format') || '',
      voice: q.get('voice') || '',
      ttsSpeed: q.get('tts_speed') || '1',
    });
    if (pending && pending !== s) pending.discard();
    pending = s;
    const send = ws.send;
    ws.send = function (data) {
      if (typeof data === 'string' && data.includes('text_chunk')) {
        try {
          const m = JSON.parse(data);
          if (m.type === 'text_chunk' && typeof m.text === 'string') s.addText(m.text);
        } catch {}
      }
      return send.call(this, data);
    };
    ws.addEventListener('close', () => s.onSocketClosed());
    log('new read', s.info);
  }

  // Remember which message's Read aloud button was pressed.
  let lastClick = null;
  document.addEventListener('click', e => {
    const btn = e.target instanceof Element && e.target.closest('[data-testid="action-bar-read-aloud"]');
    if (!btn) return;
    const msg = btn.closest('[data-testid="assistant-message"]');
    if (msg) lastClick = { msg, at: performance.now() };
  }, true);

  // ---------------------------------------------------------------- session
  class Session {
    constructor(info) {
      this.info = info;
      this.sampleRate = /^opus/.test(info.format) ? 48000 : (parseInt(info.format.split('_')[1], 10) || 16000);
      this.mode = settings.smartSpeed ? 'smart' : 'passive';
      this.texts = [];
      this.ctx = null;
      this.chunks = [];
      this.inTotal = 0;
      this.active = true;
      this.sockets = 1;
      this.socketsClosed = 0;
      this.aligner = null;
      this.message = null;
      this.wordMap = null;
      this.lastWord = -2;
      this.lastAlignAt = 0;
      this.virtLast = 0;
      this.baseOffset = 0;
    }

    get rateKey() { return `readAloudPlus:secPerUnit:${this.info.voice}:${this.info.ttsSpeed}`; }
    get wsClosed() { return this.socketsClosed >= this.sockets; }

    addText(t) {
      this.texts.push(t);
      if (this.aligner) {
        this.aligner.setText(this.texts.join(' '));
        this.message = null;
      }
    }

    discard() { this.active = false; }

    bind(ctx, dest) {
      this.ctx = ctx;
      this.baseOffset = ctxOffset.get(ctx) || 0;
      this.virtLast = realTime(ctx) + this.baseOffset;
      sessionByCtx.set(ctx, this);
      if (current && current !== this) current.end('superseded');
      current = this;
      this.aligner = new Aligner(this.texts.join(' '));
      try {
        const prior = parseFloat(localStorage.getItem(this.rateKey));
        if (prior > 0.02 && prior < 0.2) this.aligner.priorSecPerUnit = this.aligner.secPerUnit = prior;
      } catch {}
      if (this.mode === 'smart') this.engine = new Engine(this, ctx, dest);
      ui.show();
      startFrameLoop();
      log('bound to context', ctx.sampleRate, this.mode);
    }

    onChunk(node, when) {
      if (!this.active) return false;
      const data = node.buffer.getChannelData(0);
      chunkOwner.set(node, this);
      // Claude's times are on the clock we show it; translate to the real one.
      const realWhen = this.mode === 'smart' ? when : Math.max(0, when - this.baseOffset);
      this.chunks.push({ node, inStart: this.inTotal, len: data.length, when: this.mode === 'smart' ? when : realWhen, ended: false });
      this.inTotal += data.length;
      this.aligner.addAudio(data, node.buffer.sampleRate);
      if (this.mode === 'smart') this.engine.push(data);
      else origStart.call(node, realWhen);
      return true;
    }

    onChunkStopped() {
      // Claude stops all scheduled chunks at once (stop button, new read, error).
      if (this.active && !this.stopQueued) {
        this.stopQueued = true;
        queueMicrotask(() => this.end('stopped'));
      }
    }

    onSocketClosed() {
      this.socketsClosed++;
      this.engine?.kick();
    }

    // Claude's view of the clock. In smart mode it follows our playback
    // position, so its "schedule ~30 s ahead" logic tracks what is audible.
    virtualTime(real) {
      if (this.mode !== 'smart' || !this.engine) return real + this.baseOffset;
      const p = this.engine.inputPosAt(real);
      let v;
      if (p < 0) {
        v = real + this.baseOffset;
        if (this.chunks.length) v = Math.min(v, this.chunks[0].when);
      } else {
        const k = this.chunkIndexAt(p);
        const c = this.chunks[k];
        v = c.when + Math.min(p - c.inStart, c.len) / this.sampleRate;
      }
      if (v < this.virtLast) v = this.virtLast;
      this.virtLast = v;
      return v;
    }

    chunkIndexAt(p) {
      const C = this.chunks;
      let lo = 0, hi = C.length - 1, ans = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (C[mid].inStart <= p) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return ans;
    }

    // Input sample currently coming out of the speakers, or -1.
    audiblePos() {
      const ctx = this.ctx;
      let t = realTime(ctx);
      if (ctx.state === 'running') {
        const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
        if (ts && ts.contextTime > 0) t = Math.min(t, ts.contextTime + (performance.now() - ts.performanceTime) / 1000);
        else t -= ctx.outputLatency || ctx.baseLatency || 0;
      }
      if (this.engine) return this.engine.inputPosAt(t);
      // Passive mode: Claude's own schedule.
      const C = this.chunks;
      if (!C.length || t < C[0].when) return -1;
      for (let i = C.length - 1; i >= 0; i--) {
        if (C[i].when <= t) return C[i].inStart + Math.min(C[i].len, (t - C[i].when) * this.sampleRate);
      }
      return -1;
    }

    ensureMessage() {
      if (this.message && !this.message.isStale()) return true;
      const words = this.aligner.words;
      if (!words.length || performance.now() - (this.matchFailedAt || -1e9) < 2000) return false;
      const candidates = [];
      if (lastClick && performance.now() - lastClick.at < 15000 && lastClick.msg.isConnected) candidates.push(lastClick.msg);
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
        for (const el of document.querySelectorAll('[data-testid="assistant-message"]')) {
          if (!candidates.includes(el)) consider(el);
        }
      }
      if (!best || best.r < 0.3) { this.matchFailedAt = performance.now(); return false; }
      this.message = best.mt;
      this.messageEl = best.el;
      this.wordMap = best.map;
      // Sentence spans over spoken words.
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
      const p = this.audiblePos();
      const w = p < 0 ? -1 : this.aligner.wordAt(p / this.sampleRate);
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

    // Everything played: Claude has already been told each chunk ended.
    end(reason) {
      if (!this.active) return;
      this.active = false;
      log('read ended:', reason);
      this.engine?.stop();
      if (this.ctx) {
        ctxOffset.set(this.ctx, this.virtLast > 0 && this.mode === 'smart'
          ? Math.max(this.baseOffset, this.virtLast - realTime(this.ctx))
          : this.baseOffset);
        sessionByCtx.delete(this.ctx);
      }
      if (this.aligner && this.aligner.audioDuration > 25 && this.aligner.lastRho) {
        try { localStorage.setItem(this.rateKey, String(this.aligner.lastRho)); } catch {}
      }
      if (current === this) {
        current = null;
        highlighter.clear();
        ui.hide();
      }
    }
  }

  // ----------------------------------------------------------------- engine
  // Plays a session's audio through the time stretcher.
  class Engine {
    constructor(session, ctx, dest) {
      this.s = session;
      this.ctx = ctx;
      this.dest = dest;
      this.sr = ctx.sampleRate;
      this.st = new Stretcher(this.sr);
      this.st.rate = settings.speed;
      this.segments = []; // { node, start, dur, inPos[], rate }
      this.live = new Set();
      this.schedEnd = 0;
      this.nextEnded = 0; // index of the next Claude chunk to report as ended
      this.flushed = false;
      this.stopped = false;
      this.kickQueued = false;
      this.timer = setInterval(() => this.pump(), 40);
    }

    setRate(r) { this.st.rate = r; }

    push(data) {
      this.st.push(data);
      this.flushed = false;
      this.kick();
    }

    kick() {
      if (this.kickQueued || this.stopped) return;
      this.kickQueued = true;
      queueMicrotask(() => { this.kickQueued = false; this.pump(); });
    }

    pump() {
      if (this.stopped || this.pumping) return;
      if (this.ctx.state === 'closed') { this.s.end('context closed'); return; }
      this.pumping = true;
      try {
        const now = realTime(this.ctx);
        const lookahead = document.hidden ? 1.5 : 0.3;
        const hopsPerBlock = Math.max(1, Math.round((0.1 * this.sr) / this.st.Hs));
        for (;;) {
          if (this.schedEnd && this.schedEnd < now) this.schedEnd = 0; // ran dry
          const start = this.schedEnd || now + 0.03;
          if (start - now >= lookahead) break;
          const { out, inPos } = this.st.pull(hopsPerBlock);
          if (!out.length) {
            // Out of input. At the very end of the read, push the tail out.
            if (this.s.wsClosed && !this.flushed && this.st.backlog > 0 && start - now < 0.12) {
              this.st.flush();
              this.flushed = true;
              continue;
            }
            break;
          }
          this.schedule(out, inPos, start);
        }
        this.reportEnded(now);
      } finally {
        this.pumping = false;
      }
    }

    schedule(out, inPos, start) {
      const ctx = this.ctx;
      const buf = ctx.createBuffer(1, out.length, this.sr);
      buf.copyToChannel(out, 0);
      const node = ctx.createBufferSource();
      node.buffer = buf;
      origConnect.call(node, this.dest);
      origStart.call(node, start);
      this.live.add(node);
      node.onended = () => { this.live.delete(node); node.disconnect(); this.kick(); };
      this.segments.push({ node, start, dur: out.length / this.sr, inPos, rate: this.st.rate });
      if (this.segments.length > 400) this.segments.splice(0, 100);
      this.schedEnd = start + out.length / this.sr;
    }

    inputPosAt(t) {
      const S = this.segments;
      if (!S.length || t < S[0].start) return -1;
      let lo = 0, hi = S.length - 1, k = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (S[mid].start <= t) { k = mid; lo = mid + 1; } else hi = mid - 1;
      }
      const seg = S[k];
      const Hs = this.st.Hs;
      const into = Math.min((t - seg.start) * this.sr, seg.inPos.length * Hs);
      const h = Math.min(seg.inPos.length - 1, Math.floor(into / Hs));
      const p = seg.inPos[h] + (into - h * Hs) * seg.rate;
      return Math.min(p, this.s.inTotal);
    }

    // Tell Claude's player that chunks we have finished playing have "ended".
    reportEnded(now) {
      const C = this.s.chunks;
      const drained = this.flushed && this.live.size === 0 && this.st.backlog <= 0 && this.s.wsClosed;
      const played = drained ? Infinity : this.inputPosAt(now);
      while (this.nextEnded < C.length) {
        const c = C[this.nextEnded];
        if (c.inStart + c.len > played) break;
        this.nextEnded++;
        c.ended = true;
        try { c.node.dispatchEvent(new Event('ended')); } catch (err) { console.warn('[ReadAloud+]', err); }
      }
      if (drained && this.nextEnded >= C.length && !this.finishing) {
        this.finishing = true;
        setTimeout(() => this.s.end('finished'), 300);
      }
    }

    stop() {
      this.stopped = true;
      clearInterval(this.timer);
      for (const n of this.live) {
        n.onended = null;
        try { origStop.call(n); } catch {}
        try { n.disconnect(); } catch {}
      }
      this.live.clear();
    }
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
  const formatSpeed = x => `${x.toFixed(Math.round(x * 100) % 10 ? 2 : 1)}×`;

  function stepSpeed(dir) {
    const cur = settings.speed;
    let i = SPEEDS.findIndex(x => x >= cur - 1e-6);
    if (i < 0) i = SPEEDS.length - 1;
    if (dir > 0) i = SPEEDS[i] > cur + 1e-6 ? i : Math.min(SPEEDS.length - 1, i + 1);
    else i = Math.max(0, SPEEDS[i] < cur - 1e-6 ? i : i - 1);
    saveSettings({ speed: SPEEDS[i] });
  }

  document.addEventListener('keydown', e => {
    if (!current || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t instanceof Element && (t.closest('input, textarea, [contenteditable=""], [contenteditable="true"]'))) return;
    if (e.key === '>' ) { stepSpeed(1); e.preventDefault(); }
    else if (e.key === '<') { stepSpeed(-1); e.preventDefault(); }
  }, true);

  // --------------------------------------------------------------------- ui
  const ui = {
    host: null,
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
      const smart = current ? current.mode === 'smart' : settings.smartSpeed;
      const sp = this.root.querySelector('.speed');
      sp.textContent = smart ? formatSpeed(settings.speed) : '1.0×';
      this.root.querySelector('.slower').disabled = !smart || settings.speed <= SPEEDS[0];
      this.root.querySelector('.faster').disabled = !smart || settings.speed >= SPEEDS[SPEEDS.length - 1];
      sp.disabled = !smart;
      sp.title = smart ? 'Reset to 1×' : 'Turn on "Smart speed" in the extension settings to change speed';
      this.root.querySelector('.hl').classList.toggle('on', settings.highlightWord);
      if (!settings.showControls) this.hide();
    },
    syncPaused() {
      if (!this.root || !current?.ctx) return;
      const label = current.ctx.state === 'suspended' ? 'Paused' : 'Reading';
      const el = this.root.querySelector('.state');
      if (el.textContent !== label) el.textContent = label;
    },
  };

  const highlighter = new Highlighter();
  highlighter.setColors(settings);
  document.dispatchEvent(new CustomEvent('readaloudplus:hello'));

  // Small debugging handle for the console.
  window.__readAloudPlus = {
    get session() { return current; },
    settings,
  };
})();
