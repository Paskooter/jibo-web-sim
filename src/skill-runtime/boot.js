// Skill iframe bootstrap + in-place loader.
//
// Runs an ORIGINAL skill bundle unmodified. Two modes, chosen by what the bundle
// ships:
//
//  - SHIM mode (our demo skills, most third-party skills): install our lightweight
//    `jibo` runtime (window.jibo) so `require('jibo')` resolves to it.
//  - REAL-RUNTIME mode (bundles that ship their own jibo runtime, e.g. jibo-be):
//    let `require('jibo')` load the bundle's OWN real runtime (real PixiJS
//    FaceRenderer etc.), boot it in UNIT_TESTS run mode so its robot-service
//    plugins skip cleanly offline, and drive the eye locally (see live-eye.js).
//
// Either way we then fetch the bundle's own index.html and run it as written.
// The skill dir + entry come from the iframe src: /skill-host.html?dir=…&entry=…

import { installJiboShim } from './jibo-shim.js';
import { createRequire } from './cjs-require.js';
import { prepareLiveEye, populateExpressionDofs, installExpressionStubs, initOfflineServices, patchBeFramework, driveEye, installWebSpeech, connectCloud } from './live-eye.js';
import { installServiceBus } from './services/index.js';
import { installKbService } from './services/kb-service.js';

const params = new URLSearchParams(location.search);
const dir = (params.get('dir') || '/skills/hello-world').replace(/\/$/, '');
const entry = params.get('entry') || 'index.html';
// Optional backend server (e.g. a Pegasus cloud at `pegasus.jibo`), set in the
// host UI. Exposed for the runtime/services to route cloud requests at.
const server = (params.get('server') || '').trim();
if (server) window.__JIBO_SERVER__ = server;

// Run the bundle's index.html: inject its styles + body DOM, then run its scripts
// (external src resolved against the bundle dir; inline via eval).
function runBundle(onDone) {
  function runScripts(scripts, i) {
    if (i >= scripts.length) { if (onDone) onDone(); return; }
    const s = scripts[i];
    const src = s.getAttribute('src');
    if (src) {
      const el = document.createElement('script');
      el.src = new URL(src, `${location.origin}${dir}/`).href;
      el.onload = el.onerror = () => runScripts(scripts, i + 1);
      document.body.appendChild(el);
    } else {
      try { (0, eval)(s.textContent); } catch (e) { console.error('[skill] script error:', e); } // eslint-disable-line no-eval
      runScripts(scripts, i + 1);
    }
  }

  fetch(`${dir}/${entry}`)
    .then((r) => r.text())
    .then((html) => {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const base = document.createElement('base');
      base.href = `${dir}/`;
      document.head.appendChild(base);
      doc.querySelectorAll('style, link[rel="stylesheet"]').forEach((node) => document.head.appendChild(document.importNode(node, true)));
      Array.from(doc.body.childNodes).forEach((node) => {
        if (node.nodeName !== 'SCRIPT') document.body.appendChild(document.importNode(node, true));
      });
      runScripts(Array.from(doc.body.querySelectorAll('script')), 0);
    })
    .catch((e) => console.error('[skill] failed to load', `${dir}/${entry}`, e));
}

function commonGlobals(req) {
  window.require = req;
  window.module = { exports: {} };
  window.exports = window.module.exports;
  window.global = window;
  window.Buffer = window.Buffer || req('buffer').Buffer;
  try {
    const PIXI = req('pixi.js');
    if (PIXI && (PIXI.VERSION || PIXI.Application || PIXI.autoDetectRenderer || PIXI.WebGLRenderer)) window.PIXI = PIXI;
  } catch (_) { /* skill doesn't bundle pixi */ }
}

