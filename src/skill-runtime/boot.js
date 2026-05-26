// Skill iframe bootstrap + in-place loader.
//
// Loads an ORIGINAL skill bundle unmodified: it installs the jibo runtime
// (window.jibo) and a CommonJS `require` (window.require), then fetches the
// bundle's own index.html and runs it in this environment — so the bundle's
// `require('jibo')` resolves to our shim, `require('./index')` and node_modules
// resolve from the bundle, and the page's #face/scripts run as written.
//
// The skill dir + entry come from the iframe src: /skill-host.html?dir=…&entry=…

import { installJiboShim } from './jibo-shim.js';
import { createRequire } from './cjs-require.js';

const jibo = installJiboShim();
window.jibo = jibo;

const params = new URLSearchParams(location.search);
const dir = (params.get('dir') || '/skills/hello-world').replace(/\/$/, '');
const entry = params.get('entry') || 'index.html';

// Tell PathUtils where this bundle lives (findRoot/resolve + asset roots).
if (jibo.utils && jibo.utils.PathUtils && jibo.utils.PathUtils.setRoot) jibo.utils.PathUtils.setRoot(dir);

// CommonJS environment for the bundle.
window.require = createRequire(jibo)(dir);
window.module = { exports: {} };
window.exports = window.module.exports;
window.global = window;
window.Buffer = window.Buffer || window.require('buffer').Buffer;   // some deps use a global Buffer

// Jibo bundles render with PixiJS and expect a global PIXI. If the bundle ships
// pixi.js, expose it globally so pixi-animate / the GUI layer find it.
try {
  const PIXI = window.require('pixi.js');
  if (PIXI && (PIXI.VERSION || PIXI.Application || PIXI.autoDetectRenderer)) window.PIXI = PIXI;
} catch (_) { /* skill doesn't bundle pixi */ }
window.process = window.process || {
  env: { NODE_ENV: 'production' }, platform: 'browser', argv: ['node', 'skill'],
  nextTick: (f, ...a) => Promise.resolve().then(() => f(...a)), cwd: () => '/', on() {},
};

function runScripts(scripts, i) {
  if (i >= scripts.length) return;
  const s = scripts[i];
  const src = s.getAttribute('src');
  if (src) {
    const el = document.createElement('script');
    el.src = new URL(src, `${location.origin}${dir}/`).href;   // resolve to the skill dir
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

    // Base href so the bundle's relative URLs (resources, scripts) resolve to
    // its own directory.
    const base = document.createElement('base');
    base.href = `${dir}/`;
    document.head.appendChild(base);

    doc.querySelectorAll('style, link[rel="stylesheet"]').forEach((node) => {
      document.head.appendChild(document.importNode(node, true));
    });
    Array.from(doc.body.childNodes).forEach((node) => {
      if (node.nodeName !== 'SCRIPT') document.body.appendChild(document.importNode(node, true));
    });

    runScripts(Array.from(doc.body.querySelectorAll('script')), 0);
  })
  .catch((e) => console.error('[skill] failed to load', `${dir}/${entry}`, e));
