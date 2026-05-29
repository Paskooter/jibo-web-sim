// Local eye/DOF support for the real jibo runtime.
//
// On a real Jibo the eye's DOF stream + DOF metadata come from the robot's
// expression service. That service is unavailable offline, so we reproduce the
// parts the runtime/skills need, using animation-utilities (the same library the
// service is built on, bundled with the skill):
//   - populateExpressionDofs(): the DOFSet groups jibo.expression.dofs.* that the
//     embodied-dialog layer reads at init (otherwise it throws on `.ALL`).
//   - driveEye(): stream a sampled idle pose into the real PixiJS eye so it
//     renders instead of staying blank.

// The DOFSet group names the expression client builds (jibo-expression-client DOFs.js).
const DOF_SET_NAMES = [
  'ALL', 'BASE', 'BODY', 'EYE', 'LED', 'OVERLAY', 'SCREEN',
  'EYE_ROOT', 'EYE_DEFORM', 'EYE_RENDER', 'EYE_TRANSLATE', 'EYE_ROTATE', 'EYE_COLOR', 'EYE_TEXTURE', 'EYE_VISIBILITY',
  'OVERLAY_ROOT', 'OVERLAY_DEFORM', 'OVERLAY_RENDER', 'OVERLAY_TRANSLATE', 'OVERLAY_ROTATE', 'OVERLAY_COLOR', 'OVERLAY_TEXTURE', 'OVERLAY_VISIBILITY',
  'SCREEN_BG_RENDER', 'SCREEN_BG_COLOR', 'SCREEN_BG_TEXTURE',
];

// Linear-interpolate a .anim channel set (content.channels[] of {dofName,times,values}) at time t.
function sampleAnim(animJson, t) {
  const out = {};
  for (const ch of animJson.content.channels) {
    const T = ch.times;
    const V = ch.values;
    let v;
    if (t <= T[0]) v = V[0];
    else if (t >= T[T.length - 1]) v = V[V.length - 1];
    else {
      for (let i = 0; i < T.length - 1; i += 1) {
        if (t >= T[i] && t <= T[i + 1]) { const f = (t - T[i]) / (T[i + 1] - T[i]); v = V[i] + f * (V[i + 1] - V[i]); break; }
      }
    }
    out[ch.dofName] = v;
  }
  return out;
}

// Load the real eye config + idle pose once, up front. Returns null on failure.
export async function prepareLiveEye(requireFn, skillDir) {
  let anim;
  try { anim = requireFn('animation-utilities'); } catch (e) { console.warn('[live-eye] no animation-utilities:', e.message); return null; }
  if (!anim || !anim.JiboConfig || !anim.RobotInfo) return null;

  const base = `${location.origin}${skillDir}/node_modules/animation-utilities/res/geometry-config/`;
  const tdir = `${base}P1.0/textures/`;

  // Patch JiboConfig so callers that construct it with no args (notably
  // jibo-expression-client/createDOFs) get a usable HTTP base URL instead of
  // falling back to find-root(__dirname) — which in the browser bundle resolves
  // to the page origin without a protocol, and FileTools.loadText then forces
  // `file:` and gets browser-blocked ("Not allowed to load local resource").
  // Wrap the constructor so callers that DO pass a base keep their behavior.
  if (!anim.JiboConfig.__webPatched) {
    const Real = anim.JiboConfig;
    const Patched = function JiboConfig(baseGeometryURL, robotVersion) {
      return new Real(baseGeometryURL || base, robotVersion);
    };
    Patched.__webPatched = true;
    Patched.prototype = Real.prototype;
    anim.JiboConfig = Patched;
  }

  let idleAnim = null;
  try { idleAnim = await fetch(`${base}P1.0/jibo_default.anim`).then((r) => r.json()); } catch (_) { /* optional */ }

  const robotInfo = await new Promise((res) => {
    try { anim.RobotInfo.createInfo(new anim.JiboConfig(base), res); } catch (e) { console.warn('[live-eye] RobotInfo failed:', e.message); res(null); }
  });
  if (!robotInfo) return null;

  const dofs = Object.assign({}, robotInfo.getDefaultDOFValues(), idleAnim ? sampleAnim(idleAnim, 0) : {});
  const tex = { eye: `${tdir}Default_Eye.png`, overlay: `${tdir}JiBO_eye_customizer_44.png`, bg: `${tdir}JiBO_BG_00.png` };
  // Texture-infix DOFs are numeric in keyframes but the renderer wants path strings.
  dofs.eyeTextureInfixBn_r = tex.eye;
  dofs.overlayTextureInfixBn_r = tex.overlay;
  dofs.screenBGTextureInfixBn_r = tex.bg;

  return { anim, robotInfo, dofs, tex };
}

// Provide jibo.expression.dofs (DOFSet groups) the way the expression service would,
// so embodied-dialog init doesn't crash on undefined. Safe no-op if already set.
export function populateExpressionDofs(jibo, robotInfo) {
  try {
    if (!jibo || !jibo.expression || jibo.expression.dofs) return;
    const dofs = {};
    for (const name of DOF_SET_NAMES) {
      try { dofs[name] = robotInfo.getDOFSet(name); } catch (_) { /* skip unknown group */ }
    }
    jibo.expression.dofs = dofs;
  } catch (e) { console.warn('[live-eye] populateExpressionDofs failed:', e.message); }
}

