// Smoke test for the screen dock (src/ui/screen-dock.js).
//
// Loads the app, starts Jibo, and checks that the dock
//   1. is open by default, shows the live face (not blank) and is labelled for assistive tech,
//   2. keeps mirroring: it matches the face's own canvas, and follows the blink a tap causes,
//   3. sends the skill a `touch` for a click and `pan` events (ending isFinal) for a drag, keeps
//      panning (clamped to the screen edge) when the drag leaves the dock, ends a pan on
//      pointercancel, and ignores a second pointer and non-primary buttons,
//   4. leaves the 3D screen's own tap working (shared gesture code),
//   5. keeps mirroring after the skill is switched (the iframe loads a new page),
//   6. mirrors a WebGL face too (the real runtime's PixiJS), wherever its render loop sits,
//   7. mirrors images in the face's DOM (the real runtime's boot logo is a CSS background):
//      placement, clipping, first image of a list, background-size, opacity, display:none,
//   8. says so when it can't read the face (cross-origin iframe),
//   9. stops copying while collapsed, remembers being collapsed across a reload, the toggle's
//      icon sits in the middle of its button in both states, and the TTS subtitle stays above it.
//
// Waits are on conditions (a frame has passed, a pixel has appeared), not fixed sleeps.
//
// Usage: node test/screen-dock-smoke.mjs [skillDir]   (sim server must be on :8080, or SIM_URL)

import puppeteer from 'puppeteer';
import { existsSync, readdirSync } from 'node:fs';

const base = process.env.SIM_URL || 'http://localhost:8080';
const skillDir = process.argv[2] || '/skills/hello-world';

function findChrome() {
  const root = `${process.env.HOME}/.cache/puppeteer/chrome`;
  for (const v of (existsSync(root) ? readdirSync(root) : [])) {
    const p = `${root}/${v}/chrome-linux64/chrome`;
    if (existsSync(p)) return p;
  }
  return undefined;
}

let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: true,
  executablePath: findChrome(),
  timeout: 60000,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1300, height: 820 });
page.on('pageerror', (e) => { console.log(`[pageerror] ${e.message}`); failed++; });

const skillFrameNow = () => page.frames().find((f) => f.url().includes('skill-host'));

// The dock shows `dir`'s page and is lit: the iframe has navigated to it, and the dock canvas
// has bright pixels that are not the (magenta) leftovers of a previous page.
const waitForSkill = (dir) => page.waitForFunction((d) => {
  const f = document.getElementById('skill-iframe');
  try { if (!f.contentWindow.location.search.includes(encodeURIComponent(d))) return false; } catch (_) { return false; }
  const c = document.querySelector('#screen-dock .dock-screen');
  const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  let n = 0;
  for (let i = 0; i < data.length; i += 32) if (data[i] + data[i + 1] + data[i + 2] > 300) n++;
  const mid = c.getContext('2d').getImageData(c.width / 2, c.height / 2, 1, 1).data;
  return n > 100 && !(mid[0] > 250 && mid[1] < 5 && mid[2] > 250);
}, { timeout: 90000, polling: 250 }, dir);

async function startApp() {
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#start-gate', { timeout: 15000 });
  await page.click('#start-gate');
  await page.waitForSelector('#skill-picker option', { timeout: 15000 });
  await page.select('#skill-picker', skillDir);
  await waitForSkill(skillDir);
}

// Count of "eye" pixels (bright ones; the eye colour differs per skill) in the dock canvas and their mean x, in backing pixels.
const eyeStats = () => page.evaluate(() => {
  const c = document.querySelector('#screen-dock .dock-screen');
  const { data, width, height } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  let n = 0, sx = 0;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 4;
      if (data[i] + data[i + 1] + data[i + 2] > 300) { n++; sx += x; }
    }
  }
  return { n, meanX: n ? sx / n : 0, width };
});

