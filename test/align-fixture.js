// Runs the aligner on a captured read-aloud session and prints which pauses
// were matched to which text boundaries. Usage: node test/align-fixture.js [--stream]
const fs = require('fs');
const path = require('path');
const { Aligner } = require('../src/aligner.js');

const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/sharding.json'), 'utf8'));
const text = fx.chunks.join(' ');

function framesUpTo(n) {
  const db = new Array(fx.totalFrames).fill(-25);
  for (const p of fx.pauses.split(' ')) {
    const [s, l] = p.split(':').map(Number);
    for (let i = s; i < s + l; i++) db[i] = -65;
  }
  for (let i = 0; i < 20; i++) db[i] = -70; // leading silence
  return db.slice(0, n);
}

function run(nFrames, complete) {
  const a = new Aligner(text);
  if (process.env.PRIOR) a.priorSecPerUnit = a.secPerUnit = Number(process.env.PRIOR);
  const db = framesUpTo(nFrames);
  a.frameDb = db;
  for (const d of db) a.hist[Math.max(0, Math.min(199, Math.floor((d + 100) * 2)))]++;
  a.sampleRate = 16000;
  if (complete) a.markComplete();
  a.align();
  return a;
}

const full = run(fx.totalFrames, true);
console.log(`words=${full.words.length} pauses=${full.pauses.length} anchors=${full.anchors.length} sec/unit=${(full.anchors.at(-1).sp / full.cumUnits[full.words.length]).toFixed(4)}`);
for (const A of full.anchors.slice(1, -1)) {
  const w = full.words;
  const before = w.slice(Math.max(0, A.w - 3), A.w).map(x => x.text).join(' ');
  const after = w.slice(A.w, A.w + 2).map(x => x.text).join(' ');
  const p = full.pauses.find(p => Math.abs(p.e * 0.01 - A.real) < 1e-6);
  console.log(`${A.real.toFixed(2).padStart(7)}s pause ${(p.len * 1000).toFixed(0).padStart(4)}ms | ...${before} ‖ ${after}`);
}
const unmatched = full.pauses.filter(p => !full.anchors.some(A => Math.abs(p.e * 0.01 - A.real) < 1e-6));
console.log('unmatched pauses:', unmatched.map(p => `${(p.s * 0.01).toFixed(2)}s/${(p.len * 1000).toFixed(0)}ms`).join(' '));

if (process.argv.includes('--stream')) {
  // How much do streaming (partial audio) timings deviate from the final ones?
  for (const sec of [10, 20, 40, 60, 90]) {
    const part = run(sec * 100, false);
    let n = 0, sum = 0, max = 0;
    for (let i = 0; i < part.words.length; i++) {
      if (full.wordTimes[i] > sec - 3) break;
      const d = Math.abs(part.wordTimes[i] - full.wordTimes[i]);
      n++; sum += d; max = Math.max(max, d);
    }
    console.log(`stream @${sec}s: words compared=${n} meanDiff=${(sum / n).toFixed(3)}s maxDiff=${max.toFixed(3)}s rho=${part.secPerUnit.toFixed(4)}`);
  }
}
