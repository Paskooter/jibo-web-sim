// Synchronous CommonJS `require` for the skill iframe.
//
// Original Jibo skill bundles are browserified for Electron's nodeintegration
// webview: their index.html does `require('./index')` and the bundle does
// `require('jibo')` + bare `require('some-dep')` resolved from node_modules.
// Browsers have no `require`, so we provide one — letting bundles run *in
// place, unmodified*:
//
//   require('jibo')        -> our jibo shim (NOT the bundled real runtime, which
//                             would try to reach native/WebSocket robot services)
//   node builtins          -> small browser polyfills (path, events, util, …)
//   './x' / '../x' / '/x'  -> resolved relative to the requiring module
//   'pkg'                  -> resolved from node_modules walking up the tree
//
// Module sources are fetched synchronously (XHR) and wrapped exactly like Node
// ((module, exports, require, __dirname, __filename)), so resolution is sync
// like the real thing.

// Native XHR captured up-front so our internal sync requests (module loading, fs)
// keep working even after the service layer swaps window.XMLHttpRequest to route
// HTTP-service calls (see services/service-bus.js installHttpInterceptor).
const NativeXHR = typeof window !== 'undefined' ? window.XMLHttpRequest : null;

export function createRequire(jibo) {
  const moduleCache = {};      // url -> { exports }
  const textCache = {};        // url -> string | null
  const builtins = makeBuiltins();

  // Overrides for node modules that can't run in the browser (filesystem/native
  // tricks) — replaced with tolerant stubs so their dependents still construct.
  const overrides = {
    'graceful-fs': builtins.fs,
    'jibo-tunable': tolerantStub(),
    'fs-extra': builtins.fs,
    // The real jibo runtime touches electron's ipcRenderer; a no-op satisfies it.
    electron: { ipcRenderer: { send() {}, on() {}, once() {}, removeListener() {}, removeAllListeners() {} } },
    // Optional native addons (ws speedups) that don't exist in the browser; stub
    // them so the resolver doesn't probe (and 404) the whole node_modules tree.
    bufferutil: {}, 'utf-8-validate': {},
    // Node-server/native-only deps jibo-be pulls in but can't use in-browser
    // (express static file serving; icecast audio streaming). Stub to avoid load errors.
    send: () => ({ on() { return this; }, pipe() {} }), icecast: { Client: function () {}, Reader: function () {}, Writer: function () {} },
    // In-memory WebSocket (the `ws` package). jibo-be's service clients open ws
    // channels (body/notifications/lps); with no server they'd error + reconnect
    // forever. This connects silently and routes to local channel handlers
    // registered on window.__wsServers (so ported services can push messages).
    ws: makeFakeWs(),
  };

  // File manifest: a Set of every URL under the skill dir, fetched once. Module
  // resolution checks this instead of probing each candidate path over XHR — every
  // missing probe is a console "Failed to load resource" 404, and resolving the
  // real jibo runtime makes thousands of them. With the manifest, only files that
  // actually exist are ever fetched.
  function loadManifest() {
    if (typeof window === 'undefined') return null;
    if (window.__skillManifest) return window.__skillManifest;
    const root = window.__SKILL_DIR__;
    if (!root) return null;
    try {
      const xhr = new NativeXHR();
      xhr.open('GET', `/__list?root=${encodeURIComponent(root)}`, false);
      xhr.send(null);
      if (xhr.status >= 200 && xhr.status < 300) {
        const list = JSON.parse(xhr.responseText).files || [];
        window.__skillManifest = new Set(list);
        return window.__skillManifest;
      }
    } catch (_) { /* fall back to probing */ }
    window.__skillManifest = null;
    return null;
  }
  const manifest = loadManifest();

  const skillRoot = (typeof window !== 'undefined' && window.__SKILL_DIR__) || null;
  // The manifest holds normalized paths; callers may pass URLs with `/./` (e.g.
  // a skill loading `./assets/x.json` resolves to `.../radio/./assets/x.json`).
  // Collapse `/./` (and trailing `/.`) before the lookup, or real files get
  // wrongly flagged missing and never fetched (radio's defaultStations.json).
  const normPath = (u) => String(u).split('?')[0].replace(/\/\.(?=\/)/g, '').replace(/\/\.$/, '');
  const knownMissing = (url) => manifest && skillRoot && url.indexOf(skillRoot) === 0 && !manifest.has(normPath(url));
  function fetchTextSync(url) {
    if (url in textCache) return textCache[url];
    // Don't even request files the manifest says aren't there (avoids 404 noise).
    if (knownMissing(url)) { textCache[url] = null; return null; }
    let text = null;
    try {
      const xhr = new NativeXHR();
      xhr.open('GET', url, false);
      xhr.send(null);
      if (xhr.status >= 200 && xhr.status < 300) text = xhr.responseText;
    } catch (_) { text = null; }
    textCache[url] = text;
    return text;
  }
  const exists = (url) => (manifest && skillRoot && url.indexOf(skillRoot) === 0 ? manifest.has(url) : fetchTextSync(url) !== null);

  function dirname(p) { return p.replace(/\/[^/]*$/, '') || '/'; }
  function join(base, rel) {
    const parts = `${base}/${rel}`.split('/');
    const out = [];
    for (const part of parts) {
      if (part === '' || part === '.') continue;
      if (part === '..') out.pop();
      else out.push(part);
    }
    return `/${out.join('/')}`;
  }

  function resolveFile(base) {
    for (const ext of ['', '.js', '.json']) {
      if (exists(base + ext)) return base + ext;
    }
    return null;
  }
  function resolveDir(base) {
    const pkgTxt = fetchTextSync(`${base}/package.json`);
    if (pkgTxt) {
      try {
        const main = JSON.parse(pkgTxt).main || 'index.js';
        const r = resolveFile(join(base, main));
        if (r) return r;
      } catch (_) { /* fall through */ }
    }
    return resolveFile(`${base}/index`);
  }
  function resolve(request, fromDir) {
    if (request[0] === '/') {                       // absolute path
      const base = join('/', request);
      return resolveFile(base) || resolveDir(base);
    }
    if (request[0] === '.') {                        // relative to the requirer
      const base = join(fromDir, request);
      return resolveFile(base) || resolveDir(base);
    }
    let dir = fromDir;
    for (;;) {
      const candidate = join(dir, `node_modules/${request}`);
      const r = resolveFile(candidate) || resolveDir(candidate);
      if (r) return r;
      if (dir === '/' || dir === '') return null;
      dir = dirname(dir);
    }
  }

  // The real jibo-plugins PathUtils.resolve() uses node's Module internals to
  // locate packages (e.g. 'animation-utilities' for the eye textures). Back them
  // with our own resolver so those lookups return real paths instead of null.
  // node's require('module') returns the Module constructor (self-referential:
  // Module.Module === Module) with static _resolveFilename/_nodeModulePaths.
  builtins.module._nodeModulePaths = function (fromDir) {
    const paths = [];
    let dir = fromDir || '/';
    for (;;) {
      paths.push(join(dir, 'node_modules'));
      if (dir === '/' || dir === '') break;
      dir = dirname(dir);
    }
    return paths;
  };
  builtins.module._resolveFilename = function (request, opts) {
    const fromDir = opts && opts.filename ? dirname(opts.filename)
      : (opts && opts.paths && opts.paths[0] ? dirname(opts.paths[0]) : '/');
    const r = resolve(request, fromDir);
    if (!r) { const e = new Error(`Cannot find module '${request}'`); e.code = 'MODULE_NOT_FOUND'; throw e; }
    return r;
  };
  builtins.module.Module = builtins.module;

  function requireFrom(fromDir) {
    return function require(request) {
      // With a shim supplied, require('jibo') returns it. With none (createRequire(null)),
      // it falls through to node_modules so the bundle's OWN real jibo runtime loads.
      if (request === 'jibo' && jibo) return jibo;
      if (request in overrides) return overrides[request];
      if (builtins[request]) return builtins[request];

      const url = resolve(request, fromDir);
      if (!url) { if (window.__CJS_DEBUG__) console.warn(`[require] cannot resolve '${request}' from ${fromDir}`); return {}; }
      if (moduleCache[url]) return moduleCache[url].exports;

      const src = fetchTextSync(url);
      if (src == null) { if (window.__CJS_DEBUG__) console.warn(`[require] failed to load ${url}`); return {}; }

      const module = { exports: {} };
      moduleCache[url] = module;
      if (url.endsWith('.json')) { module.exports = JSON.parse(src); return module.exports; }

      const moduleDir = dirname(url);
      try {
        // eslint-disable-next-line no-new-func
        const fn = new Function('module', 'exports', 'require', '__dirname', '__filename', 'global', 'process',
          `${src}\n//# sourceURL=${url}`);
        fn(module, module.exports, requireFrom(moduleDir), moduleDir, url, window, builtins.process);
      } catch (e) {
        const detail = e && (e.stack || `${e.message || e}${e.missingRef ? ` missingRef=${e.missingRef}` : ''}${e.missingSchema ? ` missingSchema=${e.missingSchema}` : ''}`);
        console.error(`[require] error executing ${url}:`, detail);
      }
      return module.exports;
    };
  }

  return requireFrom;
}

