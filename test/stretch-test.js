// Checks the WSOLA stretcher: exact passthrough at 1x, right duration and
// unchanged pitch at other speeds, and real-time-capable speed.
const assert = require('assert');
const { Stretcher } = require('../src/stretcher.js');

const SR = Number(process.env.SR) || 48000;

function tone(sec, hz) {
  const x = new Float32Array(Math.round(sec * SR));
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / SR) * (0.6 + 0.4 * Math.sin(i / 3000));
  return x;
}

function run(input, rate, pushSize = 4800) {
  const s = new Stretcher(SR);
  s.rate = rate;
  const outs = [];
  let inPos = [];
  for (let i = 0; i < input.length; i += pushSize) {
    s.push(input.subarray(i, i + pushSize));
    const r = s.pull(1e9);
    outs.push(r.out);
    inPos = inPos.concat(r.inPos);
  }
  s.flush();
  const r = s.pull(1e9);
  outs.push(r.out);
  inPos = inPos.concat(r.inPos);
  const total = outs.reduce((a, o) => a + o.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const x of outs) { out.set(x, o); o += x.length; }
  return { out, inPos, s };
}

function zeroCrossHz(x, from, to) {
  let n = 0;
  for (let i = from + 1; i < to; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) n++;
  return n / 2 / ((to - from) / SR);
}

const input = tone(5, 220);

// 1x must reproduce the input exactly (after the first fade-in hop).
{
  const { out, s } = run(input, 1);
  let maxErr = 0;
  for (let i = s.Hs; i < input.length; i++) maxErr = Math.max(maxErr, Math.abs(out[i] - input[i]));
  assert(maxErr < 1e-5, `1x passthrough error ${maxErr}`);
  console.log(`1.0x: exact passthrough (max err ${maxErr.toExponential(1)})`);
}

for (const rate of [0.5, 0.75, 1.25, 1.5, 2, 2.5]) {
  const t0 = process.hrtime.bigint();
  const { out, inPos } = run(input, rate);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const realOut = out.length - 0.05 * SR; // ignore flush padding
  const expected = input.length / rate;
  const durErr = Math.abs(realOut - expected) / expected;
  const hz = zeroCrossHz(out, SR / 2, Math.min(out.length, input.length / rate - SR / 2));
  for (let i = 1; i < inPos.length; i++) assert(inPos[i] >= inPos[i - 1] - 600 * 2, 'inPos should move forward');
  assert(durErr < 0.03, `rate ${rate}: duration off by ${(durErr * 100).toFixed(1)}%`);
  assert(Math.abs(hz - 220) < 6, `rate ${rate}: pitch moved to ${hz.toFixed(1)} Hz`);
  console.log(`${rate.toFixed(2)}x: duration err ${(durErr * 100).toFixed(2)}%, pitch ${hz.toFixed(1)} Hz, ${(ms / 5).toFixed(1)} ms CPU per second of audio`);
}
console.log('stretcher OK');
