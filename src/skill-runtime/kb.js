// jibo.kb — knowledge base. A graph store (Nodes with data + edges) plus the
// "loop" (the people Jibo knows). API shaped after sdk-archive/jibo dts/kb.d.ts
// (Model / Node / LoopModel / UserNode, createModel, kb.loop) so skills work;
// backed by an in-memory store in the iframe (no cloud DB in the sim). Methods
// take a node-style callback or return a Promise, matching the dts.

export function createKb() {
  let seq = 0;
  const genId = (p) => `${p}-${++seq}-${Date.now().toString(36)}`;

  class Node {
    constructor(type, data) {
      this._id = genId('node');
      this.type = type || 'node';
      this.data = data || {};
      this.edges = {};
      this.assets = {};
      this.created = Date.now();
      this.updated = this.created;
      this._model = null;
    }
    save(cb) {
      this.updated = Date.now();
      if (this._model) this._model._store.set(this._id, this);
      if (cb) { cb(null); return undefined; }
      return Promise.resolve();
    }
    remove(cb) {
      if (this._model) this._model._store.delete(this._id);
      if (cb) { cb(null); return undefined; }
      return Promise.resolve();
    }
    addEdges(idsOrNodes, layer = 'default') {
      const arr = Array.isArray(idsOrNodes) ? idsOrNodes : [idsOrNodes];
      const ids = arr.map((x) => (typeof x === 'string' ? x : x._id));
      this.edges[layer] = (this.edges[layer] || []).concat(ids);
    }
    removeEdges(idsOrNodes, layer = 'default') {
      const arr = (Array.isArray(idsOrNodes) ? idsOrNodes : [idsOrNodes]).map((x) => (typeof x === 'string' ? x : x._id));
      this.edges[layer] = (this.edges[layer] || []).filter((id) => !arr.includes(id));
    }
    clearEdges(layers) { for (const l of [].concat(layers)) delete this.edges[l]; }
    getEdges(layers) { return [].concat(layers).reduce((a, l) => a.concat(this.edges[l] || []), []); }
    getLayers() { return Object.keys(this.edges); }
    setKb(model) { this._model = model; return this; }
    getKb() { return this._model; }
    setUpdated(ts) { this.updated = ts || Date.now(); }
  }

  class Model {
    constructor(names) { this.kbNames = [].concat(names); this._store = new Map(); this._roots = {}; }
    init(cb) { if (cb) cb(null); }
    createNode(type, data) { const n = new Node(type, data); n._model = this; return n; }
    createModel(names) { return new Model(names); }
    save(node, cb) { return node.save(cb); }
    load(id, cb) {
      const found = Array.isArray(id) ? id.map((i) => this._store.get(i) || null) : (this._store.get(id) || null);
      if (cb) { cb(null, found); return undefined; }
      return Promise.resolve(found);
    }
    fetch(id) { return Array.isArray(id) ? id.map((i) => this._store.get(i)) : this._store.get(id); }
    loadRoot(arg, cb) {
      if (typeof arg === 'function') { cb = arg; }
      const name = this.kbNames[0];
      if (!this._roots[name]) { const r = this.createNode('root', {}); this._store.set(r._id, r); this._roots[name] = r; }
      const root = this._roots[name];
      if (cb) { cb(null, root); return undefined; }
      return Promise.resolve(root);
    }
    fetchRoot() { return this._roots[this.kbNames[0]] || null; }
    begin() { return this; }
  }

  class UserNode extends Node {
    constructor(data) { super('person', data); this.id = (data && data.memberId) || this._id; this.isJibo = !!(data && data.isJibo); }
    toString() { return this.getWrittenName(); }
    getWrittenName() { return [this.data.firstName, this.data.lastName].filter(Boolean).join(' '); }
    getInitials() { return [(this.data.firstName || '')[0], (this.data.lastName || '')[0]].filter(Boolean).join('').toUpperCase(); }
  }

  class LoopModel extends Model {
    constructor() { super('loop'); this._loop = []; }
    _seed(users) {
      this._loop = users.map((d) => { const u = new UserNode(d); u._model = this; this._store.set(u._id, u); return u; });
    }
    _ret(value, cb) { if (cb) { cb(null, value); return undefined; } return Promise.resolve(value); }
    loadLoop(cb) { return this._ret(this._loop, cb); }
    loadLoopAll(cb) { return this._ret(this._loop, cb); }
    loadLoopActive(cb) { return this._ret(this._loop.filter((u) => u.data.isActive !== false && !u.isJibo), cb); }
    loadLoopInvited(cb) { return this._ret([], cb); }
    _find(id) { return this._loop.find((u) => u._id === id || u.id === id || u.data.memberId === id) || null; }
    getUserNodeById(id, cb) { return this._ret(this._find(id), cb); }
    getWrittenNameById(id, cb) { const u = this._find(id); return this._ret(u ? u.getWrittenName() : '', cb); }
    getSpokenNameById(id, cb) { return this.getWrittenNameById(id, cb); }
    fetchLoop() { return this._loop; }
    fetchLoopActive() { return this._loop.filter((u) => !u.isJibo); }
  }

  const loop = new LoopModel();
  loop._seed([
    { firstName: 'Alex', lastName: 'Kim', memberId: 'm1', isActive: true, gender: 'other' },
    { firstName: 'Sam', lastName: 'Rivera', memberId: 'm2', isActive: true, gender: 'female' },
    { firstName: 'Jibo', lastName: '', memberId: 'jibo', isJibo: true },
  ]);

  return {
    Node, Model, UserNode, LoopModel,
    loop,
    httpUrl: '',
    init(service, cb) { if (cb) cb(null); },
    initLoop() {},
    createModel(names) { return new Model(names); },
    createSlice(name, a, b) { const cb = typeof a === 'function' ? a : b; if (cb) { cb(null, true); return undefined; } return Promise.resolve(true); },
    existsSlice(name, a, b) { const cb = typeof a === 'function' ? a : b; if (cb) { cb(null, true); return undefined; } return Promise.resolve(true); },
    registerNodeClass() {}, registerModelClass() {},
    findNodeClass() { return Node; }, findModelClass() { return Model; },
  };
}