// Method names on expression-service handles (AttentionHandle / AcquireHandle /
// AwaitFaceHandle / ReleaseHandle) that the embodied-dialog code awaits via
// `Utils.timeout(handle.release(), TIMEOUT)`. Each must RETURN A PROMISE so
// timeout()'s `pr.then(...)` doesn't blow up with "pr.then is not a function".
// See jibo-expression-client ReleaseHandle.release / AnimationInstance.stop —
// all return Promises from sendMessage().
const PROMISE_RETURNING_METHODS = new Set([
  'release', 'cancel', 'stop', 'destroy', 'fastForward', 'play', 'pause',
  'reset', 'finish', 'init', 'open', 'close',
]);

// A value that is await-able (resolves), callable, and tolerant on any property —
// stands in for expression-service results (AnimationInstance, handles, …) so
// jibo-be's awaited expression calls resolve instead of hanging/throwing.
function tolerant() {
  const fn = function () { return tolerant(); };
  return new Proxy(fn, {
    get(t, p) {
      if (p === 'then' || p === Symbol.toPrimitive || p === Symbol.iterator) return undefined; // not thenable/iterable
      if (p === 'completed' || p === 'cancelled' || p === 'finished' || p === 'started') return Promise.resolve();
      if (typeof p === 'string' && PROMISE_RETURNING_METHODS.has(p)) {
        // Real handles return Promise<void> from these. Returning a plain
        // tolerant() proxy here breaks Utils.timeout(pr) — it expects pr.then
        // to be a function.
        return () => Promise.resolve();
      }
      if (typeof p === 'symbol') return undefined;
      return tolerant();
    },
    apply() { return tolerant(); },
    construct() { return tolerant(); },
  });
}

// A minimal event emitter matching jibo-typed-events' Event surface (on/once/
// emit/off). Prefer the real class so the API is exact; fall back if unavailable.
function makeEmitter(Event, name) {
  if (Event) { try { return new Event(name); } catch (_) { /* fall through */ } }
  const hs = new Set();
  return {
    on(h) { hs.add(h); return h; },
    once(h) { const w = (...a) => { hs.delete(w); return h(...a); }; hs.add(w); return w; },
    off(h) { hs.delete(h); },
    removeListener(h) { hs.delete(h); },
    add(h) { hs.add(h); return h; },
    remove(h) { hs.delete(h); },
    emit(d) { for (const h of [...hs]) { try { h(d); } catch (_) { /* handler threw */ } } },
  };
}

// A stand-in for a jibo-expression-client AnimationInstance. The real one carries
// `.events` (an AnimationEvents container of jibo-typed-events Events) that the
// runtime + jibo-anim-db subscribe to (instance.events.{stopped,cancelled,…}.on).
// A plain tolerant() proxy can't serve these — its lifecycle special-casing makes
// `.events.cancelled` a Promise, so `.on`/`.once` aren't functions and the eye
// animation path throws. Give `.events` REAL emitters; everything else stays
// tolerant. On a play, fire `started` then `stopped` (next tick) so the playback's
// completion promise resolves and the skill proceeds instead of awaiting forever.
// Playback length (ms) of a .keys animation from its computed data.
// jibo-keyframes.computeAnimObject output is:
//   { header:{...}, content:{ name, channels:[{dofName, length, times, values}], events } }
// — each channel's `length` is the animation duration in seconds, and the
// last entry of `times[]` is the final keyframe time. Use the max over all
// channels for a sane upper bound; fall back to `data.duration / framerate`
// if some pipeline ships the raw shape; finally 1500ms if everything's
// missing (so a skill never stalls forever).
function animDurationMs(options) {
  try {
    const d = options && options.data;
    if (!d) return 1500;
    // Standard computeAnimObject output: pull from channels.
    const channels = (d.content && Array.isArray(d.content.channels)) ? d.content.channels : null;
    if (channels && channels.length) {
      let maxSec = 0;
      for (const ch of channels) {
        if (typeof ch.length === 'number' && ch.length > maxSec) maxSec = ch.length;
        else if (Array.isArray(ch.times) && ch.times.length) {
          const last = ch.times[ch.times.length - 1];
          if (typeof last === 'number' && last > maxSec) maxSec = last;
        }
      }
      if (maxSec > 0) return Math.min(60000, Math.max(150, maxSec * 1000));
    }
    // Fallback: raw .keys-style { duration, framerate } (in case some path skips computeAnimObject).
    if (typeof d.duration === 'number' && d.duration > 0) {
      const fps = (typeof d.framerate === 'number' && d.framerate > 0) ? d.framerate : 30;
      return Math.min(60000, Math.max(150, (d.duration / fps) * 1000));
    }
  } catch (_) { /* fall through */ }
  return 1500;
}

