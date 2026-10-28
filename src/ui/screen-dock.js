// Screen dock: Jibo's screen as a flat, always-facing panel in a corner of the viewport.
//
// The face is a sandboxed iframe, projected onto the 3D screen quad (face-overlay.js), so
// it can be small, skewed, or edge-on when Jibo moves. The dock mirrors it: every frame
// the iframe's canvases and images (<img>, CSS background-image: the boot logo is one) are
// copied, in document order, into one canvas here. Text and plain coloured boxes in the
// face's DOM are not. Clicks and drags on the dock map straight to face pixels and go to
// the skill as the same touch/pan gestures the 3D screen sends. The 3D screen stays live.
//
// Needs same-origin access to the iframe's document (and its requestAnimationFrame), which
// the sandbox keeps (allow-same-origin). If the iframe ever goes cross-origin the dock can
// only say so, see paintNotice().
//
// The copy runs from the *iframe's* requestAnimationFrame, right after the face has drawn:
// a WebGL canvas (PixiJS) created without preserveDrawingBuffer reads back blank from the
// host's own frame callback. The loop is restarted whenever the iframe loads a new page.
//
// CSS background images: the first image of the list, sized auto | cover | contain | <len>
// | <%> (one or two values) and positioned by px or %, without repeat.

import { FACE_WIDTH, FACE_HEIGHT } from '../bridge/face-overlay.js';
import { createFaceGestures } from './face-gestures.js';

const STORAGE_KEY = 'jibo-web-sim.screen-dock.collapsed';
const SCALE = 2;                       // backing pixels per CSS pixel of the 400px-wide dock
const DOCK_W = 400;

function readCollapsed() {
  try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch (_) { return false; }
}
function writeCollapsed(v) {
  try { localStorage.setItem(STORAGE_KEY, v ? '1' : '0'); } catch (_) { /* private mode */ }
}

