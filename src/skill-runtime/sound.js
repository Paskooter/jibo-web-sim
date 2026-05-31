// jibo.sound — client-side audio, implemented in the skill iframe (like the
// eye, it needs no host round-trip). API mirrors the public jibo.sound
// surface so skills written against it work unchanged: add/play/stop/pause/resume,
// *All helpers, Sound / SoundInstance, SoundUtils.sineTone. File sounds use
// HTMLAudioElement (src resolved relative to the skill bundle); sineTone uses
// Web Audio. Audio is unblocked by the host's "Start" gesture.

export function createSound() {
  const registry = new Map();   // alias -> Sound
  let muted = false;
  let audioCtx = null;
  const getCtx = () => (audioCtx ||= new (window.AudioContext || window.webkitAudioContext)());

  class SoundInstance {
    constructor() { this.paused = false; this._el = null; this._tone = null; this._listeners = {}; }
    on(ev, fn) { (this._listeners[ev] ||= []).push(fn); return this; }
    _emit(ev) { (this._listeners[ev] || []).forEach((f) => f(this)); }
    stop() {
      if (this._el) { this._el.pause(); this._el.currentTime = 0; }
      if (this._tone) { try { this._tone.stop(); } catch (_) { /* already stopped */ } }
      this._emit('end');
    }
    play(offset) {
      if (this._el) { if (offset) this._el.currentTime = offset; this._el.play().catch(() => {}); }
      this.paused = false;
    }
    pause() { if (this._el) { this._el.pause(); this.paused = true; } }
    destroy() { this.stop(); }
  }

  class Sound {
    constructor(alias, options) {
      if (typeof options === 'string') options = { src: options };
      options = options || {};
      this.alias = alias;
      this.src = options.src;
      this.volume = options.volume != null ? options.volume : 1;
      this.loop = !!options.loop;
      this.autoPlay = !!options.autoPlay;
      this.complete = options.complete;
      this.isPlaying = false;
      this.isLoaded = false;
      this.instances = [];
      this._toneFn = options._toneFn || null;
      if (this.autoPlay) this.play();
    }
    play(options) {
      let complete = this.complete;
      if (typeof options === 'function') { complete = options; options = {}; }
      options = options || {};
      if (options.complete) complete = options.complete;

      const inst = new SoundInstance();
      this.instances.push(inst);
      this.isPlaying = true;

      if (this._toneFn) {
        inst._tone = this._toneFn(muted ? 0 : this.volume, () => {
          this.isPlaying = false; inst._emit('end'); if (complete) complete(this);
        });
        return inst;
      }
      const el = new Audio(this.src);
      el.volume = muted ? 0 : this.volume;
      el.loop = this.loop;
      if (options.offset) el.currentTime = options.offset;
      el.addEventListener('canplaythrough', () => { this.isLoaded = true; });
      el.addEventListener('ended', () => {
        this.isPlaying = false; inst._emit('end'); if (complete) complete(this);
      });
      inst._el = el;
      el.play().catch(() => {});
      return inst;
    }
    stop() { this.instances.forEach((i) => i.stop()); this.instances = []; this.isPlaying = false; return this; }
    pause() { this.instances.forEach((i) => i.pause()); return this; }
    resume() { this.instances.forEach((i) => { if (i.paused) i.play(); }); return this; }
    _setMute(m) { this.instances.forEach((i) => { if (i._el) i._el.volume = m ? 0 : this.volume; }); }
  }

  const ns = {
    basePath: '',
    baseUrl: '',
    Sound,
    SoundInstance,
    add(alias, options) { const s = new Sound(alias, options); registry.set(alias, s); return s; },
    addMap(map, globalOptions) {
      const out = {};
      for (const k of Object.keys(map)) {
        const o = typeof map[k] === 'string' ? { src: map[k] } : map[k];
        out[k] = ns.add(k, Object.assign({}, globalOptions, o));
      }
      return out;
    },
    remove(alias) { const s = registry.get(alias); if (s) s.stop(); registry.delete(alias); return ns; },
    removeAll() { ns.stopAll(); registry.clear(); return ns; },
    exists(alias, assert) {
      const has = registry.has(alias);
      if (!has && assert) throw new Error(`sound not found: ${alias}`);
      return has;
    },
    sound(alias) { return registry.get(alias); },
    play(alias, options) {
      const s = registry.get(alias);
      if (!s) throw new Error(`sound not found: ${alias}`);
      return s.play(options);
    },
    stop(alias) { const s = registry.get(alias); if (s) s.stop(); return s; },
    pause(alias) { const s = registry.get(alias); if (s) s.pause(); return s; },
    resume(alias) { const s = registry.get(alias); if (s) s.resume(); return s; },
    stopAll() { registry.forEach((s) => s.stop()); return ns; },
    pauseAll() { registry.forEach((s) => s.pause()); return ns; },
    resumeAll() { registry.forEach((s) => s.resume()); return ns; },
    muteAll() { muted = true; registry.forEach((s) => s._setMute(true)); return ns; },
    unmuteAll() { muted = false; registry.forEach((s) => s._setMute(false)); return ns; },
    SoundUtils: {
      sineTone(hertz, seconds) {
        return new Sound(`tone:${hertz}`, {
          _toneFn: (vol, done) => {
            const c = getCtx();
            const osc = c.createOscillator();
            const gain = c.createGain();
            osc.frequency.value = hertz;
            gain.gain.value = vol * 0.25;
            osc.connect(gain); gain.connect(c.destination);
            osc.start();
            osc.stop(c.currentTime + seconds);
            osc.onended = done;
            return osc;
          },
        });
      },
      playOnce(src, callback) {
        new Sound('__once__', { src, complete: () => callback && callback() }).play();
        return '__once__';
      },
    },
  };
  return ns;
}
