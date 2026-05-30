// In-browser TTSService.
//
// Replaces the original C++ TTS engine (~680MB voice model — not browser
// runnable) with a Web Speech API bridge to the host window. Faithful to the
// HTTP/WS contract jibo-service-clients/lib TTSService expects, so the entire
// embodied-dialog speak pipeline runs through to completion:
//
//   1. Skill calls jibo.embodied.speech.speak(text).
//   2. The pipeline POSTs /tts_lex (lex tokens), /tts_pos_tagging (POS tags),
//      /tts_token_times (per-word timings). Stubs in services/index.js
//      already produce plausible values.
//   3. The pipeline calls _dispatchWordSchedule(timings), which locally fires
//      tts.word events on the schedule (drives auto-tagging eye/body motion).
//   4. The pipeline POSTs /tts_speak with the prompt and blocks waiting for
//      the response. Real TTS returns 204 when audio finishes. We invoke
//      Web Speech via the host (postMessage 'speak'), wait for the host's
//      'speak-done', then resolve with 204. That keeps the timeline + expression
//      animations playing for the real duration of speech.
//   5. The pipeline returns; the skill mim graph advances.
//
// Without this — i.e. with the previous installWebSpeech override and an
// instantly-204 stub — the embodied-dialog timeline finished in 1ms, no
// posture-shift / per-word motion animations played, and skills paced too
// fast against the host-window audio.

// Pending speak operations keyed by id; resolved by the host's speak-done.
const _pending = new Map();
let _seq = 0;
let _bridgeInstalled = false;

function _ensureBridge() {
  if (_bridgeInstalled || typeof window === 'undefined') return;
  _bridgeInstalled = true;
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || m.__jibo !== true) return;
    if (m.kind === 'speak-done' && _pending.has(m.id)) {
      const fin = _pending.get(m.id);
      _pending.delete(m.id);
      fin();
    }
  });
}

