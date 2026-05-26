// Rig tab: dev controls for the articulated body. Drives the three
// canonical Jibo DOFs (`bottomSection_r`, `middleSection_r`, `topSection_r`),
// each a rotation in radians around the joint's local Y. Range is the
// canonical ±3.054 rad (~±175°), `isCyclic: true` per jibo_body.kin.

const DOFS = [
  { key: 'bottomSection', dofName: 'bottomSection_r',
    label: 'Bottom', desc: 'base twist (whole upper body)',
    fn: 'setBottom' },
  { key: 'middleSection', dofName: 'middleSection_r',
    label: 'Middle', desc: 'rotation about the tilted mid-section axis',
    fn: 'setMiddle' },
  { key: 'topSection',    dofName: 'topSection_r',
    label: 'Top',    desc: 'rotation about the tilted head axis',
    fn: 'setTop' },
];

const RAD2DEG = 180 / Math.PI;

export function installRigPanel(panelEl, rig) {
  panelEl.innerHTML = '';
  panelEl.classList.add('rig-panel');

  const sliderState = {};

  // Joint sliders. Slider value is in radians scaled by 1000 so we get
  // ~0.001 rad steps with integer steps; display shows both rad and deg.
  const jointsSection = document.createElement('section');
  jointsSection.className = 'rig-section';
  jointsSection.innerHTML = `
    <h3>Body DOFs</h3>
    <p class="rig-note">All three are rotations about the joint's local
    +Y axis. The middle and top joints have tilted rest poses, so the
    three motors couple to swing the head through 3D space.</p>
  `;
  const min = Math.round(rig.dofMin * 1000);
  const max = Math.round(rig.dofMax * 1000);
  for (const j of DOFS) {
    const row = document.createElement('div');
    row.className = 'rig-row';
    row.innerHTML = `
      <label for="rig-${j.key}" title="${j.dofName} — ${j.desc}">${j.label}</label>
      <input type="range" id="rig-${j.key}" min="${min}" max="${max}" step="1" value="0">
      <output id="rig-${j.key}-out">0.000 rad</output>
    `;
    const input = row.querySelector('input');
    const out = row.querySelector('output');
    input.addEventListener('input', () => {
      const rad = Number(input.value) / 1000;
      rig[j.fn](rad);
      out.textContent = `${rad.toFixed(3)} rad (${(rad * RAD2DEG).toFixed(0)}°)`;
    });
    sliderState[j.key] = { input, out };
    jointsSection.appendChild(row);
  }
  panelEl.appendChild(jointsSection);

  // LED ring controls. The lightring is a single mesh in the MIT model,
  // so per-LED control isn't available without a custom shader; for now
  // setLEDColor() tints the whole ring.
  const ledSection = document.createElement('section');
  ledSection.className = 'rig-section';
  ledSection.innerHTML = `
    <h3>LED ring</h3>
    <div class="rig-row">
      <label for="rig-led-color">Color</label>
      <input type="color" id="rig-led-color" value="#4ec9ff">
      <button type="button" id="rig-led-off">Off</button>
    </div>
    <div class="rig-row">
      <label>Demo</label>
      <button type="button" id="rig-led-rainbow">Rainbow</button>
      <button type="button" id="rig-led-pulse">Pulse</button>
    </div>
  `;
  panelEl.appendChild(ledSection);

  const colorInput = ledSection.querySelector('#rig-led-color');
  colorInput.addEventListener('input', () => {
    stopAnimations();
    rig.setLEDHex(parseInt(colorInput.value.slice(1), 16));
  });
  ledSection.querySelector('#rig-led-off').addEventListener('click', () => {
    stopAnimations();
    rig.setLEDHex(0x101418);
  });
  ledSection.querySelector('#rig-led-rainbow').addEventListener('click', startRainbow);
  ledSection.querySelector('#rig-led-pulse').addEventListener('click', () => startPulse(0x4ec9ff));

  // Reset
  const actions = document.createElement('section');
  actions.className = 'rig-section rig-actions';
  actions.innerHTML = `<button type="button" id="rig-reset">Reset pose &amp; LEDs</button>`;
  panelEl.appendChild(actions);
  actions.querySelector('#rig-reset').addEventListener('click', () => {
    stopAnimations();
    rig.reset();
    for (const j of DOFS) {
      sliderState[j.key].input.value = 0;
      sliderState[j.key].out.textContent = '0.000 rad';
    }
  });

  // --- LED animation helpers (local state, no globals) ---
  let animHandle = 0;
  function stopAnimations() {
    if (animHandle) { cancelAnimationFrame(animHandle); animHandle = 0; }
  }
  function startRainbow() {
    stopAnimations();
    const start = performance.now();
    const tick = (now) => {
      const t = (now - start) / 1000;
      rig.setLEDHex(hslToHex(t * 0.25 % 1, 0.85, 0.55));
      animHandle = requestAnimationFrame(tick);
    };
    animHandle = requestAnimationFrame(tick);
  }
  function startPulse(baseColor) {
    stopAnimations();
    const start = performance.now();
    const r = (baseColor >> 16) & 0xff;
    const g = (baseColor >> 8)  & 0xff;
    const b =  baseColor        & 0xff;
    const tick = (now) => {
      const t = (now - start) / 1000;
      const k = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(t * 2.5));
      const hex = (Math.round(r * k) << 16) | (Math.round(g * k) << 8) | Math.round(b * k);
      rig.setLEDHex(hex);
      animHandle = requestAnimationFrame(tick);
    };
    animHandle = requestAnimationFrame(tick);
  }
}

function hslToHex(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return (Math.round(f(0) * 255) << 16) |
         (Math.round(f(8) * 255) << 8)  |
          Math.round(f(4) * 255);
}