// Same measure on the face's own canvas inside the iframe (the thing being mirrored).
const sourceStats = (frame) => frame.evaluate(() => {
  const c = document.querySelector('canvas');
  const { data, width, height } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  let n = 0, sx = 0;
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      const i = (y * width + x) * 4;
      if (data[i] + data[i + 1] + data[i + 2] > 300) { n++; sx += x / width; }
    }
  }
  return { n, meanX: n ? sx / n : 0 };
});

const dockRect = () => page.evaluate(() => {
  const b = document.querySelector('#screen-dock .dock-screen').getBoundingClientRect();
  return { l: b.left, t: b.top, w: b.width, h: b.height };
});
const dockPoint = async (fx, fy) => {   // face pixel -> page coords on the dock
  const r = await dockRect();
  return { x: r.l + (fx / 1280) * r.w, y: r.t + (fy / 720) * r.h };
};
// RGB of the dock canvas at a fraction of its width/height.
const dockPixel = (fx, fy) => page.evaluate((a, b) => {
  const c = document.querySelector('#screen-dock .dock-screen');
  return Array.from(c.getContext('2d').getImageData(Math.floor(c.width * a), Math.floor(c.height * b), 1, 1).data.slice(0, 3));
}, fx, fy);
const isGreen = (p) => p[1] > 250 && p[0] < 5 && p[2] < 5;
const isRed = (p) => p[0] > 250 && p[1] < 5 && p[2] < 5;

// Poll until `pred(pixel)` holds at (fx, fy); returns the last pixel read either way.
async function waitPixel(fx, fy, pred, timeout = 8000) {
  const t0 = Date.now();
  for (;;) {
    const p = await dockPixel(fx, fy);
    if (pred(p) || Date.now() - t0 > timeout) return p;
    await sleep(50);
  }
}
// A few frames of the face have run (and so a few dock copies): lets "nothing changed" be asserted.
const frames = (frame) => frame.evaluate(() => new Promise((res) => {
  let n = 0;
  (function tick() { if (++n >= 4) res(); else requestAnimationFrame(tick); })();
}));

// Vertical distance in px from the middle of the toggle's icon (its bright pixels, from a
// screenshot) to the middle of its button: a typed glyph sits a couple of px off; a drawn icon doesn't.
async function iconOffset() {
  // A subtitle (Jibo speaking) can sit over the dock for a while; it is not part of the button.
  await page.evaluate(() => { document.getElementById('subtitle').style.visibility = 'hidden'; });
  const r = await page.evaluate(() => {
    const b = document.querySelector('#screen-dock .dock-toggle').getBoundingClientRect();
    return { x: b.left, y: b.top, width: b.width, height: b.height };
  });
  const png = await page.screenshot({ clip: r, encoding: 'base64' });
  return page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const cx = c.getContext('2d');
    cx.drawImage(bmp, 0, 0);
    const { data, width, height } = cx.getImageData(0, 0, c.width, c.height);
    let top = height, bottom = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (data[i] + data[i + 1] + data[i + 2] > 300) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
      }
    }
    return bottom < 0 ? null : (top + bottom + 1) / 2 - height / 2;
  }, png);
}

await startApp();

// Record the gestures the skill receives.
let skillFrame = skillFrameNow();
check(!!skillFrame, 'skill iframe loaded');
await skillFrame.evaluate(() => {
  window.__gestures = [];
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m && m.__jibo && m.kind === 'event' && m.ns === 'face' && (m.event === 'touch' || m.event === 'pan')) {
      window.__gestures.push({ event: m.event, ...m.data });
    }
  });
});
const drain = () => skillFrame.evaluate(() => window.__gestures.splice(0));
// Collect gestures until `pred(all so far)` holds (events arrive by postMessage, a beat later).
async function until(pred, timeout = 5000) {
  const t0 = Date.now();
  let all = [];
  for (;;) {
    all = all.concat(await drain());
    if (pred(all) || Date.now() - t0 > timeout) return all;
    await sleep(40);
  }
}
const hasFinalPan = (all) => all.some((e) => e.event === 'pan' && e.isFinal);

