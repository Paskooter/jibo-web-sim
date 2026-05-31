// In-memory RPC bus connecting the runtime's service clients to local
// service implementations — the in-browser stand-in for the on-device
// localhost service processes. No real ws/http sockets.
//
// The runtime talks to services through a RegistryClient (HTTP service
// discovery) + RemoteClient (per-service WebSocket RPC). We patch those
// — the SAME classes the bundle uses (resolved via the bundle's
// require) — so every service RPC dispatches to a local impl and every
// service event is pushed back through the client's normal event
// machinery.
//
// Protocol: a request is {type:'request', messageId, instanceId,
// methodName, args, sendAndForget}; the reply resolves the caller;
// events are {type:'event', instanceId, args} routed via
// RemoteClient.onEvent -> the registered ClientRemoteObject.

export class ServiceBus {
  constructor() {
    this.host = '127.0.0.1';
    this.services = new Map();        // name -> { name, port, impl }
    this.byPort = new Map();          // port -> entry
    this.clientsByPort = new Map();   // port -> Set<RemoteClient>
    this._nextPort = 9100;
  }

  // Register a service impl. `impl.handle(instanceId, methodName, args) -> result|Promise`
  // dispatches RPCs; if `impl.attachBus({emit, port, name, bus})` exists it's called so
  // the service can push events via emit(instanceId, args).
  register(name, impl) {
    if (this.services.has(name)) return this.services.get(name).port;
    const port = this._nextPort;
    this._nextPort += 1;
    const entry = { name, port, impl };
    this.services.set(name, entry);
    this.byPort.set(port, entry);
    if (impl && typeof impl.attachBus === 'function') {
      impl.attachBus({ bus: this, name, port, emit: (instanceId, args) => this.emitEvent(port, instanceId, args) });
    }
    return port;
  }

  records() {
    return [...this.services.values()].map((e) => ({ name: e.name, host: this.host, port: e.port }));
  }
  recordFor(name) {
    const e = this.services.get(name);
    return e ? { name, host: this.host, port: e.port } : null;
  }

  handleRequest(port, instanceId, methodName, args) {
    const entry = this.byPort.get(port);
    if (!entry || !entry.impl || typeof entry.impl.handle !== 'function') return Promise.resolve(undefined);
    try { return Promise.resolve(entry.impl.handle(instanceId, methodName, args || [])); }
    catch (e) { return Promise.reject(e); }
  }

  // HTTP-service dispatch: `impl.handleHttp(method, path, body) -> {status, body}`.
  handleHttp(port, method, path, body) {
    const entry = this.byPort.get(port);
    if (!entry || !entry.impl || typeof entry.impl.handleHttp !== 'function') return Promise.resolve({ status: 404, body: '' });
    try { return Promise.resolve(entry.impl.handleHttp(method, path, body)); } catch (e) { return Promise.reject(e); }
  }

