// Always-on, in-browser wake-word detection ("Hey Jibo").
//
// This is a faithful port of openWakeWord's streaming feature pipeline
// (github.com/dscripka/openWakeWord) running entirely on-device via
// onnxruntime-web — no audio ever leaves the browser. Three tiny ONNX models
// chain together:
//
//   raw 16 kHz audio --[melspectrogram]--> 32-bin mel frames
//                    --[embedding_model]--> 96-dim speech embeddings
//                    --[<wakeword>]-------> detection score in [0, 1]
//
// The wake model (the only phrase-specific piece) is trained separately — see
// assets/wake-word/TRAINING.md. Until you train "hey_jibo", we fall back to the
// stock "hey_jarvis" model so the whole pipeline is exercisable today.
//
// Constants below mirror openWakeWord's AudioFeatures exactly; don't tune them
// without checking that source — they're coupled to the model graphs:
//   - 16 kHz, 1280-sample (80 ms) processing step
//   - mel: input [1, 1760] (1280 + 3*160 lookback), output 8 frames of 32 bins,
//     scaled x/10 + 2 to match the original TF model
//   - embedding: window of 76 mel frames -> one 96-dim vector per step
//   - wake model: a sliding window of N embeddings (16 for the v0.1 models)

import * as ort from 'onnxruntime-web';

const SR = 16000;
const STEP = 1280;            // samples per pipeline step (80 ms)
const MEL_CONTEXT = 160 * 3;  // extra lookback so each step yields a clean 8 frames
const MEL_INPUT = STEP + MEL_CONTEXT;   // 1760
const MEL_BINS = 32;
const EMB_WINDOW = 76;        // mel frames per embedding
const EMB_DIM = 96;
const DEFAULT_WAKE_WINDOW = 16;         // embeddings per wake inference (v0.1 models)

const SHARED_DIR = '/assets/wake-word';
// Phrase-specific heads tried in order; first that exists wins. Train
// hey_jibo.onnx (TRAINING.md) and it takes over automatically.
const WAKE_MODELS = [
  { url: `${SHARED_DIR}/hey_jibo.onnx`, phrase: 'Hey Jibo' },
  { url: `${SHARED_DIR}/hey_jarvis_v0.1.onnx`, phrase: 'Hey Jarvis (stock — train hey_jibo.onnx to replace)' },
];

// onnxruntime-web setup: single-threaded wasm needs no COOP/COEP cross-origin
// isolation, and this workload (≈12 inferences/sec over three sub-megabyte
// models) doesn't want threads anyway. wasmPaths points at the same CDN build
// the importmap pins so the .wasm binary is fetched from one place.
let ortReady = false;
function initOrt() {
  if (ortReady) return;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
  ortReady = true;
}

async function urlExists(url) {
  try {
    const r = await fetch(url, { method: 'HEAD' });
    return r.ok;
  } catch (_) {
    return false;
  }
}

