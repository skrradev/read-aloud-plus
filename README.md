# Read Aloud+ for Claude

A Chrome extension for claude.ai. When you press **Read aloud** under a Claude reply, it highlights each word as it is spoken (plus a softer highlight on the current sentence), similar to Microsoft Edge's Read Aloud. It also adds speed control from 0.5× to 2.5× without the chipmunk effect. The audio is Claude's own voice. Nothing is re-synthesized.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this folder.
4. Reload any open claude.ai tabs.

## Use

- Press **Read aloud** under any reply. A small control bar appears at the top of the page.
- **−** / **+** change the speed. Clicking the speed value resets it to 1×. The highlighter button toggles word highlighting.
- Keyboard, while reading (not while typing): <kbd>Shift</kbd>+<kbd>.</kbd> is faster and <kbd>Shift</kbd>+<kbd>,</kbd> is slower.
- Claude's own Pause/Resume button keeps working as usual.
- The toolbar icon opens settings: default speed, highlight color, sentence highlight, auto-scroll, and showing or hiding the control bar.

## How it works

Claude's Read aloud sends the reply text over a WebSocket (`/api/ws/text_to_speech/text_stream`), receives audio (16 kHz PCM or 48 kHz Opus), and plays it as a chain of Web Audio buffer nodes. The stream contains **no word timestamps**, so the extension works them out itself:

| Piece | File | What it does |
|---|---|---|
| Hooks and session | `src/main.js` | Runs in the page before Claude's code. It reads the text Claude sends, intercepts each audio chunk as it is scheduled, and manages one "session" per read. |
| Word timing | `src/aligner.js` | Detects pauses in the audio (10 ms loudness frames). Dynamic programming matches the pauses to punctuation in the text, and words between matched pauses are spread by their estimated spoken length. The speech rate is searched for while streaming and remembered for the next read. |
| Speed | `src/stretcher.js` | A streaming WSOLA time-stretcher that changes tempo without changing pitch. At 1× it is bit-exact. |
| Highlighting | `src/textmap.js` | Maps spoken words onto the message's DOM text and paints them with the CSS Custom Highlight API, so the page's DOM is never modified. |
| Settings | `src/bridge.js`, `popup/` | Syncs `chrome.storage` with the page script. |

In **Smart speed** mode (the default), the extension plays the audio itself through the stretcher. Claude's player still gets "ended" events and sees a clock that follows the stretched playback. That keeps its buffering, pause/resume, interruptions and end-of-read handling working at any speed. With Smart speed off, Claude plays the audio normally and the extension only highlights.

## Limitations

- Word timing is estimated from pauses, not reported by the server. It locks on to sentence boundaries well, but within a long sentence a word can be off by a fraction of a second.
- Words Claude doesn't read literally (symbols like `≈`, or list numbers that only exist as CSS) get no word highlight. The sentence highlight still shows.
- It depends on claude.ai internals (the WebSocket path, the `action-bar-read-aloud` / `assistant-message` test IDs, and Web Audio buffer playback). If Claude changes these, the extension falls back to normal playback rather than breaking Read aloud.

## Development

```bash
npm test
```

This runs the stretcher checks (both sample rates) and replays a captured real read-aloud session (`test/fixtures/sharding.json`) through the aligner. `node tools/make-icons.js` regenerates the icons.
