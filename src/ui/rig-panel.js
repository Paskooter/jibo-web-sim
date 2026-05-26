// Rig tab: dev controls for the articulated body. Lets us slider the three
// joints and pick LED ring colors without a skill loaded. Will stay around
// past M1 as a developer test harness.

const JOINTS = [
  { key: 'yaw',   label: 'Yaw',   min: -150, max:  150, fn: 'setYaw'   },
  { key: 'pitch', label: 'Pitch', min:  -25, max:   25, fn: 'setPitch' },
  { key: 'roll',  label: 'Roll',  min:  -30, max:   30, fn: 'setRoll'  },
];

const DEG = Math.PI / 180;

export function installRigPanel(panelEl, rig) {
  panelEl.innerHTML = '';
  panelEl.classList.add('rig-panel');

  const sliderState = {};

  // Joint sliders
  const jointsSection = document.createElement('section');
  jointsSection.className = 'rig-section';
  jointsSection.innerHTML = '<h3>Joints</h3>';
  for (const j of JOINTS) {
    const row = document.createElement('div');
    row.className = 'rig-row';
    row.innerHTML = `
      <label for="rig-${j.key}">${j.label}</label>
      <input type="range" id="rig-${j.key}"
             min="${j.min}" max="${j.max}" step="1" value="0">
      <output id="rig-${j.key}-out">0°</output>
    `;
    const input = row.querySelector('input');
    const out = row.querySelector('output');
    input.addEventListener('input', () => {
      const deg = Number(input.value);
      rig[j.fn](deg * DEG);
      out.textContent = `${deg}°`;
    });
    sliderState[j.key] = { input, out };
    jointsSection.appendChild(row);
  }
  panelEl.appendChild(jointsSection);

  // LED color picker
  const segLabel = rig.ledCount > 1 ? ` (${rig.ledCount} segments)` : '';
  const ledSection = document.createElement('section');
  ledSection.className = 'rig-section';
  ledSection.innerHTML = `
    <h3>LED ring${segLabel}</h3>
    <div class="rig-row">
      <label for="rig-led-color">Color</label>
      <input type="color" id="rig-led-color" value="#4ec9ff">
      <button type="button" id="rig-led-off">Off</button>
    </div>
    <div class="rig-row">
      <label>Demo</label>
      <button type="button" id="rig-led-rainbow">Rainbow</button>
      <button type="button" id="rig-led-pulse">Pulse blue</button>
    </div>
  `;
  panelEl.appendChild(ledSection);

  const colorInput = ledSection.querySelector('#rig-led-color');
  colorInput.addEventListener('input', () => {
    stopAnimations();
    rig.setAllLeds(colorInput.value);
  });
  ledSection.querySelector('#rig-led-off').addEventListener('click', () => {
    stopAnimations();
    rig.setAllLeds(0x101418);
  });
  ledSection.querySelector('#rig-led-rainbow').addEventListener('click', () => {
    startRainbow();
  });
  ledSection.querySelector('#rig-led-pulse').addEventListener('click', () => {
    startPulse(0x4ec9ff);
  });

  // Reset
  const actions = document.createElement('section');
  actions.className = 'rig-section rig-actions';
  actions.innerHTML = `<button type="button" id="rig-reset">Reset pose &amp; LEDs</button>`;
  panelEl.appendChild(actions);
  actions.querySelector('#rig-reset').addEventListener('click', () => {
    stopAnimations();
    rig.reset();
    for (const j of JOINTS) {
      sliderState[j.key].input.value = 0;
      sliderState[j.key].out.textContent = '0°';
    }
  });

  // --- LED animation helpers (kept local, no global state) ---
  let animHandle = 0;
  function stopAnimations() {
    if (animHandle) { cancelAnimationFrame(animHandle); animHandle = 0; }
  }
  function startRainbow() {
    stopAnimations();
    const start = performance.now();
    const tick = (now) => {
      const t = (now - start) / 1000;
      for (let i = 0; i < rig.ledCount; i++) {
        const hue = ((i / rig.ledCount) + t * 0.25) % 1;
        rig.setLed(i, hslToHex(hue, 0.85, 0.55));
      }
      animHandle = requestAnimationFrame(tick);
    };
    animHandle = requestAnimationFrame(tick);
  }
  function startPulse(baseColor) {
    stopAnimations();
    const start = performance.now();
    const c = new ColorTriple(baseColor);
    const tick = (now) => {
      const t = (now - start) / 1000;
      const k = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(t * 2.5));
      const hex = (Math.round(c.r * k) << 16) | (Math.round(c.g * k) << 8) | Math.round(c.b * k);
      rig.setAllLeds(hex);
      animHandle = requestAnimationFrame(tick);
    };
    animHandle = requestAnimationFrame(tick);
  }
}

// --- tiny color helpers (no dep) ---

function hslToHex(h, s, l) {
  // h, s, l in [0,1]
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  const r = Math.round(f(0) * 255);
  const g = Math.round(f(8) * 255);
  const b = Math.round(f(4) * 255);
  return (r << 16) | (g << 8) | b;
}

class ColorTriple {
  constructor(hex) {
    this.r = (hex >> 16) & 0xff;
    this.g = (hex >> 8)  & 0xff;
    this.b =  hex        & 0xff;
  }
}