function tolerantStub() {
  const fn = function () {};
  return new Proxy(fn, {
    get(t, p) {
      if (p === 'then') return (onF) => { if (typeof onF === 'function') { try { onF(undefined); } catch (_) { /* ignore */ } } return tolerantStub(); };
      if (p === 'catch') return () => tolerantStub();
      if (p === 'finally') return (onF) => { if (typeof onF === 'function') { try { onF(); } catch (_) { /* ignore */ } } return tolerantStub(); };
      if (p === Symbol.toPrimitive || p === 'toString' || p === 'valueOf') return () => '';
      if (typeof p === 'symbol') return undefined;
      return p in t ? t[p] : tolerantStub();
    },
    apply() { return tolerantStub(); },
    construct() { return tolerantStub(); },
  });
}

// fs whose reads resolve over HTTP. Absolute bundle paths (…/node_modules/x/y)
// are rebased onto the skill's served root (window.__SKILL_DIR__), so the real
// jibo LocalLoader's fs.readFile(uri, encoding, cb) loads eye textures etc.
function makeHttpFs() {
  function mapUrl(p) {
    p = String(p);
    if (/^(https?:)?\/\//.test(p)) return p;
    const root = (typeof window !== 'undefined' && window.__SKILL_DIR__) || '';
    const i = p.lastIndexOf('/node_modules/');
    if (i >= 0) return root + p.slice(i);
    if (p[0] === '/') return p;            // already an absolute server path
    return `${root}/${p}`;
  }
  function toBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  // Skip files the manifest says don't exist (avoids 404 console noise). Normalize
  // `/./` first — the manifest is normalized, but skills resolve `./assets/x` to
  // `.../skill/./assets/x`, which would otherwise be wrongly flagged missing.
  function knownMissing(url) {
    const m = typeof window !== 'undefined' && window.__skillManifest;
    const root = typeof window !== 'undefined' && window.__SKILL_DIR__;
    const norm = String(url).split('?')[0].replace(/\/\.(?=\/)/g, '').replace(/\/\.$/, '');
    return m && root && url.indexOf(root) === 0 && !m.has(norm);
  }
  function readFile(p, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = undefined; }
    const enc = typeof opts === 'string' ? opts : (opts && opts.encoding);
    const url = mapUrl(p);
    if (knownMissing(url)) { const e = new Error(`ENOENT: ${url}`); e.code = 'ENOENT'; cb(e); return; }
    fetch(url).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
      if (enc === 'base64') return r.arrayBuffer().then((b) => cb(null, toBase64(b)));
      if (enc === 'utf8' || enc === 'utf-8') return r.text().then((t) => cb(null, t));
      return r.arrayBuffer().then((b) => cb(null, new Uint8Array(b)));
    }).catch((e) => cb(e));
  }
  // Synchronous reads (jibo-plugins PathUtils.findRoot walks up for package.json)
  // are served by synchronous XHR against the mapped HTTP URL.
  const syncCache = new Map();    // url -> text | null (findRoot probes the same paths repeatedly)
  function getSync(url, binary) {
    const key = (binary ? 'b:' : 't:') + url;
    if (syncCache.has(key)) return syncCache.get(key);
    if (knownMissing(url)) { syncCache.set(key, null); return null; }
    let out = null;
    try {
      const xhr = new NativeXHR();
      xhr.open('GET', url, false);
      if (binary) xhr.overrideMimeType('text/plain; charset=x-user-defined');
      xhr.send(null);
      if (xhr.status >= 200 && xhr.status < 300) out = xhr.responseText;
    } catch (_) { out = null; }
    syncCache.set(key, out);
    return out;
  }
  function existsSync(p) { return getSync(mapUrl(p), false) !== null; }
  function readFileSync(p, opts) {
    const enc = typeof opts === 'string' ? opts : (opts && opts.encoding);
    const url = mapUrl(p);
    const binary = enc === 'base64';
    const text = getSync(url, binary);
    if (text === null) { const e = new Error(`ENOENT: ${url}`); e.code = 'ENOENT'; throw e; }
    if (binary) { let bin = ''; for (let i = 0; i < text.length; i += 1) bin += String.fromCharCode(text.charCodeAt(i) & 0xff); return btoa(bin); }
    return text;
  }
  // fd-based reads (jibo-cai-utils.FileUtils.readFile opens, fstats, chunk-reads,
  // closes — used to load the 1MB AnimDB). open fetches the whole file once.
  const fds = new Map();
  let fdSeq = 1;
  function open(p, flags, mode, cb) {
    if (typeof mode === 'function') { cb = mode; mode = undefined; }
    if (typeof flags === 'function') { cb = flags; flags = 'r'; }
    const u0 = mapUrl(p);
    if (knownMissing(u0)) { const e = new Error(`ENOENT: ${u0}`); e.code = 'ENOENT'; cb(e); return; }
    fetch(u0).then((r) => { if (!r.ok) throw new Error(`ENOENT ${r.status}`); return r.arrayBuffer(); })
      .then((b) => { const fd = fdSeq; fdSeq += 1; fds.set(fd, new Uint8Array(b)); cb(null, fd); })
      .catch((e) => cb(e));
  }
  function fstat(fd, cb) { const u = fds.get(fd); if (!u) return cb && cb(new Error('EBADF')); return cb && cb(null, { size: u.length, isFile: () => true, isDirectory: () => false }); }
  function read(fd, buffer, offset, length, position, cb) {
    const u = fds.get(fd);
    if (!u) return cb && cb(new Error('EBADF'));
    const pos = position == null ? 0 : position;
    const end = Math.min(pos + length, u.length);
    let n = 0;
    for (let i = pos; i < end; i += 1) { buffer[offset + n] = u[i]; n += 1; }
    return cb && cb(null, n, buffer);
  }
  function close(fd, cb) { fds.delete(fd); if (cb) cb(null); }
  return {
    readFile,
    readFileSync,
    existsSync,
    exists: (p, cb) => cb && cb(existsSync(p)),
    statSync: (p) => { if (!existsSync(p)) { const e = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; throw e; } return { isFile: () => true, isDirectory: () => false, size: 0 }; },
    stat: (p, cb) => cb && cb(null, { isFile: () => true, isDirectory: () => false, size: 0 }),
    // fs-extra extras (jibo-log etc. call these for log dirs); no real FS, so no-op.
    ensureDirSync: () => {}, ensureDir: (p, cb) => { const f = typeof p === 'function' ? p : cb; if (f) f(null); },
    ensureFileSync: () => {}, mkdirpSync: () => {}, mkdirp: (p, cb) => { const f = typeof p === 'function' ? p : cb; if (f) f(null); },
    outputFile: (p, d, cb) => { if (cb) cb(null); }, outputFileSync: () => {}, removeSync: () => {}, remove: (p, cb) => { const f = typeof p === 'function' ? p : cb; if (f) f(null); },
    open, fstat, read, close,
    readdir: (p, cb) => { const f = typeof cb === 'function' ? cb : (typeof p === 'function' ? p : null); if (f) f(null, []); },
    readdirSync: () => [],
    writeFile: (p, d, o, cb) => { const f = typeof o === 'function' ? o : cb; if (f) f(null); },
    writeFileSync: () => {}, appendFile: (p, d, o, cb) => { const f = typeof o === 'function' ? o : cb; if (f) f(null); }, appendFileSync: () => {},
    unlink: (p, cb) => cb && cb(null), unlinkSync: () => {}, mkdir: (p, o, cb) => { const f = typeof o === 'function' ? o : cb; if (f) f(null); }, mkdirSync: () => {},
  };
}

