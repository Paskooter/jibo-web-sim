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

// The expression-service RPC methods route through a RemoteClient that never
// connects offline (UNIT_TESTS), so calls throw on `_client.send`. We drive the
// eye locally instead, so replace those methods with resolving local no-ops and
// make the events/feature surface tolerant — letting jibo-be's boot proceed.
const EXPRESSION_METHODS = [
  'createAnimation', 'createAndPlayAnimation', 'destroyCaches', 'acquireTarget',
  'setAttentionMode', 'pushAttentionMode', 'popAttentionMode', 'getAttentionMode',
  'setLEDColor', 'awaitFace', 'centerRobot', 'cleanup', 'indexRobot', 'setSkillRoot',
  'blink', 'doCenterRobotOnDisconnect', 'lookAt', 'subscribe', 'unsubscribe',
];
export function installExpressionStubs(jibo) {
  try {
    const ex = jibo && jibo.expression;
    if (!ex || ex.__stubbed) return;
    ex.__stubbed = true;
    for (const m of EXPRESSION_METHODS) {
      if (typeof ex[m] === 'function' || ex[m] === undefined) ex[m] = () => Promise.resolve(tolerant());
    }
    // events/features are normally set during the (skipped) expression init.
    if (!ex.events) ex.events = { dofs: { on() {}, off() {} }, kinematics: { on() {}, off() {} } };
    if (!ex.features) ex.features = tolerant();
  } catch (e) { console.warn('[live-eye] installExpressionStubs failed:', e.message); }
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

// Show the real idle eye. The shared asset loader is saturated by jibo-be's animation
// preload, so the eye's own default textures never finish loading; we load them
// directly via PIXI and apply them to the eye layers. We also force the EyeContainer
// onto the FaceRenderer's stage (it's otherwise parented to an inactive view), drive
// the idle pose + render each frame, and remove jibo-be's HTML splash.
export function driveEye(jibo, prep) {
  console.log('[live-eye] driving real eye with idle DOFs');
  const dofs = prep.dofs;
  const tex = prep.tex || {};
  const meta = { sourceTimes: {} };
  const PIXI = typeof window !== 'undefined' && window.PIXI;
  const load = (url) => (PIXI && url ? (PIXI.Texture.fromImage ? PIXI.Texture.fromImage(url) : PIXI.Texture.from(url)) : null);
  let ready = false;
  const ensureReady = () => {
    const eye = jibo.face && jibo.face.eye;
    if (ready || !eye || !PIXI || !jibo.face.stage) return ready;
    try {
      // Apply textures directly to the layers (bypassing the saturated loader).
      if (eye.eye && eye.eye.init) eye.eye.init(load(tex.eye));
      if (eye.eyeOverlay && eye.eyeOverlay.init) eye.eyeOverlay.init(load(tex.overlay));
      if (eye.background && eye.background.init) eye.background.init(load(tex.bg));
      jibo.face.stage.addChild(eye);     // PIXI reparents it onto the rendered stage
      eye.active = true;
      if (jibo.timer && jibo.timer.start) jibo.timer.start();
      jibo.face.paused = false;
      ready = true;
      console.log('[live-eye] eye textures applied + mounted on stage');
    } catch (e) { console.warn('[live-eye] ensureReady:', e.message); }
    return ready;
  };
  const tick = () => {
    const eye = jibo.face && jibo.face.eye;
    if (eye && eye.display) {
      ensureReady();
      // jibo-be's view manager keeps hiding the eye + reparenting it off the stage
      // (its eye-view never activates offline), so re-assert every frame.
      if (ready) {
        if (eye.parent !== jibo.face.stage) jibo.face.stage.addChild(eye);
        eye.visible = true;
        eye.connected = true;
        if (jibo.face.paused) jibo.face.paused = false;
      }
      // Subtle "alive" idle bob (also keeps DOFs changing so the dirty-check re-draws).
      const t = performance.now() / 1000;
      const frame = Object.assign({}, dofs);
      frame.eyeSubRootBn_t_2 = (dofs.eyeSubRootBn_t_2 || 0) + Math.sin(t * 1.2) * 0.0015;
      try {
        eye.display(performance.now(), frame, meta);
        eye.visible = true;   // Eye.display can reset visibility from DOFs; force it on
        if (jibo.face.render && jibo.face.stage) jibo.face.render(jibo.face.stage);
      } catch (_) { /* eye not ready */ }
    }
    requestAnimationFrame(tick);
  };
  tick();
  const dropSplash = () => { const s = typeof document !== 'undefined' && document.getElementById('splash'); if (s) { s.remove(); console.log('[live-eye] removed splash'); } };
  setTimeout(dropSplash, 3000);
  setTimeout(dropSplash, 7000);
}
