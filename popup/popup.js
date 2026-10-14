/* global READ_ALOUD_PLUS_DEFAULTS */
'use strict';

const SPEEDS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1, 1.1, 1.2, 1.25, 1.3, 1.4, 1.5, 1.6, 1.75, 2, 2.25, 2.5];
const COLORS = [
  { name: 'Yellow', word: '#ffd54a', text: '#1a1a1a', sentence: 'rgba(255, 213, 74, 0.22)' },
  { name: 'Green', word: '#8be0a4', text: '#10291a', sentence: 'rgba(139, 224, 164, 0.22)' },
  { name: 'Blue', word: '#9cc8ff', text: '#0e1d33', sentence: 'rgba(156, 200, 255, 0.24)' },
  { name: 'Pink', word: '#ffadd2', text: '#33101f', sentence: 'rgba(255, 173, 210, 0.24)' },
  { name: 'Orange', word: '#ffb38a', text: '#33170a', sentence: 'rgba(255, 179, 138, 0.24)' },
];
const TOGGLES = ['smartSpeed', 'highlightWord', 'highlightSentence', 'autoScroll', 'showControls'];

const $ = id => document.getElementById(id);
const fmt = s => `${s.toFixed(Math.round(s * 100) % 10 ? 2 : 1)}×`;
const nearestIndex = s => SPEEDS.reduce((best, v, i) => (Math.abs(v - s) < Math.abs(SPEEDS[best] - s) ? i : best), 0);

function render(values) {
  $('speed').value = nearestIndex(values.speed);
  $('speedOut').textContent = fmt(values.speed);
  $('speed').disabled = !values.smartSpeed;
  for (const k of TOGGLES) $(k).checked = values[k];
  for (const btn of $('colors').children) btn.setAttribute('aria-pressed', String(btn.dataset.word === values.wordColor));
}

for (const c of COLORS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.style.background = c.word;
  b.title = c.name;
  b.setAttribute('aria-label', `${c.name} highlight`);
  b.dataset.word = c.word;
  b.addEventListener('click', () => chrome.storage.sync.set({ wordColor: c.word, wordText: c.text, sentenceColor: c.sentence }));
  $('colors').appendChild(b);
}

$('speed').addEventListener('input', e => {
  const s = SPEEDS[Number(e.target.value)];
  $('speedOut').textContent = fmt(s);
  chrome.storage.sync.set({ speed: s });
});
for (const k of TOGGLES) $(k).addEventListener('change', e => chrome.storage.sync.set({ [k]: e.target.checked }));

chrome.storage.sync.get(READ_ALOUD_PLUS_DEFAULTS, render);
chrome.storage.onChanged.addListener(() => chrome.storage.sync.get(READ_ALOUD_PLUS_DEFAULTS, render));