// Node-faithful url.parse: crucially it returns `.path` (pathname+search), which
// `new URL` omits. ajv 5's id resolution reads p.path, so without it absolute
// schema ids collapse (http://x/y# -> http://x#) and every $ref breaks.
function makeUrl() {
  function parse(u) {
    u = String(u);
    let hash = null;
    const hi = u.indexOf('#');
    if (hi >= 0) { hash = u.slice(hi); u = u.slice(0, hi); }
    let search = null;
    const si = u.indexOf('?');
    if (si >= 0) { search = u.slice(si); u = u.slice(0, si); }
    let protocol = null;
    let slashes = false;
    let host = '';
    let pathname = u;
    const pm = /^([a-zA-Z][a-zA-Z0-9+.-]*:)(\/\/)?/.exec(u);
    if (pm) {
      protocol = pm[1];
      let rest = u.slice(pm[0].length);
      if (pm[2]) {
        slashes = true;
        const slash = rest.indexOf('/');
        if (slash >= 0) { host = rest.slice(0, slash); pathname = rest.slice(slash); } else { host = rest; pathname = ''; }
      } else { pathname = rest; }
    } else if (u.slice(0, 2) === '//') {
      slashes = true;
      const rest = u.slice(2);
      const slash = rest.indexOf('/');
      if (slash >= 0) { host = rest.slice(0, slash); pathname = rest.slice(slash); } else { host = rest; pathname = ''; }
    }
    const [hostname, port] = host.split(':');
    const path = ((pathname || '') + (search || '')) || null;
    return {
      href: String(arguments[0]),
      protocol,
      slashes,
      host: host || null,
      hostname: hostname || null,
      port: port || null,
      hash,
      search,
      query: search ? search.slice(1) : null,
      pathname: pathname || null,
      path,
    };
  }
  function format(o) {
    if (typeof o === 'string') return o;
    const proto = o.protocol ? (o.protocol.endsWith(':') ? o.protocol : `${o.protocol}:`) : '';
    const sep = o.slashes || /^(https?|ftp|file):$/.test(proto) ? '//' : '';
    return `${proto}${sep}${o.host || o.hostname || ''}${o.pathname || ''}${o.search || ''}${o.hash || ''}` || o.href || '';
  }
  function resolve(from, to) {
    try { return new URL(to, from).href; } catch (_) {
      if (!to) return from;
      if (/^[a-zA-Z][\w+.-]*:\/\//.test(to)) return to;
      if (to[0] === '#') { const i = String(from).indexOf('#'); return (i >= 0 ? String(from).slice(0, i) : String(from)) + to; }
      return to;
    }
  }
  return { parse, format, resolve, Url: function Url() {} };
}

// http/https that fail fast: any request emits 'error' on the next tick so
// callbacks fire (callers treat the service as unavailable and continue) instead
// of hanging forever waiting on a response that never comes.
// ---- Pegasus hub HTTP-to-WS bridge -----------------------------------------
// The jibo-be jetstream-client sends `/listen/*` and `/proactive/*` over HTTP
// (that's the API the real jetstream service exposes to skills), but the hub
// itself only speaks WebSocket at those paths. The real jetstream service
// translates each HTTP POST into Hubmsg WebSocket messages on its persistent
// hub connection, then synchronously acks the skill's POST with the booking
// transaction id (the bridge is jiboV2/jetstream JetHttpHandler.cc /
// LhubClient.cc). bridgeViaHub does the same thing in-browser, sending the
// translated Hubmsg(s) on the realSocket already open to the hub and
// responding to the POST with `{ requestID: <transID> }`. Async hub events
// then come back over the same WS and realSocket's onmessage aliases
// transID->requestID for jetstream-client.

function _hubUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// Translate a jetstream-client HTTP body into the Hubmsg(s) the hub expects
// for that path. Returns an array — start_local_turn can be 2 messages
// (LISTEN + CLIENT_NLU/CLIENT_ASR), most others are single.
function _buildHubMessages(path, body, transID) {
  const ts = Date.now();
  const mid = () => 'mid:' + _hubUuid();
  if (path === '/listen/start_local_turn') {
    // LhubClient.cc picks LISTEN.mode by whether the skill is sending pre-resolved
    // input: CLIENT_NLU (typed chat / NLU payload), CLIENT_ASR (typed transcript)
    // or the default audio path. The hub rejects 'turn'.
    const mode = body.clientNLU != null ? 'CLIENT_NLU' : (body.clientASR ? 'CLIENT_ASR' : 'ASR');
    const msgs = [{
      type: 'LISTEN', msgID: mid(), transID, ts,
      data: {
        lang: body.language || 'en-us',
        hotphrase: !!body.hotphrase,
        rules: body.nluRules || [],
        mode,
        asr: {
          hints: body.hintPhrases || [],
          earlyEOS: body.earlyEOS || [],
          encoding: 'opus',
          sampleRate: 16000,
          sosTimeout: body.sosTimeout > 0 ? Math.round(body.sosTimeout * 1000) : -1,
          maxSpeechTimeout: body.maxSpeechTimeout > 0 ? Math.round(body.maxSpeechTimeout * 1000) : -1,
        },
      },
    }];
    if (body.clientNLU != null) {
      const nluData = typeof body.clientNLU === 'string'
        ? (() => { try { return JSON.parse(body.clientNLU); } catch (_) { return { intent: body.clientNLU }; } })()
        : body.clientNLU;
      msgs.push({ type: 'CLIENT_NLU', msgID: mid(), transID, ts, data: nluData });
    } else if (body.clientASR) {
      msgs.push({ type: 'CLIENT_ASR', msgID: mid(), transID, ts, data: { text: String(body.clientASR) } });
    }
    return msgs;
  }
  if (path === '/listen/mimic_global_turn') {
    const data = body.nlu || body.clientNLU || body;
    return [{ type: 'CLIENT_NLU', msgID: mid(), transID: 'GLOBAL', ts, data }];
  }
  if (path === '/listen/update_local_turn') {
    const data = body.nlu || body.clientNLU || body;
    return [{ type: 'CLIENT_NLU', msgID: mid(), transID, ts, data }];
  }
  if (path === '/listen/cancel_local_turn' || path === '/listen/cancel_any_turn') {
    return [{ type: 'CANCEL', msgID: mid(), transID, ts, data: {} }];
  }
  if (path === '/listen/subscribe_global') {
    return [{ type: 'SUBSCRIBE_GLOBAL', msgID: mid(), transID, ts, data: body || {} }];
  }
  if (path === '/listen/unsubscribe_global' || path === '/listen/unsubscribe_all_globals') {
    return [{ type: 'UNSUBSCRIBE_GLOBAL', msgID: mid(), transID, ts, data: body || {} }];
  }
  if (path === '/listen/set_hj_mode') {
    return [{ type: 'SET_HJ_MODE', msgID: mid(), transID, ts, data: body || {} }];
  }
  if (path === '/listen/get_hj_mode') {
    return [{ type: 'GET_HJ_MODE', msgID: mid(), transID, ts, data: body || {} }];
  }
  if (path === '/proactive/trigger') {
    const data = typeof body === 'object' ? body : { payload: String(body) };
    return [{ type: 'TRIGGER', msgID: mid(), transID, ts, data }];
  }
  return [];
}

// Synthesize a Node-style HTTP response with the given JSON body, fired async
// so callers can register on('data')/on('end') first.
function _synthHttpJson(cb, obj) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const respHandlers = {};
  const resp = {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    setEncoding() {},
    on(ev, h) { (respHandlers[ev] = respHandlers[ev] || []).push(h); return resp; },
    once(ev, h) { return resp.on(ev, h); },
  };
  if (cb) cb(resp);
  setTimeout(() => {
    (respHandlers.data || []).forEach((h) => { try { h(text); } catch (_) { /* listener threw */ } });
    (respHandlers.end || []).forEach((h) => { try { h(); } catch (_) { /* listener threw */ } });
  }, 0);
}

