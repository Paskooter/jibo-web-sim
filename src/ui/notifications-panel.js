// Notifications tab — push a sample notification of each type.
// `onPush` receives a { type, title, description } object.

const SAMPLES = {
  message: ['New message', 'Cynthia sent you a message.'],
  battery: ['Low battery', "I'm running low — please charge me soon."],
  alarm: ['Alarm', "It's 7:00 AM — time to wake up!"],
  twitter: ['Twitter', 'You were mentioned in a tweet.'],
};

export function installNotificationsPanel(panelEl, { onPush }) {
  panelEl.innerHTML = '';
  panelEl.classList.add('lps-panel');
  panelEl.innerHTML = `
    <section class="rig-section">
      <h3>Notifications</h3>
      <p class="rig-note">Push a notification banner. Skills can create these
      with jibo.notifications.create and listen via jibo.notifications.on.</p>
      <div class="audio-grid">
        <button type="button" data-type="message">Message</button>
        <button type="button" data-type="battery">Battery</button>
        <button type="button" data-type="alarm">Alarm</button>
        <button type="button" data-type="twitter">Twitter</button>
      </div>
    </section>
  `;
  for (const btn of panelEl.querySelectorAll('[data-type]')) {
    btn.addEventListener('click', () => {
      const [title, description] = SAMPLES[btn.dataset.type];
      onPush({ type: btn.dataset.type, title, description });
    });
  }
}