// Sample one channel at time t (clamped at the ends) — same algorithm as
// src/anim/animation.js sampleChannel, but inlined to keep this module's
// dependency-free posture.
function sampleChannel(times, values, t) {
  const n = times.length;
  if (n === 0) return 0;
  if (t <= times[0]) return values[0];
  if (t >= times[n - 1]) return values[n - 1];
  let i = 1;
  while (i < n && times[i] < t) i++;
  const t0 = times[i - 1], t1 = times[i];
  const a = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
  return values[i - 1] + (values[i] - values[i - 1]) * a;
}

// Drive both the body rig (via window.parent.postMessage 'dofs') and the live
// eye (jibo.face.eye.display) from animation channel data over `durMs`. Stops
// when isStopped() returns true. Body DOFs ('*Section_r', 'led_*') go to the
// host viewport; everything else (eye, screen, overlay) goes to the eye.
// `events` (optional) is the AnimationInstance's events container — the data's
// timed event list (computeAnimObject.content.events) is fired into it as the
// clock crosses each event's time so KeysAnimation.onPlayAudio (subscribed to
// events.audio) triggers Sound.play() at the right beat — without it the
// dance plays visually but is silent.
function startDofPlayback(options, durMs, isStopped, events) {
  const data = options && options.data;
  const channels = (data && data.content && Array.isArray(data.content.channels)) ? data.content.channels : null;
  // Sorted event queue; each entry tracks if it's been fired.
  const timedEvents = (data && data.content && Array.isArray(data.content.events))
    ? data.content.events.slice().sort((a, b) => (a.time || 0) - (b.time || 0))
    : [];
  let nextEventIdx = 0;
  const fireEventsUpTo = (tSec) => {
    while (nextEventIdx < timedEvents.length && (timedEvents[nextEventIdx].time || 0) <= tSec) {
      const ev = timedEvents[nextEventIdx++];
      if (!events) continue;
      try {
        // computeAnimObject's eventName 'play-audio' / 'play-pixi' maps to the
        // emitter names jibo-expression-client.AnimationInstance.onEvent uses:
        //   play-audio  -> events.audio  (KeysAnimation.onPlayAudio -> Sound.play)
        //   play-pixi   -> events.pixi   (PIXI timeline overlay)
        //   HOLD_SAFE   -> events.holdSafe
        if (ev.eventName === 'play-audio' && events.audio && events.audio.emit) {
          events.audio.emit(ev.payload || {});
        } else if (ev.eventName === 'play-pixi' && events.pixi && events.pixi.emit) {
          events.pixi.emit(ev.payload || {});
        } else if (ev.eventName === 'HOLD_SAFE' && events.holdSafe && events.holdSafe.emit) {
          events.holdSafe.emit();
        } else if (events.general && events.general.emit) {
          events.general.emit(ev);
        }
      } catch (_) { /* event listener threw */ }
    }
  };
  // Fire any events at t=0 immediately so an opening play-audio (music tracks
  // typically have AudioEvent at frame 0) starts the very first frame.
  fireEventsUpTo(0);
  if (!channels || channels.length === 0) return;
  // Active animation DOFs are exposed to driveEye() so the eye-tick loop mixes
  // them in alongside the idle pose.
  if (!window.__activeAnimDofs) window.__activeAnimDofs = null;
  const startMs = performance.now();
  const durSec = durMs / 1000;
  const BODY_DOFS = new Set(['bottomSection_r', 'middleSection_r', 'topSection_r', 'led_r', 'led_g', 'led_b']);
  const tick = () => {
    if (isStopped()) { window.__activeAnimDofs = null; return; }
    const elapsedSec = (performance.now() - startMs) / 1000;
    const t = Math.min(elapsedSec, durSec);
    const sampled = {};
    for (const ch of channels) {
      try {
        const name = ch.dofName || ch.dof;
        if (!name) continue;
        sampled[name] = sampleChannel(ch.times || [], ch.values || [], t);
      } catch (_) { /* malformed channel */ }
    }
    // Split into body (post to host) vs eye/screen (apply locally via driveEye).
    const bodyDofs = {};
    let hasBody = false;
    for (const k of Object.keys(sampled)) {
      if (BODY_DOFS.has(k)) { bodyDofs[k] = sampled[k]; hasBody = true; }
    }
    if (hasBody) {
      try { window.parent.postMessage({ __jibo: true, kind: 'dofs', dofs: bodyDofs }, '*'); } catch (_) { /* no parent */ }
    }
    // The eye DOFs are mixed into driveEye's per-frame frame so motion stays
    // composited with the idle bob.
    window.__activeAnimDofs = sampled;
    // Fire any timed events whose time has now elapsed (audio cues etc.)
    fireEventsUpTo(t);
    if (t < durSec) requestAnimationFrame(tick);
    else window.__activeAnimDofs = null;
  };
  requestAnimationFrame(tick);
}

