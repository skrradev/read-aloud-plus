// Maps the words Claude sends to the TTS server back onto the text nodes of
// the rendered message, and paints word/sentence highlights with the CSS
// Custom Highlight API (no DOM changes, so React never notices).
(function (root) {
  'use strict';

  const SKIP_SELECTOR = [
    '.sr-only',
    '[data-testid="message-actions"]',
    '.turn-action-controls',
    'button',
    'svg',
    'style',
    'script',
    'textarea',
    'input',
    '[aria-hidden="true"]',
  ].join(',');

  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE',
    'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'HR', 'BR',
    'SECTION', 'ARTICLE', 'FIGURE', 'DETAILS', 'SUMMARY', 'DL', 'DT', 'DD',
  ]);

  function normalize(s) {
    return s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '');
  }

  function blockOf(node, stop) {
    for (let el = node.parentElement; el && el !== stop; el = el.parentElement) {
      if (BLOCK_TAGS.has(el.tagName)) return el;
    }
    return stop;
  }

  class MessageText {
    constructor(messageEl) {
      this.root = messageEl;
      this.build();
    }

    build() {
      const root = this.root;
      const pieces = []; // { node, flatStart }
      let flat = '';
      const breaks = []; // flat positions where a block boundary was inserted
      let lastBlock = null;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          if (n.nodeType === 1) {
            if (n.matches(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_SKIP;
          }
          return n.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        },
      });
      // <br> never reaches the walker as text, so remember them separately.
      const brs = new Set(root.querySelectorAll('br'));
      let n;
      while ((n = walker.nextNode())) {
        const block = blockOf(n, root);
        let prevBr = false;
        for (const br of brs) {
          if (br.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING) {
            prevBr = true;
            brs.delete(br);
          }
        }
        if (flat && (block !== lastBlock || prevBr)) { breaks.push(flat.length); flat += ' '; }
        lastBlock = block;
        pieces.push({ node: n, flatStart: flat.length });
        flat += n.nodeValue;
      }
      this.flat = flat;
      this.pieces = pieces;
      // Same text with line breaks between blocks: what a TTS engine would
      // read, for sites that don't tell us the spoken text.
      const chars = flat.split('');
      for (const b of breaks) chars[b] = '\n';
      this.spokenText = chars.join('');
      // Tokens over the flat string, each resolved back to (node, offset) pairs.
      const tokens = [];
      const re = /\S+/g;
      let m;
      while ((m = re.exec(flat))) {
        const norm = normalize(m[0]);
        tokens.push({ text: m[0], norm, start: m.index, end: m.index + m[0].length });
      }
      this.tokens = tokens;
    }

    locate(flatPos, isEnd) {
      const P = this.pieces;
      let lo = 0, hi = P.length - 1, idx = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (P[mid].flatStart <= flatPos - (isEnd ? 1 : 0)) { idx = mid; lo = mid + 1; } else hi = mid - 1;
      }
      const p = P[idx];
      const off = Math.max(0, Math.min(p.node.nodeValue.length, flatPos - p.flatStart));
      return { node: p.node, offset: off };
    }

    rangeFor(firstTok, lastTok) {
      const a = this.locate(this.tokens[firstTok].start, false);
      const b = this.locate(this.tokens[lastTok].end, true);
      const r = new Range();
      r.setStart(a.node, a.offset);
      r.setEnd(b.node, b.offset);
      return r;
    }

    isStale() {
      return !this.root.isConnected || this.pieces.some(p => !p.node.isConnected);
    }

    // For every spoken word, the index of the matching DOM token (or -1).
    mapSpoken(spokenWords) {
      const dom = this.tokens;
      const map = new Int32Array(spokenWords.length).fill(-1);
      const sNorm = spokenWords.map(w => normalize(w.text));
      const LOOK = 80;
      let j = 0;
      const nextSpoken = i => { for (let k = i + 1; k < sNorm.length; k++) if (sNorm[k]) return sNorm[k]; return null; };
      const confirm = (i, jj) => {
        const nx = nextSpoken(i);
        if (!nx) return true;
        for (let d = 1; d <= 3 && jj + d < dom.length; d++) if (dom[jj + d].norm === nx) return true;
        return false;
      };
      for (let i = 0; i < sNorm.length; i++) {
        const s = sNorm[i];
        if (!s) continue;
        let found = -1;
        for (let d = 0; d < LOOK && j + d < dom.length; d++) {
          const jj = j + d;
          if (dom[jj].norm === s && (d <= 2 || confirm(i, jj))) { found = jj; break; }
        }
        if (found < 0) {
          // Token split differently, e.g. "writes/sec" vs "writes/ sec".
          for (let d = 0; d < 3 && j + d < dom.length; d++) {
            const dn = dom[j + d].norm;
            if (dn && (dn.startsWith(s) || s.startsWith(dn))) { found = j + d; break; }
          }
        }
        if (found >= 0) { map[i] = found; j = found + 1; }
      }
      return map;
    }
  }

  function mappedRatio(map) {
    let n = 0;
    for (const x of map) if (x >= 0) n++;
    return map.length ? n / map.length : 0;
  }

  class Highlighter {
    constructor() {
      this.supported = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function';
      if (this.supported) {
        this.word = new Highlight();
        this.sentence = new Highlight();
        this.sentence.priority = 0;
        this.word.priority = 1;
        CSS.highlights.set('readaloudplus-sentence', this.sentence);
        CSS.highlights.set('readaloudplus-word', this.word);
      }
      this.style = document.createElement('style');
      this.style.id = 'readaloudplus-style';
      this.lastUserScroll = 0;
      const markUser = () => { this.lastUserScroll = performance.now(); };
      addEventListener('wheel', markUser, { passive: true, capture: true });
      addEventListener('touchmove', markUser, { passive: true, capture: true });
      addEventListener('keydown', e => {
        if (['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '].includes(e.key)) markUser();
      }, { capture: true });
    }

    setColors({ wordColor, wordText, sentenceColor }) {
      this.style.textContent = `
        ::highlight(readaloudplus-word) { background-color: ${wordColor}; color: ${wordText}; }
        ::highlight(readaloudplus-sentence) { background-color: ${sentenceColor}; }
      `;
      if (!this.style.isConnected) (document.head || document.documentElement).appendChild(this.style);
    }

    clear() {
      if (!this.supported) return;
      this.word.clear();
      this.sentence.clear();
    }

    show(wordRange, sentenceRange) {
      if (!this.supported) return;
      this.word.clear();
      this.sentence.clear();
      if (wordRange) this.word.add(wordRange);
      if (sentenceRange) this.sentence.add(sentenceRange);
    }

    scrollIntoView(range) {
      if (!range || performance.now() - this.lastUserScroll < 3500) return;
      const rect = range.getBoundingClientRect();
      if (!rect.height) return;
      const scroller = scrollParent(range.startContainer.parentElement);
      const box = scroller ? scroller.getBoundingClientRect() : { top: 0, height: innerHeight };
      const top = box.top + box.height * 0.15;
      const bottom = box.top + box.height * 0.8;
      if (rect.top >= top && rect.bottom <= bottom) return;
      const delta = rect.top - (box.top + box.height * 0.35);
      (scroller || document.scrollingElement).scrollBy({ top: delta, behavior: 'smooth' });
    }
  }

  function scrollParent(el) {
    for (; el && el !== document.body; el = el.parentElement) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 4) return el;
    }
    return null;
  }

  root.ReadAloudText = { MessageText, Highlighter, normalize, mappedRatio };
})(typeof globalThis !== 'undefined' ? globalThis : this);