// Strip SSML for Web Speech (the host's SpeechSynthesisUtterance takes plain
// text). embodied-dialog wraps the prompt in <speak>…<break>…</speak> tags;
// drop every tag and collapse whitespace.
function _toPlain(text) {
  return String(text == null ? '' : text)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Estimate ms a piece of text takes to speak — used as a safety-net timeout
// when the host's speak-done never fires (no SpeechSynthesis voices installed,
// headless, etc.) so the skill never hangs.
function _estimateMs(plain) {
  return Math.min(30000, Math.max(900, plain.length * 75 + 700));
}

// Talk the prompt via the host window. Resolves when speech finishes (or the
// fallback timer fires). Mirrors the inner contract of jibo-embodied-dialog's
// speak: it's a Promise<void> that paces the surrounding timeline.
function _speakViaHost(prompt) {
  _ensureBridge();
  const plain = _toPlain(prompt);
  return new Promise((resolve) => {
    if (!plain || typeof window === 'undefined' || !window.parent) { resolve(); return; }
    const id = ++_seq;
    let done = false;
    const fin = () => { if (done) return; done = true; _pending.delete(id); clearTimeout(timer); resolve(); };
    _pending.set(id, fin);
    const timer = setTimeout(fin, _estimateMs(plain) + 4000);
    try { window.parent.postMessage({ __jibo: true, kind: 'speak', id, text: plain }, '*'); }
    catch (_) { fin(); }
  });
}

// Synthesize a token-timings response from the prompt. embodied-dialog's
// _generateWordSchedule (jibo-embodied-dialog.js:5454) walks our tokens and
// pairs each one with a wordNode (word / break / audio / say-as) by name
// match. CRITICAL: <break/>, <audio/>, <say-as>...</say-as> have to come
// through as special MARKER tokens — names `<break>`, `<audioBreak>`,
// `<say-as>` (TTS_BREAK / TTS_AUDIO_BREAK / TTS_SAY_AS at
// jibo-embodied-dialog.js:4976-4978) — or the resulting wordSchedule is
// missing entries for those nodes. Any BLOCKING <anim> tag (e.g. the
// chitchat dance) anchors its timeSyncNode to a break/word node; when that
// node has no schedule entry, the bundle silently drops the anim at
// line 5523 ("Could not resolve time-sync information for blocking asset
// request"). That's why the entire chitchat-dance SLIM produced only the
// surrounding auto-tagger poses — the dance node never made it to the
// timeline.
//
// We preserve the markers by replacing the relevant tags with sentinel
// strings BEFORE the tag-stripping pass, then re-expanding them into named
// tokens with their own time slot during tokenization.
const _MARK_BREAK = 'BREAK';
const _MARK_AUDIO = 'AUDIO';
const _MARK_SAYAS = 'SAYAS';
function _markupForTiming(text) {
  return String(text == null ? '' : text)
    .replace(/<break\b[^>]*\/?>/gi, ` ${_MARK_BREAK} `)
    .replace(/<audio\b[^>]*\/?>/gi, ` ${_MARK_AUDIO} `)
    .replace(/<say-as\b[^>]*>/gi, ` ${_MARK_SAYAS} `)
    .replace(/<\/say-as\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function _tokenTimes(prompt) {
  const marked = _markupForTiming(prompt);
  const words = marked.split(/\s+/).filter(Boolean);
  let t = 0;
  const tokens = words.map((w) => {
    let name;
    let dur;
    if (w === _MARK_BREAK) { name = '<break>'; dur = 0.3; }
    else if (w === _MARK_AUDIO) { name = '<audioBreak>'; dur = 0.3; }
    else if (w === _MARK_SAYAS) { name = '<say-as>'; dur = 0.15; }
    else { name = w; dur = Math.max(0.15, w.length * 0.06); }
    const tok = { name, start: t, end: t + dur };
    t += dur;
    return tok;
  });
  if (!tokens.length) tokens.push({ name: '/pau/', start: 0, end: 0.1 });
  return { tokens };
}

export const ttsService = {
  name: 'tts',
  handle() { return undefined; },
  handleHttp(method, path, body) {
    let b = {};
    try { b = typeof body === 'string' ? JSON.parse(body) : (body || {}); } catch (_) { /* leave empty */ }
    // POS tagger contract — the lexer turns the prompt into tokens for the
    // embodied-dialog NLParser. The whole utterance as a single token is OK
    // because NLParser.split only splits on whitespace from the value itself.
    if (/\/tts_lex/.test(path)) {
      return { status: 200, body: { tokens: b.text ? [String(b.text)] : [] } };
    }
    // POS tags — embodied-dialog forEach's [word, pos] pairs; we don't have a
    // POS model in-browser, default everything to NN (noun). Conjunctions and
    // verbs would change prosody marks; for our purposes prosody is unused.
    if (/\/tts_pos_tagging/.test(path)) {
      const tokens = Array.isArray(b.tokens) ? b.tokens : [];
      return { status: 200, body: { tokentags: tokens.map((t) => [String(t), 'NN']) } };
    }
    // Per-word timings — the schedule the rest of the pipeline aligns to.
    if (/\/tts_token_times/.test(path)) {
      return { status: 200, body: { tokentimes: _tokenTimes(b.prompt || b.text) } };
    }
    // The blocking speak — drives Web Speech via host and resolves 204 only
    // after the host's speak-done event so the timeline paces to real audio.
    if (/\/tts_speak/.test(path)) {
      return _speakViaHost(b.prompt || b.text).then(() => ({ status: 204, body: '' }));
    }
    // Stop — fire-and-forget; the host cancels SpeechSynthesis on 'speak-stop'.
    if (/\/tts_stop/.test(path)) {
      try { if (typeof window !== 'undefined') window.parent.postMessage({ __jibo: true, kind: 'speak-stop' }, '*'); } catch (_) { /* */ }
      return { status: 200, body: {} };
    }
    return { status: 200, body: {} };
  },
};

export default ttsService;