function makeAnimInstance(requireFn, play, options) {
  let Event;
  try { Event = requireFn('jibo-typed-events').Event; } catch (_) { /* fall back to local emitter */ }
  const events = {};
  for (const n of ['general', 'audio', 'pixi', 'holdSafe', 'stopped', 'cancelled', 'rejected', 'started', 'stateChange']) {
    events[n] = makeEmitter(Event, n);
  }
  let stopped = false;
  let started = false;
  let raf = 0;
  const emitStopped = () => {
    if (stopped) return;
    stopped = true;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    try { events.stopped.emit(); } catch (_) { /* no listener */ }
  };
  // Start (or restart) playback: emit `started`, schedule `stopped` for the
  // computed real duration, and kick off body+eye DOF sampling. Used both by
  // the createAndPlayAnimation initial-play (play=true) and the createAnimation
  // + instance.play(...) deferred-play path (where the skill drives playback
  // explicitly after acquiring the instance — most embodied-dialog timelines
  // take this path).
  const startPlayback = () => {
    if (started || stopped) return;
    started = true;
    const dataObj = options && options.data;
    const channels = (dataObj && dataObj.content && Array.isArray(dataObj.content.channels)) ? dataObj.content.channels : null;
    const channelCount = channels ? channels.length : 0;
    const channelDofs = channels ? channels.slice(0, 6).map((c) => c.dofName || c.dof).join(',') : '';
    Promise.resolve().then(() => { try { events.started.emit(); } catch (_) { /* no listener */ } });
    const dur = animDurationMs(options);
    console.log('[live-eye] anim play: src=', (options && options.src) || '<inline>', 'dur=', dur, 'ms ch=', channelCount, channelCount ? '(' + channelDofs + (channels.length > 6 ? ',...' : '') + ')' : '');
    setTimeout(emitStopped, dur);
    // Sample the animation's channels per frame and drive both the host body rig
    // (postMessage 'dofs' for body sections + LED ring) and the local eye (push
    // DOFs into jibo.face.eye.display). options.data is the same shape
    // jibo-keyframes.computeAnimObject produces: { content: { channels: [{ dofName,
    // times, values }] } } — value at time t is a piecewise-linear sample.
    // Pass the events container so the data's timed events (play-audio →
    // music playback via KeysAnimation.onPlayAudio → Sound.play → host audio)
    // fire at the right beat.
    startDofPlayback(options, dur, () => stopped, events);
  };
  if (play) startPlayback();
  const fn = function () { return tolerant(); };
  return new Proxy(fn, {
    get(t, p) {
      if (p === 'events') return events;
      if (p === 'state') return 'INVALID';
      if (p === 'then' || typeof p === 'symbol') return undefined;
      // Real AnimationInstance.play() begins playback; do the same here for
      // animations created via createAnimation() and played explicitly.
      if (p === 'play') return () => { startPlayback(); return Promise.resolve(); };
      if (p === 'stop' || p === 'destroy' || p === 'cancel') return () => { emitStopped(); return Promise.resolve(); };
      if (typeof p === 'string' && PROMISE_RETURNING_METHODS.has(p)) return () => Promise.resolve();
      if (p === 'completed' || p === 'cancelled' || p === 'finished' || p === 'started') return Promise.resolve();
      return tolerant();
    },
    apply() { return tolerant(); },
    construct() { return tolerant(); },
  });
}

// The expression-service RPC methods route through a RemoteClient that never
// connects offline (UNIT_TESTS), so calls throw on `_client.send`. We drive the
// eye locally instead, so replace those methods with resolving local no-ops and
// make the events/feature surface tolerant — letting jibo-be's boot proceed.
// createAnimation/createAndPlayAnimation return a real-enough AnimationInstance
// (above) so the eye-animation path (KeysAnimation/jibo-anim-db) works.
const EXPRESSION_METHODS = [
  'destroyCaches', 'acquireTarget',
  'setAttentionMode', 'pushAttentionMode', 'popAttentionMode', 'getAttentionMode',
  'setLEDColor', 'awaitFace', 'centerRobot', 'cleanup', 'indexRobot', 'setSkillRoot',
  'blink', 'doCenterRobotOnDisconnect', 'lookAt', 'subscribe', 'unsubscribe',
];
export function installExpressionStubs(jibo, requireFn) {
  try {
    const ex = jibo && jibo.expression;
    if (!ex || ex.__stubbed) return;
    ex.__stubbed = true;
    for (const m of EXPRESSION_METHODS) {
      if (typeof ex[m] === 'function' || ex[m] === undefined) ex[m] = () => Promise.resolve(tolerant());
    }
    ex.createAnimation = (opts) => Promise.resolve(makeAnimInstance(requireFn, false, opts));
    ex.createAndPlayAnimation = (opts) => Promise.resolve(makeAnimInstance(requireFn, true, opts));
    // events/features are normally set during the (skipped) expression init.
    if (!ex.events) ex.events = { dofs: { on() {}, off() {} }, kinematics: { on() {}, off() {} } };
    if (!ex.features) ex.features = tolerant();
  } catch (e) { console.warn('[live-eye] installExpressionStubs failed:', e.message); }
}