// Per-turn WS to the Pegasus hub, opened through the dev server's /__cloud-ws
// proxy so X-JIBO-transID can be set on the upgrade (browsers can't set custom
// WS headers). Each turn gets its own WebSocket — the hub uses transID on the
// socket itself ("Currently a new socket connection is used for each request"
// in ListenHandler.ts). Inbound hub events are translated and forwarded onto
// jetstream-client's long-lived eventWS fake (registered in __hubSockets), so
// the skill receives them as if they came through one stream.
function bridgeViaHub(options, body, cb, reqHandlers, host) {
  const key = host + (options.port ? ':' + options.port : '');
  const reg = (typeof window !== 'undefined' && window.__hubSockets) || {};
  const eventSock = reg[key] || reg[host];
  let bodyObj = {};
  try { bodyObj = JSON.parse(body.join('') || '{}'); } catch (_) { /* leave empty */ }
  const transID = options.path === '/listen/mimic_global_turn' ? 'GLOBAL' : 'tid:' + _hubUuid();
  const msgs = _buildHubMessages(options.path, bodyObj, transID);

  // Hub path inferred from the jetstream HTTP path: /listen/* -> /listen,
  // /proactive/* -> /proactive (the hub's socket handlers).
  const hubPath = options.path.startsWith('/proactive/') ? '/proactive' : '/listen';
  const proxyUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/__cloud-ws?upstream=${encodeURIComponent(key)}&path=${encodeURIComponent(hubPath)}&transID=${encodeURIComponent(transID)}`;
  let turnWS;
  try { turnWS = new window.WebSocket(proxyUrl); }
  catch (e) {
    setTimeout(() => (reqHandlers.error || []).forEach((h) => { try { h(e); } catch (_) { /* */ } }), 0);
    return;
  }
  const pending = [];
  for (const m of msgs) pending.push(JSON.stringify(m));
  turnWS.onopen = () => { for (const m of pending) { try { turnWS.send(m); } catch (_) {} } };
  turnWS.onmessage = (ev) => {
    // Translate hub Hubmsg -> jetstream WSmsg (transID -> requestID) and forward
    // through the eventSock so jetstream-client's Client.handleMessage picks it up.
    let data = ev.data;
    if (typeof data === 'string' && data.charCodeAt(0) === 123) {
      try {
        const obj = JSON.parse(data);
        if (obj && !obj.requestID) {
          if (obj.transID) obj.requestID = obj.transID;
          else if (obj.msgID) obj.requestID = obj.msgID;
        }
        // Ensure transID matches (hub may stamp its own on error msgs).
        if (obj && !obj.transID && obj.requestID) obj.transID = obj.requestID;
        data = JSON.stringify(obj);
      } catch (_) { /* leave verbatim */ }
    }
    if (eventSock) { try { eventSock.emit('message', data); } catch (_) {} }
  };
  turnWS.onerror = (e) => { console.warn('[cloud] turn WS error', transID, e && e.message); };
  turnWS.onclose = () => { /* per-turn WS closed; let skill flow handle it */ };

  _synthHttpJson(cb, { requestID: transID });
}

// Node-style http.request implemented on top of browser `fetch`, so jibo's
// service clients (e.g. jetstream-client.sendPostRequest -> Pegasus hub) actually
// reach the network. Replaces the earlier fail-fast shim, which silently dropped
// every cloud POST. Also translates JSON responses' `msgID` -> `requestID` so
// jetstream-client (which checks getRequestID) accepts what the Pegasus hub
// returns. Note: cross-origin POSTs (the iframe -> pegasus.jibo) require CORS
// on the server — that's the next likely failure mode if this still doesn't go.
function makeHttpClient() {
  function request(options, cb) {
    const reqHandlers = {};
    const body = [];
    const upstreamHost = options.host || options.hostname || '';
    const upstreamPort = options.port || '';
    const directUrl = `http${options.protocol === 'https:' ? 's' : ''}://${upstreamHost}${upstreamPort ? ':' + upstreamPort : ''}${options.path || '/'}`;
    const method = (options.method || 'GET').toUpperCase();
    let sent = false;
    function go() {
      if (sent) return; sent = true;
      const init = { method, headers: Object.assign({}, options.headers || {}) };
      // Route requests to the configured backend (e.g. pegasus.jibo) through the
      // sim server's same-origin /__cloud proxy — the iframe is cross-origin to
      // pegasus and the jibo cloud doesn't set CORS (it was designed for Electron
      // which doesn't enforce it). The proxy strips that boundary.
      let url = directUrl;
      const server = (typeof window !== 'undefined' && window.__JIBO_SERVER__) || '';
      const isPegasus = server && upstreamHost === server;
      // The Pegasus hub speaks the WS-only protocol at /listen and /proactive.
      // jetstream-client sends those as HTTP POSTs (the way the real jetstream
      // service exposes them to skills). Translate to hub WS messages over the
      // already-open hub socket (registered by realSocket) and synthesize the
      // ack the skill expects — { requestID: <transID> }. Mirrors what
      // jiboV2/jetstream JetHttpHandler does in the real service.
      if (isPegasus && /^\/(listen|proactive)\//.test(options.path || '')) {
        return bridgeViaHub(options, body, cb, reqHandlers, upstreamHost);
      }
      if (isPegasus) {
        url = `/__cloud${options.path || '/'}`;
        init.headers['X-Cloud-Upstream'] = `${upstreamHost}${upstreamPort ? ':' + upstreamPort : ''}`;
      }
      if (method !== 'GET' && method !== 'HEAD' && body.length) init.body = body.join('');
      fetch(url, init).then(async (res) => {
        let text = await res.text();
        // Hub responses use msgID/transID; jetstream-client expects requestID.
        // Per jiboV2/jetstream LhubClient.cc the robot's requestID == hub's
        // transID, so prefer transID; msgID is a per-message fallback.
        if (text && text.charCodeAt(0) === 123 /* { */) {
          try {
            const obj = JSON.parse(text);
            if (obj && !obj.requestID) {
              if (obj.transID) obj.requestID = obj.transID;
              else if (obj.msgID) obj.requestID = obj.msgID;
              text = JSON.stringify(obj);
            }
          } catch (_) { /* not JSON, leave as-is */ }
        }
        const respHandlers = {};
        const resp = {
          statusCode: res.status,
          headers: Object.fromEntries(res.headers.entries()),
          setEncoding() {},
          on(ev, h) { (respHandlers[ev] = respHandlers[ev] || []).push(h); if (ev === 'end' && respHandlers.data) setTimeout(flush, 0); return resp; },
          once(ev, h) { return resp.on(ev, h); },
        };
        if (cb) cb(resp);
        let flushed = false;
        function flush() {
          if (flushed) return; flushed = true;
          (respHandlers.data || []).forEach((h) => { try { h(text); } catch (_) {} });
          (respHandlers.end || []).forEach((h) => { try { h(); } catch (_) {} });
        }
        setTimeout(flush, 0);
      }).catch((err) => {
        (reqHandlers.error || []).forEach((h) => { try { h(err); } catch (_) {} });
      });
    }
    const req = {
      on(ev, h) { (reqHandlers[ev] = reqHandlers[ev] || []).push(h); return req; },
      once(ev, h) { return req.on(ev, h); },
      write(data) { if (data != null) body.push(typeof data === 'string' ? data : String(data)); return req; },
      end(data) { if (data != null) body.push(typeof data === 'string' ? data : String(data)); go(); return req; },
      abort() {}, destroy() {}, setTimeout() { return req; }, setHeader(k, v) { (options.headers = options.headers || {})[k] = v; }, flushHeaders() {},
    };
    return req;
  }
  return { request, get(options, cb) { const r = request(typeof options === 'string' ? { method: 'GET', path: options } : options, cb); r.end(); return r; } };
}

