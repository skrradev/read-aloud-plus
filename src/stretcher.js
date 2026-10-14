// Streaming WSOLA (waveform-similarity overlap-add) time stretcher.
// Changes speaking speed without changing pitch. Mono Float32 in, mono out.
// rate > 1 = faster. Each emitted hop remembers which input position it came
// from, so the caller can tell which input sample is audible at any moment.
(function (root) {
  'use strict';

  class Stretcher {
    constructor(sampleRate) {
      this.sampleRate = sampleRate;
      this.N = 2 * Math.round(sampleRate * 0.015); // 30 ms frame
      this.Hs = this.N / 2; // synthesis hop, 50% overlap
      this.delta = Math.round(sampleRate * 0.0125); // ±12.5 ms search
      this.win = new Float32Array(this.N);
      for (let i = 0; i < this.N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.N);
      this.rate = 1;
      this.reset();
    }

    reset() {
      this.buf = new Float32Array(1 << 16);
      this.bufStart = 0; // absolute input index of buf[0]
      this.bufLen = 0;
      this.anaPos = 0; // nominal analysis position (absolute, may be fractional)
      this.prev = -1; // absolute input index of previous frame, -1 = none yet
      this.tail = new Float32Array(this.Hs); // second half of previous frame
      this.padded = 0; // zeros appended by flush()
    }

    get inputEnd() { return this.bufStart + this.bufLen; }

    push(samples) {
      const need = this.bufLen + samples.length;
      if (need > this.buf.length) {
        // Drop input that can no longer be referenced, then grow if needed.
        const keepFrom = Math.max(0, Math.min(this.prev < 0 ? this.anaPos : this.prev, Math.floor(this.anaPos) - this.delta) - this.N);
        const drop = Math.max(0, Math.min(this.bufLen, Math.floor(keepFrom - this.bufStart)));
        if (drop > 0) {
          this.buf.copyWithin(0, drop, this.bufLen);
          this.bufStart += drop;
          this.bufLen -= drop;
        }
        if (this.bufLen + samples.length > this.buf.length) {
          let cap = this.buf.length;
          while (cap < this.bufLen + samples.length) cap *= 2;
          const nb = new Float32Array(cap);
          nb.set(this.buf.subarray(0, this.bufLen));
          this.buf = nb;
        }
      }
      this.buf.set(samples, this.bufLen);
      this.bufLen += samples.length;
    }

    // Append silence so the last real samples can be emitted.
    flush() {
      const pad = this.N + 2 * this.delta + Math.ceil(this.Hs * Math.max(1, this.rate));
      this.push(new Float32Array(pad));
      this.padded += pad;
    }

    at(i) { return this.buf[i - this.bufStart]; }

    // Normalised cross-correlation of the overlap region.
    similarity(cand, tmpl, step) {
      const b = this.buf, o = this.bufStart, L = this.Hs;
      let xy = 0, xx = 1e-9, yy = 1e-9;
      for (let i = 0; i < L; i += step) {
        const x = b[cand + i - o], y = b[tmpl + i - o];
        xy += x * y; xx += x * x; yy += y * y;
      }
      return xy / Math.sqrt(xx * yy);
    }

    chooseFramePos() {
      if (this.prev < 0) return Math.max(this.bufStart, Math.round(this.anaPos));
      const tmpl = this.prev + this.Hs; // natural continuation of the previous frame
      if (Math.abs(this.rate - 1) < 1e-3) return tmpl;
      const c = Math.round(this.anaPos);
      const lo = Math.max(this.bufStart, c - this.delta);
      const hi = c + this.delta;
      let best = c, bestScore = -Infinity;
      for (let p = lo; p <= hi; p += 4) {
        const s = this.similarity(p, tmpl, 4);
        if (s > bestScore) { bestScore = s; best = p; }
      }
      const c2 = best;
      for (let p = Math.max(lo, c2 - 3); p <= Math.min(hi, c2 + 3); p++) {
        const s = this.similarity(p, tmpl, 2);
        if (s > bestScore) { bestScore = s; best = p; }
      }
      return best;
    }

    // Produce up to maxHops hops. Returns { out: Float32Array, inPos: number[] }
    // where inPos[h] is the input index the h-th hop starts from.
    pull(maxHops) {
      const { N, Hs } = this;
      const hops = [];
      const out = [];
      while (hops.length < maxHops) {
        const needEnd = Math.max(
          Math.round(this.anaPos) + this.delta + N,
          this.prev < 0 ? 0 : this.prev + Hs + N,
        );
        if (needEnd > this.inputEnd) break;
        const pos = this.chooseFramePos();
        const o = pos - this.bufStart;
        const hop = new Float32Array(Hs);
        for (let i = 0; i < Hs; i++) hop[i] = this.tail[i] + this.buf[o + i] * this.win[i];
        for (let i = 0; i < Hs; i++) this.tail[i] = this.buf[o + Hs + i] * this.win[Hs + i];
        out.push(hop);
        hops.push(pos);
        if (Math.abs(this.rate - 1) < 1e-3) this.anaPos = pos + Hs;
        else this.anaPos += Hs * this.rate;
        this.prev = pos;
      }
      const res = new Float32Array(out.length * Hs);
      out.forEach((h, i) => res.set(h, i * Hs));
      return { out: res, inPos: hops };
    }

    // Input samples not yet consumed (approximate, in samples).
    get backlog() { return Math.max(0, this.inputEnd - this.padded - this.anaPos); }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { Stretcher };
  else root.ReadAloudStretcher = { Stretcher };
})(typeof globalThis !== 'undefined' ? globalThis : this);