// 1. Open by default, shows the face, labelled.
const open = await page.evaluate(() => {
  const d = document.querySelector('#screen-dock');
  return !!d && !d.classList.contains('collapsed') && d.querySelector('.dock-screen').offsetWidth > 0;
});
check(open, 'dock is open by default');
const a11y = await page.evaluate(() => {
  const t = document.querySelector('#screen-dock .dock-toggle');
  const c = document.querySelector('#screen-dock .dock-screen');
  return {
    toggleLabel: t.getAttribute('aria-label'),
    controlsOk: document.getElementById(t.getAttribute('aria-controls')) === c,
    canvasRole: c.getAttribute('role'),
    canvasLabel: c.getAttribute('aria-label'),
  };
});
check(/collapse/i.test(a11y.toggleLabel || '') && a11y.controlsOk, `toggle has an accessible name and controls the screen (${a11y.toggleLabel})`);
check(a11y.canvasRole === 'img' && !!a11y.canvasLabel, 'dock canvas has a role and label');
const openOffset = await iconOffset();
check(openOffset !== null && Math.abs(openOffset) <= 0.75, `collapse icon is centred in its button (off by ${openOffset} px)`);
const before = await eyeStats();
check(before.n > 200, `dock shows the live eye (${before.n} eye pixels)`);
const src = await sourceStats(skillFrame);
check(Math.abs(before.meanX / before.width - src.meanX) < 0.02, 'dock matches the face canvas (eye position)');

// 2 + 3a. Click on the dock: a touch at those face coords, and the eye blinks;
// the copy has to follow that (the eye shrinks to a sliver and back). A tap while an idle blink
// is already running starts no new one, so compare the peak with the trough over the window
// and tap again if that blink hid it.
let p = await dockPoint(1100, 360);
let maxN = before.n, minN = before.n;
let g = [];
for (let attempt = 0; attempt < 3 && !(minN < maxN * 0.6); attempt++) {
  await page.mouse.click(p.x, p.y);
  for (let i = 0; i < 30; i++) {
    await sleep(60);
    const n = (await eyeStats()).n;
    maxN = Math.max(maxN, n); minN = Math.min(minN, n);
  }
  g = g.concat(await until((all) => all.some((e) => e.event === 'touch'), 1500));
}
await sleep(200); g = g.concat(await drain());   // a late touch from a retry must not reach the drag checks
const touch = g.find((e) => e.event === 'touch');
check(!!touch && Math.abs(touch.x - 1100) < 8 && Math.abs(touch.y - 360) < 8,
  `dock click sends touch at face coords (${touch ? `${Math.round(touch.x)},${Math.round(touch.y)}` : 'none'})`);
check(minN < maxN * 0.6, `mirror follows the face: blink after the tap took eye pixels ${maxN} -> ${minN}`);

// 3b. Drag across the dock: pans, the last one is final.
p = await dockPoint(300, 360);
const q = await dockPoint(900, 360);
await page.mouse.move(p.x, p.y);
await page.mouse.down();
await page.mouse.move((p.x + q.x) / 2, p.y, { steps: 6 });
await page.mouse.move(q.x, q.y, { steps: 6 });
await page.mouse.up();
g = await until(hasFinalPan);
await sleep(150); g = g.concat(await drain());
const pans = g.filter((e) => e.event === 'pan');
check(pans.length >= 2 && pans[pans.length - 1].isFinal === true && pans.slice(0, -1).every((e) => !e.isFinal),
  `dock drag sends ${pans.length} pans ending isFinal`);
check(!g.some((e) => e.event === 'touch'), 'a drag is not also a tap');

