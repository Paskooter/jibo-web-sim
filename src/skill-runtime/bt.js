// jibo.bt — the behavior-tree engine, running in the skill iframe (like the
// original, leaf behaviors call the runtime services — here the jibo.* shim).
//
// Faithful to sdk-archive/jibo/src/bt: the Status enum, the Behavior /
// ParentBehavior / Decorator / BehaviorTree lifecycle (_start/_update/_stop with
// decorator wrapping + WAIT), the composites (Sequence/Parallel/Switch/Random),
// the common leaves wired to services, the common decorators, and
// register/create/run. The tree is ticked on requestAnimationFrame, and async
// leaves (Say, LookAt, …) report IN_PROGRESS until their service callback fires.
//
// Trees can be built programmatically (new jibo.bt.behaviors.Sequence({...}))
// or from the compiled .bt node-map format (Factory.build).

export function createBt(jibo) {
  const Status = {
    SUCCEEDED: 0, FAILED: 1, INTERRUPTED: 2, IN_PROGRESS: 3, INVALID: 4, PAUSED: 5, WAIT: 6,
  };
  const isTerminal = (s) => s === Status.SUCCEEDED || s === Status.FAILED || s === Status.INTERRUPTED;

  class BehaviorEmitter {
    constructor() { this._l = {}; }
    on(e, f) { (this._l[e] = this._l[e] || []).push(f); return this; }
    off(e, f) { const a = this._l[e]; if (a) a.splice(a.indexOf(f) >>> 0, a.indexOf(f) >= 0 ? 1 : 0); return this; }
    emit(e, ...args) { (this._l[e] || []).slice().forEach((f) => f(...args)); return this; }
  }

  class BaseElement {
    constructor(options, defaults) {
      this.options = Object.assign({}, defaults, options);
      this.name = this.options.name || '';
      this.blackboard = this.options.blackboard;
      this.emitter = this.options.emitter;
      this.assetPack = this.options.assetPack;
      this.currentStatus = Status.INVALID;
    }
    start() { return true; }
    update() { return Status.SUCCEEDED; }
    stop() { return Promise.resolve(); }
    destroy() {}
  }

  class Decorator extends BaseElement {
    constructor(options, defaults) { super(options, defaults); this.behavior = null; }
    // start() may return Status.WAIT to delay the behavior's start.
    start() { return true; }
    update(result) { return result; }
  }

  class Behavior extends BaseElement {
    constructor(options, defaults) {
      super(options, defaults);
      this.parent = null;
      this.decorators = this.options.decorators || [];
    }
    _start() {
      this.currentStatus = Status.IN_PROGRESS;
      this._waiting = [];
      this._failedAtStart = false;
      for (const d of this.decorators) {
        d.behavior = this;
        const r = d.start();                      // WAIT delays start; FAILED gates it
        if (r === Status.WAIT) this._waiting.push(d);
        else if (r === Status.FAILED) this._failedAtStart = true;
      }
      if (this._failedAtStart) { this.currentStatus = Status.FAILED; this._started = false; return true; }
      this._started = this._waiting.length === 0;
      if (this._started && this.start() === false) this.currentStatus = Status.FAILED;
      return true;
    }
    _update() {
      if (this._failedAtStart) return Status.FAILED;   // a gating decorator (Case) blocked it
      if (!this._started) {
        this._waiting = this._waiting.filter((d) => d.update(Status.WAIT) === Status.WAIT);
        if (this._waiting.length) return Status.IN_PROGRESS;
        this._started = true;
        if (this.start() === false) { this.currentStatus = Status.FAILED; return Status.FAILED; }
      }
      let status = this.update();
      for (const d of this.decorators) status = d.update(status);
      this.currentStatus = status;
      return status;
    }
    _stop() {
      const ps = [this.stop()];
      for (const d of this.decorators) if (d.currentStatus === Status.IN_PROGRESS) ps.push(d.stop());
      this.currentStatus = Status.INTERRUPTED;
      return Promise.all(ps);
    }
  }

  class ParentBehavior extends Behavior {
    constructor(options, defaults) { super(options, defaults); this.children = this.options.children || []; }
    _stop() {
      const ps = [];
      for (const c of this.children) if (c.currentStatus === Status.IN_PROGRESS) ps.push(c._stop());
      return Promise.all([...ps, super._stop()]);
    }
  }

  // ---- composites ----
  class Sequence extends ParentBehavior {
    start() { this._i = 0; return this.children.length ? this.children[0]._start() : true; }
    update() {
      if (!this.children.length) return Status.SUCCEEDED;
      const s = this.children[this._i]._update();
      if (s === Status.SUCCEEDED) {
        this._i++;
        if (this._i >= this.children.length) return Status.SUCCEEDED;
        this.children[this._i]._start();
        return Status.IN_PROGRESS;
      }
      return s === Status.FAILED ? Status.FAILED : Status.IN_PROGRESS;
    }
  }
  class Switch extends ParentBehavior {   // selector / priority
    start() { this._i = 0; return this.children.length ? this.children[0]._start() : true; }
    update() {
      if (this._i >= this.children.length) return Status.SUCCEEDED;
      const s = this.children[this._i]._update();
      if (s === Status.FAILED) {
        this._i++;
        if (this._i >= this.children.length) return Status.SUCCEEDED;
        this.children[this._i]._start();
        return Status.IN_PROGRESS;
      }
      return s === Status.SUCCEEDED ? Status.SUCCEEDED : Status.IN_PROGRESS;
    }
  }
  class Parallel extends ParentBehavior {
    start() {
      this._active = this.children.slice();
      this._failed = false;
      for (const c of this._active) c._start();
      return true;
    }
    update() {
      const succeedOnOne = this.options.succeedOnOne;
      const still = [];
      for (const c of this._active) {
        const s = c._update();
        if (s === Status.SUCCEEDED) { if (succeedOnOne) { this._stopOthers(c); return Status.SUCCEEDED; } }
        else if (s === Status.FAILED) { this._failed = true; }
        else { still.push(c); }
      }
      this._active = still;
      if (this._failed) return Status.FAILED;
      return this._active.length ? Status.IN_PROGRESS : Status.SUCCEEDED;
    }
    _stopOthers(except) { for (const c of this._active) if (c !== except && c.currentStatus === Status.IN_PROGRESS) c._stop(); }
  }
  class Random extends ParentBehavior {
    start() {
      this._chosen = this.children[Math.floor(Math.random() * this.children.length)] || null;
      return this._chosen ? this._chosen._start() : true;
    }
    update() { return this._chosen ? this._chosen._update() : Status.SUCCEEDED; }
  }

  // ---- leaves ----
  // Async leaves set this._done in a service callback; update() returns it.
  class AsyncLeaf extends Behavior {
    start() { this._done = Status.IN_PROGRESS; this.begin(); return true; }
    update() { return this._done; }
    begin() {}
  }
  class Null extends Behavior { update() { return Status.SUCCEEDED; } }
  class ExecuteScript extends Behavior {
    start() { if (this.options.exec) this.options.exec(); return true; }
    update() { return Status.SUCCEEDED; }
  }
  class ExecuteScriptAsync extends AsyncLeaf {
    begin() {
      this.options.exec(
        () => { this._done = Status.SUCCEEDED; },
        () => { this._done = Status.FAILED; },
      );
    }
  }
  class TextToSpeech extends AsyncLeaf {
    begin() {
      const words = this.options.getWords ? this.options.getWords() : this.options.words;
      jibo.tts.speak(words, () => { this._done = Status.SUCCEEDED; });
    }
    stop() { jibo.tts.stop(); return Promise.resolve(); }
  }
  class Blink extends Behavior {
    start() { jibo.animate.blink(); return true; }
    update() { return Status.SUCCEEDED; }
  }
  class LookAt extends AsyncLeaf {
    begin() {
      const t = this.options.getTarget();
      jibo.animate.lookAt(t, () => { this._done = Status.SUCCEEDED; });
    }
  }
  class PlayAnimation extends AsyncLeaf {
    begin() { jibo.animate.play(this.options.animPath, () => { this._done = Status.SUCCEEDED; }); }
    stop() { jibo.animate.stop(); return Promise.resolve(); }
  }
  class PlayAudio extends AsyncLeaf {
    begin() {
      const path = this.options.audioPath;
      const s = jibo.sound.add(path, path);
      s.play(() => { this._done = Status.SUCCEEDED; });
    }
  }
  class TakePhoto extends AsyncLeaf {
    begin() {
      jibo.lps.takePhoto(this.options.resolution, this.options.noDistortion,
        jibo.lps.CameraID.LEFT, jibo.lps.PhotoType.FULL, (err, url) => {
          if (this.options.onPhoto) this.options.onPhoto(err || url);
          this._done = Status.SUCCEEDED;
        });
    }
  }
  class TimeoutJs extends AsyncLeaf {   // succeeds after getTime() ms
    begin() {
      const ms = this.options.getTime ? this.options.getTime() : (this.options.time || 0);
      this._t = setTimeout(() => { this._done = Status.SUCCEEDED; }, ms);
    }
    stop() { clearTimeout(this._t); return Promise.resolve(); }
  }

  // ---- decorators ----
  class TimeoutSucceed extends Decorator {
    start() { this._t0 = Date.now(); return true; }
    update(result) {
      if (isTerminal(result)) return result;
      return Date.now() - this._t0 >= this.options.timeout ? Status.SUCCEEDED : result;
    }
  }
  class TimeoutSucceedJs extends TimeoutSucceed {
    start() { this._t0 = Date.now(); this.options.timeout = this.options.getTime(); return true; }
  }
  class TimeoutFail extends Decorator {
    start() { this._t0 = Date.now(); return true; }
    update(result) {
      if (isTerminal(result)) return result;
      return Date.now() - this._t0 >= this.options.timeout ? Status.FAILED : result;
    }
  }
  class SucceedOnCondition extends Decorator {
    start() { if (this.options.init) this.options.init(); return true; }
    update(result) { return this.options.conditional() ? Status.SUCCEEDED : result; }
  }
  class FailOnCondition extends Decorator {
    start() { if (this.options.init) this.options.init(); return true; }
    update(result) { return this.options.conditional() ? Status.FAILED : result; }
  }
  class StartOnCondition extends Decorator {
    start() { if (this.options.init) this.options.init(); return this.options.conditional() ? true : Status.WAIT; }
    update(result) { return result === Status.WAIT ? (this.options.conditional() ? Status.IN_PROGRESS : Status.WAIT) : result; }
  }
  class WhileCondition extends Decorator {
    start() { if (this.options.init) this.options.init(); return true; }
    update(result) {
      if (result === Status.SUCCEEDED && this.options.conditional()) { this.behavior._start(); return Status.IN_PROGRESS; }
      return result;
    }
  }
  class Case extends Decorator {   // gates the behavior: fails (without running) if false
    start() { return this.options.conditional() ? true : Status.FAILED; }
    update(result) { return result; }
  }

  class BehaviorTree extends BehaviorEmitter {
    constructor(root) { super(); this.root = root; }
    get currentStatus() { return this.root.currentStatus; }
    start() { this.root._start(); this.emit('start'); return true; }
    update() { return this.root._update(); }
    stop() { this.emit('stop'); return this.root._stop(); }
    destroy() { this.root.destroy(); }
  }

  const behaviors = {
    Sequence, Switch, Parallel, Random, Null, ExecuteScript, ExecuteScriptAsync,
    TextToSpeech, TextToSpeechJs: TextToSpeech, Blink, LookAt, PlayAnimation, PlayAudio,
    TakePhoto, TimeoutJs,
  };
  const decorators = {
    TimeoutSucceed, TimeoutSucceedJs, TimeoutFail, SucceedOnCondition, FailOnCondition,
    StartOnCondition, WhileCondition, Case,
  };

  // registry for register()/Factory
  const registry = { core: Object.assign({}, behaviors, decorators) };
  function register(name, namespace, classRef) {
    (registry[namespace] = registry[namespace] || {})[name] = classRef;
  }
  function lookup(cls, ns) {
    return (registry[ns] && registry[ns][cls]) || registry.core[cls];
  }

  // Build a tree from the compiled .bt node-map { id: {class, children, decorators, options, parent, asset-pack} }
  function buildFromMap(map) {
    const made = {};
    for (const id of Object.keys(map)) {
      if (id === 'meta') continue;
      const node = typeof map[id] === 'function' ? map[id]() : map[id];
      const Cls = lookup(node.class, node['asset-pack'] || 'core');
      if (!Cls) throw new Error(`unknown behavior class: ${node.class}`);
      made[id] = new Cls(Object.assign({ name: node.name }, { options: node.options }, node.options || {}));
      made[id]._node = node;
    }
    let root = null;
    for (const id of Object.keys(made)) {
      const node = made[id]._node;
      if (node.children) made[id].children = node.children.map((c) => made[c]);
      if (node.decorators) made[id].decorators = node.decorators.map((d) => made[d]);
      if (node.parent == null && node.class !== undefined && !isDecorator(node.class)) root = made[id];
    }
    return new BehaviorTree(root);
  }
  const isDecorator = (cls) => !!decorators[cls];

  function toTree(def, overrides) {
    if (def instanceof BehaviorTree) return def;
    if (def instanceof Behavior) return new BehaviorTree(def);
    if (typeof def === 'function') return toTree(def(overrides || {}), overrides);
    if (def && typeof def === 'object') return buildFromMap(def);
    throw new Error('bt: cannot build tree from given definition');
  }

  function create(uri, overrides) { return toTree(uri, overrides); }

  function run(uri, overrides, onFinished) {
    const tree = toTree(uri, overrides);
    let raf = 0;
    const tick = () => {
      if (isTerminal(tree.currentStatus)) {
        const finalStatus = tree.currentStatus;   // capture before stop() marks INTERRUPTED
        tree.stop();
        if (onFinished) onFinished(finalStatus);
        return;
      }
      tree.update();
      raf = requestAnimationFrame(tick);
    };
    tree.start();
    raf = requestAnimationFrame(tick);
    tree._cancelRaf = () => cancelAnimationFrame(raf);
    return tree;
  }

  return {
    Status, BehaviorEmitter, BaseElement, Behavior, ParentBehavior, Decorator, BehaviorTree,
    behaviors, decorators, Blackboard: {}, register, create, run,
  };
}
