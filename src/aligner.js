// Estimates when each word of the spoken text is pronounced, using only the
// audio itself. Claude's TTS stream carries no word timestamps, so we:
//   1. measure loudness in 10 ms frames and find pauses (silent runs),
//   2. match pauses to punctuation boundaries in the text with dynamic
//      programming (sentence ends almost always get a pause, commas sometimes),
//   3. spread the words between matched pauses by their estimated spoken length.
// Works incrementally while audio streams in; call align() whenever you need
// fresh timings.
(function (root) {
  'use strict';

  const FRAME_SEC = 0.01;
  const MIN_PAUSE_FRAMES = 10; // 100 ms; shorter gaps are stop consonants etc.
  const DEFAULT_SEC_PER_UNIT = 0.052; // measured on Claude's default voice at 1.0

  const BRK_NONE = 0, BRK_COMMA = 1, BRK_CLAUSE = 2, BRK_SENTENCE = 3;

  // Rough "how long does this token take to say", in letter-equivalents.
  function spokenUnits(raw) {
    const w = raw.replace(/^[\s"'“”‘’([{<*_]+|[\s"'“”‘’)\]}>*_.,;:!?]+$/g, '');
    if (!w) return 1;
    let units = 0;
    // Numbers: "3,000-6,000+" -> "three thousand to six thousand plus".
    const numbers = w.match(/\d[\d,]*(\.\d+)?/g) || [];
    for (const n of numbers) {
      const digits = n.replace(/\D/g, '').length;
      units += 4 + 5 * Math.min(digits - 1, 6);
    }
    const rest = w.replace(/\d[\d,]*(\.\d+)?/g, ' ');
    const letters = rest.match(/\p{L}+/gu) || [];
    for (const l of letters) {
      // Short all-caps tokens are usually spelled out (TB, GB, URL).
      if (l.length <= 4 && l.length > 1 && l === l.toUpperCase()) units += 2.2 * l.length;
      else units += l.length;
    }
    units += (rest.match(/[%]/g) || []).length * 7;
    units += (rest.match(/[+&=@#$€£]/g) || []).length * 4;
    units += (rest.match(/[\/\\|]/g) || []).length * 3;
    units += (rest.match(/[()[\]{}<>_~^*`]/g) || []).length * 0.5;
    return units + 1.5; // + transition between words
  }

  function breakAfter(word, followingWhitespace) {
    if (/\n/.test(followingWhitespace)) return BRK_SENTENCE;
    const t = word.replace(/["'“”‘’)\]*_]+$/, '');
    if (/[.!?…]$/.test(t)) {
      // "e.g." / "i.e." / "vs." rarely end a sentence
      if (/^(e\.g|i\.e|etc|vs|mr|mrs|dr|st|no)\.$/i.test(t)) return BRK_COMMA;
      return BRK_SENTENCE;
    }
    if (/[:;]$/.test(t)) return BRK_CLAUSE;
    if (/[,—–]$/.test(t) || /[)\]"”]$/.test(word)) return BRK_COMMA;
    return BRK_NONE;
  }

  function tokenize(text) {
    const words = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(text))) {
      words.push({ text: m[0], start: m.index, end: m.index + m[0].length });
    }
    for (let i = 0; i < words.length; i++) {
      const ws = i + 1 < words.length ? text.slice(words[i].end, words[i + 1].start) : '\n';
      words[i].brk = breakAfter(words[i].text, ws);
      words[i].units = spokenUnits(words[i].text);
      // An opening parenthesis/quote on the next word is also a likely pause.
      if (i + 1 < words.length && words[i].brk === BRK_NONE && /^[("“]/.test(words[i + 1].text)) {
        words[i].brk = BRK_COMMA;
      }
    }
    return words;
  }

  class Aligner {
    constructor(text) {
      this.setText(text || '');
      this.sampleRate = 0;
      this.frameDb = []; // dB per 10 ms frame
      this.partial = null; // leftover samples for the next frame
      this.partialLen = 0;
      this.hist = new Uint32Array(200); // 0.5 dB bins from -100 dB
      this.complete = false;
      this.secPerUnit = DEFAULT_SEC_PER_UNIT;
      this.priorSecPerUnit = DEFAULT_SEC_PER_UNIT;
      this.wordTimes = null; // start time (s) of each word, input timeline
      this.dirty = true;
    }

    setText(text) {
      this.text = text;
      this.words = tokenize(text);
      this.cumUnits = new Float64Array(this.words.length + 1);
      for (let i = 0; i < this.words.length; i++) {
        this.cumUnits[i + 1] = this.cumUnits[i] + this.words[i].units;
      }
      this.dirty = true;
    }

    get audioDuration() { return this.frameDb.length * FRAME_SEC; }

    addAudio(samples, sampleRate) {
      if (!this.sampleRate) {
        this.sampleRate = sampleRate;
        this.frameLen = Math.round(sampleRate * FRAME_SEC);
        this.partial = new Float32Array(this.frameLen);
      }
      const F = this.frameLen;
      let i = 0;
      while (i < samples.length) {
        const take = Math.min(F - this.partialLen, samples.length - i);
        this.partial.set(samples.subarray(i, i + take), this.partialLen);
        this.partialLen += take;
        i += take;
        if (this.partialLen === F) {
          let s = 0;
          for (let k = 0; k < F; k++) s += this.partial[k] * this.partial[k];
          const db = 10 * Math.log10(s / F + 1e-12);
          this.frameDb.push(db);
          const bin = Math.max(0, Math.min(199, Math.floor((db + 100) * 2)));
          this.hist[bin]++;
          this.partialLen = 0;
        }
      }
      this.dirty = true;
    }

    markComplete() { this.complete = true; this.dirty = true; }

    // Silence threshold: ~32 dB under the loud speech level, clamped.
    threshold() {
      const total = this.frameDb.length;
      if (total < 50) return -48;
      let target = total * 0.9, acc = 0;
      for (let b = 0; b < 200; b++) {
        acc += this.hist[b];
        if (acc >= target) {
          const p90 = b / 2 - 100;
          return Math.max(-60, Math.min(-38, p90 - 32));
        }
      }
      return -48;
    }

    detectPauses() {
      const thr = this.threshold();
      const db = this.frameDb;
      const pauses = [];
      let s = -1;
      // A trailing silent run is not a pause yet unless the stream is complete.
      for (let i = 0; i <= db.length; i++) {
        const sil = i < db.length && db[i] < thr;
        if (sil && s < 0) s = i;
        if (!sil && s >= 0) {
          if (i < db.length && i - s >= MIN_PAUSE_FRAMES) pauses.push({ s, e: i });
          s = -1;
        }
      }
      let speechStart = 0;
      while (speechStart < db.length && db[speechStart] < thr) speechStart++;
      let speechEnd = db.length;
      while (speechEnd > speechStart && db[speechEnd - 1] < thr) speechEnd--;
      return {
        pauses: pauses.filter(p => p.s > speechStart && p.e < speechEnd),
        speechStart,
        speechEnd,
      };
    }

    align() {
      if (!this.dirty && this.wordTimes) return this.wordTimes;
      this.dirty = false;
      const N = this.words.length;
      if (!N || this.frameDb.length < 20) {
        this.wordTimes = null;
        return null;
      }
      const { pauses, speechStart, speechEnd } = this.detectPauses();
      // Speech-time (pauses removed) coordinate of every pause, in frames.
      let removed = speechStart;
      const P = pauses.map(p => {
        const sp = p.s - removed;
        removed += p.e - p.s;
        return { s: p.s, e: p.e, len: (p.e - p.s) * FRAME_SEC, sp: sp * FRAME_SEC };
      });
      const speechTotal = (speechEnd - removed) * FRAME_SEC;

      // Candidate boundaries: after words carrying punctuation.
      const C = [];
      for (let i = 0; i < N - 1; i++) {
        if (this.words[i].brk > BRK_NONE) C.push({ i, b: this.words[i].brk, u: this.cumUnits[i + 1] });
      }

      let rho, path;
      if (this.complete) {
        // Whole text and whole audio known: the average rate is exact.
        rho = speechTotal / this.cumUnits[N];
        path = this.dp(P, C, rho, speechTotal).path;
      } else {
        // Speaking rate unknown while streaming: search for the rate that
        // explains the pauses best (coarse grid, then refine).
        const tryRho = r => {
          const res = this.dp(P, C, r, speechTotal);
          const prior = (r - this.priorSecPerUnit) / 0.012;
          return { r, path: res.path, cost: res.cost + prior * prior };
        };
        let best = tryRho(this.secPerUnit);
        for (let r = 0.036; r <= 0.1; r += 0.006) {
          const c = tryRho(r);
          if (c.cost < best.cost) best = c;
        }
        const center = best.r;
        for (let r = center - 0.005; r <= center + 0.005; r += 0.001) {
          const c = tryRho(r);
          if (c.cost < best.cost) best = c;
        }
        rho = best.r;
        path = best.path;
        this.secPerUnit = rho;
      }
      this.lastRho = rho;

      // Anchors in speech-time: (speechTime, wordIndexStartingThere, realTime)
      const anchors = [{ sp: 0, w: 0, real: speechStart * FRAME_SEC }];
      for (const { j, k } of path) anchors.push({ sp: P[j].sp, w: C[k].i + 1, real: P[j].e * FRAME_SEC });
      if (this.complete) anchors.push({ sp: speechTotal, w: N, real: speechEnd * FRAME_SEC });

      const spToReal = makeSpToReal(P, speechStart);
      const times = new Float64Array(N);
      for (let a = 0; a < anchors.length; a++) {
        const A = anchors[a];
        const B = anchors[a + 1];
        const wEnd = B ? B.w : N;
        const u0 = this.cumUnits[A.w];
        const scale = B ? (B.sp - A.sp) / Math.max(1e-6, this.cumUnits[B.w] - u0) : rho;
        for (let w = A.w; w < wEnd; w++) {
          const sp = A.sp + (this.cumUnits[w] - u0) * scale;
          times[w] = w === A.w ? A.real : spToReal(sp);
        }
      }
      this.anchors = anchors;
      this.pauses = P;
      this.wordTimes = times;
      return times;
    }

    dp(P, C, rho, speechTotal) {
      const J = P.length, K = C.length;
      const MAXJ = 5, MAXK = 10;
      const SIG2 = 0.06;
      const skipPause = len => 5 * Math.max(0, len - 0.08);
      const skipBound = b => (b === BRK_SENTENCE ? 2.5 : b === BRK_CLAUSE ? 1.2 : 0.25);
      const matchCost = (len, b) =>
        b === BRK_SENTENCE ? 3 * Math.max(0, 0.3 - len)
          : b === BRK_CLAUSE ? 2 * Math.max(0, 0.2 - len)
            : 1.5 * Math.max(0, len - 0.45);
      const seg = (d, units) => {
        const e = rho * units;
        return ((d - e) * (d - e)) / (SIG2 * (Math.max(d, 0) + 0.4));
      };
      if (!J || !K) return { path: [], cost: J ? skipPauseTotal(P, skipPause) : 0 };

      const INF = 1e18;
      const cost = new Float64Array(J * K).fill(INF);
      const from = new Int32Array(J * K).fill(-2); // -1 = start state
      // prefix sums for skip costs
      const skipP = new Float64Array(J + 1);
      for (let j = 0; j < J; j++) skipP[j + 1] = skipP[j] + skipPause(P[j].len);
      const skipC = new Float64Array(K + 1);
      for (let k = 0; k < K; k++) skipC[k + 1] = skipC[k] + skipBound(C[k].b);

      for (let j = 0; j < J; j++) {
        for (let k = 0; k < K; k++) {
          const mc = matchCost(P[j].len, C[k].b);
          let best = INF, arg = -2;
          // from the start state
          if (j < MAXJ && k < MAXK) {
            const c = seg(P[j].sp, C[k].u) + skipP[j] + skipC[k];
            if (c < best) { best = c; arg = -1; }
          }
          for (let jp = Math.max(0, j - MAXJ); jp < j; jp++) {
            for (let kp = Math.max(0, k - MAXK); kp < k; kp++) {
              const prev = cost[jp * K + kp];
              if (prev >= INF) continue;
              const c = prev + seg(P[j].sp - P[jp].sp, C[k].u - C[kp].u)
                + (skipP[j] - skipP[jp + 1]) + (skipC[k] - skipC[kp + 1]);
              if (c < best) { best = c; arg = jp * K + kp; }
            }
          }
          if (arg !== -2) {
            cost[j * K + k] = best + mc;
            from[j * K + k] = arg;
          }
        }
      }

      // Pick the end state.
      const totalUnits = this.cumUnits[this.words.length];
      let bestEnd = INF, endIdx = -1;
      for (let j = 0; j < J; j++) {
        for (let k = 0; k < K; k++) {
          const c0 = cost[j * K + k];
          if (c0 >= INF) continue;
          let c = c0 + (skipP[J] - skipP[j + 1]);
          if (this.complete) {
            c += seg(speechTotal - P[j].sp, totalUnits - C[k].u) + (skipC[K] - skipC[k + 1]);
          } else {
            // Unmatched boundaries we must already have passed are suspicious.
            const heardUnits = (speechTotal - P[j].sp) / rho;
            for (let kk = k + 1; kk < K && C[kk].u - C[k].u < heardUnits * 0.8; kk++) c += skipBound(C[kk].b);
          }
          if (c < bestEnd) { bestEnd = c; endIdx = j * K + k; }
        }
      }
      const path = [];
      for (let idx = endIdx; idx >= 0; idx = from[idx]) {
        path.push({ j: Math.floor(idx / K), k: idx % K });
      }
      path.reverse();
      return { path, cost: bestEnd };
    }

    // Index of the word being spoken at input time t (seconds), or -1.
    wordAt(t) {
      const times = this.align();
      if (!times) return -1;
      let lo = 0, hi = times.length - 1, ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return ans;
    }
  }

  function skipPauseTotal(P, f) {
    let c = 0;
    for (const p of P) c += f(p.len);
    return c;
  }

  // Map a speech-time position (pauses removed) back to real input time.
  function makeSpToReal(P, speechStart) {
    return sp => {
      let real = speechStart * FRAME_SEC + sp;
      for (const p of P) {
        if (p.sp < sp) real += p.len; else break;
      }
      return real;
    };
  }

  const api = { Aligner, tokenize, spokenUnits, BRK_NONE, BRK_COMMA, BRK_CLAUSE, BRK_SENTENCE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ReadAloudAligner = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