// createWakeWord — owns the mic stream + ONNX sessions. The caller flips it on
// and off (always-on mic is opt-in) and supplies onWake, fired once per detected
// utterance (with a refractory cooldown so one "Hey Jibo" can't double-fire).
//
//   onWake()       -> called when the wake phrase is detected
//   threshold      -> score over which we fire (default 0.5; raise to cut false
//                     accepts, lower if it misses you)
//   cooldownMs     -> minimum gap between fires (default 1500)
//   onStatus(s)    -> optional lifecycle hook: 'loading' | 'listening' |
//                     'stopped' | { error } | { phrase }
//   onScore(score) -> optional per-frame hook with the raw [0,1] score, for a
//                     live confidence meter or threshold tuning (off the hot
//                     path otherwise — nothing is allocated when unset)
export function createWakeWord({ onWake, threshold = 0.5, cooldownMs = 1500, onStatus, onScore } = {}) {
  let melSession = null;
  let embSession = null;
  let wakeSession = null;
  let wakePhrase = null;
  let wakeWindow = DEFAULT_WAKE_WINDOW;

  let audioCtx = null;
  let micStream = null;
  let node = null;
  let running = false;

  // Rolling buffers (mirroring openWakeWord's streaming state).
  let raw = new Float32Array(0);   // recent raw samples, trimmed to MEL_INPUT
  let mel = [];                    // Float32Array(32) frames
  let emb = [];                    // Float32Array(96) vectors

  // Serialize the async pipeline: the worklet posts frames faster than we await
  // three inferences, so queue them and drain one at a time. A runaway backlog
  // (tab was backgrounded, etc.) is dropped rather than allowed to grow.
  const queue = [];
  let pumping = false;
  let lastFire = 0;
  const status = (s) => { try { onStatus && onStatus(s); } catch (_) { /* host hook threw */ } };

  async function loadModels() {
    initOrt();
    const opts = { executionProviders: ['wasm'] };
    [melSession, embSession] = await Promise.all([
      ort.InferenceSession.create(`${SHARED_DIR}/melspectrogram.onnx`, opts),
      ort.InferenceSession.create(`${SHARED_DIR}/embedding_model.onnx`, opts),
    ]);
    let picked = null;
    for (const cand of WAKE_MODELS) {
      if (await urlExists(cand.url)) { picked = cand; break; }
    }
    if (!picked) throw new Error('no wake-word model found in /assets/wake-word');
    wakeSession = await ort.InferenceSession.create(picked.url, opts);
    wakePhrase = picked.phrase;
    // Most v0.1 heads take [1, 16, 96]; honor a fixed window dim if the graph
    // declares one, else keep the 16-embedding default.
    const dim = wakeSession.inputMetadata?.[0]?.dimensions?.[1];
    if (typeof dim === 'number' && dim > 0) wakeWindow = dim;
    console.log(`[wake-word] ready — phrase "${wakePhrase}", window ${wakeWindow} embeddings`);
    status({ phrase: wakePhrase });
  }

  async function step(frame) {
    // 1) Raw ring buffer -> mel. Need MEL_INPUT samples before the first mel.
    const merged = new Float32Array(raw.length + frame.length);
    merged.set(raw); merged.set(frame, raw.length);
    raw = merged.length > MEL_INPUT ? merged.slice(merged.length - MEL_INPUT) : merged;
    if (raw.length < MEL_INPUT) return;

    const melOut = await melSession.run({
      [melSession.inputNames[0]]: new ort.Tensor('float32', raw.slice(), [1, MEL_INPUT]),
    });
    const md = melOut[melSession.outputNames[0]];
    const frames = md.data.length / MEL_BINS;        // 8 for a 1760-sample input
    for (let f = 0; f < frames; f++) {
      const row = new Float32Array(MEL_BINS);
      for (let b = 0; b < MEL_BINS; b++) row[b] = md.data[f * MEL_BINS + b] / 10 + 2;
      mel.push(row);
    }
    if (mel.length > 10 * EMB_WINDOW) mel = mel.slice(mel.length - 10 * EMB_WINDOW);
    if (mel.length < EMB_WINDOW) return;

    // 2) Last 76 mel frames -> one 96-dim embedding.
    const win = new Float32Array(EMB_WINDOW * MEL_BINS);
    const base = mel.length - EMB_WINDOW;
    for (let i = 0; i < EMB_WINDOW; i++) win.set(mel[base + i], i * MEL_BINS);
    const embOut = await embSession.run({
      [embSession.inputNames[0]]: new ort.Tensor('float32', win, [1, EMB_WINDOW, MEL_BINS, 1]),
    });
    emb.push(new Float32Array(embOut[embSession.outputNames[0]].data));  // 96 values
    if (emb.length > 4 * wakeWindow) emb = emb.slice(emb.length - 4 * wakeWindow);
    if (emb.length < wakeWindow) return;

    // 3) Sliding window of embeddings -> wake score.
    const feat = new Float32Array(wakeWindow * EMB_DIM);
    const eb = emb.length - wakeWindow;
    for (let i = 0; i < wakeWindow; i++) feat.set(emb[eb + i], i * EMB_DIM);
    const wakeOut = await wakeSession.run({
      [wakeSession.inputNames[0]]: new ort.Tensor('float32', feat, [1, wakeWindow, EMB_DIM]),
    });
    const score = wakeOut[wakeSession.outputNames[0]].data[0];
    if (onScore) { try { onScore(score); } catch (_) { /* host hook threw */ } }

    const now = performance.now();
    if (score >= threshold && now - lastFire >= cooldownMs) {
      lastFire = now;
      console.log(`[wake-word] "${wakePhrase}" detected (score ${score.toFixed(3)})`);
      try { onWake && onWake(score); } catch (_) { /* host handler threw */ }
    }
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length) {
        if (queue.length > 8) queue.splice(0, queue.length - 8);  // drop stale backlog
        await step(queue.shift());
      }
    } catch (e) {
      console.error('[wake-word] pipeline error', e);
    } finally {
      pumping = false;
    }
  }

  async function start() {
    if (running) return;
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
      status({ error: 'no microphone API (needs a secure context: https or localhost)' });
      return;
    }
    running = true;
    status('loading');
    try {
      if (!wakeSession) await loadModels();
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      // 16 kHz context => the browser resamples the mic for us; the worklet then
      // only has to reframe 128-sample quanta into 1280-sample steps.
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR });
      // Armed at page load (saved setting), before any click, Chrome's autoplay
      // policy can leave the context suspended — resume on the first gesture.
      if (audioCtx.state === 'suspended') {
        const ctx = audioCtx;
        const resume = () => { ctx.resume().catch(() => {}); };
        for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, resume, { once: true, capture: true });
      }
      await audioCtx.audioWorklet.addModule(`${SHARED_DIR}/wake-word-worklet.js`);
      const src = audioCtx.createMediaStreamSource(micStream);
      node = new AudioWorkletNode(audioCtx, 'wake-word-capture');
      node.port.onmessage = (e) => { queue.push(e.data); pump(); };
      src.connect(node);
      // Sink the node so the graph actually pulls audio; muted so the mic isn't
      // echoed to the speakers.
      const mute = audioCtx.createGain();
      mute.gain.value = 0;
      node.connect(mute).connect(audioCtx.destination);
      status('listening');
      console.log(`[wake-word] listening for "${wakePhrase}"`);
    } catch (e) {
      running = false;
      console.error('[wake-word] failed to start', e);
      status({ error: e && e.message ? e.message : String(e) });
      await stop();
    }
  }

  async function stop() {
    running = false;
    queue.length = 0;
    raw = new Float32Array(0); mel = []; emb = [];
    try { node && node.disconnect(); } catch (_) { /* */ }
    node = null;
    try { micStream && micStream.getTracks().forEach((t) => t.stop()); } catch (_) { /* */ }
    micStream = null;
    try { audioCtx && await audioCtx.close(); } catch (_) { /* */ }
    audioCtx = null;
    status('stopped');
  }

  return {
    start,
    stop,
    isRunning: () => running,
    get phrase() { return wakePhrase; },
  };
}