  // Route XHR to our HTTP services. The runtime's HTTP service clients
  // use raw XMLHttpRequest to http://<host>:<busPort>/<path>; intercept
  // only those and synthesize the response, proxying every other
  // request to the native XHR.
  installHttpInterceptor() {
    if (typeof window === 'undefined' || window.__busXhrPatched) return;
    window.__busXhrPatched = true;
    const bus = this;
    const Real = window.XMLHttpRequest;
    const target = (url) => {
      const m = /^https?:\/\/([^:/]+):(\d+)(\/[^#]*)?$/.exec(String(url));
      if (!m) return null;
      const port = Number(m[2]);
      return bus.byPort.has(port) ? { port, path: m[3] || '/' } : null;
    };
    // Hosts the production bundle POSTs telemetry to (LibraryAnalytics ->
    // segment.com pipeline) that we have no working endpoint for. Their DNS
    // resolves to nothing in our env, so every flush surfaces as
    // `net::ERR_CONNECTION_REFUSED` in devtools. Short-circuit them with a
    // 204 No Content so the bundle's `then`/`catch` paths see a clean
    // discard instead of repeated network errors.
    const blackholed = (url) => /^https?:\/\/(segment\.jibo\.com|api\.segment\.io)(\/|$)/i.test(String(url));
    function BusXHR() { this._real = new Real(); this._t = null; this._blackhole = false; this._ls = {}; this.readyState = 0; this.status = 0; this.responseText = ''; this.response = ''; this.responseType = ''; }
    BusXHR.prototype.open = function (method, url, async) { this._method = method; this._async = async !== false; this._t = target(url); this._blackhole = !this._t && blackholed(url); if (!this._t && !this._blackhole) this._real.open(method, url, this._async); };
    BusXHR.prototype.setRequestHeader = function (k, v) { if (!this._t && !this._blackhole) this._real.setRequestHeader(k, v); };
    BusXHR.prototype.getResponseHeader = function (k) { return (this._t || this._blackhole) ? null : this._real.getResponseHeader(k); };
    BusXHR.prototype.getAllResponseHeaders = function () { return (this._t || this._blackhole) ? '' : this._real.getAllResponseHeaders(); };
    BusXHR.prototype.abort = function () { if (!this._t && !this._blackhole) this._real.abort(); };
    BusXHR.prototype.addEventListener = function (ev, cb) { (this._ls[ev] = this._ls[ev] || []).push(cb); if (!this._t && !this._blackhole) this._real.addEventListener(ev, cb); };
    BusXHR.prototype.removeEventListener = function (ev, cb) { if (!this._t && !this._blackhole) this._real.removeEventListener(ev, cb); };
    BusXHR.prototype._fire = function (ev) { if (typeof this['on' + ev] === 'function') this['on' + ev].call(this, {}); (this._ls[ev] || []).forEach((f) => f.call(this, {})); };
    BusXHR.prototype.send = function (body) {
      if (this._blackhole) {
        // Pretend the analytics endpoint accepted the batch — 204 No Content,
        // empty body, success fire order. Async to match real XHR semantics.
        setTimeout(() => { this.status = 204; this.readyState = 4; this.responseText = ''; this.response = ''; this._fire('readystatechange'); this._fire('load'); }, 0);
        return;
      }
      if (!this._t) {
        const r = this._real;
        r.onreadystatechange = () => { this.readyState = r.readyState; this.status = r.status; try { this.responseText = r.responseText; } catch (_) { /* responseType */ } this.response = r.response; this._fire('readystatechange'); };
        r.onload = () => { this._fire('load'); };
        r.onerror = () => { this._fire('error'); };
        r.ontimeout = () => { this._fire('timeout'); };
        r.send(body);
        return;
      }
      Promise.resolve(bus.handleHttp(this._t.port, this._method, this._t.path, body)).then((res) => {
        res = res || {};
        this.status = res.status || 200;
        const b = res.body;
        this.responseText = b == null ? '' : (typeof b === 'string' ? b : JSON.stringify(b));
        this.response = this.responseText;
        this.readyState = 4;
        this._fire('readystatechange'); this._fire('load');
      }).catch(() => { this.status = 500; this.responseText = ''; this.readyState = 4; this._fire('readystatechange'); this._fire('error'); });
    };
    window.XMLHttpRequest = BusXHR;
    console.log('[bus] HTTP interceptor installed');
  }

  // Push an event from a service to every client connected to its port.
  emitEvent(port, instanceId, args) {
    const set = this.clientsByPort.get(port);
    if (!set) return;
    for (const client of set) {
      try { client.onMessage({ type: 'event', instanceId, args }); } catch (_) { /* client gone */ }
    }
  }

  _addClient(port, client) {
    if (!this.clientsByPort.has(port)) this.clientsByPort.set(port, new Set());
    this.clientsByPort.get(port).add(client);
  }

  // Patch the runtime's client-framework RegistryClient + RemoteClient (idempotent).
  install(requireFn) {
    let cf;
    try { cf = requireFn('jibo-client-framework'); } catch (e) { console.warn('[bus] client framework not loadable:', e.message); return; }
    const bus = this;

    const RegistryClient = cf.RegistryClient;
    if (RegistryClient && RegistryClient.prototype && !RegistryClient.prototype.__busPatched) {
      RegistryClient.prototype.__busPatched = true;
      RegistryClient.prototype.getRecords = function getRecords(cb) { if (cb) cb(null, bus.records()); };
      RegistryClient.prototype.getRecordByName = function getRecordByName(name, cb) {
        const r = bus.recordFor(name);
        if (cb) { if (r) cb(null, r); else cb(new Error(`no record for service "${name}"`)); }
      };
      // Some callers register records; accept + ignore (our registry is authoritative).
      RegistryClient.prototype.register = function register(record, cb) { if (cb) cb(null); };
      RegistryClient.prototype.unregister = function unregister(record, cb) { if (cb) cb(null); };
      // Ensure an instance exists even if createInstance is never called.
      const origCreate = RegistryClient.createInstance;
      RegistryClient.createInstance = function createInstance(host, port) {
        try { return origCreate.call(this, bus.host, port || 1); } catch (_) { return RegistryClient._instance; }
      };
    }
    if (RegistryClient && !RegistryClient._instance) {
      try { RegistryClient.createInstance(bus.host, 1); } catch (_) { /* ignore */ }
    }

    const RemoteClient = cf.RemoteClient;
    if (RemoteClient && RemoteClient.prototype && !RemoteClient.prototype.__busPatched) {
      RemoteClient.prototype.__busPatched = true;
      RemoteClient.prototype.init = function init(port) {
        this.port = port;
        this._isInitialized = true;
        bus._addClient(port, this);
        return Promise.resolve();
      };
      RemoteClient.prototype.sendMessage = function sendMessage(instanceId, methodName, args, sendAndForget) {
        const p = bus.handleRequest(this.port, instanceId, methodName, args);
        return sendAndForget ? undefined : p;
      };
      RemoteClient.prototype.destroy = function destroy() {
        const set = bus.clientsByPort.get(this.port);
        if (set) set.delete(this);
      };
      // onMessage/onEvent/processMessageQueue are reused as-is to route pushed events.
    }
    console.log('[bus] installed; services:', [...this.services.keys()].join(',') || '(none yet)');
  }
}