// In-memory replacement for the `ws` package. Clients connect silently (emit
// 'open', never 'error'/'close') so jibo-be's HTTPWSClient doesn't reconnect-storm;
// if a handler for the URL is registered on window.__wsServers, the two sides are
// wired for bidirectional JSON messaging (so ported channel services work).
function makeFakeWs() {
  function Socket() { this._h = {}; this.readyState = 1; }
  Socket.prototype.on = function (e, cb) { (this._h[e] = this._h[e] || []).push(cb); return this; };
  Socket.prototype.once = function (e, cb) { const g = (...a) => { this.removeListener(e, g); cb(...a); }; return this.on(e, g); };
  Socket.prototype.addEventListener = Socket.prototype.on;
  Socket.prototype.removeListener = function (e, cb) { const a = this._h[e]; if (a) { const i = a.indexOf(cb); if (i >= 0) a.splice(i, 1); } return this; };
  Socket.prototype.removeAllListeners = function () { this._h = {}; return this; };
  Socket.prototype.emit = function (e, ...a) { (this._h[e] || []).slice().forEach((f) => f(...a)); };
  Socket.prototype.send = function (data) { if (this._peer) { const d = typeof data === 'string' ? data : String(data); setTimeout(() => this._peer.emit('message', d), 0); } };
  Socket.prototype.close = function () { this.readyState = 3; this.emit('close'); };
  Socket.prototype.terminate = function () { this.readyState = 3; };

  // Registry of live hub WebSockets keyed by host, populated by realSocket on
  // open. The HTTP-to-WS bridge (see http.request below) dispatches /listen/*
  // POSTs via the matching open socket rather than HTTP-proxying them, because
  // the Pegasus hub only speaks WebSocket at those paths.
  if (typeof window !== 'undefined' && !window.__hubSockets) window.__hubSockets = {};
  function hostFromUrl(u) { try { return new URL(u).host; } catch (_) { return ''; } }

  // Bridge a real browser WebSocket to the `ws`-package event interface, so the
  // configured backend server (e.g. a Pegasus jetstream at ws://pegasus.jibo:8090)
  // is actually reached instead of the in-memory fake.
  function realSocket(url) {
    const sock = new Socket();
    sock.url = url;
    sock.readyState = 0;
    let real;
    try { real = new window.WebSocket(url); } catch (e) { setTimeout(() => sock.emit('error', e), 0); return sock; }
    real.onopen = () => {
      sock.readyState = 1;
      try { const h = hostFromUrl(url); if (h && typeof window !== 'undefined' && window.__hubSockets) window.__hubSockets[h] = real; } catch (_) {}
      sock.emit('open');
    };
    // The pegasus hub speaks Hubmsg {type, ts, msgID, transID, ...} on its
    // socket; the robot-side jetstream-client expects WSmsg {type, ts, requestID,
    // transID, ...} and rejects events lacking requestID. Per jiboV2/jetstream
    // LhubClient.cc, when the original request_id isn't "GLOBAL", the jetstream
    // service reuses request_id AS the transaction_id — so the robot's requestID
    // ↔ the hub's transID. Mirror that: alias transID -> requestID (msgID is just
    // a per-message id and isn't the correlation key, although we fall back to it
    // for messages that lack a transID).
    real.onmessage = (ev) => {
      let data = ev.data;
      if (typeof data === 'string' && data.charCodeAt(0) === 123 /* { */) {
        try {
          const obj = JSON.parse(data);
          if (obj && !obj.requestID) {
            if (obj.transID) obj.requestID = obj.transID;
            else if (obj.msgID) obj.requestID = obj.msgID;
          }
          data = JSON.stringify(obj);
        } catch (_) { /* not JSON, pass through */ }
      }
      sock.emit('message', data);
    };
    real.onclose = () => {
      sock.readyState = 3;
      try { const h = hostFromUrl(url); if (h && typeof window !== 'undefined' && window.__hubSockets && window.__hubSockets[h] === real) delete window.__hubSockets[h]; } catch (_) {}
      sock.emit('close');
    };
    real.onerror = (e) => sock.emit('error', e);
    sock.send = (data) => { try { real.send(data); } catch (_) { /* not open */ } };
    sock.close = () => { try { real.close(); } catch (_) { /* already closed */ } };
    sock.terminate = sock.close;
    return sock;
  }

  function WebSocket(url) {
    const server = (typeof window !== 'undefined' && window.__JIBO_SERVER__) || '';
    // The pegasus hub uses per-turn WS connections WITH custom upgrade headers
    // (X-JIBO-transID). Browsers can't set those, so the per-turn opens go through
    // the dev server's /__cloud-ws proxy (see bridgeViaHub). The long-lived
    // /events + /vad sockets jetstream-client opens aren't real connections to
    // anything on the hub (the hub has no such routes) — make them silent fakes
    // and register the /events socket so bridgeViaHub can push translated hub
    // events back into jetstream-client through it.
    if (server && String(url).indexOf(server) >= 0 && /\/(events|vad)(\?|$)/.test(String(url))) {
      const sock = new Socket();
      sock.url = url;
      sock.readyState = 1;
      setTimeout(() => sock.emit('open'), 0);
      try {
        const h = hostFromUrl(url);
        if (h && typeof window !== 'undefined' && window.__hubSockets && /\/events/.test(String(url))) {
          window.__hubSockets[h] = sock;
        }
      } catch (_) { /* ignore */ }
      return sock;
    }
    const client = new Socket();
    client.url = url;
    setTimeout(() => {
      const servers = (typeof window !== 'undefined' && window.__wsServers) || [];
      const srv = servers.find((s) => { try { return s.match(url); } catch (_) { return false; } });
      if (srv) {
        const server = new Socket();
        server.url = url;
        let path = url; try { path = new URL(url, 'ws://x').pathname; } catch (_) { /* keep url */ }
        server.upgradeReq = { url: path };
        client._peer = server; server._peer = client;
        try { srv.onConnection(server); } catch (_) { /* handler error */ }
      }
      client.emit('open');   // connect silently whether or not a handler exists
    }, 0);
    return client;
  }
  WebSocket.prototype = Socket.prototype;
  WebSocket.Server = function Server() { this.on = function () { return this; }; this.close = function () {}; this.handleUpgrade = function () {}; };
  WebSocket.CONNECTING = 0; WebSocket.OPEN = 1; WebSocket.CLOSING = 2; WebSocket.CLOSED = 3;
  return WebSocket;
}

