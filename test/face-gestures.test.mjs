// Unit test for src/ui/face-gestures.js: the tap / drag logic shared by the 3D screen and
// the screen dock. Pure logic, no browser.
//
// Usage: node test/face-gestures.test.mjs

import assert from 'node:assert/strict';
import { createFaceGestures } from '../src/ui/face-gestures.js';

let now = 1000;
Object.defineProperty(globalThis.performance, 'now', { configurable: true, value: () => now });

const ev = (x, y) => ({ clientX: x, clientY: y });
const onScreen = (e) => ({ x: e.clientX, y: e.clientY });   // face coords = client coords
const offScreen = () => null;

function setup(opts = {}) {
  const out = [];
  const g = createFaceGestures({ emit: (event, data) => out.push({ event, ...data }), ...opts });
  return { g, out };
}

const tests = {
  'a quick press and release is a tap at the release point'() {
    const { g, out } = setup();
    g.down(ev(10, 20), onScreen); now += 100; g.up(ev(12, 21), onScreen);
    assert.deepEqual(out, [{ event: 'touch', x: 12, y: 21 }]);
  },
  'jitter within 6 px still counts as a tap'() {
    const { g, out } = setup();
    g.down(ev(0, 0), onScreen); g.move(ev(3, 3), onScreen); now += 50; g.up(ev(3, 3), onScreen);
    assert.equal(out.length, 1); assert.equal(out[0].event, 'touch');
  },
  'a press held longer than 350 ms is not a tap'() {
    const { g, out } = setup();
    g.down(ev(0, 0), onScreen); now += 400; g.up(ev(0, 0), onScreen);
    assert.deepEqual(out, []);
  },
  'a drag sends pans with movement, then a final pan, and no tap'() {
    const { g, out } = setup();
    g.down(ev(0, 0), onScreen);
    g.move(ev(20, 0), onScreen); g.move(ev(50, 10), onScreen);
    now += 500; g.up(ev(50, 10), onScreen);
    assert.deepEqual(out.map((e) => e.event), ['pan', 'pan', 'pan']);
    assert.deepEqual([out[0].movementX, out[1].movementX, out[1].movementY], [20, 30, 10]);
    assert.deepEqual(out.map((e) => e.isFinal), [false, false, true]);
    assert.deepEqual([out[2].x, out[2].y], [50, 10]);
  },
  'a press that starts off the screen does nothing'() {
    const { g, out } = setup();
    g.down(ev(0, 0), offScreen); g.move(ev(50, 0), onScreen); now += 50; g.up(ev(50, 0), onScreen);
    assert.deepEqual(out, []);
  },
  'isBlocked (camera gesture) stops a pan from starting, and from continuing'() {
    let blocked = true;
    const { g, out } = setup({ isBlocked: () => blocked });
    g.down(ev(0, 0), onScreen); g.move(ev(50, 0), onScreen); g.up(ev(50, 0), onScreen);
    assert.deepEqual(out, [], 'blocked at press: no pan, no final pan');

    blocked = false;
    g.down(ev(0, 0), onScreen); g.move(ev(20, 0), onScreen);
    blocked = true;                                      // e.g. Ctrl pressed mid-drag
    g.move(ev(60, 0), onScreen);
    assert.equal(out.filter((e) => e.event === 'pan' && !e.isFinal).length, 1, 'no pan while blocked');
  },
  'a quick tap is still a touch while blocked (Ctrl held)'() {
    const { g, out } = setup({ isBlocked: () => true });
    g.down(ev(5, 5), onScreen); now += 50; g.up(ev(5, 5), onScreen);
    // down() started no drag, but a quick click is always a face touch (used for menus)
    assert.deepEqual(out, [{ event: 'touch', x: 5, y: 5 }]);
  },
  'isHolding (double-tap-hold camera pan) swallows the release'() {
    const { g, out } = setup({ isHolding: () => true });
    g.down(ev(0, 0), onScreen); g.move(ev(50, 0), onScreen); g.up(ev(50, 0), onScreen);
    assert.ok(!out.some((e) => e.isFinal), 'no final pan');
    g.down(ev(0, 0), onScreen); now += 30; g.up(ev(0, 0), onScreen);
    assert.ok(!out.some((e) => e.event === 'touch'), 'no tap');
  },
  'state does not leak: a drag, then a tap'() {
    const { g, out } = setup();
    g.down(ev(0, 0), onScreen); g.move(ev(40, 0), onScreen); g.up(ev(40, 0), onScreen);
    out.length = 0;
    now += 1000; g.down(ev(7, 7), onScreen); now += 60; g.up(ev(7, 7), onScreen);
    assert.deepEqual(out, [{ event: 'touch', x: 7, y: 7 }]);
  },
  'an abort with no mapping (pointercancel) ends a pan but sends no tap'() {
    const { g, out } = setup();
    g.down(ev(0, 0), onScreen); g.move(ev(40, 0), onScreen);
    g.up(ev(40, 0), offScreen);
    assert.equal(out[out.length - 1].isFinal, true);
    out.length = 0;
    g.down(ev(0, 0), onScreen); now += 20; g.up(ev(0, 0), offScreen);
    assert.deepEqual(out, [], 'a cancelled press is not a tap');
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message.split('\n').join('\n      ')}`); }
}
console.log(failed ? `\n${failed} test(s) FAILED` : '\nall tests passed');
process.exit(failed ? 1 : 0);
