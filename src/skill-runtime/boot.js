// Skill iframe bootstrap + in-place loader.
//
// Runs an original skill bundle unmodified. Two modes, chosen by what the bundle
// ships:
//
//  - SHIM mode (our demo skills, most third-party skills): install our lightweight
//    `jibo` runtime (window.jibo) so `require('jibo')` resolves to it.
//  - REAL-RUNTIME mode (bundles that ship their own jibo runtime):
//    let `require('jibo')` load the bundle's own real runtime (real PixiJS
//    FaceRenderer etc.), boot it in UNIT_TESTS run mode so its robot-service
//    plugins skip cleanly offline, and drive the eye locally (see live-eye.js).
//
// Either way we then fetch the bundle's own index.html and run it as written.
// The skill dir + entry come from the iframe src: /skill-host.html?dir=…&entry=…

import { installJiboShim } from './jibo-shim.js';
import { createRequire } from './cjs-require.js';
import { prepareLiveEye, populateExpressionDofs, installExpressionStubs, initOfflineServices, patchBeFramework, driveEye, connectCloud, installIdleMotion } from './live-eye.js';
import { installServiceBus } from './services/index.js';
import { installKbService } from './services/kb-service.js';
import { localParse, KNOWN_PHRASES } from './local-nlu.js';
import { createRegistry } from './nlu/index.js';

// Rule-based NLU registry. Loaded from rule files in two places:
//   - The user's skill bundle, under <bundle>/node_modules/<scope>/<name>/launch.rule
//     and <bundle>/**/*.grm.
//   - An optional companion rule pack served at /external-rules, walked the
//     same way. Configured server-side via the EXTERNAL_RULES env var.
// Nothing is bundled with the simulator. Used as PRIMARY local NLU when no
// backend is configured; falls back to the regex matcher in local-nlu.js for
// any input the rules don't cover.
const _nluRegistry = createRegistry();

// Fetch a manifest from /__list?root=... synchronously-friendly: returns a
// Map<url, size> (matching the cjs-require manifest shape). Empty Map on
// any failure or empty response.
async function _fetchListing(root) {
  try {
    const r = await fetch('/__list?root=' + encodeURIComponent(root));
    if (!r.ok) return new Map();
    const { files = [] } = await r.json();
    const out = new Map();
    for (const e of files) {
      if (typeof e === 'string') out.set(e, 0);
      else if (e && e.url) out.set(e.url, e.size || 0);
    }
    return out;
  } catch (_) { return new Map(); }
}

