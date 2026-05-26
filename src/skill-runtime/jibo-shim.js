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
import { createBt } from './bt.js';
import { createFlow } from './flow.js';
import { createKb } from './kb.js';
import { createTimer, createUtils, createLoader, createLifecycle, createVersions } from './runtime-extras.js';

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

// A callable, infinitely-chainable no-op — lets original bundles touch runtime
// namespaces we don't implement (jibo.action, jibo.embodied, jibo.gl, …)
// without throwing, so they can load and degrade rather than crash.
function tolerantStub() {
  const fn = function () {};
  return new Proxy(fn, {
    get(target, prop) {
      // Act as a resolved promise (many jibo APIs return one); resolve with
      // undefined — NOT another stub — to avoid infinite promise-chaining.
      if (prop === 'then') return (onF) => { if (typeof onF === 'function') { try { onF(undefined); } catch (_) { /* ignore */ } } return tolerantStub(); };
      if (prop === 'catch') return () => tolerantStub();
      if (prop === 'finally') return (onF) => { if (typeof onF === 'function') { try { onF(); } catch (_) { /* ignore */ } } return tolerantStub(); };
      if (prop === Symbol.toPrimitive || prop === 'toString' || prop === 'valueOf') return () => '';
      if (typeof prop === 'symbol') return undefined;
      if (prop in target) return target[prop];
      return tolerantStub();
    },
    apply() { return tolerantStub(); },     // chainable: foo().bar().baz won't throw
    construct() { return tolerantStub(); },
  });
}

