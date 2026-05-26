// TTS tab — shows what Jibo is currently saying, plus a short history.
// Audio itself is produced by the TTS service (Web Speech API).

export function installTtsPanel(panelEl) {
  panelEl.innerHTML = '';
  panelEl.classList.add('speech-panel');
  panelEl.innerHTML = `
    <section class="rig-section">
      <h3>Text to speech (TTS)</h3>
      <p class="rig-note">What Jibo is saying. Audio uses the browser's Web
      Speech voice (autoplay may require a click on the page first).</p>
      <div class="speech-readout">
        <div class="speech-line"><span class="speech-label">Status</span><span id="tts-status">idle</span></div>
        <div class="speech-current" id="tts-current">—</div>
      </div>
    </section>
    <section class="rig-section">
      <h3>History</h3>
      <div class="speech-history" id="tts-history"></div>
    </section>
  `;
  const status = panelEl.querySelector('#tts-status');
  const current = panelEl.querySelector('#tts-current');
  const history = panelEl.querySelector('#tts-history');

  return {
    setSpeaking(text) {
      if (text) {
        status.textContent = 'speaking';
        current.textContent = text;
        const row = document.createElement('div');
        row.className = 'speech-hist-row';
        row.textContent = text;
        history.prepend(row);
      } else {
        status.textContent = 'idle';
        current.textContent = '—';
      }
    },
  };
}