const _nluReady = (async () => {
  // Wait briefly for the bundle's file manifest to be available — populated
  // by the require shim during bundle boot. If the bundle never loads, this
  // times out and we serve regex-only NLU (plus whatever the rule pack has).
  for (let i = 0; i < 50 && !(window.__skillManifest && window.__skillManifest.size); i += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const root = window.__SKILL_DIR__ || '';
  // Combine the bundle's tree with the optional rule pack.
  const rulePackManifest = await _fetchListing('/external-rules');
  const sources = [];
  if (window.__skillManifest && window.__skillManifest.size) {
    sources.push({ root, manifest: window.__skillManifest });
  }
  if (rulePackManifest.size) {
    sources.push({ root: '/external-rules', manifest: rulePackManifest });
  }
  if (sources.length === 0) {
    console.log('[nlu] no manifests available; rule-based NLU disabled');
    return;
  }

  const launches = [];
  const grammars = [];
  for (const src of sources) {
    const escapedRoot = src.root.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&');
    const launchRe = new RegExp('^' + escapedRoot + '/node_modules/(@[^/]+/[^/]+|[^/]+)/launch\\.rule$');
    const grmRe = /\/([^/]+)\.grm$/;
    for (const url of src.manifest.keys()) {
      const lm = launchRe.exec(url);
      if (lm) { launches.push({ pkg: lm[1], url }); continue; }
      const gm = grmRe.exec(url);
      if (gm) grammars.push({ name: gm[1], url });
    }
  }
  for (const { pkg, url } of launches) {
    try { await _nluRegistry.loadSkill(pkg, url); }
    catch (e) { console.warn('[nlu] skill load failed:', pkg, e.message); }
  }
  for (const { name, url } of grammars) {
    try { await _nluRegistry.loadFactory(name, url); }
    catch (e) { console.warn('[nlu] factory load failed:', name, e.message); }
  }
  console.log('[nlu] registry loaded', _nluRegistry._skills.length, 'skill rule(s),',
              Object.keys(_nluRegistry._factories).length, 'factory grammar(s)');
})();

const params = new URLSearchParams(location.search);
const dir = (params.get('dir') || '/skills/hello-world').replace(/\/$/, '');
const entry = params.get('entry') || 'index.html';
// Optional cloud backend, set in the host UI. Exposed for the runtime/services
// to route cloud requests at.
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
        // Connect the bundle's service clients to the in-memory service bus
        // (the in-browser stand-in for localhost services).
        try { if (!window.__serviceBus) window.__serviceBus = installServiceBus(req); } catch (e) { console.warn('[boot] service bus:', e.message); }
        // The service-records plugin is skipped under UNIT_TESTS, so jibo.records is empty
        // and clients have no host:port. Populate it from the bus so they connect to us.
        try { if (window.__serviceBus) v.records = window.__serviceBus.records(); } catch (e) { console.warn('[boot] records:', e.message); }
        try { installKbService(req); } catch (e) { console.warn('[boot] kb service:', e.message); }
        if (eye) populateExpressionDofs(v, eye.robotInfo);
        installExpressionStubs(v, req);
        initOfflineServices(v, req);
      }
    },
  });

  // The skill framework sets `global.be = this` at the top of its constructor
  // (by which point the framework is fully loaded) and only calls BeSkill.init
  // later in be.init(). Intercept that assignment to patch BeSkill.init in between.
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
      if (window.jibo && window.jibo.face) {
        clearInterval(wait);
        driveEye(window.jibo, eye);
        connectCloud(req);
        // Start the ambient blink + gaze-drift driver once the runtime
        // is fully up. Animations are queried from the indexed animDB
        // and routed through the standard expression/lookat path, so
        // explicit skill playback preempts them via the DOF arbiter.
        installIdleMotion(window.jibo);
      }
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
    // Typed chat input from the host. Two paths:
    //  - In-MIM: MimManager.handleSpeech.emit(...) — the same hook the
    //    UTTERANCE action uses. Only the active MIM listens; outside any MIM
    //    it's a no-op.
    //  - Out-of-MIM / global: jetstream.startLocalTurn({clientNLU:{...}}) —
    //    what the runtime does itself when a spoofed utterance arrives
    //    mid-speak. This requires the cloud; HTTP goes via BusXHR's native
    //    pass-through.
    if (m.kind === 'utterance' && typeof m.text === 'string' && m.text.trim()) {
      const text = m.text.trim();
      // Stop in-flight Web Speech immediately so the MIM can transition past speak.
      // Without this the bundle's MimSkill.onSpeechEvent sees current=speak and
      // takes the spoofed CLIENT_NLU path, leaving the MIM stuck on raw intent
      // and ignoring the cloud's parsed NLU.
      try { window.parent.postMessage({ __jibo: true, kind: 'speak-stop' }, '*'); } catch (_) { /* */ }

      // Path A — active MIM Listen open: inject CLIENT_ASR into THAT turn via
      // LocalTurnRequest.update(string). The hub parses against the listen's
      // rules and returns the TURN_RESULT on the same WS the MIM is waiting on;
      // the MIM advances. (live-eye.connectCloud monkey-patches
      // jetstream.startLocalTurn to stash the active non-launch request at
      // window.__activeListen.)
      const active = (typeof window !== 'undefined' && window.__activeListen) || null;
      const activeUsable = active && typeof active.update === 'function' && active.status !== 'CANCELED' && active.status !== 'COMPLETED';
      if (activeUsable) {
        try {
          active.update(text);
          console.log('[utterance]', JSON.stringify(text), '-> active listen update');
        } catch (e) { console.warn('[utterance] active listen update failed:', (e && e.message) || e); }
        return;
      }

      // Path B — no active Listen (MIM still in speak, or idle): pre-parse the
      // text via a fresh launch-rule turn (CLIENT_ASR so the hub parses it),
      // then route the parsed NLU two ways:
      //   1. global-manager's turnResult listener already handles skill-launch
      //      matches (via jetstream events).
      //   2. If no skill match, forward the parsed NLU to mim.handleSpeech.emit
      //      so the active MIM's onSpeechEvent sees a canonical intent
      //      (e.g. "yes" for typed "sure") instead of the raw text the MIM
      //      would otherwise reject when parsing a spoofed utterance.
      // Why NOT call handleSpeech.emit synchronously with raw text: the bundle
      // wraps the raw string as {intent: <raw>}, sends CLIENT_NLU with that
      // utterance, then locally constructs asrResults from the raw utterance
      // (not the cloud response). The MIM's rule then sees intent="sure"
      // instead of the canonical "yes" and rejects.
      const js = window.jibo && window.jibo.jetstream;
      if (!js || typeof js.startLocalTurn !== 'function') return;

      // Offline fallback: when the host has no backend server configured,
      // the cloud path can't reach an intent router. Run NLU locally.
      // Primary path: the rule-based registry (src/skill-runtime/nlu/) which
      // matches against the .rule files the bundle ships — same DSL the cloud
      // compiles, just walked by a JS interpreter.
      // Fallback path: the regex matcher (local-nlu.js) for cases the rules
      // don't cover.
      // Only on-robot skills work this way — cloud-skill intents (chitchat
      // dances, news) need the cloud's SKILL_ACTION mim graph and are silently
      // dropped (with a log hint).
      if (!window.__JIBO_SERVER__) {
        (async () => {
          await _nluReady;
          let result = null;
          try { result = _nluRegistry.parse(text); } catch (e) { console.warn('[nlu] parse error:', e.message); }
          const source = result ? 'rule' : 'regex';
          if (!result) result = localParse(text);
          if (!result) {
            console.log('[nlu] no match for', JSON.stringify(text), '— try one of:', KNOWN_PHRASES.slice(0, 6).join(' / '), '...');
            return;
          }
          console.log('[nlu/' + source + '] matched', JSON.stringify(text), '->', result.match.skillID, '(' + result.nlu.intent + ')');
          try {
            if (js.events && js.events.localTurnResult && typeof js.events.localTurnResult.emit === 'function') {
              js.events.localTurnResult.emit({ status: 'SUCCEEDED', result });
            } else {
              const ge = window.jibo && window.jibo.globalEvents;
              if (ge && ge.skillRelaunch && typeof ge.skillRelaunch.emit === 'function') {
                ge.skillRelaunch.emit(result);
              }
            }
          } catch (e) { console.warn('[nlu] emit failed:', (e && e.message) || e); }
        })();
        return;
      }

      console.log('[utterance]', JSON.stringify(text), '-> startLocalTurn launch (pre-parse)');
      js.startLocalTurn({ nluRules: ['launch'], clientASR: text })
        .then((turn) => (turn && turn.promise) ? turn.promise : null)
        .then((data) => {
          if (!data || data.status !== 'SUCCEEDED' || !data.result) return;
          const nlu = data.result.nlu || {};
          const skillMatch = data.result.match;
          if (skillMatch) return; // global-manager → skill switch
          try {
            const mim = window.jibo && window.jibo.mim;
            if (mim && mim.handleSpeech && typeof mim.handleSpeech.emit === 'function') {
              mim.handleSpeech.emit({
                intent: nlu.intent || text,
                entities: nlu.entities || {},
                rules: nlu.rules || [],
              });
            }
          } catch (e) { console.warn('[utterance] handleSpeech forward:', (e && e.message) || e); }
        })
        .catch((e) => console.warn('[utterance] startLocalTurn pre-parse failed:', (e && e.message) || e));
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

// Use the real runtime when the bundle ships one; otherwise the shim.
fetch(`${dir}/node_modules/jibo/lib/jibo.js`, { method: 'HEAD' })
  .then((r) => (r.ok ? bootReal() : bootShim()))
  .catch(() => bootShim());