// REAL-RUNTIME mode: boot the bundle's own jibo runtime.
async function bootReal() {
  window.__SKILL_DIR__ = dir;          // HTTP root for the loader's fs + asset resolution
  window.__JIBO_ELECTRON__ = true;     // the runtime builds its render path under electron
  const req = createRequire(null)(dir); // require('jibo') -> the bundle's real runtime
  commonGlobals(req);
  window.process = req('process');
  window.process.env.RUNMODE = 'UNIT_TESTS';   // robot-service plugins skip cleanly offline

  // Preload the eye config so we can fill in what the (absent) expression service
  // would provide BEFORE the runtime's init runs.
  const eye = await prepareLiveEye(req, dir).catch((e) => { console.warn('[live-eye] prepare failed:', e.message); return null; });

  // The bundle does `global.jibo = new Runtime(...)` then calls jibo.init itself.
  // Intercept that assignment so we can populate jibo.expression.dofs (which the
  // embodied-dialog layer reads at init) before init proceeds.
  let _jibo;
  Object.defineProperty(window, 'jibo', {
    configurable: true,
    get() { return _jibo; },
    set(v) {
      _jibo = v;
      if (v) {
        // Connect jibo-be's service clients to the in-memory service bus (the
        // in-browser stand-in for the original sim's localhost services).
        try { if (!window.__serviceBus) window.__serviceBus = installServiceBus(req); } catch (e) { console.warn('[boot] service bus:', e.message); }
        // service-records plugin is skipped under UNIT_TESTS, so jibo.records is empty
        // and clients have no host:port. Populate it from the bus so they connect to us.
        try { if (window.__serviceBus) v.records = window.__serviceBus.records(); } catch (e) { console.warn('[boot] records:', e.message); }
        try { installKbService(req); } catch (e) { console.warn('[boot] kb service:', e.message); }
        if (eye) populateExpressionDofs(v, eye.robotInfo);
        installExpressionStubs(v, req);
        initOfflineServices(v, req);
      }
    },
  });

  // The Be framework sets `global.be = this` at the top of its constructor (by which
  // point @be/be-framework is fully loaded) and only calls BeSkill.init later in
  // be.init(). Intercept that assignment to patch BeSkill.init in between.
  let _be;
  Object.defineProperty(window, 'be', {
    configurable: true,
    get() { return _be; },
    set(v) { _be = v; patchBeFramework(req); },
  });

  runBundle();

  // Once the FaceRenderer exists, stream the idle pose into the real eye.
  if (eye) {
    let waited = 0;
    const wait = setInterval(() => {
      waited += 100;
      if (window.jibo && window.jibo.face) { clearInterval(wait); driveEye(window.jibo, eye); installWebSpeech(window.jibo); connectCloud(req); }
      else if (waited > 20000) { clearInterval(wait); console.warn('[boot] real runtime: jibo.face never appeared'); }
    }, 100);
  }

  // Forward host screen-taps to the real FaceRenderer's gesture manager: the sim
  // raycasts a tap on the body screen and emits {ns:'face',event:'touch',{x,y}};
  // spoofGesture('tap') drives Hammer -> the active view's tap handler (e.g. the
  // idle EyeView's onTouch -> MainMenu).
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || m.__jibo !== true) return;
    // Typed chat input from the host. Two paths, mirroring the original sim:
    //  - In-MIM: MimManager.handleSpeech.emit(...) (same hook ActionData.UTTERANCE
    //    uses). Only the active MIM listens; outside any MIM it's a no-op.
    //  - Out-of-MIM / global: jetstream.startLocalTurn({clientNLU:{...}}) — what
    //    jibo.js does itself when a spoofed utterance arrives mid-speak. This
    //    requires the cloud (Pegasus); HTTP goes via BusXHR's native pass-through.
    if (m.kind === 'utterance' && typeof m.text === 'string' && m.text.trim()) {
      const text = m.text.trim();
      // In-MIM hook: ActionData.UTTERANCE drives the same emitter — the active
      // MIM's handleSpeech listener can match on raw text/intent for dialog
      // prompts. We keep an utterance-shaped object for that path.
      const utt = { intent: text, entities: {}, rules: [] };
      let inMim = false;
      try {
        const mim = window.jibo && window.jibo.mim;
        if (mim && mim.handleSpeech && typeof mim.handleSpeech.emit === 'function') {
          mim.handleSpeech.emit(utt);
          inMim = true;
        }
      } catch (e) { console.warn('[boot] handleSpeech forward:', e.message); }
      try {
        const js = window.jibo && window.jibo.jetstream;
        if (js && typeof js.startLocalTurn === 'function') {
          // Use CLIENT_ASR (raw text), NOT CLIENT_NLU. The hub's IntentRouter
          // only matches when nluData.rules contains 'launch', and only the
          // hub-side parser (API.ai / dialogflow) produces those rules. If we
          // stuff the text into CLIENT_NLU.intent, the hub treats it as a
          // pre-resolved intent name and the router returns match:null.
          js.startLocalTurn({ nluRules: [], clientASR: text })
            .then(() => console.log('[utterance] startLocalTurn ok:', JSON.stringify(text)))
            .catch((e) => console.warn('[utterance] startLocalTurn failed:', (e && e.message) || e));
        }
        console.log('[utterance]', JSON.stringify(text), 'in-mim=', inMim);
      } catch (e) { console.warn('[boot] startLocalTurn forward:', e.message); }
      return;
    }
    if (m.kind !== 'event' || m.ns !== 'face') return;
    const g = window.jibo && window.jibo.face && window.jibo.face.gestures;
    if (!g) return;
    const d = m.data || {};
    try {
      if (m.event === 'touch' && g.spoofGesture) {
        g.spoofGesture('tap', d.x || 640, d.y || 360);
      } else if (m.event === 'pan' && g.spoofGestureWithOptions) {
        // Drag on the screen -> Hammer pan (menu scroll, etc.), in face coords.
        g.spoofGestureWithOptions('pan', {
          isFinal: !!d.isFinal,
          srcEvent: { movementX: d.movementX || 0, movementY: d.movementY || 0 },
          pointers: [{ clientX: d.x || 0, clientY: d.y || 0 }],
        });
      }
    } catch (e) { console.warn('[boot] gesture forward:', e.message); }
  });
  // Tell the host bridge we're listening so it flushes queued events (incl. taps).
  try { parent.postMessage({ __jibo: true, kind: 'hello' }, '*'); } catch (_) { /* no parent */ }
}

// SHIM mode: our lightweight runtime.
function bootShim() {
  const jibo = installJiboShim();
  window.jibo = jibo;
  if (jibo.utils && jibo.utils.PathUtils && jibo.utils.PathUtils.setRoot) jibo.utils.PathUtils.setRoot(dir);
  const req = createRequire(jibo)(dir);
  commonGlobals(req);
  window.process = window.process || {
    env: { NODE_ENV: 'production' }, platform: 'browser', argv: ['node', 'skill'],
    nextTick: (f, ...a) => Promise.resolve().then(() => f(...a)), cwd: () => '/', on() {},
  };
  runBundle();
}

// Use the real runtime when the bundle ships one (e.g. jibo-be); otherwise the shim.
fetch(`${dir}/node_modules/jibo/lib/jibo.js`, { method: 'HEAD' })
  .then((r) => (r.ok ? bootReal() : bootShim()))
  .catch(() => bootShim());
