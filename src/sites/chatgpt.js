// ChatGPT adapter. Runs in the page's own JS world, before ChatGPT's scripts.
//
// How ChatGPT's "Read aloud" works (observed): it fetches
// /backend-api/synthesize?message_id=…&voice=…&format=aac, streams the AAC
// (ADTS) response into a MediaSource and plays it with a detached <audio>
// element. "Stop reading aloud" removes the element's src.
//
// What we do:
//  - copy the audio response and decode it with WebCodecs so the aligner can
//    find pauses (the whole reply usually downloads in a few seconds),
//  - take the text from the message on the page (ChatGPT doesn't send it),
//  - change speed with the element's own pitch-preserving playbackRate,
//  - use the element's currentTime as the clock for highlighting.
(() => {
  'use strict';
  if (window.__readAloudPlusChatGPT) return;
  window.__readAloudPlusChatGPT = true;

  const Core = window.ReadAloudCore;
  const { settings, log } = Core;
  const { Aligner } = window.ReadAloudAligner;
  const { MessageText } = window.ReadAloudText;

  const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const TURN = '[data-turn-key]';
  const UNIT = '[data-chatgpt-search-message-ids]'; // one message; attribute holds its id

  let pending = null; // response is streaming, audio element not seen yet
  let playing = null;

  // A turn (one message) from any element inside it.
  function turnOf(el) {
    if (!el) return null;
    const t = el.closest(TURN);
    if (t) return t;
    for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
      if ((e.textContent || '').trim().length > 40) return e;
    }
    return null;
  }
  function playingTurn() {
    return turnOf(document.querySelector('button[aria-label="Stop reading aloud"]'));
  }
  // A turn holds the user's question and the reply; we want only the reply.
  function replyIn(turn) {
    if (!turn) return null;
    const units = [...turn.querySelectorAll(UNIT)].filter(u => !u.closest('[class*="user-message"]'));
    return units[units.length - 1] || turn;
  }
  function messageById(id) {
    if (!id) return null;
    for (const el of document.querySelectorAll(UNIT)) {
      if ((el.getAttribute('data-chatgpt-search-message-ids') || '').includes(id)) return el;
    }
    return null;
  }

  // Remember the message whose action bar was clicked last (works in any UI
  // language: we only care which turn the click was in).
  let lastClick = null;
  document.addEventListener('click', e => {
    const btn = e.target instanceof Element && e.target.closest('button');
    const turn = btn && turnOf(btn);
    if (turn) lastClick = { turn, at: performance.now() };
  }, true);

  // ------------------------------------------------------------ fetch hook
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (/\/backend-api\/synthesize\b/.test(url)) {
        const q = new URL(url, location.href).searchParams;
        const s = new GptSession(q.get('message_id') || '', q.get('voice') || '', q.get('format') || '');
        if (pending) pending.discard();
        pending = s;
        p.then(res => { if (res.ok && res.body) s.consume(res.clone()); }, () => {});
        log('synthesize request', s.voice, s.format);
      }
    } catch (err) {
      console.warn('[ReadAloud+]', err);
    }
    return p;
  };

  // ----------------------------------------------------------- audio hook
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    try {
      if (this instanceof HTMLAudioElement) {
        const s = pending;
        if (s && !s.el && performance.now() - s.createdAt < 60000) {
          pending = null;
          s.bind(this);
        } else if (playing && playing.el === this) {
          playing.applyRate();
        }
      }
    } catch (err) {
      console.warn('[ReadAloud+]', err);
    }
    return origPlay.apply(this, arguments);
  };

  // --------------------------------------------------------------- session
  class GptSession extends Core.Session {
    constructor(messageId, voice, format) {
      super();
      this.messageId = messageId;
      this.voice = voice;
      this.format = format;
      this.createdAt = performance.now();
      this.el = null;
      this.turn = lastClick && performance.now() - lastClick.at < 10000 ? lastClick.turn : null;
      this.sampleRate = 0;
      this.fed = 0; // samples given to the aligner
      this.early = []; // decoded audio waiting for the aligner
      this.audioDone = false;
    }

    get rateKey() { return `readAloudPlus:gpt:secPerUnit:${this.voice}`; }

    discard() { this.active = false; this.decoder?.close?.(); }

    // -- audio decoding ----------------------------------------------------
    async consume(res) {
      const reader = res.body.getReader();
      if (this.format !== 'aac') return this.consumeWhole(reader);
      let buf = new Uint8Array(0);
      let frameIndex = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (!this.active) { reader.cancel().catch(() => {}); return; }
        if (done) break;
        const joined = new Uint8Array(buf.length + value.length);
        joined.set(buf);
        joined.set(value, buf.length);
        buf = joined;
        let i = 0;
        while (i + 7 <= buf.length) {
          if (buf[i] !== 0xff || (buf[i + 1] & 0xf0) !== 0xf0) { i++; continue; }
          const len = ((buf[i + 3] & 3) << 11) | (buf[i + 4] << 3) | (buf[i + 5] >> 5);
          if (len < 7) { i++; continue; }
          if (i + len > buf.length) break;
          if (!this.decoder) {
            const sr = ADTS_RATES[(buf[i + 2] >> 2) & 15];
            const ch = ((buf[i + 2] & 1) << 2) | (buf[i + 3] >> 6);
            if (!this.startDecoder(sr, ch || 1)) return;
          }
          this.decoder.decode(new EncodedAudioChunk({
            type: 'key',
            timestamp: Math.round((frameIndex * 1024 * 1e6) / this.sampleRate),
            data: buf.subarray(i, i + len),
          }));
          frameIndex++;
          i += len;
        }
        buf = buf.slice(i);
      }
      try { await this.decoder?.flush(); } catch {}
      this.finishAudio();
    }

    startDecoder(sampleRate, channels) {
      if (typeof AudioDecoder !== 'function') return false;
      this.sampleRate = sampleRate;
      this.decoder = new AudioDecoder({
        output: data => {
          try {
            const pcm = new Float32Array(data.numberOfFrames);
            data.copyTo(pcm, { planeIndex: 0, format: 'f32-planar' });
            this.onPcm(pcm, Math.round((data.timestamp * sampleRate) / 1e6));
          } finally {
            data.close();
          }
        },
        error: err => log('decode error', err),
      });
      this.decoder.configure({ codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels });
      return true;
    }

    // Formats we can't decode incrementally: decode once fully downloaded.
    async consumeWhole(reader) {
      const parts = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
      }
      const bytes = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
      let o = 0;
      for (const p of parts) { bytes.set(p, o); o += p.length; }
      const ctx = new OfflineAudioContext(1, 1, 24000);
      try {
        const audio = await ctx.decodeAudioData(bytes.buffer);
        this.sampleRate = audio.sampleRate;
        this.onPcm(audio.getChannelData(0), 0);
      } catch (err) {
        log('could not decode', this.format, err);
      }
      this.finishAudio();
    }

    onPcm(pcm, atSample) {
      if (!this.active) return;
      // Keep the timeline exact: fill small gaps (e.g. the decoder's priming frame).
      const gap = atSample - this.fed;
      if (gap > 0 && gap < this.sampleRate) this.push(new Float32Array(gap));
      this.push(pcm);
    }

    push(pcm) {
      this.fed += pcm.length;
      if (this.aligner) this.aligner.addAudio(pcm, this.sampleRate);
      else this.early.push(pcm);
    }

    finishAudio() {
      this.audioDone = true;
      if (this.aligner) this.aligner.markComplete();
      log('audio decoded', (this.fed / (this.sampleRate || 1)).toFixed(1) + 's');
    }

    // -- text --------------------------------------------------------------
    messageElement() {
      return messageById(this.messageId) ||
        replyIn((this.turn && this.turn.isConnected && this.turn) || playingTurn());
    }

    ensureAligner() {
      if (this.aligner) return true;
      const el = this.messageElement();
      if (!el) return false;
      const text = new MessageText(el).spokenText.trim();
      if (!text) return false;
      this.messageEl = el;
      this.aligner = new Aligner(text);
      this.recallRate(this.rateKey);
      for (const pcm of this.early) this.aligner.addAudio(pcm, this.sampleRate);
      this.early = [];
      if (this.audioDone) this.aligner.markComplete();
      return true;
    }

    // -- playback ------------------------------------------------------------
    bind(el) {
      this.el = el;
      this.abort = new AbortController();
      const opts = { signal: this.abort.signal };
      el.addEventListener('emptied', () => this.end('stopped'), opts);
      el.addEventListener('ended', () => setTimeout(() => this.end('finished'), 300), opts);
      el.addEventListener('ratechange', () => {
        if (Math.abs(el.playbackRate - settings.speed) > 1e-3) this.applyRate();
      }, opts);
      if (playing && playing !== this) playing.end('superseded');
      playing = this;
      Core.start(this);
      log('bound to audio element');
    }

    applyRate() {
      const el = this.el;
      if (!el || !this.active) return;
      el.preservesPitch = true;
      el.defaultPlaybackRate = settings.speed;
      if (Math.abs(el.playbackRate - settings.speed) > 1e-3) el.playbackRate = settings.speed;
    }

    setRate() { this.applyRate(); }
    canChangeSpeed() { return true; }
    isPaused() { return !!this.el && this.el.paused && !this.el.ended; }
    audibleSec() { return this.el ? this.el.currentTime : -1; }
    candidateMessages() { return [this.messageElement()]; }
    allMessages() { return document.querySelectorAll(UNIT); }

    tick() {
      if (!this.ensureAligner()) return;
      super.tick();
    }

    end(reason) {
      if (!this.active) return;
      this.active = false;
      log('read ended:', reason);
      this.abort?.abort();
      if (this.el) {
        this.el.defaultPlaybackRate = 1;
        if (this.el.playbackRate !== 1) this.el.playbackRate = 1;
      }
      this.rememberRate(this.rateKey);
      if (playing === this) playing = null;
      Core.finish(this);
    }
  }
})();
