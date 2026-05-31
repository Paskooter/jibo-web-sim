// Host side of the skill bridge.
//
// The skill runs in a sandboxed <iframe>. Inside it, the `jibo` shim
// (src/skill-runtime/jibo-shim.js) proxies the public `jibo.*` API over
// postMessage to host-side services registered here. This plays the same role
// a desktop simulator's service bus would, but using postMessage as the
// transport instead of WebSocket/HTTP.
//
// Wire protocol (all messages carry `__jibo: true`):
//   skill → host   { kind: 'hello' }                                  handshake
//   skill → host   { kind: 'call', id, ns, method, args }             RPC request
//   host  → skill  { kind: 'reply', id, ok, result|error }            RPC reply
//   host  → skill  { kind: 'event', ns, event, data }                 push event
//
// A service is a plain object: { methodName(...args) -> value|Promise }.
// Returned values (or thrown errors) are sent back as the matching reply.

export function createHostBridge(iframe) {
  const services = new Map();   // ns -> { method: fn }
  const pending = [];           // events queued until the shim says 'hello'
  let ready = false;

  const peer = () => iframe.contentWindow;

  function post(msg) {
    const w = peer();
    if (w) w.postMessage(msg, '*');
  }

  function register(ns, methods) {
    services.set(ns, methods);
  }

  // Push an event to the skill (e.g. tts word timings, asr input).
  function emit(ns, event, data) {
    const msg = { __jibo: true, kind: 'event', ns, event, data };
    if (ready) post(msg);
    else pending.push(msg);
  }

  async function handleCall(msg) {
    const svc = services.get(msg.ns);
    const fn = svc && svc[msg.method];
    let reply;
    if (typeof fn !== 'function') {
      reply = { ok: false, error: `no host handler for ${msg.ns}.${msg.method}` };
    } else {
      try {
        reply = { ok: true, result: await fn(...(msg.args || [])) };
      } catch (e) {
        reply = { ok: false, error: String((e && e.message) || e) };
      }
    }
    post({ __jibo: true, kind: 'reply', id: msg.id, ...reply });
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== peer()) return;            // only our skill iframe
    const msg = ev.data;
    if (!msg || msg.__jibo !== true) return;
    switch (msg.kind) {
      case 'hello':
        ready = true;
        post({ __jibo: true, kind: 'welcome' });
        while (pending.length) post(pending.shift());
        break;
      case 'call':
        handleCall(msg);
        break;
    }
  });

  return {
    register,
    emit,
    get ready() { return ready; },
  };
}
