// Keyframed animations + a linear-interpolation evaluator.
//
// Same data model as the legacy .anim format (channels of dofName + times[] +
// values[]; see animation-utilities AnimationLoader / MotionTrack): each
// channel is sampled by lerping between the bracketing keyframes. The bundled
// jibo_default.anim is only a rest pose, so the built-ins below are
// hand-authored gestures that actually move Jibo.
//
// Internal animation shape:
//   { name, duration, channels: [ { dof, times:[s...], values:[...] } ] }
//
// DOF names understood by the animation service applier:
//   bottomSection_r / middleSection_r / topSection_r  body rotations (rad)
//   led_r / led_g / led_b                             light-ring color (0..1)
//   eye_x / eye_y                                     eye gaze (-1..1)

// Linearly sample one channel at time t (clamped at the ends).
export function sampleChannel(times, values, t) {
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

// Evaluate every channel at time t -> { dof: value }.
export function evaluate(anim, t) {
  const out = {};
  for (const ch of anim.channels) out[ch.dof] = sampleChannel(ch.times, ch.values, t);
  return out;
}

const CYAN = [0.31, 0.79, 1.0];   // #4ec9ff, the resting ring color

export const BUILTINS = {
  // "Yes" — a small bob (middle forward / top back) with the eye glancing down.
  nodYes: {
    name: 'nodYes', duration: 1.2, channels: [
      { dof: 'middleSection_r', times: [0, 0.3, 0.6, 0.9, 1.2], values: [0, 0.22, 0, 0.22, 0] },
      { dof: 'topSection_r',    times: [0, 0.3, 0.6, 0.9, 1.2], values: [0, -0.18, 0, -0.18, 0] },
      { dof: 'eye_y',           times: [0, 0.3, 0.6, 0.9, 1.2], values: [0, 0.45, 0, 0.45, 0] },
    ],
  },
  // "No" — a head shake about the base axis, eye tracking side to side.
  shakeNo: {
    name: 'shakeNo', duration: 1.1, channels: [
      { dof: 'bottomSection_r', times: [0, 0.2, 0.5, 0.8, 1.1], values: [0, -0.28, 0.28, -0.28, 0] },
      { dof: 'eye_x',           times: [0, 0.2, 0.5, 0.8, 1.1], values: [0, -0.3, 0.3, -0.3, 0] },
    ],
  },
  // A slow scan left then right.
  lookAround: {
    name: 'lookAround', duration: 3.0, channels: [
      { dof: 'bottomSection_r', times: [0, 0.8, 1.8, 2.6, 3.0], values: [0, -0.55, 0.55, 0, 0] },
      { dof: 'topSection_r',    times: [0, 0.8, 1.8, 2.6, 3.0], values: [0, 0.12, -0.12, 0, 0] },
      { dof: 'eye_x',           times: [0, 0.8, 1.8, 2.6, 3.0], values: [0, -0.6, 0.6, 0, 0] },
    ],
  },
  // A friendly little hello wiggle.
  greeting: {
    name: 'greeting', duration: 1.6, channels: [
      { dof: 'bottomSection_r', times: [0, 0.35, 0.7, 1.1, 1.6], values: [0, 0.25, -0.18, 0.1, 0] },
      { dof: 'middleSection_r', times: [0, 0.4, 0.9, 1.6], values: [0, 0.14, 0.06, 0] },
      { dof: 'eye_y',           times: [0, 0.4, 0.9, 1.6], values: [0, -0.25, 0.1, 0] },
    ],
  },
  // Excited wiggle with a quick color cycle on the ring.
  happy: {
    name: 'happy', duration: 1.8, channels: [
      { dof: 'bottomSection_r', times: [0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.8], values: [0, 0.2, -0.2, 0.2, -0.2, 0.15, -0.1, 0] },
      { dof: 'middleSection_r', times: [0, 0.3, 0.9, 1.5, 1.8], values: [0, 0.12, -0.06, 0.06, 0] },
      { dof: 'led_r', times: [0, 0.45, 0.9, 1.35, 1.8], values: [1, 0, 0, 1, CYAN[0]] },
      { dof: 'led_g', times: [0, 0.45, 0.9, 1.35, 1.8], values: [0, 1, 0, 0.5, CYAN[1]] },
      { dof: 'led_b', times: [0, 0.45, 0.9, 1.35, 1.8], values: [0, 0, 1, 0.5, CYAN[2]] },
      { dof: 'eye_x', times: [0, 0.45, 0.9, 1.35, 1.8], values: [0, 0.3, -0.3, 0.2, 0] },
    ],
  },
};

// Convert a legacy .anim JSON into the internal shape (body + ring channels;
// the many overlay/vertex/screen channels are ignored for now).
export function fromLegacy(json) {
  const content = json.content || {};
  const rename = {
    lightring_redChannelBn_r: 'led_r',
    lightring_greenChannelBn_r: 'led_g',
    lightring_blueChannelBn_r: 'led_b',
  };
  const keep = new Set(['bottomSection_r', 'middleSection_r', 'topSection_r']);
  const channels = [];
  let duration = 0;
  for (const ch of content.channels || []) {
    const dof = keep.has(ch.dofName) ? ch.dofName : rename[ch.dofName];
    if (!dof) continue;
    const values = ch.values.map((v) => (Array.isArray(v) ? v[0] : v));
    channels.push({ dof, times: ch.times, values });
    const last = ch.times[ch.times.length - 1] || 0;
    duration = Math.max(duration, last, ch.length || 0);
  }
  return { name: content.name || 'legacy', duration: duration || 0.3, channels };
}
