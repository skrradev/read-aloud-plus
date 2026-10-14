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
  if (window.__readAloudPlusClaude) return;
  window.__readAloudPlusClaude = true;

  const Core = window.ReadAloudCore;
  const { settings, log } = Core;
  const { Aligner } = window.ReadAloudAligner;
  const { Stretcher } = window.ReadAloudStretcher;

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
  let playing = null; // session bound to an AudioContext

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
    if (p && !p.loggedMismatch) {
      p.loggedMismatch = true;
      log('audio chunk not matched to read', { expected: p.sampleRate, buffer: node.buffer?.sampleRate, ctx: ctx.sampleRate, channels: node.buffer?.numberOfChannels });
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
      const s = playing || pending;
      if (s) { s.sockets++; ws.addEventListener('close', () => s.onSocketClosed()); }
      return;
    }
    const s = new ClaudeSession({
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
  class ClaudeSession extends Core.Session {
    constructor(info) {
      super();
      this.info = info;
      this.sampleRate = /^opus/.test(info.format) ? 48000 : (parseInt(info.format.split('_')[1], 10) || 16000);
      this.mode = settings.smartSpeed ? 'smart' : 'passive';
      this.texts = [];
      this.ctx = null;
      this.chunks = [];
      this.inTotal = 0;
      this.sockets = 1;
      this.socketsClosed = 0;
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
      this.aligner = new Aligner(this.texts.join(' '));
      this.recallRate(this.rateKey);
      if (this.mode === 'smart') this.engine = new Engine(this, ctx, dest);
      if (playing && playing !== this) playing.end('superseded');
      playing = this;
      Core.start(this);
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

    audibleSec() {
      const p = this.audiblePos();
      return p < 0 ? -1 : p / this.sampleRate;
    }
    isPaused() { return this.ctx?.state === 'suspended'; }
    canChangeSpeed() { return this.mode === 'smart'; }
    setRate(r) { this.engine?.setRate(r); }
    candidateMessages() {
      return lastClick && performance.now() - lastClick.at < 15000 ? [lastClick.msg] : [];
    }
    allMessages() { return document.querySelectorAll('[data-testid="assistant-message"]'); }

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
      this.rememberRate(this.rateKey);
      if (playing === this) playing = null;
      Core.finish(this);
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
})();