// (installWebSpeech removed in M45 — the previous override of
// jibo.embodied.speech.speak short-circuited the whole speak pipeline,
// killing word-aligned eye motion + body posture shifts. Web Speech now
// lives behind the /tts_speak HTTP endpoint (services/tts-service.js), so
// the full embodied-dialog timeline drives expression animations against
// real speech timing.)

// When a backend server is configured in the host UI (window.__JIBO_SERVER__),
// connect the jetstream cloud client to it. jibo-be skips jetstream init under
// UNIT_TESTS (and hardcodes localhost), so init the shared @jibo/jetstream-client
// api ourselves, pointed at the Pegasus hub — ws://<server>:9000/events. The
// hub's docker-compose maps host :9000 to container :8080 (Pegasus convention is
// host ports in the 9000+ range; 8080 is internal-network only). cjs-require's
// fake-ws passthrough routes that URL to a real browser WebSocket. Local Pegasus
// has auth disabled by default, so no webTokenSecret is needed here.
export function connectCloud(requireFn) {
  const server = (typeof window !== 'undefined' && window.__JIBO_SERVER__) || '';
  if (!server) return;
  try {
    const js = requireFn('@jibo/jetstream-client');
    // init lives on `.api` (what jibo-be's JetstreamPlugin uses); fall back to top-level.
    const api = (js && js.api && typeof js.api.init === 'function') ? js.api : js;
    if (!api || typeof api.init !== 'function') { console.warn('[cloud] jetstream-client has no init'); return; }
    console.log('[cloud] connecting jetstream to', `${server}:9000`);
    Promise.resolve(api.init({ hostname: server, port: 9000 }))
      .then(() => console.log('[cloud] jetstream connected to', `${server}:9000`))
      .catch((e) => console.warn('[cloud] jetstream connect failed:', (e && e.message) || e));
  } catch (e) { console.warn('[cloud] jetstream init error:', e.message); }
}