function makeBuiltins() {
  // Function-style so it works as both `new EventEmitter()` and the legacy
  // `EventEmitter.call(this)` (pixi.js / node 'events' style).
  function EventEmitter() { if (!this._e) this._e = {}; }
  EventEmitter.prototype.on = function (t, f) { (this._e || (this._e = {})); (this._e[t] = this._e[t] || []).push(f); return this; };
  EventEmitter.prototype.once = function (t, f) { const g = (...a) => { this.removeListener(t, g); f(...a); }; return this.on(t, g); };
  EventEmitter.prototype.addListener = EventEmitter.prototype.on;
  EventEmitter.prototype.removeListener = function (t, f) { const a = this._e && this._e[t]; if (a) { const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); } return this; };
  EventEmitter.prototype.removeAllListeners = function (t) { if (t) { if (this._e) delete this._e[t]; } else this._e = {}; return this; };
  EventEmitter.prototype.emit = function (t, ...a) { const l = (this._e && this._e[t]) || []; l.slice().forEach((f) => f(...a)); return l.length > 0; };
  EventEmitter.prototype.listeners = function (t) { return ((this._e && this._e[t]) || []).slice(); };
  EventEmitter.EventEmitter = EventEmitter;
  // Minimal Node `stream` (jibo-log etc. extend Writable/Transform).
  class Writable extends EventEmitter {
    write(chunk, enc, cb) { this.emit('data', chunk); if (typeof enc === 'function') enc(); else if (cb) cb(); return true; }
    end(chunk, enc, cb) { if (chunk != null) this.write(chunk); this.emit('finish'); this.emit('end'); if (cb) cb(); }
    setDefaultEncoding() { return this; }
    cork() {} uncork() {}
  }
  class Readable extends EventEmitter { pipe(dest) { return dest; } read() { return null; } push() { return true; } resume() { return this; } pause() { return this; } }
  class Transform extends Writable { }
  class Duplex extends Writable { pipe(d) { return d; } }
  class PassThrough extends Transform { }
  const stream = { Writable, Readable, Transform, Duplex, PassThrough, Stream: Writable };

  // Buffer: Uint8Array-backed with a node-like toString(encoding,start,end) so
  // fd reads + `buffer.toString('utf8')` (jibo's AnimDB loader) work, while
  // `new Buffer(n)` / indexed writes / from / concat keep working for ws/iconv/etc.
  const _td = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
  const _te = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  function _decode(u8, encoding, start, end) {
    const s = start || 0;
    const e = end === undefined ? u8.length : end;
    const sub = u8.subarray(s, e);
    if (encoding === 'base64') { let b = ''; for (let i = 0; i < sub.length; i += 1) b += String.fromCharCode(sub[i]); return btoa(b); }
    if (encoding === 'hex') { let h = ''; for (let i = 0; i < sub.length; i += 1) h += sub[i].toString(16).padStart(2, '0'); return h; }
    return _td ? _td.decode(sub) : String.fromCharCode.apply(null, Array.from(sub));
  }
  function _wrap(u8) { u8.toString = function (enc, s, e) { return _decode(this, enc, s, e); }; return u8; }
  function Buffer(arg) {
    if (typeof arg === 'number') return _wrap(new Uint8Array(arg));
    if (typeof arg === 'string') return _wrap(_te ? _te.encode(arg) : Uint8Array.from(arg, (c) => c.charCodeAt(0) & 0xff));
    if (arg instanceof Uint8Array || Array.isArray(arg)) return _wrap(Uint8Array.from(arg));
    return _wrap(new Uint8Array(0));
  }
  Buffer.from = (x) => Buffer(x);
  Buffer.alloc = (n) => _wrap(new Uint8Array(n));
  Buffer.allocUnsafe = (n) => _wrap(new Uint8Array(n));
  Buffer.isBuffer = (x) => x instanceof Uint8Array;
  Buffer.concat = (arr) => { let len = 0; for (const a of arr) len += a.length; const out = new Uint8Array(len); let o = 0; for (const a of arr) { out.set(a, o); o += a.length; } return _wrap(out); };
  // jibo-client-framework's sendPostRequest uses Buffer.byteLength(body) for
  // Content-Length. Without it, every HTTP POST to the Pegasus hub (e.g.
  // /listen/start_local_turn) throws before sending.
  Buffer.byteLength = (str, enc) => {
    if (str == null) return 0;
    if (typeof str !== 'string') return str.length || str.byteLength || 0;
    if (!enc || /^utf-?8$/i.test(enc)) {
      try { return new TextEncoder().encode(str).length; } catch (_) { /* fall through */ }
    }
    return str.length;
  };

  const path = {
    sep: '/',
    join: (...a) => a.filter(Boolean).join('/').replace(/\/{2,}/g, '/'),
    dirname: (p) => String(p).replace(/\/[^/]*$/, '') || '/',
    basename: (p, ext) => { let b = String(p).split('/').pop(); if (ext && b.endsWith(ext)) b = b.slice(0, -ext.length); return b; },
    extname: (p) => { const m = /\.[^./]+$/.exec(String(p)); return m ? m[0] : ''; },
    resolve: (...a) => a.join('/').replace(/\/{2,}/g, '/'),
    relative: (from, to) => to,
    normalize: (p) => String(p).replace(/\/{2,}/g, '/'),
    isAbsolute: (p) => String(p).charAt(0) === '/',
    parse: (p) => {
      p = String(p);
      const base = p.split('/').pop();
      const ext = (/\.[^./]+$/.exec(base) || [''])[0];
      return { root: p[0] === '/' ? '/' : '', dir: p.replace(/\/[^/]*$/, '') || (p[0] === '/' ? '/' : ''), base, ext, name: ext ? base.slice(0, -ext.length) : base };
    },
  };
  const process = {
    env: { NODE_ENV: 'production' },
    platform: 'browser',
    argv: ['node', 'skill'],
    nextTick: (f, ...a) => Promise.resolve().then(() => f(...a)),
    // The skill root, which has a package.json — jibo-plugins FindRoot/getPackagePath
    // and the `core://` asset-pack resolver start here. Returning '/' makes them
    // thrash (no package.json up the tree) and mis-resolve core assets.
    cwd: () => (typeof window !== 'undefined' && window.__SKILL_DIR__) || '/',
    on() {}, once() {}, exit() {},
    title: 'browser', pid: 1, arch: 'x64',
    hrtime: (prev) => {
      const ns = Math.floor((typeof performance !== 'undefined' ? performance.now() : Date.now()) * 1e6);
      const sec = Math.floor(ns / 1e9);
      const nano = ns % 1e9;
      if (prev) { let s = sec - prev[0]; let n = nano - prev[1]; if (n < 0) { s -= 1; n += 1e9; } return [s, n]; }
      return [sec, nano];
    },
    uptime: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000,
    memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }),
    stdout: { write() { return true; } }, stderr: { write() { return true; } },
    send() {},
    version: 'v16.0.0',
    // The real jibo Runtime gates its render path on `process.versions.electron`.
    // Off by default; the live-face boot opts in via window.__JIBO_ELECTRON__ so
    // the shim path for other bundles is unaffected.
    versions: { node: '16.0.0', get electron() { return (typeof window !== 'undefined' && window.__JIBO_ELECTRON__) ? '11.0.0' : undefined; } },
  };
  return {
    events: Object.assign(EventEmitter, { EventEmitter }),
    path,
    process,
    util: {
      inherits: (ctor, sup) => { ctor.super_ = sup; ctor.prototype = Object.create(sup.prototype, { constructor: { value: ctor } }); },
      inspect: (o) => { try { return JSON.stringify(o); } catch (_) { return String(o); } },
      format: (...a) => a.join(' '),
      isArray: Array.isArray,
    },
    // HTTP-backed fs: the real jibo loader (LocalLoader) reads assets via
    // fs.readFile(uri, 'base64'|'utf8'). We map the absolute bundle path onto the
    // skill's HTTP root and fetch it, so the disk loader works unmodified.
    fs: makeHttpFs(),
    os: { platform: () => 'browser', homedir: () => '/', tmpdir: () => '/tmp', EOL: '\n', hostname: () => 'websim' },
    // The real jibo runtime's GlobalPerfTimer double-stops a perf timer during
    // init (benign instrumentation) and asserts on it; that throw would break
    // jibo.init's callback chain, which skills wait on. Downgrade that one to a warn.
    assert: (() => {
      const benign = (m) => typeof m === 'string' && /PerformanceTimer\.stop\(\) was called twice/.test(m);
      const fn = (v, m) => { if (!v) { if (benign(m)) return; throw new Error(m || 'assert'); } };
      return Object.assign(fn, {
        equal: () => {},
        ok: (v, m) => { if (!v) { if (benign(m)) return; throw new Error(m || 'assert'); } },
      });
    })(),
    stream,
    buffer: { Buffer },
    string_decoder: { StringDecoder: class { write(x) { return String(x); } end() { return ''; } } },
    crypto: { randomBytes: (n) => Buffer.alloc(n), createHash: () => ({ update() { return this; }, digest: () => '' }), createHmac: () => ({ update() { return this; }, digest: () => '' }) },
    url: makeUrl(),
    querystring: { parse: (s) => Object.fromEntries(new URLSearchParams(s)), stringify: (o) => new URLSearchParams(o).toString(), escape: (s) => encodeURIComponent(String(s)), unescape: (s) => decodeURIComponent(String(s)) },
    // No local servers exist, so HTTP requests must FAIL FAST (emit 'error') rather
    // than hang — jibo's service clients (RegistryClient/NotificationsDispatcher)
    // wait on the callback and would otherwise stall the whole boot.
    http: makeHttpClient(),
    https: makeHttpClient(),
    net: {}, tls: {}, dns: {}, dgram: {}, zlib: {}, tty: { isatty: () => false },
    vm: (() => {
      // vm.runInContext(code, ctx) returns the COMPLETION VALUE of `code` evaluated
      // with `ctx`'s properties in scope (like eval) — not a function call. jibo's
      // MimConfig.runSandboxed relies on this: it evals `` `${vars}` `` (a template
      // expression) and splits the result, so an impl that returns undefined for a
      // bodied Function (no `return`) silently kills every MIM/menu. Use `with(ctx)`
      // + direct eval so the expression's value is returned.
      const runIn = (code, sandbox) => {
        // eslint-disable-next-line no-new-func
        const fn = new Function('__sandbox__', '__code__', 'with (__sandbox__) { return eval(__code__); }');
        try { return fn(sandbox || {}, String(code)); } catch (_) { return undefined; }
      };
      function Script(code) {
        this.code = code;
        this.runInContext = (ctx) => runIn(code, ctx);
        this.runInNewContext = this.runInContext;
        this.runInThisContext = () => (0, eval)(code); // eslint-disable-line no-eval
      }
      return {
        runInNewContext: runIn,
        runInContext: runIn,
        runInThisContext: (code) => (0, eval)(code), // eslint-disable-line no-eval
        createContext: (o) => o || {},
        isContext: () => true,
        Script,
        compileFunction: (code, params = []) => { try { return new Function(...params, code); } catch (_) { return () => undefined; } }, // eslint-disable-line no-new-func
      };
    })(),
    domain: { create: () => ({ run: (f) => f(), on() {}, add() {}, enter() {}, exit() {}, dispose() {} }) },
    child_process: {}, cluster: {}, readline: {}, timers: { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate: (f) => setTimeout(f, 0) },
    constants: {}, module: { Module: {} },
  };
}
