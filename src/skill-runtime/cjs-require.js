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

export function createRequire(jibo) {
  const moduleCache = {};      // url -> { exports }
  const textCache = {};        // url -> string | null
  const builtins = makeBuiltins();

  function fetchTextSync(url) {
    if (url in textCache) return textCache[url];
    let text = null;
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, false);
      xhr.send(null);
      if (xhr.status >= 200 && xhr.status < 300) text = xhr.responseText;
    } catch (_) { text = null; }
    textCache[url] = text;
    return text;
  }
  const exists = (url) => fetchTextSync(url) !== null;

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
    if (request[0] === '.' || request[0] === '/') {
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

  function requireFrom(fromDir) {
    return function require(request) {
      if (request === 'jibo') return jibo;
      if (builtins[request]) return builtins[request];

      const url = resolve(request, fromDir);
      if (!url) { console.warn(`[require] cannot resolve '${request}' from ${fromDir}`); return {}; }
      if (moduleCache[url]) return moduleCache[url].exports;

      const src = fetchTextSync(url);
      if (src == null) { console.warn(`[require] failed to load ${url}`); return {}; }

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
        console.error(`[require] error executing ${url}:`, e);
      }
      return module.exports;
    };
  }

  return requireFrom;
}

function makeBuiltins() {
  class EventEmitter {
    constructor() { this._e = {}; }
    on(t, f) { (this._e[t] = this._e[t] || []).push(f); return this; }
    once(t, f) { const g = (...a) => { this.removeListener(t, g); f(...a); }; return this.on(t, g); }
    addListener(t, f) { return this.on(t, f); }
    removeListener(t, f) { const a = this._e[t]; if (a) { const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); } return this; }
    removeAllListeners(t) { if (t) delete this._e[t]; else this._e = {}; return this; }
    emit(t, ...a) { (this._e[t] || []).slice().forEach((f) => f(...a)); return (this._e[t] || []).length > 0; }
    listeners(t) { return (this._e[t] || []).slice(); }
  }
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

  // Buffer must be constructable (`new Buffer(...)` is used by ws/iconv/etc.).
  function Buffer(arg) {
    if (typeof arg === 'number') return new Array(arg).fill(0);
    if (typeof arg === 'string') return arg.split('').map((c) => c.charCodeAt(0));
    return arg || [];
  }
  Buffer.from = (x) => (typeof x === 'string' ? x.split('').map((c) => c.charCodeAt(0)) : (x || []));
  Buffer.alloc = (n) => new Array(n).fill(0);
  Buffer.allocUnsafe = (n) => new Array(n).fill(0);
  Buffer.isBuffer = () => false;
  Buffer.concat = (arr) => [].concat(...arr);

  const path = {
    sep: '/',
    join: (...a) => a.filter(Boolean).join('/').replace(/\/{2,}/g, '/'),
    dirname: (p) => String(p).replace(/\/[^/]*$/, '') || '/',
    basename: (p, ext) => { let b = String(p).split('/').pop(); if (ext && b.endsWith(ext)) b = b.slice(0, -ext.length); return b; },
    extname: (p) => { const m = /\.[^./]+$/.exec(String(p)); return m ? m[0] : ''; },
    resolve: (...a) => a.join('/').replace(/\/{2,}/g, '/'),
    relative: (from, to) => to,
    normalize: (p) => String(p).replace(/\/{2,}/g, '/'),
  };
  const process = {
    env: { NODE_ENV: 'production' },
    platform: 'browser',
    argv: ['node', 'skill'],
    nextTick: (f, ...a) => Promise.resolve().then(() => f(...a)),
    cwd: () => '/',
    on() {}, once() {}, exit() {},
    version: 'v16.0.0', versions: { node: '16.0.0' },
  };
  return {
    events: Object.assign(function () {}, { EventEmitter }),
    eventemitter3: EventEmitter,
    path,
    process,
    util: {
      inherits: (ctor, sup) => { ctor.super_ = sup; ctor.prototype = Object.create(sup.prototype, { constructor: { value: ctor } }); },
      inspect: (o) => { try { return JSON.stringify(o); } catch (_) { return String(o); } },
      format: (...a) => a.join(' '),
      isArray: Array.isArray,
    },
    fs: { readFileSync: () => { throw new Error('fs unavailable in web sim'); }, existsSync: () => false, readFile: (p, o, cb) => (cb || o)(new Error('fs unavailable')) },
    os: { platform: () => 'browser', homedir: () => '/', tmpdir: () => '/tmp', EOL: '\n', hostname: () => 'websim' },
    assert: Object.assign((v, m) => { if (!v) throw new Error(m || 'assert'); }, { equal: () => {}, ok: (v, m) => { if (!v) throw new Error(m || 'assert'); } }),
    stream,
    buffer: { Buffer },
    string_decoder: { StringDecoder: class { write(x) { return String(x); } end() { return ''; } } },
    crypto: { randomBytes: (n) => Buffer.alloc(n), createHash: () => ({ update() { return this; }, digest: () => '' }), createHmac: () => ({ update() { return this; }, digest: () => '' }) },
    url: { parse: (u) => { try { const x = new URL(u); return { href: x.href, protocol: x.protocol, host: x.host, hostname: x.hostname, port: x.port, pathname: x.pathname, search: x.search, query: x.search.slice(1) }; } catch (_) { return { href: u }; } }, format: (o) => (typeof o === 'string' ? o : o.href || ''), resolve: (from, to) => { try { return new URL(to, from).href; } catch (_) { return to; } } },
    querystring: { parse: (s) => Object.fromEntries(new URLSearchParams(s)), stringify: (o) => new URLSearchParams(o).toString() },
    http: { request: () => ({ on() { return this; }, end() {}, write() {} }), get: () => ({ on() { return this; } }) },
    https: { request: () => ({ on() { return this; }, end() {}, write() {} }), get: () => ({ on() { return this; } }) },
    net: {}, tls: {}, dns: {}, dgram: {}, zlib: {}, tty: { isatty: () => false }, vm: {},
    child_process: {}, cluster: {}, readline: {}, timers: { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate: (f) => setTimeout(f, 0) },
    constants: {}, module: { Module: {} },
  };
}