// Some service clients initialize internal state (loggers, data converters) in an
// init() that UNIT_TESTS skips, then crash later when used (e.g. the analytics
// path logEvent -> getActiveSpeaker -> DataConverter.mostRecentSpeaker on an
// undefined logger). Initialize those internals directly (no sockets) so skill
// lifecycle events don't throw and the framework can open a skill.
export function initOfflineServices(jibo, requireFn) {
  // (Service transport is now handled by the in-memory service bus — see
  // services/service-bus.js. The remaining patches below cover client-side state
  // that the [absent] service init would normally set up, pending full service ports.)

  // (KB is now backed by the in-memory KnowledgeBase service — services/kb-service.js.)

  // The ServicesPlugin configures all service clients (host:port from records) via
  // ServiceClients.init, but skips it under UNIT_TESTS — so clients have no endpoint
  // and fall back to the page origin (404 HTML). Run it ourselves against the bus
  // records so each client connects to its local service (HTTP/ws/RPC).
  try {
    const SC = requireFn && requireFn('jibo-service-clients');
    if (SC && typeof SC.init === 'function' && jibo.records && !jibo.__clientsInited) {
      jibo.__clientsInited = true;
      SC.init(jibo, jibo.records, () => {}, (initFn) => (cb) => { try { initFn((e, p) => cb()); } catch (_) { cb(); } });
    }
  } catch (e) { console.warn('[live-eye] ServiceClients.init:', e.message); }

  // Configure clients ServiceClients.init doesn't wire from records: the system
  // client's body interface (LED/backlight) and wifi (connection state).
  const recordFor = (name) => (jibo.records || []).find((r) => r.name === name);
  try { const b = recordFor('body'); if (b && jibo.system && jibo.system.initBody) jibo.system.initBody(b, jibo.log, () => {}); } catch (e) { console.warn('[live-eye] system.initBody:', e.message); }
  try { const w = recordFor('wifi'); if (w && jibo.wifi && jibo.wifi.init) jibo.wifi.init(w, jibo.log, () => {}); } catch (e) { console.warn('[live-eye] wifi.init:', e.message); }

  const tryInit = (obj, name) => { try { if (obj && obj.init) obj.init(jibo.log); } catch (e) { console.warn(`[live-eye] ${name}.init:`, e.message); } };
  if (jibo && jibo.lps) { tryInit(jibo.lps.identity, 'lps.identity'); tryInit(jibo.lps.detector, 'lps.detector'); }

  // The action/goal system (jibo-action-system) creates its ActionRuntime singleton
  // in init({jibo}); the ActionPlugin skips this in UNIT_TESTS, leaving _runtime
  // undefined so goals (e.g. BeSkillSwitchGoal) crash on parent.dateProvider. init
  // is local (goal providers + update loop on jibo.timer), so run it ourselves.
  // Plug a noop `proactive` on the runtime after init: jibo-action-system reads
  // pegasusProactiveTrigger from ITS OWN package.json (= false), so
  // `_runtime.proactive` stays null and any skill calling
  // `jibo.action.checkEnvironmentContext()` (e.g. @be/surprises in its open
  // hook) crashes with "Cannot read properties of null (reading
  // 'checkEnvironmentInhibitors')". A noop returning [] keeps the skill alive.
  try {
    if (jibo && jibo.action && jibo.action.init && !jibo.action.__inited) {
      jibo.action.__inited = true;
      const r = jibo.action.init({ jibo });
      const installProactiveStub = () => {
        try {
          const rt = jibo.action._runtime;
          if (rt && !rt.proactive) {
            rt.proactive = {
              checkEnvironmentInhibitors: () => [],
              update: () => {},
              dispose: () => {},
              setDisableProactiveTrigger: () => {},
              init: () => {},
            };
          }
        } catch (_) { /* */ }
      };
      if (r && typeof r.then === 'function') r.then(installProactiveStub, (e) => { console.warn('[live-eye] action.init:', e && e.message); installProactiveStub(); });
      else installProactiveStub();
    }
  } catch (e) { console.warn('[live-eye] action.init:', e.message); }
  // The KB loop is normally set up by the host (the original sim called kb.init +
  // kb.initLoop). jibo-be assumes jibo.kb.loop exists (e.g. analytics
  // listenForLoopChanges reads jibo.kb.loop.events). initLoop is connection-free.
  try {
    if (jibo && jibo.kb) {
      if (jibo.kb.init && !jibo.kb.httpUrl) jibo.kb.init({ host: '127.0.0.1', port: 0 }, () => {});
      if (jibo.kb.initLoop && !jibo.kb.loop) jibo.kb.initLoop();
    }
  } catch (e) { console.warn('[live-eye] kb init:', e.message); }

  // ServicesPlugin (jibo.js) bundles three service-specific init functions —
  // global-manager / kb / remote — and skips ALL of them under UNIT_TESTS. KB
  // is already covered above; here we run the global-manager equivalent so
  // jibo.globalEvents opens its /globals WebSocket (the cloud→skill-switch
  // pipe) against our in-browser GlobalManagerService. Without this, every
  // localTurnResult lands silently — the service has no connected client to
  // broadcast to.
  try {
    const gmRec = recordFor('global-manager');
    if (gmRec && jibo.globalEvents && typeof jibo.globalEvents.init === 'function' && !jibo.__globalEventsInited) {
      jibo.__globalEventsInited = true;
      jibo.globalEvents.init(gmRec, (err) => {
        if (err) console.warn('[live-eye] globalEvents.init:', (err && err.message) || err);
      });
    }
  } catch (e) { console.warn('[live-eye] globalEvents.init:', e.message); }

  // The Media plugin (`jibo.media`) opens a connection to the local
  // media-service in non-UNIT_TESTS. Skill audio playback (sfx, music tracks)
  // queries jibo.media for routing; if init never ran, those calls may NPE
  // when a skill plays back audio. The init is connection-free — it just
  // wires up the in-process Media class — so safe to run.
  try {
    if (jibo.media && typeof jibo.media.init === 'function' && !jibo.media.__inited) {
      jibo.media.__inited = true;
      jibo.media.init(() => {});
    }
  } catch (e) { console.warn('[live-eye] media.init:', e.message); }

  // Audio playback: the sandboxed iframe never gets user activation
  // (sandbox=allow-scripts,allow-same-origin, no allow-user-activation), so
  // its AudioContext stays in 'suspended' state and Web Audio buffer playback
  // is silent. The host window DOES have user activation (Start Jibo gate).
  // Route every Sound.play() through the host: postMessage 'play-sound' with
  // the file URL, host plays via HTMLAudioElement, posts 'sound-done' back
  // when it ends. Mirrors the existing TTS routing.
  try {
    if (jibo.sound && jibo.sound.Sound && jibo.sound.Sound.prototype && !jibo.sound.Sound.prototype.__hostRouted) {
      const Sound = jibo.sound.Sound;
      Sound.prototype.__hostRouted = true;
      const origPlay = Sound.prototype.play;
      let _seq = 0;
      if (!window.__pendingSounds) window.__pendingSounds = new Map();
      // One bridge listener picks up sound-done events from the host.
      if (!window.__soundBridgeInstalled) {
        window.__soundBridgeInstalled = true;
        window.addEventListener('message', (ev) => {
          const m = ev.data;
          if (!m || m.__jibo !== true) return;
          if (m.kind === 'sound-done' && window.__pendingSounds.has(m.id)) {
            const fin = window.__pendingSounds.get(m.id);
            window.__pendingSounds.delete(m.id);
            try { fin(); } catch (_) { /* */ }
          }
        });
      }
      Sound.prototype.play = function play(options) {
        const callOpts = (typeof options === 'function') ? { complete: options } : (options || {});
        const src = this.src;
        // Local Sound class still runs (decoded buffer + chain), but the iframe's
        // AudioContext is suspended so nothing is audible. The HOST plays the
        // file from the same HTTP origin, and we signal complete when it ends.
        try {
          if (typeof src === 'string' && src && typeof window !== 'undefined' && window.parent) {
            const id = ++_seq;
            // Map a bundle path (/external-skills/...) — already HTTP-relative —
            // straight through to the host. If src is absolute file path inside
            // node_modules, rewrite onto our HTTP origin.
            let url = src;
            const i = src.lastIndexOf('/node_modules/');
            if (i >= 0) url = location.origin + src.slice(i);
            else if (src.indexOf('/external-skills/') >= 0) url = location.origin + src.slice(src.indexOf('/external-skills/'));
            else if (src[0] === '/') url = location.origin + src;
            const fin = () => {
              if (callOpts.complete) { try { callOpts.complete(this); } catch (_) { /* */ } }
            };
            window.__pendingSounds.set(id, fin);
            window.parent.postMessage({ __jibo: true, kind: 'play-sound', id, src: url, loop: !!this.loop, volume: this.volume }, '*');
          }
        } catch (e) { console.warn('[live-eye] sound bridge:', e && e.message); }
        // Still run the original local play (sets isPlaying, event timers, etc.)
        // even though it's audibly silent — local consumers may check state.
        return origPlay.call(this, options);
      };
      console.log('[live-eye] Sound.play routed to host window');
    }
  } catch (e) { console.warn('[live-eye] sound routing failed:', e.message); }

  // AnimDB: jibo's AnimDBPlugin (jibo.js:7463) calls `resolveAnimDB(jibo)`
  // which walks node's Module._resolveFilename from process.cwd() to find
  // jibo-anim-db-animations. In the browser that resolver has no usable
  // cwd, so resolveAnimDB returns undefined and the plugin inits an EMPTY
  // AnimDB (the "Module 'jibo-anim-db-animations' not found" warning at
  // boot). With an empty AnimDB, every `<anim cat='dance' filter='&(music)'
  // />` tag in skill prompts resolves to "no matching animations" and gets
  // dropped from the timeline — only the auto-tagger's per-word posture
  // shifts (CommaRule / NounRule etc., with bundled named animations) play,
  // so the dance speak is ~1.5s of background motion and Jibo never
  // actually dances.
  //
  // We can't re-init AFTER the plugin runs (initOfflineServices fires
  // BEFORE jibo.init drives the plugin chain). Instead, monkey-patch
  // animdb.api.init to auto-fill the path when the plugin calls it. Once
  // patched, the plugin's `animdb.api.init(jibo)` becomes
  // `animdb.api.init(jibo, <skill>/node_modules/jibo-anim-db-animations/animdb.json)`
  // and readAndAddAnimCollection walks the ~66000-line manifest (via our
  // cjs-require fs.open/fstat/read shims) and indexes everything by name,
  // category, and meta. Subsequent embodied-dialog queries
  // (`{ categories: ['dance'], includeSomeMeta: ['music'] }`) then return
  // matching animations.
  try {
    if (jibo.animDB && typeof jibo.animDB.init === 'function' && !jibo.animDB.__webPatched) {
      jibo.animDB.__webPatched = true;
      const skillDir = (typeof window !== 'undefined' && window.__SKILL_DIR__) || '';
      const defaultPath = skillDir ? `${skillDir}/node_modules/jibo-anim-db-animations/animdb.json` : '';
      const orig = jibo.animDB.init.bind(jibo.animDB);
      jibo.animDB.init = function patchedInit(jiboArg, animDBPath, ...rest) {
        const path = animDBPath || defaultPath;
        console.log('[live-eye] animDB.init(', !!path ? path : '<empty>', ')');
        const r = orig(jiboArg, path, ...rest);
        if (r && typeof r.then === 'function') {
          r.then(() => {
            try {
              const n = jibo.animDB.getAnimationNames ? jibo.animDB.getAnimationNames().length : -1;
              console.log('[live-eye] animDB indexed animations:', n);
            } catch (_) { /* */ }
          }, (e) => console.warn('[live-eye] animDB.init failed:', e && e.message));
        }
        return r;
      };
    }
  } catch (e) { console.warn('[live-eye] animDB patch failed:', e.message); }

  // Expression plugin: subscribes the local face renderer to the expression
  // service's `dofs` events. Without it, jibo.face.eye won't reflect any
  // cloud-driven expression cues. Connection-free if we just bind the local
  // event handler — see ExpressionPlugin.init's body.
  try {
    if (jibo.expression && typeof jibo.expression.init === 'function' && !jibo.expression.__inited) {
      const expRec = recordFor('expression');
      if (expRec) {
        jibo.expression.__inited = true;
        // The plugin chains .init(port, jibo).then(...) to bind to events.dofs.
        const r = jibo.expression.init(expRec.port, jibo);
        if (r && typeof r.then === 'function') {
          r.then(() => {
            try {
              if (jibo.expression.events && jibo.expression.events.dofs && jibo.face && jibo.face.eye) {
                jibo.expression.events.dofs.on((data) => {
                  try { jibo.face.eye.display(data.timestamp, data.dofValues, data.metadata); }
                  catch (_) { /* eye may not be ready */ }
                });
              }
            } catch (_) { /* */ }
          }).catch((e) => console.warn('[live-eye] expression.init:', e && e.message));
        }
      }
    }
  } catch (e) { console.warn('[live-eye] expression.init:', e.message); }
}

