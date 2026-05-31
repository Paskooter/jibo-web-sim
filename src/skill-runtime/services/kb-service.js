// In-memory KnowledgeBase service.
//
// On-device the KB service is a thin HTTP wrapper over a disk-backed
// node store, and the runtime's KB client talks to it over axios HTTP.
// In-browser there's no server (and no disk), so we back the WebClient
// directly with an in-memory node store per kb slice, faithful to the
// node wire-format (_id/data/type/created/updated/edges round-tripped
// via createNodeFromObject). Reads/writes persist for the session, so
// subskills that store + reload KB state work.

const stores = new Map(); // kbName -> { rootId, nodes: Map<id, obj> }

function storeFor(kbName) {
  if (!stores.has(kbName)) stores.set(kbName, { rootId: null, nodes: new Map() });
  return stores.get(kbName);
}
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
function clone(o) { try { return JSON.parse(JSON.stringify(o)); } catch (_) { return Object.assign({}, o); } }

// Seed data the framework expects so it picks the right boot path.
function seedData(kbName) {
  if (kbName === 'skills-config') return { hasAlreadyLaunchedFirstContact: true };
  return {};
}
// Seed child nodes + root-edge layers per slice. Some plugins query the
// root for an edge layer and warn loudly when the result is empty, even
// though the empty-list path is "no data" not "broken". A single inert
// placeholder per layer (e.g. a disabled holiday) suppresses the warn
// without changing observable behavior — filters that read the placeholder
// just skip it (isEnabled:false / category:'placeholder' etc.).
function seedChildren(kbName, root) {
  const s = storeFor(kbName);
  const now = Date.now();
  const addChild = (layer, child) => {
    child._id = child._id || uuid();
    child.created = child.created || now;
    child.updated = now;
    s.nodes.set(child._id, child);
    root.edges = root.edges || {};
    root.edges[layer] = root.edges[layer] || [];
    if (root.edges[layer].indexOf(child._id) < 0) root.edges[layer].push(child._id);
  };
  if (kbName === '/jibo/holidays' || kbName === 'jibo/holidays') {
    // The framework's holiday plugin warns "KB returned no holiday list"
    // if root.edges.holiday is empty, then "No active holiday data"
    // downstream. Seed one disabled holiday so the list is non-empty;
    // the filter drops it (isEnabled false) and getActiveHolidaySet()
    // returns an empty Set — same end state, no warning.
    addChild('holiday', {
      _id: '_placeholder_holiday',
      type: 'holiday',
      data: {
        name: '_placeholder',
        isEnabled: false,
        category: 'placeholder',
        date: '2099-12-31',
        endDate: '2099-12-31',
      },
    });
  }
}
function makeRoot(kbName) {
  const s = storeFor(kbName);
  const now = Date.now();
  const root = { _id: uuid(), type: 'root', data: seedData(kbName), created: now, updated: now };
  s.nodes.set(root._id, root);
  s.rootId = root._id;
  seedChildren(kbName, root);
  return root;
}

export function installKbService(requireFn) {
  let kb;
  try { kb = requireFn('jibo-kb'); } catch (e) { console.warn('[kb] jibo-kb not loadable:', e.message); return; }
  const WebClient = kb && kb.WebClient;
  if (!WebClient || !WebClient.prototype || WebClient.prototype.__kbStorePatched) return;
  WebClient.prototype.__kbStorePatched = true;

  const toNode = function toNode(self, obj) { return obj ? self.createNodeFromObject(clone(obj)) : null; };

  WebClient.prototype.load = function load(id, cb) {
    const s = storeFor(this.kbName);
    cb(null, toNode(this, s.nodes.get(id)));
  };
  WebClient.prototype.loadList = function loadList(ids, cb) {
    const s = storeFor(this.kbName);
    cb(null, (ids || []).map((id) => toNode(this, s.nodes.get(id))));
  };
  WebClient.prototype.loadRoot = function loadRoot(cb) {
    const s = storeFor(this.kbName);
    let root = s.rootId && s.nodes.get(s.rootId);
    if (!root) root = makeRoot(this.kbName);
    cb(null, toNode(this, root));
  };
  WebClient.prototype.save = function save(node, cb) {
    const s = storeFor(this.kbName);
    const obj = clone(node);
    if (!obj._id) obj._id = uuid();
    obj.updated = Date.now();
    if (!obj.created) obj.created = obj.updated;
    s.nodes.set(obj._id, obj);
    if (obj.type === 'root') s.rootId = obj._id;
    if (cb) cb(null);
  };
  WebClient.prototype.remove = function remove(idOrNode, cb) {
    const s = storeFor(this.kbName);
    const id = (idOrNode && idOrNode._id) || idOrNode;
    s.nodes.delete(id);
    if (s.rootId === id) s.rootId = null;
    if (cb) cb(null);
  };
  // KB slice management (createSlice/existsSlice/removeSlice) is on the
  // KnowledgeBase itself (axios to /create etc.). In the real runtime these are
  // @promisify-decorated, so they're DUAL-MODE: return a Promise when called
  // without a callback (e.g. MimManager.loadMimKB does
  // `kb.createSlice(name).then(...)`), and use the callback when one is given
  // (e.g. KnowledgeBase.init). Back them with the in-memory store, preserving
  // that duality — a callback-only stub here breaks the Promise path and the
  // thrown "reading 'then' of undefined" gets swallowed, silently killing menus.
  const KB = kb.KnowledgeBase;
  if (KB && KB.prototype && !KB.prototype.__kbStorePatched) {
    KB.prototype.__kbStorePatched = true;
    const dual = (cb, value) => {
      if (cb) { cb(null, value); return undefined; }
      return Promise.resolve(value);
    };
    KB.prototype.createSlice = function createSlice(sliceName, httpUrl, cb) {
      if (typeof httpUrl === 'function') { cb = httpUrl; httpUrl = null; }
      storeFor(sliceName);
      return dual(cb, true);
    };
    KB.prototype.existsSlice = function existsSlice(sliceName, httpUrl, cb) {
      if (typeof httpUrl === 'function') { cb = httpUrl; httpUrl = null; }
      return dual(cb, true); // slices are created on demand, so treat as existing
    };
    KB.prototype.removeSlice = function removeSlice(sliceName, httpUrl, cb) {
      if (typeof httpUrl === 'function') { cb = httpUrl; httpUrl = null; }
      stores.delete(sliceName);
      return dual(cb, true);
    };
  }
  console.log('[kb] in-memory KnowledgeBase installed');
}
