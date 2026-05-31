// jibo.flow — the flow (state-machine) engine, running client-side in the skill
// iframe. Faithful to the public jibo.flow API: a FlowExecutor walks a graph of
// activities (READY -> IN_PROGRESS -> DONE), following the transition whose text
// matches the finished activity's result, until a Flow.End / no transition.
//
// Flow definitions are the GoJS "flow-1" GraphLinksModel the SDK emits:
//   { nodeDataArray: [{ class, id, name, options }], linkDataArray: [{from,to,text}] }
// Option values are either plain values or arrays of code-string lines that
// evaluate to a function/value (the compiled .flow form); real functions are
// also accepted so flows can be authored by hand.
//
// Activities implemented: Flow.Begin, Flow.End, Flow.Eval, Flow.EvalAsync,
// Flow.Wait, Flow.Behavior, Flow.Subtree, Flow.Subflow. (Mim/Menu are TODO.)

export function createFlow(jibo) {
  // Turn an option value into its runtime value: arrays of code lines are
  // eval'd (the .flow compiled form); anything else passes through.
  function evalValue(v) {
    if (Array.isArray(v) && v.every((s) => typeof s === 'string')) {
      // eslint-disable-next-line no-new-func
      return Function(`return (${v.join('\n')});`)();
    }
    return v;
  }
  function evalOptions(options) {
    const out = {};
    for (const k of Object.keys(options || {})) out[k] = evalValue(options[k]);
    return out;
  }

  // --- activities ---
  class Activity {
    constructor(node) {
      this.id = node.id;
      this.class = node.class;
      this.name = node.name || '';
      this.options = evalOptions(node.options);
      this.result = undefined;
      this._done = false;
    }
    start(ctx) {}                 // eslint-disable-line no-unused-vars
    update() { return this._done; }   // returns true when finished
    stop() {}
  }
  class FlowBegin extends Activity {
    start(ctx) {
      if (this.options.inputParameters) Object.assign(ctx.notepad, this.options.inputParameters() || {});
      this._done = true;
    }
  }
  class FlowEnd extends Activity {
    start() { this.result = this.options.getTransition ? this.options.getTransition() : undefined; this._done = true; }
  }
  class FlowEval extends Activity {
    start() { this.result = this.options.exec ? this.options.exec() : undefined; this._done = true; }
  }
  class FlowEvalAsync extends Activity {
    start() {
      this._done = false;
      this.options.exec(
        (res) => { this.result = res; this._done = true; },
        (res) => { this.result = res; this._done = true; },
      );
    }
  }
  class FlowWait extends Activity {
    start() {
      this._done = false;
      const ms = this.options.getTime ? this.options.getTime() : (this.options.time || 0);
      this._t = setTimeout(() => { this._done = true; }, ms);
    }
    stop() { clearTimeout(this._t); }
  }
  // Run a single behavior (or behavior tree) and map its outcome to a transition.
  class FlowBehavior extends Activity {
    start() {
      this._done = false;
      const behavior = this.options.getBehavior ? this.options.getBehavior() : this.options.behavior;
      this._tree = jibo.bt.run(behavior, {}, (status) => {
        this.result = this.options.onResult ? this.options.onResult(status) : undefined;
        this._done = true;
      });
    }
    stop() { if (this._tree && this._tree._cancelRaf) this._tree._cancelRaf(); }
  }
  class FlowSubtree extends FlowBehavior {}   // same: getBehavior + onResult
  class FlowSubflow extends Activity {
    start() {
      this._done = false;
      const def = this.options.getFlow ? this.options.getFlow() : this.options.flow;
      run(def, {}, (result) => { this.result = this.options.onResult ? this.options.onResult(result) : result; this._done = true; });
    }
  }
  // Mim.Question / Mim.Statement: run a Mim behavior; its onSuccess/onFailure
  // return value becomes this activity's result -> the matching transition.
  class FlowMim extends Activity {
    start() {
      this._done = false;
      const mim = new jibo.bt.behaviors.Mim({
        mimPath: this.options.mimPath,
        getPromptData: this.options.getPromptData,
        onStatus: this.options.onStatus,
        onSuccess: this.options.onSuccess,
        onFailure: this.options.onFailure,
      });
      this._tree = jibo.bt.run(mim, {}, () => { this.result = mim.result; this._done = true; });
    }
    stop() { if (this._tree && this._tree._cancelRaf) this._tree._cancelRaf(); }
  }
  class FlowMenu extends Activity {
    start() {
      this._done = false;
      const menu = new jibo.bt.behaviors.Menu({
        getConfig: this.options.getConfig,
        onItemChosen: this.options.onItemChosen,
        onMenuClosed: this.options.onMenuClosed,
        onPositionalSelect: this.options.onPositionalSelect,
      });
      this._tree = jibo.bt.run(menu, {}, () => { this.result = menu.result; this._done = true; });
    }
    stop() { if (this._tree && this._tree._cancelRaf) this._tree._cancelRaf(); }
  }

  const ACTIVITIES = {
    'Flow.Begin': FlowBegin,
    'Flow.End': FlowEnd,
    'Flow.Eval': FlowEval,
    'Flow.EvalAsync': FlowEvalAsync,
    'Flow.Wait': FlowWait,
    'Flow.Behavior': FlowBehavior,
    'Flow.Subtree': FlowSubtree,
    'Flow.Subflow': FlowSubflow,
    'Flow.Mim': FlowMim,
    'Mim.Question': FlowMim,
    'Mim.Statement': FlowMim,
    'Mim.Announcement': FlowMim,
    'Flow.Menu': FlowMenu,
    'Menu.Single': FlowMenu,
    'Menu.Multi': FlowMenu,
  };
  const registry = Object.assign({}, ACTIVITIES);
  function register(name, namespace, classRef) { registry[`${namespace}.${name}`] = classRef; }

  class FlowExecutor {
    constructor(model) {
      this.blackboard = {};
      this.notepad = {};
      this.result = undefined;
      this.emitter = { _l: {}, on(e, f) { (this._l[e] = this._l[e] || []).push(f); return this; }, emit(e, ...a) { (this._l[e] || []).forEach((f) => f(...a)); } };
      this._nodes = {};
      this._links = model.linkDataArray || [];
      for (const node of model.nodeDataArray || []) {
        const Cls = registry[node.class];
        if (!Cls) throw new Error(`unknown flow activity: ${node.class}`);
        this._nodes[node.id] = new Cls(node);
      }
      this._current = (model.nodeDataArray || []).map((n) => this._nodes[n.id])
        .find((a) => a.class === 'Flow.Begin') || this._nodes[(model.nodeDataArray || [])[0]?.id];
      this._started = false;
      this._done = false;
      this._onFinished = null;
    }
    _follow(activity) {
      const out = this._links.filter((l) => l.from === activity.id);
      if (!out.length) return null;
      let link = null;
      if (activity.result != null) link = out.find((l) => l.text === String(activity.result));
      if (!link) link = out.find((l) => !l.text) || out[0];
      return this._nodes[link.to] || null;
    }
    start() { this.emitter.emit('start'); }
    update() {
      if (this._done || !this._current) return false;
      const a = this._current;
      if (!a._started) { a._started = true; a.start(this); }
      if (!a.update()) return true;          // still in progress
      if (a.class === 'Flow.End') { this._finish(a.result); return false; }
      const next = this._follow(a);
      if (!next) { this._finish(a.result); return false; }
      next._started = false;
      this._current = next;
      return true;
    }
    _finish(result) {
      this._done = true;
      this.result = result;
      this.emitter.emit('exit', result);
      if (this._onFinished) this._onFinished(result);
    }
    stop() { if (this._current && this._current.stop) this._current.stop(); this._done = true; return Promise.resolve(); }
    destroy() {}
  }

  function build(def) {
    if (def instanceof FlowExecutor) return def;
    if (typeof def === 'function') return build(def());
    if (def && typeof def === 'object' && def.nodeDataArray) return new FlowExecutor(def);
    throw new Error('flow: cannot build from given definition');
  }

  function create(uri, overrides) { return build(uri); }   // eslint-disable-line no-unused-vars

  function run(uri, overrides, onFinished) {
    let exec = null;
    let raf = 0;
    const tick = () => { if (!exec) return; if (!exec.update()) return; raf = requestAnimationFrame(tick); };
    const begin = (def) => {
      exec = build(def);
      exec._onFinished = onFinished;
      exec.start();
      raf = requestAnimationFrame(tick);
    };
    if (typeof uri === 'string') {
      // a .flow URL relative to the skill bundle
      const handle = { stop: () => cancelAnimationFrame(raf), get result() { return exec && exec.result; } };
      fetch(uri).then((r) => r.json()).then(begin).catch((e) => console.error('flow load failed:', e));
      return handle;
    }
    begin(uri);
    return exec;
  }

  return { FlowExecutor, register, create, run };
}
