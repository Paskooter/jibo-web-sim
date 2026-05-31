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
    // Node-server/native-only deps the runtime pulls in but can't use
    // in-browser (express static file serving; icecast audio streaming).
    // Stub to avoid load errors.
    send: () => ({ on() { return this; }, pipe() {} }), icecast: { Client: function () {}, Reader: function () {}, Writer: function () {} },
    // In-memory WebSocket (the `ws` package). The runtime's service clients
    // open ws channels (body/notifications/lps); with no server they'd
    // error + reconnect forever. This connects silently and routes to
    // local channel handlers registered on window.__wsServers (so
    // ported services can push messages).
    ws: makeFakeWs(),
  };

  // File manifest: a Map of every URL → byte-size under the skill dir, fetched
  // once. Module resolution checks this instead of probing each candidate path
  // over XHR — every missing probe is a console "Failed to load resource" 404,
  // and resolving the real jibo runtime makes thousands of them. With the
  // manifest, only files that actually exist are ever fetched, and the sizes
  // let the fd shim satisfy fstat() without pre-fetching every file body.
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
        const map = new Map();
        for (const e of list) {
          if (typeof e === 'string') map.set(e, 0);
          else if (e && e.url) map.set(e.url, e.size || 0);
        }
        window.__skillManifest = map;
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
  // When a manifest is loaded, ANY path is decidable: under skillRoot we check
  // the manifest, OUTSIDE skillRoot it's guaranteed missing (we only serve the
  // bundle's own tree). This also kills the require-walk's higher node_modules/
  // 404s (the loop probes /skills/node_modules/X, /node_modules/X after
  // exhausting the skill's own — none ever exist).
  const knownMissing = (url) => {
    if (!manifest || !skillRoot) return false;
    if (url.indexOf(skillRoot) !== 0) return true;
    return !manifest.has(normPath(url));
  };
  // FHS-style absolute paths the production runtime probes for on-robot files
  // (jibo-tbd version, /var/jibo/identity.json, /.jibo/t.logging.json, etc.).
  // None exist on our HTTP server — the bundle has try/catch fallbacks for each,
  // but the underlying XHR still lands in devtools as a 404. Short-circuit them
  // so the bundle takes the same fallback path silently.
  const isAbsentAbsolute = (u) => /^\/(opt|var|etc|root|home|usr|sys|proc|tmp|\.jibo|src(\/|$))/.test(String(u));
  function fetchTextSync(url) {
    if (url in textCache) return textCache[url];
    // Don't even request files the manifest says aren't there (avoids 404 noise).
    if (knownMissing(url) || isAbsentAbsolute(url)) { textCache[url] = null; return null; }
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

  // The runtime's PathUtils.resolve() uses node's Module internals to
  // locate packages (e.g. 'animation-utilities' for the eye textures).
  // Back them with our own resolver so those lookups return real paths
  // instead of null.
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

// fs whose reads resolve over HTTP. Absolute bundle paths
// (…/node_modules/x/y) are rebased onto the skill's served root
// (window.__SKILL_DIR__), so the runtime's loader fs.readFile(uri,
// encoding, cb) loads eye textures etc.
function makeHttpFs() {
  // Animation textures (White_Eye.png etc.) shipped under the shared
  // anim-db get referenced by KeysAnimation against the playing skill's
  // assetPack root — so a dance animation queued by the idle skill
  // looks for it at <idle>/animations/textures/X. Every on-robot
  // skill that plays an anim-db named animation will reproduce the
  // same ENOENT. Rewrite at the fs layer (not just at express)
  // because knownMissing() consults the skill manifest BEFORE the
  // fetch fires, so the unrewritten path fails the manifest check
  // and synthesizes ENOENT before HTTP ever sees the URL.
  const ANIM_DB_TEX = '/skills/jibo-be/node_modules/jibo-anim-db-animations/animations/textures/';
  // Capture the SUBPATH after animations/textures/ — not just a single
  // filename — because anim-db textures are organized in subdirectories
  // (e.g. jibojis/coin-flip/coin-tails.png). Earlier version only
  // matched a leaf filename so multi-segment paths fell through and
  // returned ENOENT.
  const BE_TEX_RE = /^(.*?)\/@be\/[^/]+\/animations\/textures\/(.+?)(\?.*)?$/;
  function rewriteAnimTexture(p) {
    const m = BE_TEX_RE.exec(String(p));
    return m ? ANIM_DB_TEX + m[2] + (m[3] || '') : p;
  }
  function mapUrl(p) {
    p = String(p);
    if (/^(https?:)?\/\//.test(p)) return p;
    const root = (typeof window !== 'undefined' && window.__SKILL_DIR__) || '';
    const i = p.lastIndexOf('/node_modules/');
    if (i >= 0) return rewriteAnimTexture(root + p.slice(i));
    if (p[0] === '/') return rewriteAnimTexture(p);  // already an absolute server path
    return rewriteAnimTexture(`${root}/${p}`);
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
  // Also short-circuit FHS-style absolute paths the on-robot bundle probes for
  // (/var/jibo/identity.json, /.jibo/t.logging.json, /src/package.json, etc.) —
  // these never exist on our HTTP server and every probe lands as a 404 in
  // devtools even though the bundle has a try/catch fallback for each.
  const isAbsentFhsPath = (u) => /^\/(opt|var|etc|root|home|usr|sys|proc|tmp|\.jibo|src(\/|$))/.test(String(u));
  function knownMissing(url) {
    if (isAbsentFhsPath(url)) return true;
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
  // Synchronous reads (PathUtils.findRoot walks up for package.json)
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
  function existsSync(p) {
    const u = mapUrl(p);
    return getSync(u, false) !== null || isDirInManifest(u);
  }
  function readFileSync(p, opts) {
    const enc = typeof opts === 'string' ? opts : (opts && opts.encoding);
    const url = mapUrl(p);
    const binary = enc === 'base64';
    const text = getSync(url, binary);
    if (text === null) { const e = new Error(`ENOENT: ${url}`); e.code = 'ENOENT'; throw e; }
    if (binary) { let bin = ''; for (let i = 0; i < text.length; i += 1) bin += String.fromCharCode(text.charCodeAt(i) & 0xff); return btoa(bin); }
    return text;
  }
  // fd-based reads (FileUtils.readFile opens, fstats, chunk-reads,
  // closes — used to load the 1MB AnimDB). open fetches the whole file
  // once. Directory paths get a marker fd so fstat reports
  // isDirectory()=true — this is what FileUtils.findAllFilesWithExt
  // uses to walk into subdirs (chitchat populates its
  // scriptedResponseMiMSet that way at postInit).
  const fds = new Map();
  let fdSeq = 1;
  function isDirInManifest(url) {
    const m = typeof window !== 'undefined' && window.__skillManifest;
    if (!m) return false;
    if (m.has(url)) return false;
    const prefix = url.endsWith('/') ? url : url + '/';
    for (const entry of m.keys()) { if (entry.startsWith(prefix)) return true; }
    return false;
  }
  function open(p, flags, mode, cb) {
    if (typeof mode === 'function') { cb = mode; mode = undefined; }
    if (typeof flags === 'function') { cb = flags; flags = 'r'; }
    const u0 = mapUrl(p);
    if (isDirInManifest(u0)) {
      const fd = fdSeq; fdSeq += 1; fds.set(fd, { __dir: true }); cb(null, fd); return;
    }
    // Lazy fd for in-manifest files: defer the body fetch until the first
    // read. chitchat's postInit walks ~3900 mim files via fs.open + fstat +
    // close just to discriminate files from directories; eagerly fetching
    // every body wasted ~16 MB. fstat satisfies size from the manifest;
    // read fetches lazily on first call.
    const m = typeof window !== 'undefined' && window.__skillManifest;
    if (m && m.has(u0)) {
      const fd = fdSeq; fdSeq += 1;
      fds.set(fd, { __lazyUrl: u0, __size: m.get(u0) || 0 });
      cb(null, fd);
      return;
    }
    if (knownMissing(u0)) { const e = new Error(`ENOENT: ${u0}`); e.code = 'ENOENT'; cb(e); return; }
    fetch(u0).then((r) => { if (!r.ok) throw new Error(`ENOENT ${r.status}`); return r.arrayBuffer(); })
      .then((b) => { const fd = fdSeq; fdSeq += 1; fds.set(fd, new Uint8Array(b)); cb(null, fd); })
      .catch((e) => cb(e));
  }
  function fstat(fd, cb) {
    const u = fds.get(fd);
    if (!u) return cb && cb(new Error('EBADF'));
    if (u.__dir) return cb && cb(null, { size: 0, isFile: () => false, isDirectory: () => true });
    if (u.__lazyUrl) return cb && cb(null, { size: u.__size, isFile: () => true, isDirectory: () => false });
    return cb && cb(null, { size: u.length, isFile: () => true, isDirectory: () => false });
  }
  function read(fd, buffer, offset, length, position, cb) {
    const u = fds.get(fd);
    if (!u) return cb && cb(new Error('EBADF'));
    if (u.__dir) return cb && cb(new Error('EISDIR'));
    if (u.__lazyUrl) {
      // First read on a lazy fd: fetch the body, replace the entry with the
      // bytes, and re-dispatch through the buffered path.
      const url = u.__lazyUrl;
      fetch(url).then((r) => { if (!r.ok) throw new Error(`ENOENT ${r.status}`); return r.arrayBuffer(); })
        .then((b) => {
          const bytes = new Uint8Array(b);
          fds.set(fd, bytes);
          read(fd, buffer, offset, length, position, cb);
        })
        .catch((e) => cb && cb(e));
      return;
    }
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
    statSync: (p) => {
      const u = mapUrl(p);
      if (isDirInManifest(u)) return { isFile: () => false, isDirectory: () => true, size: 0 };
      if (!existsSync(p)) { const e = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; throw e; }
      return { isFile: () => true, isDirectory: () => false, size: 0 };
    },
    stat: (p, cb) => {
      const u = mapUrl(p);
      if (isDirInManifest(u)) return cb && cb(null, { isFile: () => false, isDirectory: () => true, size: 0 });
      return cb && cb(null, { isFile: () => true, isDirectory: () => false, size: 0 });
    },
    // fs-extra extras (log libs call these for log dirs); no real FS, so no-op.
    ensureDirSync: () => {}, ensureDir: (p, cb) => { const f = typeof p === 'function' ? p : cb; if (f) f(null); },
    ensureFileSync: () => {}, mkdirpSync: () => {}, mkdirp: (p, cb) => { const f = typeof p === 'function' ? p : cb; if (f) f(null); },
    outputFile: (p, d, cb) => { if (cb) cb(null); }, outputFileSync: () => {}, removeSync: () => {}, remove: (p, cb) => { const f = typeof p === 'function' ? p : cb; if (f) f(null); },
    open, fstat, read, close,
    // readdir / readdirSync walk the manifest. Used by
    // FileUtils.findAllFilesWithExt to populate chitchat's scripted /
    // emotion mim sets at postInit. Without this the sets stayed empty
    // and every scripted-response lookup missed even when the rule
    // produced the right mim ID.
    readdir: (p, cb) => {
      const f = typeof cb === 'function' ? cb : (typeof p === 'function' ? p : null);
      if (!f) return;
      const m = typeof window !== 'undefined' && window.__skillManifest;
      if (!m) { f(null, []); return; }
      const url = mapUrl(p);
      const prefix = url.endsWith('/') ? url : url + '/';
      const seen = new Set();
      for (const entry of m.keys()) {
        if (!entry.startsWith(prefix)) continue;
        const name = entry.slice(prefix.length).split('/')[0];
        if (name) seen.add(name);
      }
      f(null, Array.from(seen));
    },
    readdirSync: (p) => {
      const m = typeof window !== 'undefined' && window.__skillManifest;
      if (!m) return [];
      const url = mapUrl(p);
      const prefix = url.endsWith('/') ? url : url + '/';
      const seen = new Set();
      for (const entry of m.keys()) {
        if (!entry.startsWith(prefix)) continue;
        const name = entry.slice(prefix.length).split('/')[0];
        if (name) seen.add(name);
      }
      return Array.from(seen);
    },
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
// ---- Hub HTTP-to-WS bridge -------------------------------------------------
// The jetstream client sends `/listen/*` and `/proactive/*` over HTTP
// (that's the API the on-device jetstream service exposes to skills),
// but the cloud hub itself only speaks WebSocket at those paths. The
// on-device jetstream service translates each HTTP POST into Hubmsg
// WebSocket messages on its persistent hub connection, then
// synchronously acks the skill's POST with the booking transaction id.
// bridgeViaHub does the same thing in-browser, sending the translated
// Hubmsg(s) on the realSocket already open to the hub and responding
// to the POST with `{ requestID: <transID> }`. Async hub events then
// come back over the same WS and realSocket's onmessage aliases
// transID->requestID for the jetstream client.

function _hubUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// Translate a jetstream-client HTTP body into the Hubmsg(s) the hub
// expects for that path. Returns an array — start_local_turn can be
// 2 messages (LISTEN + CLIENT_NLU/CLIENT_ASR), most others are single.
function _buildHubMessages(path, body, transID) {
  const ts = Date.now();
  const mid = () => 'mid:' + _hubUuid();
  if (path === '/listen/start_local_turn') {
    // Hub TIMEOUT_CONTEXT is 5000ms; if no CONTEXT message arrives
    // within 5s after LISTEN, the hub fires ERROR { code: TIMEOUT_CONTEXT }.
    // The C++ jetstream-service and the hub-client-cli both send a
    // CONTEXT — collapse that into our LISTEN bundle:
    //   LISTEN  +  CONTEXT(general:null)  +  CLIENT_NLU
    // CONTEXT with `general: null` triggers MessagePreProcessor to
    // auto-fill {accountID: socket.auth.id, robotID: socket.auth.friendlyId}
    // (we sign a Bearer JWT in server.js using the hub-client-cli
    // default creds, so socket.auth is populated correctly).
    // BaseMessage shape is { type, msgID, ts, data }; transID is the
    // SOCKET header, not a per-message field. ListenMessageMode is only
    // CLIENT_ASR | CLIENT_NLU (audio path = no mode).
    const mode = body.clientNLU != null ? 'CLIENT_NLU' : (body.clientASR ? 'CLIENT_ASR' : undefined);
    const lang = String(body.language || 'en-US').toLowerCase() === 'en-ca' ? 'en-CA' : 'en-US';
    const data = {
      lang,
      hotphrase: !!body.hotphrase,
      rules: Array.isArray(body.nluRules) ? body.nluRules.map((r) => String(r).toLowerCase()) : [],
    };
    if (mode) data.mode = mode;
    if (!mode || mode === 'CLIENT_ASR') {
      data.asr = {
        hints: body.hintPhrases || [],
        earlyEOS: body.earlyEOS || [],
        encoding: 'opus',
        sampleRate: 16000,
        sosTimeout: body.sosTimeout > 0 ? Math.round(body.sosTimeout * 1000) : -1,
        maxSpeechTimeout: body.maxSpeechTimeout > 0 ? Math.round(body.maxSpeechTimeout * 1000) : -1,
      };
    }
    // CONTEXT.runtime needs to be structurally complete: the deployed
    // hub reads `runtime.loop` etc. without null-checks and crashed
    // with "Cannot read property 'loop' of null" on null runtime. Use
    // sensible defaults — empty loop/users/peoplePresent, neutral
    // character, etc.
    const _runtime = {
      loop: { loopId: '', jibo: { id: '', birthdate: 0, color: 'WHITE' }, owner: '', users: [] },
      location: { lng: 0, lat: 0, country: '', countryCode: '', stateAbbr: '', state: '', city: '', iso: new Date().toISOString() },
      perception: { peoplePresent: [], speaker: null },
      character: { motivation: { playful: 0, social: 0 }, emotion: { confidence: 0, valence: 0, name: 'NEUTRAL' } },
      dialog: { referent: null },
    };
    // CONTEXT.data.general.release is read by the hub's intent-router
    // decision mediator. If release < '1.9.0', it overrides certain IR
    // decisions — notably rewriting `report-skill` + requestNews into
    // `{skillID:'news'}`, which doesn't exist on current builds (the
    // news manifest moved into answer-skill RSS). MessagePreProcessor
    // auto-fills general {accountID,robotID,lang,remoteAddress} but
    // NOT release, so without us stamping a value the mediator runs
    // and breaks news. Provide a current release so the mediator
    // stays out of the way and the IR decision (report-skill) stands.
    const generalRelease = (typeof window !== 'undefined' && window.__JIBO_RELEASE__) || '1.9.0';
    const msgs = [
      { type: 'LISTEN', msgID: mid(), ts, data },
      { type: 'CONTEXT', msgID: mid(), ts, data: { general: { release: generalRelease }, runtime: _runtime, skill: null } },
    ];
    if (body.clientNLU != null) {
      // NLUResult shape: { rules, intent, entities }. The jetstream
      // client may send `rules: null` — normalize to [].
      const raw = typeof body.clientNLU === 'string'
        ? (() => { try { return JSON.parse(body.clientNLU); } catch (_) { return { intent: body.clientNLU }; } })()
        : body.clientNLU;
      const nluData = {
        rules: Array.isArray(raw.rules) ? raw.rules : [],
        intent: raw.intent || '',
        entities: raw.entities || {},
      };
      msgs.push({ type: 'CLIENT_NLU', msgID: mid(), ts, data: nluData });
    } else if (body.clientASR) {
      msgs.push({ type: 'CLIENT_ASR', msgID: mid(), ts, data: { text: String(body.clientASR) } });
    }
    return msgs;
  }
  if (path === '/listen/mimic_global_turn') {
    const data = body.nlu || body.clientNLU || body;
    return [{ type: 'CLIENT_NLU', msgID: mid(), transID: 'GLOBAL', ts, data }];
  }
  if (path === '/listen/update_local_turn') {
    // LocalTurnRequest.update(asrOrNlu) posts a body with EITHER
    // clientASR (string) OR clientNLU (object). Route to the matching
    // envelope so the hub parses raw text against the existing turn's
    // rules instead of treating it as a pre-parsed NLU. Sending
    // CLIENT_NLU here breaks typed-in "yes/sure" replies — the hub
    // returns intent="sure" literally and the MIM rejects it (rules
    // expect parsed "yes").
    if (body && typeof body.clientASR === 'string') {
      return [{ type: 'CLIENT_ASR', msgID: mid(), transID, ts, data: { text: body.clientASR } }];
    }
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

// Per-turn WS to the hub, opened through the dev server's /__cloud-ws
// proxy so X-JIBO-transID can be set on the upgrade (browsers can't
// set custom WS headers). Each turn gets its own WebSocket — the hub
// uses transID on the socket itself ("a new socket connection is used
// for each request"). Inbound hub events are translated and forwarded
// onto the jetstream client's long-lived eventWS fake (registered in
// __hubSockets), so the skill receives them as if they came through
// one stream.
// Translate one inbound hub Hubmsg into jetstream WSmsg event(s). Hub
// vocabulary (LISTEN, NLU, ASR, SOS_TIMEOUT, ...) maps to robot-side
// jetstream events (TURN_RESULT, SOS, EOS, HJ_*, SKILL_*, PROACTIVE).
function _translateHubMsg(hubMsg, transID, requestID, isGlobal) {
  const base = { ts: hubMsg.ts || Date.now(), transID, requestID };
  switch (hubMsg.type) {
    case 'SOS':                 return [{ ...base, type: 'SOS' }];
    case 'EOS':                 return [{ ...base, type: 'EOS' }];
    case 'SOS_TIMEOUT':         return isGlobal
      ? [{ ...base, type: 'HJ_ONLY' }]
      : [{ ...base, type: 'TURN_RESULT', data: { status: 'TIMEDOUT', message: 'sos', global: isGlobal } }];
    case 'MAX_SPEECH_TIMEOUT':  return [{ ...base, type: 'TURN_RESULT', data: { status: 'TIMEDOUT', message: 'maxSpeech', global: isGlobal } }];
    case 'LISTEN':              // hub-side LISTEN response = final turn result (asr+nlu+match)
      return [{ ...base, type: 'TURN_RESULT', data: { status: 'SUCCEEDED', result: hubMsg.data, global: isGlobal } }];
    case 'ERROR':               return [
      { ...base, type: 'ERROR', data: hubMsg.data },
      { ...base, type: 'TURN_RESULT', data: { status: 'FAILED', message: (hubMsg.data && hubMsg.data.message) || 'hub error', global: isGlobal } },
    ];
    case 'SKILL_REDIRECT':
    case 'SKILL_ACTION':
    case 'PROACTIVE':
    case 'COMMAND':
      return [{ ...base, type: hubMsg.type, data: hubMsg.data }];
    // Intermediate hub state — the on-device jetstream service consumes
    // these without emitting an event of its own (the final LISTEN
    // response is what matters).
    case 'ASR':
    case 'NLU':                 return [];
    default:                    return [{ ...base, type: hubMsg.type, data: hubMsg.data }];
  }
}

function bridgeViaHub(options, body, cb, reqHandlers, host) {
  const key = host + (options.port ? ':' + options.port : '');
  const reg = (typeof window !== 'undefined' && window.__hubSockets) || {};
  const eventSock = reg[key] || reg[host];
  let bodyObj = {};
  try { bodyObj = JSON.parse(body.join('') || '{}'); } catch (_) { /* leave empty */ }
  const isGlobal = options.path === '/listen/mimic_global_turn';
  const transID = isGlobal ? 'GLOBAL' : 'tid:' + _hubUuid();
  const requestID = transID; // request_id is reused as transaction_id
  const msgs = _buildHubMessages(options.path, bodyObj, transID);

  const hubPath = options.path.startsWith('/proactive/') ? '/proactive' : '/listen';
  const proxyUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/__cloud-ws?upstream=${encodeURIComponent(key)}&path=${encodeURIComponent(hubPath)}&transID=${encodeURIComponent(transID)}`;
  let turnWS;
  try { turnWS = new window.WebSocket(proxyUrl); }
  catch (e) { setTimeout(() => (reqHandlers.error || []).forEach((h) => { try { h(e); } catch (_) { /* */ } }), 0); return; }

  const emitToSkill = (obj) => { if (!eventSock) return; try { eventSock.emit('message', JSON.stringify(obj)); } catch (_) { /* */ } };
  const pending = msgs.map((m) => JSON.stringify(m));
  console.log('[hub-bridge] open', transID, 'path=', options.path, '->', proxyUrl);
  turnWS.onopen = () => {
    console.log('[hub-bridge] WS open', transID, 'sending', pending.length, 'msg(s)');
    for (const m of pending) {
      console.log('[hub-bridge]   ->', m.slice(0, 200));
      try { turnWS.send(m); } catch (e) { console.warn('[hub-bridge] send threw', e.message); }
    }
    if (!isGlobal) {
      const ts = { ts: Date.now(), type: 'TURN_STARTED', transID, requestID };
      console.log('[hub-bridge] emit TURN_STARTED', transID);
      emitToSkill(ts);
    }
  };
  turnWS.onmessage = (ev) => {
    let raw = ev.data;
    console.log('[hub-bridge] <-', transID, 'type=', typeof raw, String(raw).slice(0, 200));
    if (typeof raw !== 'string') { return; }
    try {
      const hubMsg = JSON.parse(raw);
      const events = _translateHubMsg(hubMsg, transID, requestID, isGlobal);
      console.log('[hub-bridge]   translated -> ', events.length, events.map((e) => e.type).join(','));
      for (const e of events) emitToSkill(e);
    } catch (e) { console.warn('[hub-bridge] parse failed', e.message); }
  };
  turnWS.onerror = (e) => { console.warn('[hub-bridge] WS error', transID, e && e.message); };
  turnWS.onclose = (e) => { console.log('[hub-bridge] WS close', transID, 'code=', e.code, 'reason=', e.reason); };

  _synthHttpJson(cb, { requestID });
}

// Node-style http.request implemented on top of browser `fetch`, so
// the runtime's service clients (e.g. jetstream-client.sendPostRequest
// -> cloud hub) actually reach the network. Replaces the earlier
// fail-fast shim, which silently dropped every cloud POST. Also
// translates JSON responses' `msgID` -> `requestID` so the jetstream
// client (which checks getRequestID) accepts what the hub returns.
// Note: cross-origin POSTs require CORS on the server — that's the
// next likely failure mode if this still doesn't go.
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
      // Route requests to the configured backend through the sim
      // server's same-origin /__cloud proxy — the iframe is cross-origin
      // to the backend host, and the jibo cloud doesn't set CORS (it
      // was designed for Electron which doesn't enforce it). The proxy
      // strips that boundary.
      let url = directUrl;
      const server = (typeof window !== 'undefined' && window.__JIBO_SERVER__) || '';
      const isHub = server && upstreamHost === server;
      // The cloud hub speaks the WS-only protocol at /listen and
      // /proactive. The jetstream client sends those as HTTP POSTs
      // (the way the on-device jetstream service exposes them to
      // skills). Translate to hub WS messages over the already-open
      // hub socket (registered by realSocket) and synthesize the ack
      // the skill expects — { requestID: <transID> }.
      if (isHub && /^\/(listen|proactive)\//.test(options.path || '')) {
        return bridgeViaHub(options, body, cb, reqHandlers, upstreamHost);
      }
      if (isHub) {
        url = `/__cloud${options.path || '/'}`;
        init.headers['X-Cloud-Upstream'] = `${upstreamHost}${upstreamPort ? ':' + upstreamPort : ''}`;
      }
      if (method !== 'GET' && method !== 'HEAD' && body.length) init.body = body.join('');
      fetch(url, init).then(async (res) => {
        let text = await res.text();
        // Hub responses use msgID/transID; the jetstream client
        // expects requestID. The robot's requestID == hub's transID,
        // so prefer transID; msgID is a per-message fallback.
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

// In-memory replacement for the `ws` package. Clients connect silently
// (emit 'open', never 'error'/'close') so the runtime's HTTPWSClient
// doesn't reconnect-storm; if a handler for the URL is registered on
// window.__wsServers, the two sides are wired for bidirectional JSON
// messaging (so ported channel services work).
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

  // Registry of live hub WebSockets keyed by host, populated by
  // realSocket on open. The HTTP-to-WS bridge (see http.request below)
  // dispatches /listen/* POSTs via the matching open socket rather
  // than HTTP-proxying them, because the cloud hub only speaks
  // WebSocket at those paths.
  if (typeof window !== 'undefined' && !window.__hubSockets) window.__hubSockets = {};
  function hostFromUrl(u) { try { return new URL(u).host; } catch (_) { return ''; } }

  // Bridge a real browser WebSocket to the `ws`-package event
  // interface, so the configured backend server is actually reached
  // instead of the in-memory fake.
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
    // The cloud hub speaks Hubmsg {type, ts, msgID, transID, ...} on
    // its socket; the robot-side jetstream client expects WSmsg
    // {type, ts, requestID, transID, ...} and rejects events lacking
    // requestID. When the original request_id isn't "GLOBAL", the
    // jetstream service reuses request_id AS the transaction_id — so
    // the robot's requestID ↔ the hub's transID. Mirror that: alias
    // transID -> requestID (msgID is just a per-message id and isn't
    // the correlation key, although we fall back to it for messages
    // that lack a transID).
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
    // The cloud hub uses per-turn WS connections WITH custom upgrade
    // headers (X-JIBO-transID). Browsers can't set those, so the
    // per-turn opens go through the dev server's /__cloud-ws proxy
    // (see bridgeViaHub). The long-lived /events + /vad sockets the
    // jetstream client opens aren't real connections to anything on
    // the hub (the hub has no such routes) — make them silent fakes
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
  // Minimal Node `stream` (log libs etc. extend Writable/Transform).
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

  // Buffer: Uint8Array-backed with a node-like toString(encoding,start,end)
  // so fd reads + `buffer.toString('utf8')` (the AnimDB loader) work,
  // while `new Buffer(n)` / indexed writes / from / concat keep
  // working for ws/iconv/etc.
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
  // The client framework's sendPostRequest uses Buffer.byteLength(body)
  // for Content-Length. Without it, every HTTP POST to the cloud hub
  // (e.g. /listen/start_local_turn) throws before sending.
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
    // The skill root, which has a package.json — FindRoot/getPackagePath
    // and the `core://` asset-pack resolver start here. Returning '/'
    // makes them thrash (no package.json up the tree) and mis-resolve
    // core assets.
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
