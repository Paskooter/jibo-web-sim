// In-browser TTSService.
//
// Replaces the on-device C++ TTS engine (~680MB voice model — not
// browser runnable) with a Web Speech API bridge to the host window.
// Faithful to the HTTP/WS contract the runtime's TTS service client
// expects, so the entire embodied-dialog speak pipeline runs through
// to completion:
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

// Talk the prompt via the host window. Resolves when speech finishes
// (or the fallback timer fires). Mirrors the inner contract of the
// embodied-dialog speak: a Promise<void> that paces the surrounding
// timeline.
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

// Synthesize a token-timings response from the prompt. The embodied
// dialog's word-schedule generator walks our tokens and pairs each one
// with a wordNode (word / break / audio / say-as) by name match.
// CRITICAL: <break/>, <audio/>, <say-as>...</say-as> have to come
// through as special MARKER tokens — names `<break>`, `<audioBreak>`,
// `<say-as>` (matching the TTS_BREAK / TTS_AUDIO_BREAK / TTS_SAY_AS
// markers the runtime checks for) — or the resulting wordSchedule is
// missing entries for those nodes. Any BLOCKING <anim> tag (e.g. the
// chitchat dance) anchors its timeSyncNode to a break/word node; when
// that node has no schedule entry, the bundle silently drops the anim
// ("Could not resolve time-sync information for blocking asset
// request"). Without the markers, dance/anim nodes never made it to
// the timeline.
//
// We preserve the markers by replacing the relevant tags with sentinel
// strings BEFORE the tag-stripping pass, then re-expanding them into named
// tokens with their own time slot during tokenization.
const _MARK_BREAK = 'BREAK';
const _MARK_AUDIO = 'AUDIO';
const _MARK_SAYAS = 'SAYAS';
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
// Tokenize a plain-text prompt into per-word + per-punctuation tokens.
// The embodied-dialog NL parser detects sentence ends and connectors from
// individual punctuation tokens (`.`, `?`, `!`, `;`, `:`, `,`), so each
// HAS to come through as its own array entry. Without that split, the
// parser sees one giant word — no sentence structure builds, no per-word
// auto-rules (Beat, Blink, Comma, Question, Or, But, ...) fire, and the
// bundle speaks completely stiff.
function _lexTokens(text) {
  return String(text == null ? '' : text)
    .replace(/([,.?!;:])/g, ' $1 ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

// Conjunctions the NL parser flags as CC tokens. CC entries become PART
// boundaries inside a sentence, which is what the Or/But/List/Noun
// structure rules and the phrase-level beat timing anchor against.
const _CC_WORDS = new Set(['and', 'or', 'but', 'so', 'yet', 'nor', 'for']);
function _posTag(token) {
  if (/^[,.?!;:]$/.test(token)) return token;
  if (_CC_WORDS.has(token.toLowerCase())) return 'CC';
  return 'NN';
}

function _tokenTimes(prompt) {
  // Marker substitution first so the floating-punctuation regex below
  // doesn't break the BREAK/AUDIO/SAYAS sentinels.
  const marked = _markupForTiming(prompt);
  const tokens = [];
  let t = 0;
  // Split on the markers to keep them intact; for the rest, run the
  // SAME tokenizer as /tts_lex so wordSchedule matches up by value
  // equality against the parser's word nodes.
  const raw = marked.split(/(BREAK|AUDIO|SAYAS)/);
  for (const chunk of raw) {
    if (!chunk) continue;
    if (chunk === _MARK_BREAK) { tokens.push({ name: '<break>', start: t, end: t + 0.3 }); t += 0.3; continue; }
    if (chunk === _MARK_AUDIO) { tokens.push({ name: '<audioBreak>', start: t, end: t + 0.3 }); t += 0.3; continue; }
    if (chunk === _MARK_SAYAS) { tokens.push({ name: '<say-as>', start: t, end: t + 0.15 }); t += 0.15; continue; }
    for (const w of _lexTokens(chunk)) {
      // Punctuation gets a brief pause; words scale with length, capped so a
      // long compound doesn't blow up the schedule.
      const dur = /^[,.?!;:]$/.test(w) ? 0.12 : Math.min(0.55, Math.max(0.18, w.length * 0.07));
      tokens.push({ name: w, start: t, end: t + dur });
      t += dur;
    }
  }
  if (!tokens.length) tokens.push({ name: '/pau/', start: 0, end: 0.1 });
  return { tokens };
}

export const ttsService = {
  name: 'tts',
  handle() { return undefined; },
  handleHttp(method, path, body) {
    let b = {};
    try { b = typeof body === 'string' ? JSON.parse(body) : (body || {}); } catch (_) { /* leave empty */ }
    // Word + punctuation tokens for the NL parser. Each comma / period /
    // question mark / exclamation comes through as its own array entry so
    // the parser can detect sentence ends and connectors. Result shape
    // matches the on-device contract: { tokens: string[] }.
    if (/\/tts_lex/.test(path)) {
      return { status: 200, body: { tokens: _lexTokens(b.text) } };
    }
    // POS tags. No real POS model in-browser, so default content words to
    // NN, flag conjunctions as CC (the parser uses CC entries as PART
    // boundaries inside a sentence), and pass punctuation through as its
    // own POS so the parser recognises sentence ends.
    if (/\/tts_pos_tagging/.test(path)) {
      const tokens = Array.isArray(b.tokens) ? b.tokens : [];
      return { status: 200, body: { tokentags: tokens.map((t) => [String(t), _posTag(String(t))]) } };
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
