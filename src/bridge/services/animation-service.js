// animation service — fulfils jibo.animate.play / stop / setLEDColor / blink.
//
// Plays a keyframed animation on a clock, sampling its channels each frame and
// applying the resulting DOF values to the live rig (body rotations + LED ring)
// and to the iframe eye (via 'face' events). play() resolves when the
// animation finishes (mirroring how the original animate builders signal an
// AnimationEventType.STOPPED), so skills can `await` a gesture. A new play()
// interrupts the current one.

import { evaluate, BUILTINS, fromLegacy } from '../../anim/animation.js';

const RING_REST = [0.31, 0.79, 1.0];   // #4ec9ff

export function createAnimationService({ rig, emitFace, loadAnim }) {
  let raf = 0;
  let token = 0;
  let activeResolve = null;

  function applyDofs(map) {
    if ('bottomSection_r' in map) rig.setDof('bottomSection_r', map.bottomSection_r);
    if ('middleSection_r' in map) rig.setDof('middleSection_r', map.middleSection_r);
    if ('topSection_r' in map) rig.setDof('topSection_r', map.topSection_r);

    if ('led_r' in map || 'led_g' in map || 'led_b' in map) {
      rig.setLEDColor(
        map.led_r ?? RING_REST[0],
        map.led_g ?? RING_REST[1],
        map.led_b ?? RING_REST[2],
      );
    }
    if ('eye_x' in map || 'eye_y' in map) {
      emitFace('look', { x: map.eye_x || 0, y: map.eye_y || 0 });
    }
  }

  function settle() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    const resolve = activeResolve;
    activeResolve = null;
    token++;
    if (resolve) resolve();
  }

  function getAnim(nameOrUri) {
    if (BUILTINS[nameOrUri]) return Promise.resolve(BUILTINS[nameOrUri]);
    if (/\.anim$/.test(nameOrUri) && loadAnim) {
      return loadAnim(nameOrUri).then(fromLegacy);
    }
    return Promise.reject(new Error(`unknown animation: ${nameOrUri}`));
  }

  function play(nameOrUri, options = {}) {
    return getAnim(nameOrUri).then((anim) => new Promise((resolve) => {
      settle();                              // interrupt anything in flight
      const myToken = ++token;
      activeResolve = resolve;
      const loop = !!(options && options.loop);
      const dur = anim.duration || 0.001;
      const start = performance.now();

      const tick = (now) => {
        if (myToken !== token) return;
        let t = (now - start) / 1000;
        if (!loop && t >= dur) {
          applyDofs(evaluate(anim, dur));    // land exactly on the final pose
          settle();
          return;
        }
        applyDofs(evaluate(anim, loop ? t % dur : t));
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }));
  }

  function stop() {
    settle();
    return Promise.resolve();
  }

  function setLEDColor(r, g, b) {
    rig.setLEDColor(r, g, b);
  }

  function blink() {
    emitFace('blink', {});
  }

  // True while a gesture is playing (look-at yields to it).
  function isActive() {
    return activeResolve !== null;
  }

  return { play, stop, setLEDColor, blink, isActive };
}