export function installJiboShim() {
  let eye = null;
  let session = null;
  let talking = false;
  const sound = createSound();   // client-side audio, local to the iframe
  const kb = createKb();         // knowledge base + loop, local to the iframe
  const timer = createTimer();   // 'update' heartbeat
  const utils = createUtils();   // DelayedCall, PathUtils
  const loader = createLoader(sound);
  const lifecycle = createLifecycle();
  const versions = createVersions();

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
  on('tts', 'start', () => { talking = true; if (eye) eye.setTalking(true); });
  on('tts', 'stop', () => { talking = false; if (eye) eye.setTalking(false); });

  // 'face' events let the host (animation playback) drive the eye.
  on('face', 'look', (d) => { if (eye) eye.lookAt(d.x, d.y); });
  on('face', 'color', (d) => { if (eye) eye.setColor(d.hex); });
  on('face', 'blink', () => { if (eye) eye.blink(); });

  // Screen touch (host raycasts a tap on the face) -> face gestures + reaction.
  const gestureHandlers = [];
  on('face', 'touch', (d) => {
    if (eye) { eye.lookAt((d.x / 1280 - 0.5) * 2, (d.y / 720 - 0.5) * 2); eye.blink(); }
    const ev = { type: 'tap', center: { x: d.x, y: d.y } };
    for (const h of gestureHandlers.slice()) if (h.type === 'tap') h.cb(ev);
  });
  // jibo.face.gestures.addStageGesture(displayObject, hammerType, opts, cb).
  // Accepts (type, cb) too; Hammer types are normalized to a string.
  const gestures = {
    addStageGesture(target, type, opts, cb) {
      if (typeof target === 'function') { cb = target; type = 'tap'; }
      else if (typeof target === 'string' && typeof type === 'function') { cb = type; type = target; }
      const name = typeof type === 'string' ? type.toLowerCase() : 'tap';
      const handle = { type: name.indexOf('tap') >= 0 || name === 'press' ? 'tap' : name, cb };
      gestureHandlers.push(handle);
      return handle;
    },
    removeStageGesture(handle) {
      const i = gestureHandlers.indexOf(handle);
      if (i >= 0) gestureHandlers.splice(i, 1);
    },
  };

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
    get isTalking() { return talking; },
    isInitialized: true,
    TTSEvents: { WORD: 'word', PHONE: 'phone', STOP: 'stop', EFFECT: 'effect', ANALYSIS: 'analysis' },
    TTSMode: { SSML: 'ssml', TEXT: 'text' },
    getWordTimings(text, options, cb) {
      if (typeof options === 'function') { cb = options; options = undefined; }
      const words = String(text).trim().split(/\s+/).filter(Boolean);
      let t = 0;
      const tokens = words.map((w) => { const start = t; t += 0.36; return { name: w, start, end: t }; });
      const result = { tokentimes: { tokens } };
      if (cb) { cb(null, result); return undefined; }
      return Promise.resolve(result);
    },
    startEffect() {}, stopEffect() {}, updateEffect() {},
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
    CameraID: { LEFT: 0, RIGHT: 1 },
    PhotoType: { FULL: 'full', THUMBNAIL: 'thumbnail' },
    // takePhoto(photoRes, noDistort, cameraID, photoType, callback) -> url
    takePhoto(photoRes, noDistort, cameraID, photoType, callback) {
      const args = [photoRes, noDistort, cameraID, photoType].filter((a) => typeof a !== 'function');
      const cb = [photoRes, noDistort, cameraID, photoType, callback].find((a) => typeof a === 'function');
      const p = rawCall('lps', 'takePhoto', args);
      if (cb) { p.then((r) => cb(null, r.url), (e) => cb(String(e))); return; }
      return p;
    },
  };

  // The face/eye renders locally in this iframe (no bridge round-trip needed).
  const face = {
    get eye() { return eye; },
    gestures,
    lookAt(x, y) { if (eye) eye.lookAt(x, y); },
    lookForward() { if (eye) eye.lookAt(0, 0); },
    blink() { if (eye) eye.blink(); },
    setColor(hex) { if (eye) eye.setColor(hex); },
  };

  // jibo.media — photo storage (callback/promise; bridged to the host).
  const media = {
    getUrlById(id, cb) {
      const p = rawCall('media', 'getUrlById', [id]);
      if (cb) { p.then((r) => cb(null, r), (e) => cb(e)); return; }
      return p;
    },
    getPhoto(id, cb) {
      const p = rawCall('media', 'getPhoto', [id]);
      if (cb) { p.then((r) => cb(null, r), (e) => cb(e)); return; }
      return p;
    },
    storePhoto(buffer, thumbnails, cb) {
      const result = { id: `photo-${Date.now()}`, thumbnails: {} };
      if (cb) { cb(null, result); return undefined; }
      return Promise.resolve(result);
    },
    recording: null,
    startRecording(options, cb) { if (cb) cb(new Error('recording not supported in web sim')); },
    stopRecording(cb) { if (cb) cb(null); },
    playRecording(options, cb) { if (cb) cb(null); },
  };

  // jibo.mim — multimodal-interaction manager surface (the Mim/Menu behaviors
  // do the work; this exposes the manager config skills may reference).
  const mim = {
    ListenMode: { NORMAL: 'NORMAL', OPTIONAL_RESPONSE: 'OPTIONAL_RESPONSE', NO_BODY: 'NO_BODY', UI: 'UI' },
    listenDelegate: null,
    speakDelegate: null,
    timeoutIgnoresSimulator: false,
  };

  // jibo.system — device info. Static mock values in the web sim.
  const system = {
    pluggedIn: true,
    batteryCharging: true,
    batteryChargeRate: 0,
    inputEnergy: { ts: [0, 0], db_rms: -90, db_high: -90, db_mid: -90, db_low: -90 },
    getBatteryTemperature: () => 27,
    getBatteryLevel: () => 100,
    getSystemVoltage: () => 12.0,
    getMainBoardTemperature: () => 40,
    getCPUTemperature: () => 45,
    getTouchState: () => ({ changed: [], pad_state: [false, false, false, false, false, false] }),
    getFanSpeed: (cb) => cb && cb(null, 0),
    getBacklight: (cb) => cb && cb(null, 100),
    setBacklight: (v, cb) => cb && cb(null),
    getMasterVolume: (cb) => cb && cb(null, 100),
    setMasterVolume: (v, cb) => cb && cb(null),
    index: (cb) => cb && cb(null),
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
    // Point Jibo at a world target; resolves/cb when the look settles.
    lookAt(point, options, cb) {
      if (typeof options === 'function') { cb = options; options = undefined; }
      const p = rawCall('animate', 'lookAt', [point]);
      if (cb) { p.then(() => cb(), (e) => cb(e)); return; }
      return p;
    },
    // Spec-shaped look-at builder (jibo.animate.createLookatBuilder()).
    createLookatBuilder() {
      const handlers = {};
      const fire = (ev) => (handlers[ev] || []).forEach((f) => f());
      return {
        setContinuousMode() { return this; },
        startLookat(vec) {
          rawCall('animate', 'lookAt', [vec]).then(() => { fire('TARGET_REACHED'); fire('STOPPED'); });
          return { updateTarget: (v) => rawCall('animate', 'lookAt', [v]), stop() {} };
        },
        on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return this; },
      };
    },
    // Spec-shaped animation builder; .play() returns an instance you can listen
    // to. The uri is an animation name/path passed to play().
    createAnimationBuilder(uri, cb) {
      const builder = {
        setConfig() { return this; },
        play() {
          const handlers = {};
          const instance = {
            on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return instance; },
            stop() { rawCall('animate', 'stop', []); },
          };
          rawCall('animate', 'play', [uri]).then(() => (handlers.STOPPED || []).forEach((f) => f()));
          return instance;
        },
      };
      if (cb) { cb(null, builder); return undefined; }
      return builder;
    },
    setEyeVisible(v) { if (eye && eye.setVisible) eye.setVisible(v); },
    setEyeScale(s) { if (eye && eye.setScale) eye.setScale(s); },
    getRobotInfo() { return { dofs: ['bottomSection_r', 'middleSection_r', 'topSection_r'] }; },
    getClock() { return { now: () => performance.now() / 1000 }; },
    dofs: { ALL: 'all', BASE: 'base', BODY: 'body', EYE: 'eye', LED: 'led', OVERLAY: 'overlay', SCREEN: 'screen' },
    AnimationEventType: { STARTED: 'STARTED', STOPPED: 'STOPPED', CANCELLED: 'CANCELLED', EVENT: 'EVENT' },
    LookatEventType: { STARTED: 'STARTED', TARGET_REACHED: 'TARGET_REACHED', TARGET_SUPERSEDED: 'TARGET_SUPERSEDED', STOPPED: 'STOPPED', CANCELLED: 'CANCELLED' },
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
    media,
    system,
    kb,
    mim,
    timer,
    utils,
    loader,
    lifecycle,
    versions,
    RunMode: { SIMULATOR: 'simulator', REMOTELY: 'remotely', ON_ROBOT: 'on-robot', UNIT_TESTS: 'unit-tests' },
    get runMode() { return session ? session.runMode : 'simulator'; },
    version: '0.0.0-websim',
  };

  // Behavior trees + flows run client-side; their leaves call the services above
  // (built on the real `jibo`, not the tolerant proxy below).
  jibo.bt = createBt(jibo);
  jibo.flow = createFlow(jibo);

  // Announce readiness so the host flushes any queued events to us.
  parent.postMessage({ __jibo: true, kind: 'hello' }, '*');

  // Hand skills a tolerant view: implemented members are real; any other
  // namespace an original bundle reaches for (jibo.action, jibo.embodied,
  // jibo.expression, jibo.gl, …) becomes a chainable no-op instead of crashing.
  return new Proxy(jibo, {
    get(t, p) {
      if (p in t || typeof p === 'symbol') return Reflect.get(t, p);
      return tolerantStub();
    },
  });
}
