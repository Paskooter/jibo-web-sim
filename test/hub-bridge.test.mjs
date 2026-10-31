// Unit test for the hub bridge in src/skill-runtime/cjs-require.js: the jetstream
// client's /listen/* and /proactive/* HTTP POSTs become hub messages on a per-turn
// WebSocket. Drives the real require('http') shim with a stub browser WebSocket and
// checks what the bridge sends on it. No browser, no network.
//
// Usage: node test/hub-bridge.test.mjs

import assert from 'node:assert/strict';
import { createRequire } from '../src/skill-runtime/cjs-require.js';

const HUB = 'hub.test';

// Records every per-turn socket the bridge opens and every frame sent on it.
const sockets = [];
class StubWebSocket {
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; }
}
globalThis.window = { WebSocket: StubWebSocket, __JIBO_SERVER__: HUB };
globalThis.location = { protocol: 'http:', host: 'sim.test' };

const http = createRequire(null)('/')('http');

// POST like jetstream-client does, open the turn socket, and collect the skill's
// ack plus the frames the bridge sent on that socket.
function post(path, body) {
  return new Promise((resolve, reject) => {
    const first = sockets.length;
    const log = console.log;
    console.log = () => {};                  // the bridge traces every frame
    try {
      const req = http.request({ host: HUB, port: 9000, path, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
        let text = '';
        res.on('data', (d) => { text += d; });
        res.on('end', () => {
          const opened = sockets.slice(first);
          const frames = opened.length ? opened[0].sent.map((m) => JSON.parse(m)) : [];
          resolve({ ack: JSON.parse(text), opened, ws: opened[0], frames });
        });
      });
      req.on('error', reject);
      req.end(JSON.stringify(body));
      const ws = sockets[first];
      if (ws) { ws.readyState = 1; ws.onopen(); }
    } catch (e) { reject(e); } finally { console.log = log; }
  });
}
const param = (ws, name) => new URL(ws.url).searchParams.get(name);

const TRIGGER_BODY = { triggerSource: 'SURPRISE', triggerData: {} };
const TYPED_TURN = { clientASR: 'what time is it', nluRules: ['launch'], language: 'en-US' };
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// runtime.location.iso is the send time; the rest of the context is fixed.
const withoutTime = (data) => { const c = structuredClone(data); delete c.runtime.location.iso; return c; };

const tests = {
  async 'a proactive trigger sends TRIGGER then CONTEXT on one /proactive socket'() {
    const { opened, ws, frames } = await post('/proactive/trigger', TRIGGER_BODY);
    assert.equal(opened.length, 1, 'one per-turn socket');
    assert.equal(param(ws, 'path'), '/proactive');
    assert.deepEqual(frames.map((f) => f.type), ['TRIGGER', 'CONTEXT']);
  },
  async 'the TRIGGER carries the posted body unchanged'() {
    const { frames } = await post('/proactive/trigger', TRIGGER_BODY);
    assert.equal(frames[0].type, 'TRIGGER');
    assert.deepEqual(frames[0].data, TRIGGER_BODY);
  },
  async 'both proactive frames carry the transID of the socket and of the ack'() {
    const { ack, ws, frames } = await post('/proactive/trigger', TRIGGER_BODY);
    const transID = param(ws, 'transID');
    assert.match(transID, /^tid:/);
    assert.match(transID.slice(4), UUID_V4);
    assert.equal(ack.requestID, transID);
    assert.equal(frames.length, 2, 'TRIGGER and CONTEXT');
    for (const f of frames) assert.equal(f.transID, transID, `${f.type}.transID`);
  },
  async 'the proactive CONTEXT is the context a listen turn sends'() {
    const pro = (await post('/proactive/trigger', TRIGGER_BODY)).frames.find((f) => f.type === 'CONTEXT');
    const lis = (await post('/listen/start_local_turn', TYPED_TURN)).frames.find((f) => f.type === 'CONTEXT');
    assert.ok(pro, 'proactive CONTEXT sent');
    // The hub reads these without null checks.
    assert.ok(pro.data.runtime && pro.data.runtime.loop && Array.isArray(pro.data.runtime.loop.users), 'runtime.loop.users');
    assert.ok(pro.data.runtime.perception && Array.isArray(pro.data.runtime.perception.peoplePresent), 'runtime.perception');
    assert.equal(typeof pro.data.general.release, 'string');
    assert.ok(!Number.isNaN(Date.parse(pro.data.runtime.location.iso)), 'runtime.location.iso is a time');
    assert.deepEqual(withoutTime(pro.data), withoutTime(lis.data));
  },
  async 'the proactive CONTEXT release follows window.__JIBO_RELEASE__'() {
    window.__JIBO_RELEASE__ = '9.8.7';
    try {
      const ctx = (await post('/proactive/trigger', TRIGGER_BODY)).frames.find((f) => f.type === 'CONTEXT');
      assert.ok(ctx, 'proactive CONTEXT sent');
      assert.equal(ctx.data.general.release, '9.8.7');
    } finally { delete window.__JIBO_RELEASE__; }
  },
  async 'a typed listen turn still sends LISTEN, CONTEXT, CLIENT_ASR on one /listen socket'() {
    const { opened, ws, frames } = await post('/listen/start_local_turn', TYPED_TURN);
    assert.equal(opened.length, 1, 'one per-turn socket');
    assert.equal(param(ws, 'path'), '/listen');
    assert.deepEqual(frames.map((f) => f.type), ['LISTEN', 'CONTEXT', 'CLIENT_ASR']);
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message.split('\n').join('\n      ')}`); }
}
console.log(failed ? `\n${failed} test(s) FAILED` : '\nall tests passed');
process.exit(failed ? 1 : 0);