// A drag that leaves the dock keeps panning, clamped to the screen edge, and ends there.
p = await dockPoint(1000, 360);
await page.mouse.move(p.x, p.y);
await page.mouse.down();
await page.mouse.move(p.x + 400, p.y, { steps: 8 });    // well outside the dock
await page.mouse.up();
g = await until(hasFinalPan);
const outPans = g.filter((e) => e.event === 'pan');
const lastOut = outPans[outPans.length - 1];
check(outPans.length >= 2 && outPans.every((e) => e.x >= 0 && e.x <= 1280) && lastOut.isFinal && Math.abs(lastOut.x - 1280) < 1e-6,
  `pointer capture: a drag outside the dock pans to the screen edge and ends there (final x=${lastOut && lastOut.x})`);

// pointercancel mid-drag ends the pan (no stuck drag), and the dock works afterwards.
await page.evaluate(() => {
  document.querySelector('#screen-dock .dock-screen').addEventListener('pointerdown', (e) => { window.__pid = e.pointerId; }, { once: true });
});
p = await dockPoint(300, 360);
await page.mouse.move(p.x, p.y);
await page.mouse.down();
await page.mouse.move(p.x + 60, p.y, { steps: 5 });
await until((all) => all.some((e) => e.event === 'pan'));
await page.evaluate(() => {
  document.querySelector('#screen-dock .dock-screen').dispatchEvent(new PointerEvent('pointercancel', { pointerId: window.__pid, bubbles: true }));
});
g = await until(hasFinalPan);
check(hasFinalPan(g), 'pointercancel ends the pan with a final pan');
await page.mouse.up();
await sleep(150);
g = await drain();
check(!g.some((e) => e.event === 'touch' || e.event === 'pan'), 'the release after a cancel sends nothing');
p = await dockPoint(640, 100);
await page.mouse.click(p.x, p.y);
g = await until((all) => all.some((e) => e.event === 'touch'));
check(g.some((e) => e.event === 'touch'), 'the dock still takes a tap after a cancel');

// A second pointer during a drag must not restart it; a right-click must not tap.
p = await dockPoint(200, 360);
const far = await dockPoint(1200, 600);
await page.mouse.move(p.x, p.y);
await page.mouse.down();
await page.mouse.move(p.x + 100, p.y, { steps: 4 });
await page.evaluate((x, y) => {
  const c = document.querySelector('#screen-dock .dock-screen');
  const init = { pointerId: 77, button: 0, clientX: x, clientY: y, bubbles: true };
  c.dispatchEvent(new PointerEvent('pointerdown', init));    // a second finger lands far away...
  c.dispatchEvent(new PointerEvent('pointerup', init));      // ...and lifts
}, far.x, far.y);
await page.mouse.move(p.x + 300, p.y, { steps: 6 });
await page.mouse.up();
g = await until(hasFinalPan);
await sleep(150); g = g.concat(await drain());
const secondPans = g.filter((e) => e.event === 'pan');
check(secondPans.length >= 3 && secondPans.every((e) => Math.abs(e.movementX) < 200) && !g.some((e) => e.event === 'touch'),
  'a second pointer is ignored: the drag carries on without a jump or a tap');
p = await dockPoint(640, 360);
await page.mouse.click(p.x, p.y, { button: 'right' });
await sleep(300);
check((await drain()).length === 0, 'a right-click on the dock sends nothing');

