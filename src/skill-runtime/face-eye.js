// Jibo's eye, rendered to a <canvas> inside the skill iframe.
//
// Not the real PixiJS eye — a faithful stand-in: the iconic single
// glowing cyan disc on a black screen, with idle
// breathing + auto-blink, smooth look tracking, and a talking pulse. The
// canvas fills the logical 1280×720 face; the face-overlay projects it onto
// Jibo's 3D screen quad.

export function createEye(parentEl, { width = 1280, height = 720 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  Object.assign(canvas.style, { width: '100%', height: '100%', display: 'block' });
  parentEl.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  let color = '#4ec9ff';
  const look = { x: 0, y: 0 };          // target gaze, each in [-1, 1]
  const lookCur = { x: 0, y: 0 };       // eased current gaze
  let talking = false;
  let blinkT = -1;                      // 0..1 while blinking, else -1

  const cx = width / 2, cy = height / 2;
  const baseR = Math.min(width, height) * 0.30;

  const start = performance.now();
  let lastBlink = start;
  let raf = 0;

  function hexFrom(v) {
    return typeof v === 'number' ? '#' + (v >>> 0).toString(16).padStart(6, '0').slice(-6) : v;
  }

  function frame(now) {
    const t = (now - start) / 1000;

    if (blinkT < 0 && now - lastBlink > 3800 + Math.random() * 2600) {
      blinkT = 0;
      lastBlink = now;
    }

    lookCur.x += (look.x - lookCur.x) * 0.12;
    lookCur.y += (look.y - lookCur.y) * 0.12;

    const breathe = 1 + 0.015 * Math.sin(t * 1.6);
    const talkPulse = talking ? 1 + 0.06 * Math.sin(t * 14) : 1;
    let rx = baseR * breathe;
    let ry = baseR * breathe * talkPulse;

    if (blinkT >= 0) {
      blinkT += 0.10;
      const k = blinkT < 0.5 ? blinkT * 2 : (1 - blinkT) * 2;   // 0→1→0
      ry *= 1 - 0.92 * Math.min(1, k);
      if (blinkT >= 1) blinkT = -1;
    }

    const ex = cx + lookCur.x * baseR * 0.5;
    const ey = cy + lookCur.y * baseR * 0.5;

    ctx.fillStyle = '#05070a';
    ctx.fillRect(0, 0, width, height);

    // soft glow halo
    const grad = ctx.createRadialGradient(ex, ey, baseR * 0.2, ex, ey, baseR * 1.7);
    grad.addColorStop(0, color);
    grad.addColorStop(0.55, color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save();
    ctx.globalAlpha = 0.32;
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.ellipse(ex, ey, rx * 1.7, ry * 1.7, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // main disc
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.ellipse(ex, ey, rx, ry, 0, 0, Math.PI * 2); ctx.fill();

    // subtle inner brightening
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath(); ctx.ellipse(ex, ey, rx * 0.62, ry * 0.62, 0, 0, Math.PI * 2); ctx.fill();

    // specular highlight
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.ellipse(ex - rx * 0.28, ey - ry * 0.30, rx * 0.16, ry * 0.16, 0, 0, Math.PI * 2);
    ctx.fill();

    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return {
    setColor(hex) { color = hexFrom(hex); },
    lookAt(x, y) {
      look.x = Math.max(-1, Math.min(1, x || 0));
      look.y = Math.max(-1, Math.min(1, y || 0));
    },
    blink() { if (blinkT < 0) blinkT = 0; },
    setTalking(v) { talking = !!v; },
    setVisible(v) { canvas.style.display = v ? 'block' : 'none'; },
    setScale(s) { canvas.style.transform = `scale(${s})`; canvas.style.transformOrigin = 'center'; },
    destroy() { cancelAnimationFrame(raf); canvas.remove(); },
  };
}
