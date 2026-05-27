// In-memory KnowledgeBase service.
//
// The original sim ran KBService (skills-service-manager) — a thin HTTP wrapper
// over jibo.kb.KnowledgeDatabase (an nedb/disk store). jibo-be's KB client
// (jibo-kb WebClient) talks to it over axios HTTP. In-browser there's no server
// (and no disk), so we back the WebClient directly with an in-memory node store
// per kb slice, faithful to the node wire-format (_id/data/type/created/updated/
// edges round-tripped via createNodeFromObject). Reads/writes persist for the
// session, so subskills that store + reload KB state work.

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
function makeRoot(kbName) {
  const s = storeFor(kbName);
  const now = Date.now();
  const root = { _id: uuid(), type: 'root', data: seedData(kbName), created: now, updated: now };
  s.nodes.set(root._id, root);
  s.rootId = root._id;
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
  // KB slice management (createSlice/existsSlice) is on the KnowledgeBase itself
  // (axios to /create + /exists). Back it with the in-memory store.
  const KB = kb.KnowledgeBase;
  if (KB && KB.prototype && !KB.prototype.__kbStorePatched) {
    KB.prototype.__kbStorePatched = true;
    KB.prototype.createSlice = function createSlice(sliceName, httpUrl, cb) {
      if (typeof httpUrl === 'function') cb = httpUrl;
      storeFor(sliceName);
      if (cb) cb(null, true);
    };
    KB.prototype.existsSlice = function existsSlice(sliceName, httpUrl, cb) {
      if (typeof httpUrl === 'function') cb = httpUrl;
      if (cb) cb(null, true); // slices are created on demand, so treat as existing
    };
  }
  console.log('[kb] in-memory KnowledgeBase installed');
}