// BeSkill.init chains the framework's plugins and aborts the whole boot if any one
// rejects; several (e.g. 'context', which stands up a jibo-service-framework server)
// can't initialize in the browser. Make the chain tolerant so a failing plugin doesn't
// block the skill launch. Call this only once @be/be-framework is loaded (don't
// force-require it early — that breaks its own load order).
export function patchBeFramework(requireFn) {
  // jibo-be's in-process service servers (e.g. ContextService) extend
  // jibo-service-framework's HTTPService and can't bind a real socket in-browser
  // (init throws). Make the server init resolve without binding — clients reach
  // services through our bus/interceptors, not these servers.
  try {
    const sf = requireFn && requireFn('jibo-service-framework');
    for (const cls of ['HTTPService', 'HTTPWSService', 'HTTPSWSService']) {
      const C = sf && sf[cls];
      if (C && C.prototype && !Object.prototype.hasOwnProperty.call(C.prototype, '__offlineInit')) {
        C.prototype.__offlineInit = true;
        C.prototype.init = function init(callback) { if (callback) setTimeout(() => callback(null), 0); return Promise.resolve(); };
      }
    }
  } catch (e) { console.warn('[live-eye] jibo-service-framework patch:', e.message); }

  try {
    const bf = requireFn && requireFn('@be/be-framework');
    const BeSkill = bf && (bf.BeSkill || bf.default);
    if (BeSkill && BeSkill.init && BeSkill._queuedPlugins && !BeSkill.__tolerantInit) {
      BeSkill.__tolerantInit = true;
      BeSkill.init = function init(done) {
        let pr = Promise.resolve();
        for (const el of BeSkill._queuedPlugins) {
          pr = pr.then(() => new Promise(el.plugin)
            .then((v) => { BeSkill.plugins[el.name] = v; })
            .catch((e) => console.warn('[live-eye] BeSkill plugin failed (skipped):', el.name, e && e.message)));
        }
        pr.then(() => { BeSkill._queuedPlugins = []; done(); }).catch(done);
      };
      return true;
    }
  } catch (e) { console.warn('[live-eye] BeSkill patch:', e.message); }
  return false;
}

