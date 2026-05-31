// Look-at controller — turns Jibo to face a world-space target.
//
// A faithful port of animation-utilities' Lookat solver (ifr-motion/lookat/*,
// configured in SingleLookatBuilder). The neck's three motors twist about
// near-vertical, tilted axes, so pitch can't be reached by naive IK — but the
// real solver does it analytically, joint by joint, root to leaf:
//
//   base  (bottomSection_r): pointDOF — rotate so the local forward (0,0,-1)
//                            aims at the target (handles left/right).
//   torso (middleSection_r): pointDOFToIntersectConeWithPoint — the tilted axis
//                            sweeps a CONE; solve where it meets the target.
//   top   (topSection_r):    pointDOF again.
//
// The middle's tilted cone + the top counter-rotating is what pitches the head
// up/down while keeping the face forward. The eye then covers residual gaze
// (notably "up", which the mechanism can barely reach physically).
//
// Geometry constants come straight from jibo_body.kin + SingleLookatBuilder's
// LookatDOFGeometryConfig.

import * as THREE from 'three';

const RAW_AXIS = new THREE.Vector3(0, 1, 0);   // all three DOFs rotate about local +Y
const FORWARD = new THREE.Vector3(0, 0, -1);

// Rest orientations = inverse of the stored wxyz quats (BasicFrame convention).
function quatFromWXYZ(w, x, y, z) {
  return new THREE.Quaternion(x, y, z, w).invert();
}
const REST = {
  bottom: quatFromWXYZ(-0, 0, 1, 0),
  middle: quatFromWXYZ(0.9935718579377518, 0.11320319392192023, 0, -0),
  top: quatFromWXYZ(0.9821233481679139, -0.18823848964397946, 0, -0),
};
// TorsoLookatDOF cone (middleSection): tilted plane normal + mount geometry.
const TORSO_PLANE = new THREE.Vector3(9.509979e-9, 0.9271838, 0.37460676);
const TORSO_DIST = 0.18703285;
const TORSO_CONE = 0.29670632;

// Per-joint acceleration limits (rad/s^2), from SingleLookatBuilder's
// LookatNodeRuntimeConfig (base 3, torso 2.5, top 3).
const ACCEL = { bottom: 3.0, middle: 2.5, top: 3.0 };

// Eye DOF geometry — animation-utilities.js:2329-2348 LookatDOFGeometryConfig.
// EyeLeftRight (eyeSubRootBn_t):  InternalDistance 0.0165, range ±0.03450608.
// EyeUpDown    (eyeSubRootBn_t_2): InternalDistance 0.013,  range ±0.00609551.
// The eye is rendered on the screen plane; the iris translates in screen-local
// space and the apparent gaze direction is `atan(translation / InternalDistance)`.
// Inverting: to gaze at residual angle θ, set translation = InternalDistance * tan(θ),
// clamped to ±MaxValue. Small-angle: linear in θ.
const EYE_LR_DIST = 0.0165;
const EYE_LR_MAX  = 0.03450607937;
const EYE_UD_DIST = 0.013;
const EYE_UD_MAX  = 0.00609550625;

// Acceleration-limited trapezoidal motion planner — a port of
// AccelPlanner.computeWithFixedAccel + AccelPlan (ifr-motion/base/AccelPlanner).
// Plans a trip of `pDelta` from velocity `v0`, decelerating to a stop, never
// exceeding `accel`. Returns null for degenerate cases.
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

