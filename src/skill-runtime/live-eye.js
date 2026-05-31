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

import { DOFArbiter } from './dof-arbiter.js';

// Singleton — initialized in installExpressionStubs once robotInfo is available
// (we need the DOF universe to seed OwnershipInformation entries). All animation
// playback through createAnimation/createAndPlayAnimation runs through this so
// the priority policy (BargeIn > EmbodiedListen > Behavior/EmbodiedSpeech > etc.)
// actually preempts active animations instead of stacking them.
export const dofArbiter = new DOFArbiter();

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

// Per-body-DOF motion state — port of animation-utilities'
// `PoseOffsetFilter` (animation-utilities.js:16860+). The model:
//
//   applied(t) = anim_value(t) + offset(t)
//
// `offset` starts at (prev_applied - anim_value(0)) so applied(0) =
// prev_applied (no snap) and decays to 0 via an acceleration-limited
// trapezoidal planner. Once offset is 0, applied tracks anim_value
// exactly — so the ANIMATION PLAYS AT FULL FIDELITY (no smoothing
// of the keyframes themselves). Only the transition from the rig's
// previous pose into the new animation is rate-limited.
//
// Default body accel = 3 rad/s² (LookatNodeRuntimeConfig in
// animation-utilities.js:2370 — bottom 3, middle 2.5, top 3). For a
// 1-rad offset that takes ~0.82s to decay; for a 0.3-rad offset
// ~0.45s — natural scaling with offset magnitude, never a fixed time.
//
// `lastApplied` is the rig's current actual pose; carried across
// animation boundaries so the next anim's startPlayback knows where
// the body is when computing its initial offset.
const _bodyState = {
  bottomSection_r: { offset: 0, offsetVel: 0, lastApplied: 0, accel: 3.0 },
  middleSection_r: { offset: 0, offsetVel: 0, lastApplied: 0, accel: 2.5 },
  topSection_r:    { offset: 0, offsetVel: 0, lastApplied: 0, accel: 3.0 },
};
// LED color channels — applied directly (no motion planner; color
// transitions look weird if they coast past their target).
const LED_CHANNELS = new Set(['led_r', 'led_g', 'led_b']);

// AccelPlanner — trapezoidal motion planner; port of
// animation-utilities/ifr-motion/base/AccelPlanner.computeWithFixedAccel.
// Same algorithm src/viewport/lookat.js uses for the lookat joints.
// Plans a trip of `pDelta` from velocity v0, decelerating to a stop at
// the target, never exceeding `accel`. Returns null for degenerate cases.
function planFixedAccel(v0, pDelta, accel) {
  if (accel < 1e-10) return null;
  let a = accel;
  if ((v0 * Math.abs(v0)) / (2 * accel) > pDelta) a = -accel;
  let tosqrt = 2 * v0 * v0 + 4 * a * pDelta;
  if (tosqrt < 0) { if (tosqrt > -1e-10) tosqrt = 0; else return null; }
  const root = Math.sqrt(tosqrt);
  let t1 = (-2 * v0 + Math.sign(a) * root) / (2 * a);
  let t2 = v0 / a + t1;
  if (t1 < 0) { if (t1 > -1e-10) t1 = 0; else return null; }
  if (t2 < 0) { if (t2 > -1e-10) t2 = 0; else return null; }
  return { v0, a, t1, t2 };
}
function planDisplacement(p, t) {
  let pos = 0;
  if (t > 0) { const ta = Math.min(t, p.t1); pos += (p.v0 + (p.a * ta) / 2) * ta; t -= ta; }
  if (t > 0) { const td = Math.min(t, p.t2); pos += (p.v0 + p.a * p.t1 - (p.a * td) / 2) * td; t -= td; }
  return pos;
}
function planVelocity(p, t) {
  let v = p.v0;
  if (t > 0) { const ta = Math.min(t, p.t1); v += p.a * ta; t -= ta; }
  if (t > 0) { const td = Math.min(t, p.t2); v -= p.a * td; }
  return v;
}

// When the running animation's `events.audio.emit(payload)` fires (from
// fireEventsUpTo in startDofPlayback), KeysAnimation's onPlayAudio
// listener runs synchronously and calls Sound.play(), whose patched
// version posts a 'play-sound' to the host. We need to associate the
// host-side audio id with the OWNING animation so a cancel/preempt can
// also stop the audio. Set this right before emitting, clear right
// after — Sound.play (further down this file) reads it.
let _currentAudioOwner = null;