// Provide the eye's DOF stream (the expression service the robot would run). The
// real ViewManager owns rendering (it shows the EyeView, MenuView, etc., driven by
// the FaceRenderer's update loop), so we DON'T mount/force anything — we just apply
// the eye's default textures once (the shared loader is saturated by jibo-be's anim
// preload) and stream the idle pose into face.eye.display, exactly as the expression
// service's dofs event would. This lets the eye AND the menu/views render naturally,
// and the EyeView's touch handler reach onTouch -> MainMenu.
export function driveEye(jibo, prep) {
  console.log('[live-eye] streaming idle DOFs to the eye (view-managed)');
  const dofs = prep.dofs;
  const tex = prep.tex || {};
  const meta = { sourceTimes: {} };
  const PIXI = typeof window !== 'undefined' && window.PIXI;
  const load = (url) => (PIXI && url ? (PIXI.Texture.fromImage ? PIXI.Texture.fromImage(url) : PIXI.Texture.from(url)) : null);
  let texApplied = false;
  const tick = () => {
    const eye = jibo.face && jibo.face.eye;
    if (eye) {
      if (!texApplied && PIXI && eye.eye && eye.eye.init) {
        try {
          eye.eye.init(load(tex.eye));
          if (eye.eyeOverlay && eye.eyeOverlay.init) eye.eyeOverlay.init(load(tex.overlay));
          if (eye.background && eye.background.init) eye.background.init(load(tex.bg));
          if (jibo.timer && jibo.timer.start) jibo.timer.start();
          jibo.face.paused = false;
          texApplied = true;
        } catch (_) { /* not ready yet */ }
      }
      // Subtle "alive" idle bob; also keeps the DOFs changing so the dirty-check redraws.
      const t = performance.now() / 1000;
      const frame = Object.assign({}, dofs);
      frame.eyeSubRootBn_t_2 = (dofs.eyeSubRootBn_t_2 || 0) + Math.sin(t * 1.2) * 0.0015;
      // Overlay any active skill-driven animation DOFs (eye/screen/overlay only —
      // body sections go to the host viewport). startDofPlayback() in this file
      // writes into window.__activeAnimDofs; consume them as a per-frame mix-in
      // so the eye actually moves during expression.createAndPlayAnimation.
      const active = window.__activeAnimDofs;
      if (active) {
        for (const k of Object.keys(active)) {
          // Skip body+LED DOFs (handled by the host viewport).
          if (k === 'bottomSection_r' || k === 'middleSection_r' || k === 'topSection_r' ||
              k === 'led_r' || k === 'led_g' || k === 'led_b') continue;
          frame[k] = active[k];
        }
      }
      if (eye.display) { try { eye.display(performance.now(), frame, meta); } catch (_) { /* eye not ready */ } }
    }
    requestAnimationFrame(tick);
  };
  tick();
}
