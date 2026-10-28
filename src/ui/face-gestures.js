// Turns pointer input over Jibo's screen into face gestures: a quick click is a
// tap ('touch'), a drag is a pan, both in face pixel coords. Shared by the 3D
// screen (raycast) and the screen dock (flat mapping), so both behave the same.
//
// The caller feeds pointer events plus a `faceAt(e)` that maps the event to a
// face point ({x, y}) or null when it isn't over the screen.
//   isBlocked(): a camera gesture owns the pointer (Ctrl-orbit, double-tap-hold);
//                 don't start or continue a pan.
//   isHolding(): the double-tap-hold camera pan is active; swallow the release.

const MOVE_SLOP = 6;      // px of jitter still counted as a tap
const TAP_MAX_MS = 350;

export function createFaceGestures({ emit, isBlocked = () => false, isHolding = () => false }) {
  let downX = 0, downY = 0, downT = 0;
  let dragging = false, panned = false;
  let pfx = 0, pfy = 0;

  function down(e, faceAt) {
    downX = e.clientX; downY = e.clientY; downT = performance.now(); dragging = false; panned = false;
    if (isBlocked()) return;
    const f = faceAt(e);
    if (f) { dragging = true; pfx = f.x; pfy = f.y; }
  }

  function move(e, faceAt) {
    if (!dragging || isBlocked()) return;
    if (!panned && Math.hypot(e.clientX - downX, e.clientY - downY) <= MOVE_SLOP) return; // ignore tap jitter
    const f = faceAt(e);
    if (!f) return;
    panned = true;
    emit('pan', { x: f.x, y: f.y, movementX: f.x - pfx, movementY: f.y - pfy, isFinal: false });
    pfx = f.x; pfy = f.y;
  }

  function up(e, faceAt) {
    if (isHolding()) { dragging = false; panned = false; return; }
    if (dragging && panned) {
      emit('pan', { x: pfx, y: pfy, movementX: 0, movementY: 0, isFinal: true });
    } else if (Math.hypot(e.clientX - downX, e.clientY - downY) <= MOVE_SLOP && performance.now() - downT <= TAP_MAX_MS) {
      // Tap on the face. Allowed regardless of the orbit modifier state:
      // a single quick tap is always a face touch (used to tap menu items
      // etc.). A real drag moves > 6 px before release, so the tap branch
      // doesn't fire then.
      const f = faceAt(e);
      if (f) emit('touch', f);
    }
    dragging = false; panned = false;
  }

  // Where the last press started, which main.js's double-tap detection needs.
  return {
    down, move, up,
    get downX() { return downX; },
    get downY() { return downY; },
    get downT() { return downT; },
  };
}