export function createScreenDock({ viewportEl, iframe, emitFace }) {
  const el = document.createElement('div');
  el.id = 'screen-dock';
  el.innerHTML = `
    <div class="dock-head">
      <span class="dock-title">Jibo screen</span>
      <button type="button" class="dock-toggle" aria-controls="screen-dock-screen" aria-expanded="true"></button>
    </div>
    <canvas class="dock-screen" id="screen-dock-screen" role="img"
      aria-label="Jibo's screen. Click to touch it, drag to scroll."
      width="${DOCK_W * SCALE}" height="${Math.round(DOCK_W * SCALE * FACE_HEIGHT / FACE_WIDTH)}"></canvas>
  `;
  viewportEl.appendChild(el);
  const toggle = el.querySelector('.dock-toggle');
  const screen = el.querySelector('.dock-screen');
  const ctx = screen.getContext('2d');
  const k = screen.width / FACE_WIDTH;     // face pixels -> dock backing pixels

  let collapsed = readCollapsed();
  function applyCollapsed() {
    el.classList.toggle('collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    const label = collapsed ? 'Expand Jibo screen' : 'Collapse Jibo screen';
    toggle.title = label;
    toggle.setAttribute('aria-label', label);
  }
  applyCollapsed();
  toggle.addEventListener('click', () => {
    collapsed = !collapsed;
    writeCollapsed(collapsed);
    applyCollapsed();
  });

  function paintBlank() {
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, screen.width, screen.height);
  }
  paintBlank();

  // One line per page, not per frame: a broken copy shows as a blank dock otherwise.
  let warned = false;
  function warnOnce(err) {
    if (warned) return;
    warned = true;
    console.warn('[screen-dock] mirroring the face failed:', err);
  }

  // The dock can't read the face (cross-origin iframe): say so rather than sit black.
  function paintNotice(text) {
    paintBlank();
    ctx.fillStyle = '#8b95a5';
    ctx.font = `${14 * SCALE}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, screen.width / 2, screen.height / 2);
  }

  // Images CSS asked for, loaded by the host (same origin as the iframe, so never tainted).
  const bgImages = new Map();
  function bgImage(url) {
    let img = bgImages.get(url);
    if (!img) { img = new Image(); img.src = url; bgImages.set(url, img); }
    return img.complete && img.naturalWidth ? img : null;
  }
  // Where a background image sits in its box, see the header for what is supported. Computed
  // styles list one value per image ("a, b"); only the first image is drawn, so only the
  // first value of each list counts.
  function drawBackground(cs, r, img) {
    const first = (v) => v.split(',')[0].trim();
    const size = first(cs.backgroundSize);
    let w, h;
    if (size === 'cover' || size === 'contain') {
      const f = (size === 'cover' ? Math.max : Math.min)(r.width / img.naturalWidth, r.height / img.naturalHeight);
      w = img.naturalWidth * f; h = img.naturalHeight * f;
    } else {
      const [sw = 'auto', sh = 'auto'] = size.split(' ');
      const len = (v, box) => (v.endsWith('%') ? box * parseFloat(v) / 100 : parseFloat(v));   // NaN for auto
      w = len(sw, r.width); h = len(sh, r.height);
      if (Number.isNaN(w) && Number.isNaN(h)) { w = img.naturalWidth; h = img.naturalHeight; }
      else if (Number.isNaN(w)) w = h * img.naturalWidth / img.naturalHeight;
      else if (Number.isNaN(h)) h = w * img.naturalHeight / img.naturalWidth;
    }
    const [px = '0%', py = '0%'] = first(cs.backgroundPosition).split(' ');
    const at = (v, free) => (v.endsWith('%') ? free * parseFloat(v) / 100 : parseFloat(v) || 0);
    ctx.save();
    try {
      ctx.beginPath();
      ctx.rect(r.left * k, r.top * k, r.width * k, r.height * k);
      ctx.clip();
      ctx.drawImage(img, (r.left + at(px, r.width - w)) * k, (r.top + at(py, r.height - h)) * k, w * k, h * k);
    } finally {
      ctx.restore();       // a throw must not leave the clip on for the rest of the frame
    }
  }

  // Copy the face: each visible canvas and image, placed where it sits inside the iframe page.
  function copyFrame(win) {
    const doc = win.document;
    paintBlank();
    for (const node of doc.body.querySelectorAll('*')) {
      const tag = node.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE') continue;
      const cs = win.getComputedStyle(node);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = node.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const alpha = parseFloat(cs.opacity);
      if (alpha === 0) continue;                       // invisible, e.g. mid fade-in
      ctx.globalAlpha = Number.isNaN(alpha) ? 1 : alpha;
      try {
        const bg = /url\((["']?)(.*?)\1\)/.exec(cs.backgroundImage);   // the first image of a list
        const bgImg = bg && bgImage(bg[2]);
        if (bgImg) drawBackground(cs, r, bgImg);
        if (tag === 'CANVAS' && node.width && node.height) {
          ctx.drawImage(node, r.left * k, r.top * k, r.width * k, r.height * k);
        } else if (tag === 'IMG' && node.complete && node.naturalWidth) {
          ctx.drawImage(node, r.left * k, r.top * k, r.width * k, r.height * k);
        }
      } catch (err) { warnOnce(err); }                 // e.g. a lost context; keep drawing the rest
    }
    ctx.globalAlpha = 1;
  }

  let generation = 0;
  function startMirror() {
    const gen = ++generation;
    let win;
    try { win = iframe.contentWindow; void win.document; } catch (_) {   // cross-origin
      paintNotice('Face is not mirrorable (cross-origin)');
      return;
    }
    if (!win || !win.requestAnimationFrame) return;
    const tick = () => {
      if (gen !== generation) return;                  // the iframe moved on to another page
      if (!collapsed) {
        try { copyFrame(win); } catch (err) { warnOnce(err); }   // page tearing down
      }
      win.requestAnimationFrame(tick);
    };
    win.requestAnimationFrame(tick);
  }
  iframe.addEventListener('load', startMirror);
  startMirror();

  // Input: flat mapping, no raycast. The pointer is captured, so a drag that strays
  // outside the dock keeps panning (clamped to the screen edge) until release. One pointer
  // at a time: a second finger, or a non-primary button, must not restart the gesture.
  const faceAt = (e) => {
    const r = screen.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    return { x: x * FACE_WIDTH, y: y * FACE_HEIGHT };
  };
  const gestures = createFaceGestures({ emit: emitFace });
  let activeId = null;
  screen.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || activeId !== null) return;
    activeId = e.pointerId;
    screen.setPointerCapture(e.pointerId);
    gestures.down(e, faceAt);
  });
  screen.addEventListener('pointermove', (e) => {
    if (e.pointerId === activeId) gestures.move(e, faceAt);
  });
  screen.addEventListener('pointerup', (e) => {
    if (e.pointerId !== activeId) return;
    activeId = null;
    gestures.up(e, faceAt);
  });
  // Cancelled, or the capture was lost without a release: end the gesture where it stands.
  const abort = (e) => {
    if (e.pointerId !== activeId) return;
    activeId = null;
    gestures.up(e, () => null);
  };
  screen.addEventListener('pointercancel', abort);
  screen.addEventListener('lostpointercapture', abort);

  return { el, isCollapsed: () => collapsed };
}
