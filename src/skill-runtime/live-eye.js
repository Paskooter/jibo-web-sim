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

// A value that is await-able (resolves), callable, and tolerant on any property —
// stands in for expression-service results (AnimationInstance, handles, …) so
// jibo-be's awaited expression calls resolve instead of hanging/throwing.
function tolerant() {
  const fn = function () { return tolerant(); };
  return new Proxy(fn, {
    get(t, p) {
      if (p === 'then' || p === Symbol.toPrimitive || p === Symbol.iterator) return undefined; // not thenable/iterable
      if (p === 'completed' || p === 'cancelled' || p === 'finished' || p === 'started') return Promise.resolve();
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
// Playback length (ms) of a .keys animation from its computed data
// (`duration` frames / `framerate` fps). The skill paces its flow off the
// animation completing, so this must be the REAL length: too short and a splash
// screen flashes and vanishes before it's seen (Word of the Day "did nothing");
// too long and the skill stalls. Falls back to a sane default if unknown.
function animDurationMs(options) {
  try {
    const d = options && options.data;
    if (d && typeof d.duration === 'number' && d.duration > 0) {
      const fps = (typeof d.framerate === 'number' && d.framerate > 0) ? d.framerate : 30;
      return Math.min(20000, Math.max(150, (d.duration / fps) * 1000));
    }
  } catch (_) { /* fall through */ }
  return 1500;
}

function makeAnimInstance(requireFn, play, options) {
  let Event;
  try { Event = requireFn('jibo-typed-events').Event; } catch (_) { /* fall back to local emitter */ }
  const events = {};
  for (const n of ['general', 'audio', 'pixi', 'holdSafe', 'stopped', 'cancelled', 'rejected', 'started', 'stateChange']) {
    events[n] = makeEmitter(Event, n);
  }
  let stopped = false;
  const emitStopped = () => { if (stopped) return; stopped = true; try { events.stopped.emit(); } catch (_) { /* no listener */ } };
  if (play) {
    Promise.resolve().then(() => { try { events.started.emit(); } catch (_) { /* no listener */ } });
    // The eye renders the .keys locally over its duration; signal completion when
    // that elapses so the playback promise resolves and the skill advances.
    setTimeout(emitStopped, animDurationMs(options));
  }
  const fn = function () { return tolerant(); };
  return new Proxy(fn, {
    get(t, p) {
      if (p === 'events') return events;
      if (p === 'state') return 'INVALID';
      if (p === 'then' || typeof p === 'symbol') return undefined;
      if (p === 'stop' || p === 'destroy' || p === 'cancel') return () => { emitStopped(); return tolerant(); };
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

// Give Jibo a real voice with the browser's built-in Web Speech API. The original
// TTS is a native C++ engine + ~680MB voice model (not browser-runnable), so the
// embodied-dialog speak pipeline can only build timing/visemes offline, never
// audio ("TTS Service is unavailable"). Replace jibo.embodied.speech.speak — the
// MIM speakDelegate — with a SpeechSynthesis-backed speak: strip SSML to plain
// text, utter it, and resolve when it ends so the skill paces to real speech. A
// length-estimated fallback timer guarantees we resolve even when 'end' never
// fires (headless/no audio device), so speaking skills never hang.
export function installWebSpeech(jibo) {
  try {
    const sp = jibo && jibo.embodied && jibo.embodied.speech;
    if (!sp || sp.__webspeech) return;
    sp.__webspeech = true;

    // Speech runs in the HOST window, not here: the skill iframe is sandboxed, so
    // SpeechSynthesis there has no user activation and stays silent. We post the
    // text to the host (main.js), which speaks it and posts 'speak-done' back when
    // it finishes so the skill paces to real speech. A generous length-based
    // fallback resolves if the host never replies (so a skill never hangs).
    let seq = 0;
    const pending = new Map();
    window.addEventListener('message', (ev) => {
      const m = ev.data;
      if (m && m.__jibo === true && m.kind === 'speak-done' && pending.has(m.id)) {
        const fin = pending.get(m.id); pending.delete(m.id); fin();
      }
    });

    sp.speak = function speak(text, _options, _autoRuleConfig) {
      const plain = String(text == null ? '' : text).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      return new Promise((resolve) => {
        if (!plain) { resolve(); return; }
        const id = ++seq;
        let done = false;
        const fin = () => { if (done) return; done = true; pending.delete(id); clearTimeout(timer); resolve(); };
        pending.set(id, fin);
        const estMs = Math.min(30000, Math.max(900, plain.length * 75 + 700));
        const timer = setTimeout(fin, estMs + 4000); // safety net; the host's 'end' normally resolves first
        try { parent.postMessage({ __jibo: true, kind: 'speak', id, text: plain }, '*'); } catch (_) { fin(); }
      });
    };
    sp.stop = function stop() {
      try { parent.postMessage({ __jibo: true, kind: 'speak-stop' }, '*'); } catch (_) { /* no parent */ }
      return Promise.resolve();
    };
    console.log('[live-eye] Web Speech routed to host window');
  } catch (e) { console.warn('[live-eye] installWebSpeech failed:', e.message); }
}

// When a backend server is configured in the host UI (window.__JIBO_SERVER__),
// connect the jetstream cloud client to it. jibo-be skips jetstream init under
// UNIT_TESTS (and hardcodes localhost), so init the shared @jibo/jetstream-client
// api ourselves, pointed at the server's jetstream — ws://<server>:8090/events,
// which the cjs-require fake-ws passthrough routes to a real browser WebSocket.
// This brings up cloud dialog / Hey-Jibo (and GQA where pegasus routes it here).
export function connectCloud(requireFn) {
  const server = (typeof window !== 'undefined' && window.__JIBO_SERVER__) || '';
  if (!server) return;
  try {
    const js = requireFn('@jibo/jetstream-client');
    // init lives on `.api` (what jibo-be's JetstreamPlugin uses); fall back to top-level.
    const api = (js && js.api && typeof js.api.init === 'function') ? js.api : js;
    if (!api || typeof api.init !== 'function') { console.warn('[cloud] jetstream-client has no init'); return; }
    console.log('[cloud] connecting jetstream to', `${server}:8090`);
    Promise.resolve(api.init({ hostname: server, port: 8090 }))
      .then(() => console.log('[cloud] jetstream connected to', `${server}:8090`))
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
  try {
    if (jibo && jibo.action && jibo.action.init && !jibo.action.__inited) {
      jibo.action.__inited = true;
      const r = jibo.action.init({ jibo });
      if (r && typeof r.catch === 'function') r.catch((e) => console.warn('[live-eye] action.init:', e && e.message));
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
      if (eye.display) { try { eye.display(performance.now(), frame, meta); } catch (_) { /* eye not ready */ } }
    }
    requestAnimationFrame(tick);
  };
  tick();
}
