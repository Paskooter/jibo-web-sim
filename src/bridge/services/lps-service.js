// lps service — Local Perceptual Space (Jibo's model of targets around it).
//
// The original LPSService tracked entities/targets the robot perceived and the
// skill could query/subscribe to them (jibo-cli lps-view + MouseTargetPositioner).
// Here the host (LPS tab / shift-click in the viewport) sets a single target;
// we hold it, notify the skill via 'lps' events, and the look-at controller
// turns Jibo toward it.
//
// Returns { service, setTarget }:
//   service    — skill-callable methods (getTarget) registered on the bridge.
//   setTarget  — host-only entry point the UI / placement calls.

export function createLpsService({ emit }) {
  let target = null;   // { x, y, z } | null

  return {
    service: {
      getTarget() { return target; },
    },
    setTarget(v) {
      target = v ? { x: v.x, y: v.y, z: v.z } : null;
      if (target) emit('target', target);
      else emit('target-lost', {});
    },
  };
}
