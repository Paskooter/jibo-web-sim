// Smaller client-side jibo namespaces implemented in the skill iframe:
// timer, utils, loader, lifecycle, versions. Shaped after sdk-archive/jibo
// (utils.d.ts, loader.d.ts, lifecycle, versions.d.ts) so real skills that use
// jibo.timer.on('update'), jibo.utils.DelayedCall, jibo.loader.load,
// jibo.lifecycle.finished(), etc. keep working.

// jibo.timer — emits 'update' every animation frame (the runtime heartbeat).
export function createTimer() {
  const listeners = new Set();
  let last = performance.now();
  let raf = 0;
  function tick(now) {
    const dt = (now - last) / 1000;
    last = now;
    for (const f of [...listeners]) f(dt, now);
    raf = requestAnimationFrame(tick);
  }
  raf = requestAnimationFrame(tick);
  return {
    on(ev, fn) { if (ev === 'update') listeners.add(fn); return this; },
    off(ev, fn) { listeners.delete(fn); return this; },
    removeListener(ev, fn) { listeners.delete(fn); return this; },
    start() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); } },
    stop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } },
  };
}

// jibo.utils — DelayedCall (cancellable timeout, seconds) + PathUtils.
export function createUtils() {
  class DelayedCall {
    constructor(fn, seconds) { this._fn = fn; this._id = setTimeout(() => { this._id = null; fn(); }, (seconds || 0) * 1000); }
    cancel() { if (this._id) { clearTimeout(this._id); this._id = null; } }
    reset(seconds) { this.cancel(); this._id = setTimeout(this._fn, (seconds || 0) * 1000); }
    get pending() { return this._id != null; }
  }
  const PathUtils = {
    join(...parts) { return parts.filter(Boolean).join('/').replace(/\/{2,}/g, '/'); },
    resolve(p) { return p; },
    basename(p) { return String(p).split('/').pop(); },
  };
  return { DelayedCall, PathUtils };
}

// jibo.loader — asset loader. Sounds register with jibo.sound; JSON-ish assets
// (anim/flow/bt/json) are fetched; everything else resolves to its URL.
export function createLoader(sound) {
  function guessType(src) {
    if (!src) return 'unknown';
    if (/\.(mp3|wav|ogg|m4a)$/i.test(src)) return 'sound';
    if (/\.(png|jpe?g|gif|webp)$/i.test(src)) return 'image';
    if (/\.(json|anim|flow|bt|keys)$/i.test(src)) return 'json';
    return 'unknown';
  }
  function load(asset, complete) {
    const src = typeof asset === 'string' ? asset : (asset && asset.src);
    const type = (asset && asset.type) || guessType(src);
    if (type === 'sound') {
      const s = sound.add(src, src);
      if (complete) complete(null, s);
      return { running: false, numLoaded: 1, total: 1, asset: s };
    }
    if (type === 'json' || type === 'keys') {
      const handle = { running: true, numLoaded: 0, total: 1 };
      fetch(src).then((r) => r.json())
        .then((d) => { handle.running = false; handle.numLoaded = 1; if (complete) complete(null, d); })
        .catch((e) => { handle.running = false; if (complete) complete(e); });
      return handle;
    }
    if (complete) complete(null, { src });
    return { running: false, numLoaded: 1, total: 1, asset: { src } };
  }
  return { load };
}

// jibo.lifecycle — skills call finished() to signal completion.
export function createLifecycle() {
  const listeners = {};
  return {
    finished(cb) {
      (listeners.finished || []).slice().forEach((f) => f());
      if (cb) cb();
    },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return this; },
    off(ev, fn) { const a = listeners[ev]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } return this; },
  };
}

export function createVersions() {
  return { sdk: '0.0.0-websim', firmware: 'websim', robot: 'websim', api: '1.0' };
}
