// Audio tab — trigger a spatial sound event that Jibo glances toward.
//
// Each button fires a transient audio event at a point around Jibo; the
// checkbox enables click-to-place in the viewport. `onFire` receives a {x,y,z}
// world point; `onPlacementMode(bool)` toggles viewport click-to-place.

const PRESETS = {
  Front: { x: 0.6, y: 0.26, z: 0.0 },
  Left: { x: 0.1, y: 0.26, z: 0.6 },
  Right: { x: 0.1, y: 0.26, z: -0.6 },
  Behind: { x: -0.6, y: 0.26, z: 0.0 },
  Above: { x: 0.4, y: 0.7, z: 0.0 },
};

export function installAudioPanel(panelEl, { onFire, onPlacementMode }) {
  panelEl.innerHTML = '';
  panelEl.classList.add('lps-panel');
  panelEl.innerHTML = `
    <section class="rig-section">
      <h3>Audio events</h3>
      <p class="rig-note">Make a sound somewhere around Jibo and he glances
      toward it, then looks back. Skills hear it via jibo.lps audio events.</p>
      <div class="audio-grid">
        <button type="button" data-preset="Front">Front</button>
        <button type="button" data-preset="Left">Left</button>
        <button type="button" data-preset="Right">Right</button>
        <button type="button" data-preset="Behind">Behind</button>
        <button type="button" data-preset="Above">Above</button>
      </div>
    </section>
    <section class="rig-section">
      <label class="lps-check"><input type="checkbox" id="audio-place"> Click in viewport to make a sound</label>
    </section>
  `;

  for (const btn of panelEl.querySelectorAll('[data-preset]')) {
    btn.addEventListener('click', () => onFire(PRESETS[btn.dataset.preset]));
  }
  panelEl.querySelector('#audio-place').addEventListener('change', (e) => {
    onPlacementMode(e.target.checked);
  });
}