function correctAngleSign(v4, refAxis) {
  const a = new THREE.Vector3(v4.x, v4.y, v4.z);
  const angNow = a.angleTo(refAxis);
  const angInv = a.clone().negate().angleTo(refAxis);
  return angNow <= angInv ? v4.w : -v4.w;
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// Cyclically shift `v` to the representation nearest `ref`.
const closestEquiv = (v, ref) => v + Math.round((ref - v) / (2 * Math.PI)) * (2 * Math.PI);

// Angle about the joint axis so its local `forward` aims at `target` (world).
function pointDOF(transform, rest, forward, target) {
  const lt = transform.worldToLocal(target.clone());
  lt.applyQuaternion(transform.quaternion);
  const axis = RAW_AXIS.clone().applyQuaternion(rest);
  const fwd = forward.clone().applyQuaternion(rest).projectOnPlane(axis);
  const loc = lt.projectOnPlane(axis);
  if (fwd.lengthSq() < 1e-8 || loc.lengthSq() < 1e-8) return null;
  fwd.normalize(); loc.normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(fwd, loc);
  const v4 = new THREE.Vector4().setAxisAngleFromQuaternion(q);
  return correctAngleSign(v4, axis.normalize());
}

// The two angles (cyclic) where the joint's tilted cone meets the target.
function coneSolve(transform, rest, planeNormal, dist, target, coneAngle) {
  const lt = transform.worldToLocal(target.clone());
  lt.applyQuaternion(transform.quaternion);
  const rotAxis = RAW_AXIS.clone().applyQuaternion(rest);
  let pn = planeNormal.clone();
  if (pn.angleTo(RAW_AXIS) > Math.PI / 2) pn.negate();
  if (dist !== 0) lt.sub(rotAxis.clone().setLength(dist));
  if (coneAngle !== 0) {
    const bend = new THREE.Vector3().crossVectors(rotAxis, lt).normalize();
    lt.applyAxisAngle(bend, coneAngle);
  }
  const npi = pn.applyQuaternion(rest);
  const axisToNormal = rotAxis.angleTo(npi);
  const normalAngleProj = Math.PI / 2 - rotAxis.angleTo(lt);
  const rBack = (Math.PI / 2) * clamp(Math.tan(normalAngleProj) / Math.tan(axisToNormal), -1, 1);
  const backVec = new THREE.Vector3().crossVectors(rotAxis, lt).normalize();
  const flatN = npi.clone().projectOnPlane(rotAxis.clone().normalize()).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(flatN, backVec);
  const v4 = new THREE.Vector4().setAxisAngleFromQuaternion(q);
  const rN2B = correctAngleSign(v4, rotAxis.clone().normalize());
  const other = -(rBack - (-Math.PI / 2)) + (-Math.PI / 2);
  return [rN2B + rBack, rN2B + other];
}

export function createLookAtController({ rig, screenMesh, emitFace, emitEyeDofs, isBusy, dofMax = 3.0 }) {
  const frames = rig.frames;
  const root = rig.root;

  // Screen-quad corners for residual eye gaze (which way the face actually ends
  // up pointing vs. the target).
  const posAttr = screenMesh.geometry.getAttribute('position');
  const uvAttr = screenMesh.geometry.getAttribute('uv');
  const corners = [];
  for (let i = 0; i < posAttr.count; i++) {
    corners.push(new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)));
  }
  const localCenter = corners.reduce((a, c) => a.add(c), new THREE.Vector3())
    .multiplyScalar(1 / corners.length);
  const byUV = (wu, wv) => {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < uvAttr.count; i++) {
      const d = Math.hypot(uvAttr.getX(i) - wu, uvAttr.getY(i) - wv);
      if (d < bd) { bd = d; bi = i; }
    }
    return bi;
  };
  const iTL = byUV(0, 1), iTR = byUV(1, 1), iBL = byUV(0, 0);

  const target = new THREE.Vector3();
  let hasTarget = false;
  let applied = [0, 0, 0];
  const vel = [0, 0, 0];
  let lastT = 0;
  let wasBusy = false;

  const c = new THREE.Vector3(), n = new THREE.Vector3();
  // World-space face-LOCAL right + up axes (computed alongside the normal so the
  // residual gaze can be split into yaw + pitch in the face's own frame, rather
  // than just world-vertical elevation).
  const faceRight = new THREE.Vector3(), faceUp = new THREE.Vector3();
  const a = new THREE.Vector3(), b = new THREE.Vector3();

  function faceNormalElev() {
    screenMesh.updateWorldMatrix(true, false);
    const m = screenMesh.matrixWorld;
    a.copy(corners[iTR]).applyMatrix4(m).sub(b.copy(corners[iTL]).applyMatrix4(m));
    // a is the screen's local +X in world (TL→TR). Save normalized as faceRight.
    faceRight.copy(a).normalize();
    const tl = b.clone();
    b.copy(corners[iBL]).applyMatrix4(m).sub(tl);
    // b is the screen's local -Y (TL→BL). Save +Y as faceUp.
    faceUp.copy(b).negate().normalize();
    n.crossVectors(a, b).normalize();
    c.copy(localCenter).applyMatrix4(m);
    if (n.x * c.x + n.z * c.z < 0) { n.negate(); faceRight.negate(); }
  }

  function setTarget(v) {
    if (v) { target.set(v.x, v.y, v.z); hasTarget = true; }
    else {
      hasTarget = false;
      emitFace('look', { x: 0, y: 0 });
      // Re-center the real eye DOFs too — without this, releasing a be-side
      // lookAt would leave the iris frozen at the last residual position.
      if (emitEyeDofs) emitEyeDofs({ eyeSubRootBn_t: 0, eyeSubRootBn_t_2: 0 });
    }
  }

  function update() {
    if (!hasTarget) return;
    if (isBusy && isBusy()) { wasBusy = true; return; }
    if (wasBusy) { applied = [0, 0, 0]; vel[0] = vel[1] = vel[2] = 0; wasBusy = false; }

    // Solve the goal pose joint-by-joint (transiently posing the rig; this runs
    // after render, so these intermediate poses are never drawn).
    root.updateMatrixWorld(true);
    let gB = pointDOF(frames.bottomSection, REST.bottom, FORWARD, target);
    gB = clamp(gB == null ? applied[0] : gB, -dofMax, dofMax);
    rig.setDof('bottomSection_r', gB);
    root.updateMatrixWorld(true);

    const sols = coneSolve(frames.middleSection, REST.middle, TORSO_PLANE, TORSO_DIST, target, TORSO_CONE);
    const m0 = closestEquiv(sols[0], applied[1]);
    const m1 = closestEquiv(sols[1], applied[1]);
    let gM = Math.abs(m0 - applied[1]) <= Math.abs(m1 - applied[1]) ? m0 : m1;
    gM = clamp(gM, -dofMax, dofMax);
    rig.setDof('middleSection_r', gM);
    root.updateMatrixWorld(true);

    let gT = pointDOF(frames.topSection, REST.top, FORWARD, target);
    gT = clamp(gT == null ? applied[2] : gT, -dofMax, dofMax);

    // Advance each joint under its acceleration limit, decelerating to a stop
    // at the goal (the original PoseOffsetFilter / AccelPlanner behaviour).
    const now = (typeof performance !== 'undefined' ? performance : Date).now();
    let dt = lastT ? (now - lastT) / 1000 : 0;
    lastT = now;
    dt = Math.min(dt, 0.05);
    const goal = [gB, gM, gT];
    const accels = [ACCEL.bottom, ACCEL.middle, ACCEL.top];
    for (let i = 0; i < 3; i++) {
      const p = dt > 0 ? planFixedAccel(vel[i], goal[i] - applied[i], accels[i]) : null;
      if (p) { applied[i] += planDisplacement(p, dt); vel[i] = planVelocity(p, dt); }
    }
    rig.setDof('bottomSection_r', applied[0]);
    rig.setDof('middleSection_r', applied[1]);
    rig.setDof('topSection_r', applied[2]);

    // Eye covers the residual gaze the head couldn't reach. The body
    // does its best to point n→target; whatever's left is the angular
    // gap between n and (target-c), which we split into yaw + pitch in
    // the FACE-LOCAL frame (using faceRight + faceUp built alongside n).
    faceNormalElev();
    const des = target.clone().sub(c).normalize();

    // World-vertical elevation residual — kept for the SHIM eye driver
    // (emitFace), which expects a single normalized [-1,1] y value.
    const residElev = Math.asin(THREE.MathUtils.clamp(des.y, -1, 1))
      - Math.asin(THREE.MathUtils.clamp(n.y, -1, 1));
    emitFace('look', { x: 0, y: THREE.MathUtils.clamp(-residElev * 1.8, -1, 1) });

    // Real-runtime eye DOFs: project des into face-local coords so we
    // can derive yaw (around faceUp) and pitch (around faceRight)
    // independently of world up. Map each angle into its eye DOF via
    // InternalDistance * tan(angle), clamped to MaxValue. The bundle's
    // FaceRenderer reads these as eye-iris screen translations and
    // renders the iris offset accordingly — producing the apparent
    // gaze toward the world target.
    if (emitEyeDofs) {
      const dx = des.dot(faceRight);      // +right of face
      const dy = des.dot(faceUp);         // +up of face
      const dz = des.dot(n);              // +forward (face normal)
      // Yaw: angle in the horizontal (face-right × face-forward) plane.
      // Pitch: angle in the vertical (face-up × face-forward) plane.
      // atan2(opp, adj) — adj is the forward component, opp is the
      // sideways/vertical. Clamp the angle pre-tan to avoid blowup
      // when the target is behind the face (dz <= 0 → eye saturates).
      const yawRad   = Math.atan2(dx, Math.max(dz, 1e-3));
      const pitchRad = Math.atan2(dy, Math.max(dz, 1e-3));
      // Sign convention check: when target is to the FACE'S RIGHT (dx>0),
      // we want the iris to shift right on the screen so the apparent
      // gaze line aims at the target. That's +eyeSubRootBn_t.
      // When target is above (dy>0), iris shifts up = +eyeSubRootBn_t_2.
      const tLR = THREE.MathUtils.clamp(EYE_LR_DIST * Math.tan(THREE.MathUtils.clamp(yawRad, -1.2, 1.2)), -EYE_LR_MAX, EYE_LR_MAX);
      const tUD = THREE.MathUtils.clamp(EYE_UD_DIST * Math.tan(THREE.MathUtils.clamp(pitchRad, -1.2, 1.2)), -EYE_UD_MAX, EYE_UD_MAX);
      emitEyeDofs({ eyeSubRootBn_t: tLR, eyeSubRootBn_t_2: tUD });
    }
  }

  // applied[] is the controller's current per-frame target for the three
  // body sections (post acceleration-limited planner step). Exposing it
  // lets the host send these values back to the iframe so its
  // _bodyState.lastApplied stays in sync with the host-side rig pose —
  // without that, the next animation's pose-offset computation reads a
  // stale value and the body visibly snaps when playback starts.
  function getAppliedBody() {
    return { bottomSection_r: applied[0], middleSection_r: applied[1], topSection_r: applied[2] };
  }
  return { setTarget, update, calibrate() {}, isTracking: () => hasTarget, getAppliedBody };
}