// 4. The 3D screen still takes taps: aim at the middle of the face's projected quad.
const tap3d = await page.evaluate(() => {
  const r = document.getElementById('skill-iframe').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
await page.mouse.click(tap3d.x, tap3d.y);
g = await until((all) => all.some((e) => e.event === 'touch'));
check(g.some((e) => e.event === 'touch'), `3D screen tap still sends touch (aimed at ${Math.round(tap3d.x)},${Math.round(tap3d.y)})`);

// 5. Switching skill reloads the iframe; the mirror must pick up the new page. The old page
// is marked with a magenta overlay first, so a dock still showing the old page is caught.
const otherSkill = await page.$$eval('#skill-picker option', (os) => os.map((o) => o.value));
const next = otherSkill.find((v) => v !== skillDir);
const magenta = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#ff00ff"/></svg>');
if (next) {
  await skillFrame.evaluate((u) => {
    const d = document.createElement('div');
    d.style.cssText = `position:absolute;left:0;top:0;width:1280px;height:720px;background-image:url("data:image/svg+xml,${u}")`;
    document.body.appendChild(d);
  }, magenta);
  const mid = await waitPixel(0.5, 0.5, (px) => px[0] > 250 && px[1] < 5 && px[2] > 250);
  check(mid[0] > 250 && mid[2] > 250 && mid[1] < 5, `old page is marked in the dock before the switch (${mid})`);
  await page.select('#skill-picker', next);
  await waitForSkill(next);
  const sw = await eyeStats();
  check(sw.n > 200, `dock mirrors the new page after switching skill to ${next} (${sw.n} eye pixels, no magenta left over)`);
} else {
  console.log('SKIP  only one skill available, cannot test skill switch');
}
skillFrame = skillFrameNow();

// 6. A WebGL canvas in the face (what PixiJS makes), covering the bottom-right quarter. Its
// render loop is registered after the dock's, the order in which a plain copy reads blank.
{
  await skillFrame.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 640; c.height = 360;
    Object.assign(c.style, { position: 'absolute', left: '640px', top: '360px', width: '640px', height: '360px' });
    document.body.appendChild(c);
    const gl = c.getContext('webgl');
    (function draw() { gl.clearColor(1, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); requestAnimationFrame(draw); })();
  });
  const inside = await waitPixel(0.75, 0.75, isRed);
  await frames(skillFrame);
  const outside = await dockPixel(0.25, 0.8);
  check(isRed(inside), `WebGL canvas is mirrored, placed by its own rect (${inside})`);
  check(!isRed(outside), 'WebGL canvas does not spill outside its rect');
}

// 7. CSS background images (how jibo-be shows its boot logo).
{
  const svgOf = (w, h, fill) => encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${fill}"/></svg>`);
  const box = (id, css) => skillFrame.evaluate((i, c) => {
    const d = document.createElement('div');
    d.id = i;
    d.style.cssText = `position:absolute;${c}`;
    document.body.appendChild(d);
  }, id, css);
  const dataUrl = (svg) => `url("data:image/svg+xml,${svg}")`;
  const green = svgOf(640, 360, '#00ff00');

  // A boot-logo-like box over the top-left quarter.
  await box('test-splash', `left:0;top:0;width:640px;height:360px;background-image:${dataUrl(green)}`);
  const inside = await waitPixel(0.25, 0.25, isGreen);
  check(isGreen(inside), `CSS background image is mirrored (${inside})`);
  check(!isGreen(await dockPixel(0.75, 0.25)), 'background image is clipped to its box');

  // opacity:0 (a fade-in just starting) is not drawn, opaque is. The image is cached by now,
  // so "not drawn" is the opacity check and not a not-yet-loaded image.
  await box('test-faded', `left:0;top:360px;width:640px;height:360px;opacity:0;background-image:${dataUrl(green)}`);
  await frames(skillFrame);
  const faded = await dockPixel(0.25, 0.75);
  check(!isGreen(faded), `opacity:0 element is not drawn (${faded})`);
  await skillFrame.evaluate(() => { document.getElementById('test-faded').style.opacity = '1'; });
  const shown = await waitPixel(0.25, 0.75, isGreen);
  check(isGreen(shown), `...and is drawn once it is opaque (${shown})`);
  await skillFrame.evaluate(() => { document.getElementById('test-faded').remove(); });

  // Two images in one box (the first is drawn) and background-size: 100% 100% on a tiny image.
  // Only the size makes a 64x36 image reach the middle of the box.
  const tinyGreen = svgOf(64, 36, '#00ff00'), tinyRed = svgOf(64, 36, '#ff0000');
  await box('test-multi', `left:0;top:360px;width:640px;height:360px;background-image:${dataUrl(tinyGreen)}, ${dataUrl(tinyRed)};background-size:100% 100%;background-repeat:no-repeat`);
  const multi = await waitPixel(0.25, 0.75, isGreen);
  check(isGreen(multi), `first of several background images, sized 100% 100% (${multi})`);
  await skillFrame.evaluate(() => { document.getElementById('test-multi').remove(); });

  await skillFrame.evaluate(() => { document.getElementById('test-splash').style.display = 'none'; });
  const gone = await waitPixel(0.25, 0.25, (px) => !isGreen(px));
  check(!isGreen(gone), 'hidden background image leaves the dock');
}

