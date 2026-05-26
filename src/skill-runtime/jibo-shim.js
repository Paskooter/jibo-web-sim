// In-iframe `jibo` shim. Runs inside the sandboxed skill iframe and exposes a
// subset of the public Jibo API, proxying calls to host-side services over
// postMessage (see src/bridge/host-bridge.js for the protocol + the host end).
//
// API shape mirrors sdk-archive/jibo (the runtime skills consume):
//   jibo.init(display?, cb)         — set up the face, then call back
//   jibo.tts.speak(text, opts?, cb?) / stop(cb?) / on(event, fn)
//   jibo.nlu.parseFromRule / parseFromURI / compile  (callback or promise)
//   jibo.face.lookAt / lookForward / blink / setColor   (local: the eye)
//   jibo.RunMode / jibo.runMode / jibo.version
//
// Async methods accept a trailing node-style callback OR return a Promise,
// matching the original overloaded signatures.

import { createEye } from './face-eye.js';
import { createSound } from './sound.js';

let nextId = 1;
const pendingCalls = new Map();          // id -> { resolve, reject }
const emitters = new Map();              // ns -> Map(event -> Set<fn>)

function rawCall(ns, method, args) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pendingCalls.set(id, { resolve, reject });
    parent.postMessage({ __jibo: true, kind: 'call', id, ns, method, args }, '*');
  });
}

function listenersFor(ns, event) {
  if (!emitters.has(ns)) emitters.set(ns, new Map());
  const m = emitters.get(ns);
  if (!m.has(event)) m.set(event, new Set());
  return m.get(event);
}
function on(ns, event, fn) { listenersFor(ns, event).add(fn); }
function off(ns, event, fn) { listenersFor(ns, event).delete(fn); }
function dispatch(ns, event, data) {
  const m = emitters.get(ns);
  const set = m && m.get(event);
  if (set) for (const fn of [...set]) fn(data);
}

window.addEventListener('message', (ev) => {
  if (ev.source !== parent) return;
  const msg = ev.data;
  if (!msg || msg.__jibo !== true) return;
  if (msg.kind === 'reply') {
    const p = pendingCalls.get(msg.id);
    if (!p) return;
    pendingCalls.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error));
  } else if (msg.kind === 'event') {
    dispatch(msg.ns, msg.event, msg.data);
  }
});

export function installJiboShim() {
  let eye = null;
  let session = null;
  const sound = createSound();   // client-side audio, local to the iframe

  // notifications: skill creates them; the host shows the banner.
  const notifications = {
    create(note, cb) {
      const p = rawCall('notifications', 'create', [note]);
      if (cb) { p.then(() => cb(), (e) => cb(e)); return; }
      return p;
    },
    on: (event, fn) => on('notifications', event, fn),
    off: (event, fn) => off('notifications', event, fn),
  };

  // TTS start/stop events drive the talking animation on the eye.
  on('tts', 'start', () => { if (eye) eye.setTalking(true); });
  on('tts', 'stop', () => { if (eye) eye.setTalking(false); });

  // 'face' events let the host (animation playback) drive the eye.
  on('face', 'look', (d) => { if (eye) eye.lookAt(d.x, d.y); });
  on('face', 'color', (d) => { if (eye) eye.setColor(d.hex); });
  on('face', 'blink', () => { if (eye) eye.blink(); });

  const tts = {
    speak(text, options, cb) {
      if (typeof options === 'function') { cb = options; options = undefined; }
      const p = rawCall('tts', 'speak', [text, options]);
      if (cb) { p.then(() => cb(), (e) => cb(e)); return; }
      return p;
    },
    stop(cb) {
      const p = rawCall('tts', 'stop', []);
      if (cb) { p.then(() => cb(), (e) => cb(e)); return; }
      return p;
    },
    on: (event, fn) => on('tts', event, fn),
    off: (event, fn) => off('tts', event, fn),
  };

  const nlu = {
    parseFromRule(rule, text, cb) {
      const p = rawCall('nlu', 'parseFromRule', [rule, text]);
      if (cb) { p.then((r) => cb(null, r), (e) => cb(String(e))); return; }
      return p;
    },
    parseFromURI(uri, text, cb) {
      const p = rawCall('nlu', 'parseFromURI', [uri, text]);
      if (cb) { p.then((r) => cb(null, r), (e) => cb(String(e))); return; }
      return p;
    },
    compile(rule, cb) {
      const p = rawCall('nlu', 'compile', [rule]);
      if (cb) { p.then((uri) => cb(null, uri), (e) => cb(String(e))); return; }
      return p;
    },
  };

  // Recognized speech arrives as 'asr' 'speech' events from the host.
  const asr = {
    on: (event, fn) => on('asr', event, fn),
    off: (event, fn) => off('asr', event, fn),
  };

  // Local Perceptual Space: look-at targets around Jibo. 'target' /
  // 'target-lost' events arrive from the host; getTarget() queries the current.
  const lps = {
    on: (event, fn) => on('lps', event, fn),
    off: (event, fn) => off('lps', event, fn),
    getTarget(cb) {
      const p = rawCall('lps', 'getTarget', []);
      if (cb) { p.then((r) => cb(null, r), (e) => cb(e)); return; }
      return p;
    },
    getClosestAudibleEntity(cb) {
      const p = rawCall('lps', 'getClosestAudibleEntity', []);
      if (cb) { p.then((r) => cb(null, r), (e) => cb(e)); return; }
      return p;
    },
  };

  // The face/eye renders locally in this iframe (no bridge round-trip needed).
  const face = {
    get eye() { return eye; },
    lookAt(x, y) { if (eye) eye.lookAt(x, y); },
    lookForward() { if (eye) eye.lookAt(0, 0); },
    blink() { if (eye) eye.blink(); },
    setColor(hex) { if (eye) eye.setColor(hex); },
  };

  // Keyframed body/LED/eye animation, played host-side on the rig.
  const animate = {
    play(name, options, cb) {
      if (typeof options === 'function') { cb = options; options = undefined; }
      const p = rawCall('animate', 'play', [name, options]);
      if (cb) { p.then(() => cb(), (e) => cb(e)); return; }
      return p;
    },
    stop(cb) {
      const p = rawCall('animate', 'stop', []);
      if (cb) { p.then(() => cb(), (e) => cb(e)); return; }
      return p;
    },
    setLEDColor(r, g, b) { rawCall('animate', 'setLEDColor', [r, g, b]); },
    blink() { if (eye) eye.blink(); },
  };

  function resolveDisplay(arg) {
    if (arg && arg.display) arg = arg.display;
    if (typeof arg === 'string') return document.getElementById(arg) || document.body;
    if (arg instanceof HTMLElement) return arg;
    return document.body;
  }

  function init(arg, cb) {
    if (typeof arg === 'function') { cb = arg; arg = undefined; }
    rawCall('session', 'init', []).then((s) => {
      session = s;
      eye = createEye(resolveDisplay(arg), s.face);
      if (cb) cb();
    }, (err) => { if (cb) cb(err); });
  }

  const jibo = {
    init,
    tts,
    nlu,
    asr,
    lps,
    face,
    animate,
    sound,
    notifications,
    RunMode: { SIMULATOR: 'simulator', REMOTELY: 'remotely', ON_ROBOT: 'on-robot', UNIT_TESTS: 'unit-tests' },
    get runMode() { return session ? session.runMode : 'simulator'; },
    version: '0.0.0-websim',
  };

  // Announce readiness so the host flushes any queued events to us.
  parent.postMessage({ __jibo: true, kind: 'hello' }, '*');
  return jibo;
}