// Animations whose body channels have ended (natural completion) but
// whose host-side audio is still playing. A typical dance keyframe
// emits play-audio at t=0 for a ~20s music track; the animation's body
// channels are often only 3-5s. So when a SECOND dance arrives between
// the body-end (~5s) and the music-end (~20s), the arbiter says
// "DOFs are AVAILABLE" and lets the new dance play — but the previous
// dance's music is still pumping audio in the host. The new dance
// then starts ITS music → two overlapping tracks.
//
// Track each instance whose natural-completion left audio playing, and
// when a NEW animation's startPlayback runs, drain this list: post
// stop-sound for each tracked id so the lingering music is replaced
// by the new dance's music instead of stacking on top of it.
const _completedWithLingeringAudio = new Set();
function _drainLingeringAudio() {
  if (_completedWithLingeringAudio.size === 0) return;
  for (const owner of _completedWithLingeringAudio) {
    if (!owner._audioIds || owner._audioIds.size === 0) continue;
    const ids = Array.from(owner._audioIds);
    owner._audioIds.clear();
    try {
      for (const id of ids) {
        window.parent.postMessage({ __jibo: true, kind: 'stop-sound', id }, '*');
      }
    } catch (_) { /* no parent */ }
  }
  _completedWithLingeringAudio.clear();
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
function startDofPlayback(options, durMs, isStopped, events, audioOwner) {
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
        // Tag the audio owner around the emit so the Sound.play patch can
        // attribute the resulting host-side audio id back to this animation
        // for cancel/preempt cleanup. play-pixi / HOLD_SAFE don't need this.
        if (ev.eventName === 'play-audio' && events.audio && events.audio.emit) {
          const prev = _currentAudioOwner;
          _currentAudioOwner = audioOwner || null;
          try { events.audio.emit(ev.payload || {}); }
          finally { _currentAudioOwner = prev; }
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
  // fireEventsUpTo handles the audio-owner tagging internally.
  fireEventsUpTo(0);
  if (!channels || channels.length === 0) return;
  // Active animation DOFs are exposed to driveEye() so the eye-tick loop mixes
  // them in alongside the idle pose.
  if (!window.__activeAnimDofs) window.__activeAnimDofs = null;
  const startMs = performance.now();
  const durSec = durMs / 1000;
  let lastFrameMs = startMs;
  const BODY_DOFS_PLANNED = Object.keys(_bodyState);   // bottom/middle/top sections

  // PoseOffsetFilter init: capture per-body-DOF offset = current rig
  // pose minus animation's t=0 value. The offset decays to 0 via the
  // acceleration-limited planner over the first frames of playback,
  // so the rig eases from where it was into the animation track —
  // WITHOUT slowing the animation itself. Velocity starts at 0 (the
  // simplest correct initial condition; preserving prev-anim velocity
  // would require tracking applied-velocity which adds complexity for
  // little perceptible gain).
  const t0Samples = {};
  for (const ch of channels) {
    const name = ch.dofName || ch.dof;
    if (name && BODY_DOFS_PLANNED.indexOf(name) >= 0) {
      t0Samples[name] = sampleChannel(ch.times || [], ch.values || [], 0);
    }
  }
  for (const name of BODY_DOFS_PLANNED) {
    const state = _bodyState[name];
    if (name in t0Samples) {
      state.offset = state.lastApplied - t0Samples[name];
      state.offsetVel = 0;
    }
    // For DOFs this animation doesn't touch, leave offset/vel alone — the
    // joint just holds its current pose (lastApplied is unchanged below).
  }

  const tick = () => {
    if (isStopped()) { window.__activeAnimDofs = null; return; }
    const nowMs = performance.now();
    const elapsedSec = (nowMs - startMs) / 1000;
    const t = Math.min(elapsedSec, durSec);
    // Per-frame dt for the offset planner. Cap at 50ms — large tab-blur
    // gaps shouldn't let the offset decay in one giant leap.
    let dt = (nowMs - lastFrameMs) / 1000;
    if (dt > 0.05) dt = 0.05;
    lastFrameMs = nowMs;

    const sampled = {};
    for (const ch of channels) {
      try {
        const name = ch.dofName || ch.dof;
        if (!name) continue;
        sampled[name] = sampleChannel(ch.times || [], ch.values || [], t);
      } catch (_) { /* malformed channel */ }
    }

    // BODY DOFs: applied = anim_value + decaying_offset. The animation
    // value plays unfiltered (full keyframe fidelity, no smoothing).
    // The offset decays toward 0 via acceleration-limited motion so
    // the transition from the rig's prior pose into the animation
    // happens smoothly without affecting in-animation playback speed.
    const bodyDofs = {};
    let hasBody = false;
    for (const name of BODY_DOFS_PLANNED) {
      const state = _bodyState[name];
      // Decay the offset toward 0. planFixedAccel handles direction
      // sign; we pass pDelta = -offset to drive it back to zero.
      if (dt > 0 && Math.abs(state.offset) > 1e-5) {
        const plan = planFixedAccel(state.offsetVel, -state.offset, state.accel);
        if (plan) {
          state.offset    += planDisplacement(plan, dt);
          state.offsetVel  = planVelocity(plan, dt);
        } else {
          state.offset = 0; state.offsetVel = 0;
        }
      } else {
        state.offset = 0; state.offsetVel = 0;
      }
      if (name in sampled) {
        state.lastApplied = sampled[name] + state.offset;
        bodyDofs[name] = state.lastApplied;
        hasBody = true;
      } else if (Math.abs(state.offset) > 1e-5) {
        // DOF not in animation but offset still decaying — still post.
        state.lastApplied = (state.lastApplied - state.offset) + state.offset;
        bodyDofs[name] = state.lastApplied;
        hasBody = true;
      }
    }
    // LEDs aren't motion — apply the sampled value directly so animated
    // color sweeps render crisply (no acceleration limit on hue).
    for (const k of LED_CHANNELS) if (k in sampled) { bodyDofs[k] = sampled[k]; hasBody = true; }

    if (hasBody) {
      try { window.parent.postMessage({ __jibo: true, kind: 'dofs', dofs: bodyDofs }, '*'); } catch (_) { /* no parent */ }
    }
    // The eye DOFs are mixed into driveEye's per-frame frame so motion stays
    // composited with the idle bob.
    window.__activeAnimDofs = sampled;
    // Fire any timed events whose time has now elapsed (audio cues etc.)
    fireEventsUpTo(t);
    if (t < durSec) requestAnimationFrame(tick);
    else {
      // Animation ended — KEEP _bodyState.lastApplied in place. The
      // next animation reads it when computing its initial offset so
      // motion is continuous across boundaries. Any residual offset
      // (uncommon — usually decays well before anim end) just shifts
      // the starting point of the next transition, which the next
      // anim's planner handles naturally.
      window.__activeAnimDofs = null;
    }
  };
  requestAnimationFrame(tick);
}

function makeAnimInstance(requireFn, play, options, requestor, jibo) {
  let Event;
  try { Event = requireFn('jibo-typed-events').Event; } catch (_) { /* fall back to local emitter */ }
  const events = {};
  for (const n of ['general', 'audio', 'pixi', 'holdSafe', 'stopped', 'cancelled', 'rejected', 'started', 'stateChange']) {
    events[n] = makeEmitter(Event, n);
  }
  let stopped = false;
  let started = false;
  let cancelled = false;
  let raf = 0;
  // Stable identity for the arbiter — _instanceToDOF keys on this object.
  // _audioIds tracks every host-side audio id this animation triggered (via
  // its events.audio.emit → KeysAnimation.onPlayAudio → Sound.play patch).
  // emitStopped walks this set and posts 'stop-sound' for each so a
  // preempted dance doesn't leave its music playing while the new dance's
  // music starts on top.
  const arbiterInstance = { _audioIds: new Set() };
  // Channel DOF names — what this animation will try to claim. Computed
  // once so emitStopped/preemption can release them via the arbiter.
  const channelDofs = (() => {
    const data = options && options.data;
    const channels = (data && data.content && Array.isArray(data.content.channels)) ? data.content.channels : null;
    if (!channels) return [];
    const out = [];
    for (const c of channels) { const n = c.dofName || c.dof; if (n) out.push(n); }
    return out;
  })();
  // Build a real animation-utilities DOFSet from the channel names. Required
  // by jibo-anim-db.Playback.registerEventsAndHandlers' hasScreenDOFs check
  // (jibo-anim-db.js:935-940) so face.eye.addAnimation actually fires for
  // animations that touch screen/eye DOFs — without this, JiboJi PIXI
  // overlays (coin-flip, applause, dance flourishes) never render because
  // their TimelineLayers are never attached to the EyeContainer.
  const animDofs = (() => {
    try {
      const ALL = jibo && jibo.expression && jibo.expression.dofs && jibo.expression.dofs.ALL;
      if (ALL && typeof ALL.createFromDofs === 'function') return ALL.createFromDofs(channelDofs);
    } catch (_) { /* fall through to tolerant */ }
    return tolerant();
  })();
  const emitStopped = (reason) => {
    if (stopped) return;
    stopped = true;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    // Release DOFs to the arbiter so the next animation can claim them
    // (matches DOFArbiter.ts:785 STOPPED/CANCELLED → TIMED_RELEASE).
    try { dofArbiter.releaseInstance(arbiterInstance); } catch (_) { /* arbiter not inited */ }
    // Stop any host-side audio this animation started. Without this,
    // preempting a dance leaves its music playing while the next
    // dance starts its own — overlapping tracks. The host's stop-sound
    // handler pauses the Audio element and emits sound-done so any
    // pending iframe-side fin() can resolve cleanly. Only cancellation
    // stops audio mid-stream; natural completion (reason undefined) lets
    // the audio finish on its own — it was timed to the animation length.
    if (reason === 'cancelled' && arbiterInstance._audioIds.size > 0) {
      const ids = Array.from(arbiterInstance._audioIds);
      arbiterInstance._audioIds.clear();
      try {
        for (const id of ids) {
          window.parent.postMessage({ __jibo: true, kind: 'stop-sound', id }, '*');
        }
      } catch (_) { /* no parent */ }
    } else if (arbiterInstance._audioIds.size > 0) {
      // Natural completion BUT audio is still playing (music outlives
      // a short body anim). Park this instance — the next startPlayback
      // will preempt the lingering audio so two dances don't overlap.
      _completedWithLingeringAudio.add(arbiterInstance);
    } else {
      arbiterInstance._audioIds.clear();
    }
    try {
      if (reason === 'cancelled') {
        cancelled = true;
        events.cancelled.emit();
      }
      events.stopped.emit();
    } catch (_) { /* no listener */ }
  };
  // Arbiter listener — when a HIGHER-priority requester acquires any of
  // OUR channel DOFs, the arbiter calls dofsLost(ourRequester, lostDofs).
  // If anything we own gets taken, this animation is preempted. Mirrors
  // the real expression service's behavior where the new playAnimation
  // call interrupts ours via the global ADDED → markInUseByInstance flow.
  const arbiterListener = {
    dofsLost: (owner, lost) => {
      if (stopped || !started) return;
      // Only react if any of OUR channels were taken — the arbiter
      // notifies us about anything we owned, including DOFs we hadn't
      // started writing yet (e.g. peripheral channels intersected by
      // another requester).
      let taken = false;
      for (const d of lost) { if (channelDofs.indexOf(d) >= 0) { taken = true; break; } }
      if (taken) emitStopped('cancelled');
    },
    dofsGained: () => {},
    dofsAvailable: () => {},
  };
  if (requestor) {
    try { dofArbiter.addListener(requestor, arbiterListener); } catch (_) { /* */ }
  }
  // Start (or restart) playback: emit `started`, schedule `stopped` for the
  // computed real duration, and kick off body+eye DOF sampling. Used both by
  // the createAndPlayAnimation initial-play (play=true) and the createAnimation
  // + instance.play(...) deferred-play path (where the skill drives playback
  // explicitly after acquiring the instance — most embodied-dialog timelines
  // take this path).
  const startPlayback = (playRequestor) => {
    if (started || stopped) return;
    // Arbitrate before we mark started — if the policy says we can't
    // have ANY of our channels (with allOrNothing), reject without
    // touching __activeAnimDofs. Mirrors AnimationInstance.play() at
    // /tmp/sdk/.../expression/AnimationInstance.ts:35-50: PlayStatus
    // REJECTED → emit REJECTED event, return without playing.
    const useReq = playRequestor || requestor || 'Behavior';
    const allowed = (channelDofs.length > 0)
      ? dofArbiter.attemptToClaimForInstance(useReq, arbiterInstance, channelDofs, { allOrNothing: true })
      : [];
    if (channelDofs.length > 0 && allowed.length === 0) {
      // Rejected — same surface as the real expression service:
      // delay REJECTED to the next tick so the play() reply lands first,
      // then mark as stopped without firing started/stopped pairs.
      stopped = true;
      try { dofArbiter.removeListener(useReq, arbiterListener); } catch (_) { /* */ }
      setTimeout(() => { try { events.rejected.emit(); } catch (_) { /* */ } }, 0);
      console.log('[live-eye] anim REJECTED by arbiter (req=' + useReq + ', wanted ' + channelDofs.length + ' dofs)');
      return;
    }
    // Preempt any lingering audio from previously-completed animations
    // (their body channels finished but their audio is still playing —
    // a new animation about to start its own audio takes precedence).
    _drainLingeringAudio();
    started = true;
    const dataObj = options && options.data;
    const channels = (dataObj && dataObj.content && Array.isArray(dataObj.content.channels)) ? dataObj.content.channels : null;
    const channelCount = channels ? channels.length : 0;
    const summary = channels ? channels.slice(0, 6).map((c) => c.dofName || c.dof).join(',') : '';
    Promise.resolve().then(() => { try { events.started.emit(); } catch (_) { /* no listener */ } });
    const dur = animDurationMs(options);
    console.log('[live-eye] anim play: req=' + useReq + ' src=', (options && options.src) || '<inline>', 'dur=', dur, 'ms ch=', channelCount, channelCount ? '(' + summary + (channels.length > 6 ? ',...' : '') + ')' : '');
    setTimeout(() => emitStopped(), dur);
    // Sample the animation's channels per frame and drive both the host body rig
    // (postMessage 'dofs' for body sections + LED ring) and the local eye (push
    // DOFs into jibo.face.eye.display). options.data is the same shape
    // jibo-keyframes.computeAnimObject produces: { content: { channels: [{ dofName,
    // times, values }] } } — value at time t is a piecewise-linear sample.
    // Pass the events container so the data's timed events (play-audio →
    // music playback via KeysAnimation.onPlayAudio → Sound.play → host audio)
    // fire at the right beat. arbiterInstance is the audio-owner: any host-side
    // audio id triggered from events.audio.emit gets tagged onto its _audioIds
    // set so cancellation can stop those audios via the host 'stop-sound' bridge.
    startDofPlayback(options, dur, () => stopped, events, arbiterInstance);
  };
  if (play) startPlayback(requestor);
  const fn = function () { return tolerant(); };
  return new Proxy(fn, {
    get(t, p) {
      if (p === 'events') return events;
      // dofs: real DOFSet built from this animation's channels. The bundle's
      // anim-db Playback gates face.eye.addAnimation on a hasScreenDOFs
      // check (jibo-anim-db.js:935-940) that does
      // `dofsInScreen.minus(instance.dofs).getDOFs().length !== ...`. A
      // tolerant proxy here breaks that check and addAnimation never fires
      // → JiboJi PIXI overlays never render.
      if (p === 'dofs') return animDofs;
      if (p === 'state') return cancelled ? 'CANCELLED' : (stopped ? 'STOPPED' : (started ? 'PLAYING' : 'INVALID'));
      if (p === 'then' || typeof p === 'symbol') return undefined;
      // Real AnimationInstance.play(requestor) begins playback; same here for
      // animations created via createAnimation() and played explicitly. The
      // bundle passes a requestor string (jibo-expression-client.AnimationInstance.play
      // line 59 — default 'Behavior'); thread it into the arbiter call.
      if (p === 'play') return (req) => { startPlayback(req || requestor); return Promise.resolve(stopped && !started ? 'REJECTED' : 'OK'); };
      if (p === 'stop' || p === 'destroy' || p === 'cancel') return () => {
        emitStopped(p === 'cancel' ? 'cancelled' : undefined);
        if (requestor) { try { dofArbiter.removeListener(requestor, arbiterListener); } catch (_) { /* */ } }
        return Promise.resolve();
      };
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
// eye locally instead. Methods listed here have no meaningful behavior in a
// browser sim (cache eviction, LED hardware, robot indexing, etc.) so they
// resolve to a tolerant proxy that satisfies any chained API calls. Methods
// that DO drive observable behavior (acquireTarget/awaitFace/lookAt/centerRobot/
// cleanup) get full implementations below the loop, not in this list.
const EXPRESSION_METHODS = [
  'destroyCaches',
  'setAttentionMode', 'pushAttentionMode', 'popAttentionMode', 'getAttentionMode',
  'indexRobot', 'setSkillRoot',
  'doCenterRobotOnDisconnect', 'subscribe', 'unsubscribe',
];

// Build a real AcquireHandle the source returns from acquireTarget/awaitFace.
// Source (Expression.ts:245-265, AcquireHandle.ts): the SSM returns an object
// with .instanceId; the client wraps it so callers can later .release() to
// drop the target. We return a shape with .release() that posts lookat-clear
// to the host. The proxy stays tolerant for any other property access so
// skills doing `handle.someExtension()` don't crash.
function makeAcquireHandle(onRelease) {
  let released = false;
  const release = () => {
    if (released) return Promise.resolve();
    released = true;
    try { onRelease(); } catch (_) { /* */ }
    return Promise.resolve();
  };
  const obj = { release, then: undefined };
  return new Proxy(obj, {
    get(t, p) {
      if (p === 'release') return release;
      if (p === 'released') return released;
      if (p === 'then') return undefined;        // not a thenable
      if (p === 'instanceId') return null;
      return tolerant();
    },
  });
}
// Extract a world-space target from acquireTarget/lookAt options. The source
// AcquireOptions accepts:
//   - {position: {x,y,z}}  — direct world point
//   - {entity: blackboardObj}  — track a moving entity (LPS face/sound source)
// In our sim we don't track entities (no LPS visual_awareness stream), so we
// fall back to whatever last-known position the entity carries, else null.
function extractLookAtTarget(opts) {
  if (!opts) return null;
  if (opts.position && typeof opts.position.x === 'number') {
    return { x: opts.position.x, y: opts.position.y, z: opts.position.z };
  }
  if (opts.entity) {
    const e = opts.entity;
    if (e.position && typeof e.position.x === 'number') {
      return { x: e.position.x, y: e.position.y, z: e.position.z };
    }
    if (typeof e.x === 'number' && typeof e.y === 'number') return { x: e.x, y: e.y, z: e.z || 0 };
  }
  return null;
}
export function installExpressionStubs(jibo, requireFn) {
  try {
    const ex = jibo && jibo.expression;
    if (!ex || ex.__stubbed) return;
    ex.__stubbed = true;
    // Initialize the DOFArbiter against the bundle's robot DOF universe.
    // The expression service does this in ExpressionService.initDOFArbiter
    // (using its own animate.getRobotInfo()); we use the same RobotInfo
    // populateExpressionDofs already built (jibo.expression.dofs.ALL is
    // a DOFSet whose getDOFs() lists every DOF, equivalent to the source's
    // getRobotInfo().getDOFNames()).
    try {
      let dofNames = [];
      const all = ex.dofs && ex.dofs.ALL;
      if (all && typeof all.getDOFs === 'function') dofNames = all.getDOFs();
      if (dofNames.length > 0) {
        dofArbiter.init(dofNames);
        console.log('[live-eye] DOFArbiter initialized with', dofNames.length, 'DOFs');
      } else {
        console.log('[live-eye] DOFArbiter NOT initialized: no DOF universe (jibo.expression.dofs.ALL empty)');
      }
    } catch (e) { console.warn('[live-eye] DOFArbiter init failed:', e.message); }
    for (const m of EXPRESSION_METHODS) {
      if (typeof ex[m] === 'function' || ex[m] === undefined) ex[m] = () => Promise.resolve(tolerant());
    }
    // Replace centerRobot with one that routes through the arbiter.
    // Real impl (Expression.ts:267-284): dofArbiter.centerRobot(requestor,
    // dofs, centerGlobally, cb). Skills pass options.{requestor, dofs,
    // centerGlobally}. The host bridge interprets this as "drop lookAt
    // target so the rig eases back to neutral via the next anim's
    // approach-blend"; full pose-restoration is the next deepening.
    ex.centerRobot = (opts = {}) => new Promise((resolve) => {
      try {
        const req = opts.requestor || 'Behavior';
        const dofSet = opts.dofs && opts.dofs.getDOFs ? opts.dofs : null;
        // Clear any active be-side lookAt so the lookat solver returns
        // to neutral as part of the centering.
        try { window.parent.postMessage({ __jibo: true, kind: 'lookat-clear' }, '*'); } catch (_) { /* */ }
        dofArbiter.centerRobot(req, dofSet, !!opts.centerGlobally, () => resolve());
      } catch (_) { resolve(); }
    });
    ex.cleanup = (opts = {}) => new Promise((resolve) => {
      try {
        const req = opts.requestor || 'Behavior';
        const trustee = opts.trustee || 'Cleanup';
        const dofSet = opts.dofs && opts.dofs.getDOFs ? opts.dofs : null;
        dofArbiter.centerWithHybridPriority(req, trustee, dofSet, opts.owners || null, false, () => resolve());
      } catch (_) { resolve(); }
    });
    // blink — trigger a one-shot eye blink. Source (Expression.ts:321):
    // expression.blink(interrupt?) → animate.blink() → drives the eye
    // overlay's blink animation. In our port jibo.face.eye.blink() is
    // available directly on the bundle's FaceRenderer; call it so
    // skills that periodically blink (e.g. idle skill heartbeat,
    // @be/who-am-i question pauses) produce visible blinks.
    ex.blink = (interrupt) => {
      try {
        const eye = jibo && jibo.face && jibo.face.eye;
        if (eye && typeof eye.blink === 'function') eye.blink(interrupt);
      } catch (_) { /* eye not ready */ }
      return Promise.resolve();
    };
    // setLEDColor — drive the rig's lightring mesh. Source contract
    // (Expression.ts:312-314): setLEDColor(colors:[number,number,number])
    // with each component normalized [0,1]. Skills that pulse the ring
    // (idle skill heartbeat, listening-state LED) now produce visible
    // color changes on the viewport's lightring instead of vanishing.
    ex.setLEDColor = (colors) => {
      try {
        if (Array.isArray(colors) && colors.length === 3) {
          window.parent.postMessage({ __jibo: true, kind: 'led-color', rgb: colors }, '*');
        }
      } catch (_) { /* */ }
      return Promise.resolve();
    };
    // acquireTarget — drive the body+eye lookat solver toward a world target.
    // Source (Expression.ts:245-254) creates an AcquireHandle (server-side
    // tracker that subscribes the attention manager to a target). Our impl
    // posts the target to the host where createLookAtController's analytical
    // IK solver (src/viewport/lookat.js) animates bottom/middle/top sections
    // toward it. The returned handle's .release() drops the target so the
    // rig returns to neutral. Many be skills use this for face-tracking
    // (@be/introductions, @be/tutorial, @be/create, @be/circuit-saver).
    ex.acquireTarget = (opts) => {
      const tgt = extractLookAtTarget(opts);
      if (tgt) {
        try { window.parent.postMessage({ __jibo: true, kind: 'lookat-target', target: tgt }, '*'); } catch (_) { /* */ }
        console.log('[live-eye] acquireTarget @', tgt);
      } else {
        console.log('[live-eye] acquireTarget: no position/entity in opts, skipping');
      }
      const handle = makeAcquireHandle(() => {
        try { window.parent.postMessage({ __jibo: true, kind: 'lookat-clear' }, '*'); } catch (_) { /* */ }
      });
      return Promise.resolve(handle);
    };
    // awaitFace — wait for a face to be present at a target. The real impl
    // is a long-poll on the LPS visual_awareness stream; we don't have one,
    // so we drive the lookat for ~2s (simulating gaze acquisition) and then
    // resolve. Returns an AcquireHandle compatible shape so skills calling
    // .release() get the expected interface (Expression.ts:256-265).
    ex.awaitFace = (opts) => {
      const tgt = extractLookAtTarget(opts);
      if (tgt) {
        try { window.parent.postMessage({ __jibo: true, kind: 'lookat-target', target: tgt }, '*'); } catch (_) { /* */ }
      }
      console.log('[live-eye] awaitFace @', tgt || '<no-pos>');
      return Promise.resolve(makeAcquireHandle(() => {
        try { window.parent.postMessage({ __jibo: true, kind: 'lookat-clear' }, '*'); } catch (_) { /* */ }
      }));
    };
    // lookAt — convenience wrapper for one-shot gaze. Real impl runs a
    // Lookat for the duration the caller specifies (or until interrupted);
    // we drive the host lookat and clear after `opts.duration` ms (default
    // 2000 — matches typical embodied-speech gaze cues).
    ex.lookAt = (opts = {}) => new Promise((resolve) => {
      const tgt = extractLookAtTarget(opts);
      if (!tgt) { resolve(); return; }
      try { window.parent.postMessage({ __jibo: true, kind: 'lookat-target', target: tgt }, '*'); } catch (_) { /* */ }
      const dur = typeof opts.duration === 'number' ? opts.duration : 2000;
      setTimeout(() => {
        try { window.parent.postMessage({ __jibo: true, kind: 'lookat-clear' }, '*'); } catch (_) { /* */ }
        resolve();
      }, dur);
    });
    // Diagnostic: log every animation instance creation so we can tell which
    // anim tags get through resolveAssetToPlayback. Helpful for tracking down
    // missing dance/etc. anims — if a `<anim cat='dance' ...>` produces no
    // create log line, the resolver dropped the node silently.
    const summarize = (opts) => {
      if (!opts) return '<no-opts>';
      const src = opts.src || '<no-src>';
      const data = opts.data;
      const ch = data && data.content && Array.isArray(data.content.channels) ? data.content.channels.length : '-';
      return `src=${src} ch=${ch}`;
    };
    // Both createAnimation and createAndPlayAnimation take the requestor as
    // their second arg (jibo-expression-client.js:253 / Expression.ts:97-109).
    // Default 'Behavior' matches AnimationInstance.play()'s default.
    ex.createAnimation = (opts, requestor = 'Behavior') => {
      console.log('[live-eye] createAnimation:', summarize(opts), 'req=' + requestor);
      return Promise.resolve(makeAnimInstance(requireFn, false, opts, requestor, jibo));
    };
    ex.createAndPlayAnimation = (opts, requestor = 'Behavior') => {
      console.log('[live-eye] createAndPlayAnimation:', summarize(opts), 'req=' + requestor);
      return Promise.resolve(makeAnimInstance(requireFn, true, opts, requestor, jibo));
    };
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

    // Track the active MIM Listen request. When a skill (e.g. @be/friendly-tips
    // in its `wanna see more?` MIM) opens a Listen with non-launch rules, the
    // cloud is waiting on THAT WS to receive the ASR/NLU for the answer. If our
    // typed-chat path opens a separate startLocalTurn for "sure", the MIM's
    // listen times out (SOS_TIMEOUT) and the answer lands on a new, ignored
    // turn. By stashing the most-recent in-flight LocalTurnRequest on
    // window.__activeListen, boot.js can call .update(text) to inject
    // CLIENT_ASR into the existing turn instead — the cloud parses against
    // the MIM's rules and returns the result on the same WS the MIM is
    // waiting on. Skip turns whose only rule is `launch` (those are the
    // out-of-mim fallback we ourselves start; updating them would loop).
    try {
      const origStart = api.startLocalTurn;
      if (typeof origStart === 'function' && !api.__activeListenTracked) {
        api.__activeListenTracked = true;
        api.startLocalTurn = function patchedStartLocalTurn(opts) {
          const req = origStart.apply(this, arguments);
          try {
            const rules = (opts && (opts.nluRules || (opts.listen && opts.listen.rules))) || [];
            const isLaunchOnly = Array.isArray(rules) && rules.length === 1 && rules[0] === 'launch';
            if (req && !isLaunchOnly) {
              window.__activeListen = req;
              const clear = () => { if (window.__activeListen === req) window.__activeListen = null; };
              if (req.promise && typeof req.promise.then === 'function') {
                req.promise.then(clear, clear);
              } else if (req.events) {
                ['turnResult', 'completed', 'failed', 'closed'].forEach((n) => {
                  try { if (req.events[n] && typeof req.events[n].on === 'function') req.events[n].on(clear); } catch (_) { /* */ } });
              }
            }
          } catch (_) { /* */ }
          return req;
        };
      }
    } catch (e) { console.warn('[cloud] activeListen track:', e.message); }

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

  // InteractionMemoryPlugin (jibo.js:7734) skips under UNIT_TESTS — so
  // jibo-interaction-memory's `exports._memory` is undefined. @be/greetings'
  // ShouldDoMorningGreetingState calls `getTimeSinceLast(...)` and
  // GreetingsSkill's session-create calls `noteEvent(...)`; both crash
  // ("Cannot read properties of undefined (reading 'getTimeSinceLast' /
  // 'noteEvent')") and the skill's first turn aborts. Init the singleton
  // ourselves — it's connection-free (in-memory event list).
  try {
    const im = requireFn && requireFn('jibo-interaction-memory');
    if (im && im.api && typeof im.api.init === 'function' && !im._memory) {
      im.api.init(jibo);
    }
  } catch (e) { console.warn('[live-eye] im.init:', e.message); }

  // CloudResponseRegistry.cull (jetstream-client.js:541) rejects every entry
  // that's been pending > 10s with an Error('Timeout … reached. Culling cloud
  // response'). The ExtPromiseWrapper.reject hits the registry's internal
  // Promise — but in our flow the Promise has no .catch (the matching
  // SKILL_ACTION already arrived through our M47 direct path, or the entry
  // is an orphan from a timed-out turn). Devtools then logs an unhandled
  // rejection per cull cycle. Attach a global filter so the timeout reason
  // is silently swallowed; any other rejection still surfaces.
  try {
    if (typeof window !== 'undefined' && !window.__cullSwallowInstalled) {
      window.__cullSwallowInstalled = true;
      window.addEventListener('unhandledrejection', (ev) => {
        const r = ev && ev.reason;
        const msg = r && (r.message || r);
        if (typeof msg === 'string' && /Culling cloud response/.test(msg)) {
          ev.preventDefault();
        }
      });
    }
  } catch (e) { console.warn('[live-eye] cull swallow:', e.message); }

  // console.time/timeEnd noise: the bundle's keyframe loader times every
  // animation load under the single name "Asset loading", but `console.time`
  // warns "Timer 'X' already exists" when called twice without an intervening
  // `timeEnd`, and `timeEnd` warns "Timer 'X' does not exist" when the timer
  // was already stopped. Both are non-fatal but spam the console once per
  // animation. Idempotent wrappers — startWith-timeEnd if already running,
  // skip if not — give the bundle the same measurement semantics with no log.
  try {
    if (typeof console !== 'undefined' && !console.__timersIdempotent) {
      console.__timersIdempotent = true;
      const _timers = new Set();
      const _time = console.time.bind(console);
      const _timeEnd = console.timeEnd.bind(console);
      console.time = function (label) { if (_timers.has(label)) { try { _timeEnd(label); } catch (_) { /* */ } } _timers.add(label); return _time(label); };
      console.timeEnd = function (label) { if (!_timers.has(label)) return; _timers.delete(label); try { return _timeEnd(label); } catch (_) { /* */ } };
    }
  } catch (e) { console.warn('[live-eye] console.time patch:', e.message); }

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

  // Cross-origin images (news thumbnails from report-skill SKILL_ACTIONs)
  // load fine into <img> tags but PIXI's texImage2D fails ("SecurityError:
  // image element contains cross-origin data, and may not be loaded") if
  // the remote server doesn't return Access-Control-Allow-Origin. Once one
  // texture upload fails, the sprite's _texture stays null and
  // PIXI.SpriteRenderer.flush throws "Cannot read properties of null
  // (reading 'baseTexture')" every render frame → console spam.
  // Patch HTMLImageElement.src so any cross-origin URL gets routed through
  // our same-origin /__img proxy (added to server.js). The proxy fetches
  // server-side and replays the bytes back with permissive CORS, so the
  // image is no longer cross-origin from the browser's perspective and
  // texImage2D succeeds.
  try {
    const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    if (desc && desc.set && !HTMLImageElement.prototype.__webProxied) {
      HTMLImageElement.prototype.__webProxied = true;
      const isCrossOrigin = (u) => /^https?:\/\//i.test(u) && new URL(u, location.href).origin !== location.origin;
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        configurable: true,
        get: desc.get,
        set(url) {
          try {
            const s = String(url == null ? '' : url);
            if (isCrossOrigin(s)) {
              url = `${location.origin}/__img?url=${encodeURIComponent(s)}`;
            }
          } catch (_) { /* leave url unchanged */ }
          desc.set.call(this, url);
        },
      });
    }
  } catch (e) { console.warn('[live-eye] image proxy patch:', e.message); }

  // Lifecycle.finished crashes under UNIT_TESTS: its init (jibo.js:7841)
  // returns early without creating `this._client`, and every phase-end
  // callsite (~10 places in jibo.js, plus skill graphs) does
  //   `this._client.send({ command: 'finished' })`
  // which throws "Cannot read properties of undefined (reading 'send')".
  // The error is non-fatal but recurring — every news headline / mim
  // completion fires it, spamming hundreds of identical exceptions per
  // skill. Replace finished() with a no-op that swallows the missing
  // client. The ipc.send branch was already gated by Runtime.ipcRenderer
  // and continues to work for the EventEmitter fallback.
  try {
    const lc = jibo && jibo.lifecycle;
    if (lc && typeof lc.finished === 'function' && !lc.__webPatched) {
      lc.__webPatched = true;
      const origFinished = lc.finished.bind(lc);
      lc.finished = function patchedFinished() {
        if (!lc._client || typeof lc._client.send !== 'function') return;
        try { return origFinished(); } catch (_) { /* still tolerate */ }
      };
    }
  } catch (e) { console.warn('[live-eye] lifecycle patch:', e.message); }

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
      // One bridge listener picks up sound-done events + lookat eye DOFs
      // from the host. (Both ride on the same window 'message' channel.)
      if (!window.__soundBridgeInstalled) {
        window.__soundBridgeInstalled = true;
        window.addEventListener('message', (ev) => {
          const m = ev.data;
          if (!m || m.__jibo !== true) return;
          if (m.kind === 'sound-done' && window.__pendingSounds.has(m.id)) {
            const fin = window.__pendingSounds.get(m.id);
            window.__pendingSounds.delete(m.id);
            try { fin(); } catch (_) { /* */ }
          } else if (m.kind === 'eye-lookat-dofs') {
            // Host's createLookAtController emits residual eye DOFs every
            // frame the body lookat is engaged. driveEye's tick reads
            // window.__lookatEyeDofs and mixes into face.eye.display so
            // the iris actually aims at the world target.
            window.__lookatEyeDofs = m.dofs || null;
          }
        });
      }
      Sound.prototype.play = function play(options) {
        const callOpts = (typeof options === 'function') ? { complete: options } : (options || {});
        const src = this.src;
        // Two playback paths run side-by-side:
        //   HOST     — new Audio(url).play() in the parent (M52). Always
        //              audible (parent has user activation from Start Jibo).
        //   IFRAME   — origPlay.call(...) below. Drives SoundInstance's Web
        //              Audio chain (bufferSource → gain → analyser → panner →
        //              SoundContext._gainNode). We KEEP this call so the
        //              instance's isPlaying / _instances / timer-events
        //              state machine behaves identically to a real Sound.play.
        // The iframe's master gain is force-muted by initOfflineServices'
        // soundContext patch (set _context.muted=true), so the Web Audio
        // chain renders silent even if its AudioContext is or becomes
        // 'running' (which it can — allow-same-origin propagates sticky
        // activation, so the moment the user clicks anywhere the iframe's
        // ctx is resumable). Without that mute, BOTH paths emit the same
        // file with ~30-50ms desync → audible reverb/echo plus clipping
        // from summed amplitudes.
        let postedHost = false;
        try {
          if (typeof src === 'string' && src && typeof window !== 'undefined' && window.parent) {
            const id = ++_seq;
            // Rewrite to the HTTP-served path. mirrors cjs-require's mapUrl
            // logic: paths under /node_modules/ get rebased onto the skill
            // dir so external-skill bundle URLs resolve under our HTTP root.
            // (the report-skill cloud SKILL_ACTION emits anim-db sound refs
            //  like 'jibo-anim-db-animations/audio/sfx/.../*.ogg' which the
            //  loader resolves to /node_modules/jibo-anim-db-animations/...
            //  — that absolute path has to be served under our skill dir.)
            const skillDir = (typeof window !== 'undefined' && window.__SKILL_DIR__) || '';
            let url = src;
            const i = src.lastIndexOf('/node_modules/');
            if (i >= 0) url = location.origin + (skillDir || '') + src.slice(i);
            else if (src.indexOf('/external-skills/') >= 0) url = location.origin + src.slice(src.indexOf('/external-skills/'));
            else if (src[0] === '/') url = location.origin + src;
            // Attribute this audio to the currently-firing animation event
            // (set by fireEventsUpTo around events.audio.emit) so that an
            // arbiter preempt of that animation can also stop the audio.
            const owner = _currentAudioOwner;
            if (owner && owner._audioIds) owner._audioIds.add(id);
            const fin = () => {
              if (owner && owner._audioIds) {
                owner._audioIds.delete(id);
                // If this drains the last id for a lingering instance,
                // drop it from the preempt set — nothing left to stop.
                if (owner._audioIds.size === 0) _completedWithLingeringAudio.delete(owner);
              }
              if (callOpts.complete) { try { callOpts.complete(this); } catch (_) { /* */ } }
            };
            window.__pendingSounds.set(id, fin);
            window.parent.postMessage({ __jibo: true, kind: 'play-sound', id, src: url, loop: !!this.loop, volume: this.volume }, '*');
            postedHost = true;
          }
        } catch (e) { console.warn('[live-eye] sound bridge:', e && e.message); }
        // When the host is the source of "done", strip `complete` from
        // origPlay's options so the iframe's SoundInstance doesn't ALSO
        // fire it when its (muted) buffer reaches the end — same callback,
        // two timestamps, could advance dialog state or queue the next
        // animation twice. Everything else (offset, etc.) passes through.
        let localOpts = options;
        if (postedHost) {
          if (typeof options === 'function') localOpts = {};
          else localOpts = Object.assign({}, options || {}, { complete: null });
        }
        return origPlay.call(this, localOpts);
      };
      console.log('[live-eye] Sound.play routed to host window');
    }
  } catch (e) { console.warn('[live-eye] sound routing failed:', e.message); }

  // Mute the iframe SoundContext's master gain — see Sound.play patch above
  // for the rationale (avoid double-playback with the host). The bundle's
  // SoundContext (jibo.sound._context, SoundContext.ts) routes every Sound
  // chain through a single _gainNode → DynamicsCompressor → destination;
  // setting .muted=true zeros that gain so the entire chain is silent
  // regardless of AudioContext state, while leaving the audio graph alive
  // so timing/state/events behave unchanged.
  try {
    const sc = jibo && jibo.sound && jibo.sound._context;
    if (sc && !sc.__webMuted) {
      sc.__webMuted = true;
      sc.muted = true;
    }
  } catch (e) { console.warn('[live-eye] sound mute failed:', e.message); }

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
        const installQueryHook = () => {
          try {
            if (jibo.animDB.__queryHooked) return;
            const origQuery = jibo.animDB.query && jibo.animDB.query.bind(jibo.animDB);
            if (!origQuery) return;
            jibo.animDB.__queryHooked = true;
            jibo.animDB.query = function patchedQuery(q) {
              const r2 = origQuery(q);
              try {
                const n = (r2 && r2.matching && r2.matching.length) | 0;
                const summary = JSON.stringify({ categories: q.categories, includeMeta: q.includeMeta, includeSomeMeta: q.includeSomeMeta, excludeMeta: q.excludeMeta });
                console.log('[live-eye] animDB.query', summary, '-> matching=', n, n > 0 ? '(' + r2.matching.slice(0, 3).map((a) => a.name || (a.meta && a.meta.name)).join(',') + (n > 3 ? ',...' : '') + ')' : '');
              } catch (_) { /* */ }
              return r2;
            };
          } catch (_) { /* */ }
        };
        if (r && typeof r.then === 'function') {
          r.then(() => {
            try {
              const n = jibo.animDB.getAnimationNames ? jibo.animDB.getAnimationNames().length : -1;
              console.log('[live-eye] animDB indexed animations:', n);
              installQueryHook();
            } catch (_) { /* */ }
          }, (e) => console.warn('[live-eye] animDB.init failed:', e && e.message));
        } else {
          installQueryHook();
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
      // Apply residual eye-gaze DOFs from the host's lookat solver. The host
      // computes how far the head's pointing missed the target and maps the
      // remainder to eyeSubRootBn_t (yaw → horizontal iris shift) /
      // eyeSubRootBn_t_2 (pitch → vertical iris shift) via the animation-
      // utilities EyeLeftRight/EyeUpDown geometry config. Apply BEFORE the
      // active-anim overlay below so a real animation playing on the eye
      // (e.g. dance saccades) wins over the residual.
      const lookatEye = window.__lookatEyeDofs;
      if (lookatEye) {
        if (typeof lookatEye.eyeSubRootBn_t === 'number') frame.eyeSubRootBn_t = lookatEye.eyeSubRootBn_t;
        if (typeof lookatEye.eyeSubRootBn_t_2 === 'number') frame.eyeSubRootBn_t_2 = lookatEye.eyeSubRootBn_t_2 + Math.sin(t * 1.2) * 0.0015;
      }
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
      // Populate sourceTimes for any animation EyeContainer is tracking.
      // EyeContainer.display (jibo.js:10046) consults meta.sourceTimes
      // to (1) detect a pending anim ready to swap in, and (2) drive the
      // current animation's update(time, dofValues) — which runs each
      // TimelineLayer.update so PIXI overlays (JiboJis, dance flourishes,
      // the coin-flip sprites) animate frame-by-frame. Without this the
      // pending swap never happens; layers never get addChild'd to the
      // EyeContainer; the screen stays blank.
      // The time value is in SECONDS, used by TimelineLayer.update as
      // `time - this.startTime` to compute the current frame. As long as
      // it advances monotonically at real-time rate, the timelines run
      // at the correct framerate.
      meta.sourceTimes = {};
      const animSec = performance.now() / 1000;
      if (eye._animation && eye._animation.name) meta.sourceTimes[eye._animation.name] = animSec;
      if (eye._pendingAnim && eye._pendingAnim.name) meta.sourceTimes[eye._pendingAnim.name] = animSec;
      if (eye.display) { try { eye.display(performance.now(), frame, meta); } catch (_) { /* eye not ready */ } }
    }
    requestAnimationFrame(tick);
  };
  tick();
}