// 8. The face goes cross-origin (same page, the other of localhost / 127.0.0.1): the dock
// can't read it, so it says so instead of sitting black; the next skill brings it back.
{
  const other = new URL(base);
  other.hostname = other.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
  await page.evaluate((u) => { document.getElementById('skill-iframe').src = u; }, `${other.origin}/skill-host.html`);
  await page.waitForFunction(() => {
    const c = document.querySelector('#screen-dock .dock-screen');
    const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    let n = 0;
    for (let i = 0; i < data.length; i += 16) if (data[i] + data[i + 1] + data[i + 2] > 300) n++;
    return n > 20 && n < 3000;     // a line of grey text, not a lit face
  }, { timeout: 30000, polling: 250 });
  check(true, 'dock shows a notice when the face is cross-origin');
  await page.select('#skill-picker', skillDir === next ? otherSkill[0] : skillDir);
  await waitForSkill(skillDir === next ? otherSkill[0] : skillDir);
  check(true, 'dock mirrors again once a skill loads');
  skillFrame = skillFrameNow();
}

// 9. Collapsed: no copying. Expanded again: the face is current.
{
  const green = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#00ff00"/></svg>');
  await page.click('#screen-dock .dock-toggle');
  check(await page.evaluate(() => document.querySelector('#screen-dock').classList.contains('collapsed')), 'toggle collapses the dock');
  check(/expand/i.test(await page.$eval('#screen-dock .dock-toggle', (b) => b.getAttribute('aria-label'))), 'toggle label follows the state');
  const collapsedOffset = await iconOffset();
  check(collapsedOffset !== null && Math.abs(collapsedOffset) <= 0.75, `expand icon is centred in its button (off by ${collapsedOffset} px)`);
  await skillFrame.evaluate((u) => {
    const d = document.createElement('div');
    d.id = 'test-collapsed';
    d.style.cssText = `position:absolute;left:0;top:0;width:640px;height:360px;background-image:url("data:image/svg+xml,${u}")`;
    document.body.appendChild(d);
  }, green);
  await frames(skillFrame);
  check(!isGreen(await dockPixel(0.25, 0.25)), 'a collapsed dock does not copy the face');
  await page.click('#screen-dock .dock-toggle');
  const resumed = await waitPixel(0.25, 0.25, isGreen);
  check(isGreen(resumed), 'expanding resumes the copy with the current face');
}

// The TTS subtitle is stacked above the dock (a long subtitle runs over the dock's area).
check(await page.evaluate(() => {
  const z = (sel) => Number(getComputedStyle(document.querySelector(sel)).zIndex) || 0;
  return z('#subtitle') > z('#screen-dock');
}), 'subtitle is stacked above the dock');

// Collapse persists across reload.
await page.click('#screen-dock .dock-toggle');
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#start-gate');
await page.click('#start-gate');
await page.waitForSelector('#screen-dock');
check(await page.evaluate(() => document.querySelector('#screen-dock').classList.contains('collapsed')), 'collapsed state survives a reload');
await page.click('#screen-dock .dock-toggle');
check(await page.evaluate(() => !document.querySelector('#screen-dock').classList.contains('collapsed')), 'toggle expands it again');

await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
