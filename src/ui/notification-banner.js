// Notification banner — slides a styled banner in over the viewport, dwells,
// then slides out (the original's 250ms in / 1500ms dwell / 250ms out).

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

export function createNotificationBanner(hostEl) {
  const el = document.createElement('div');
  el.id = 'notification-banner';
  el.hidden = true;
  hostEl.appendChild(el);

  let hideTimer = 0;
  let removeTimer = 0;

  function show(note) {
    clearTimeout(hideTimer);
    clearTimeout(removeTimer);
    el.className = `notif-${note.type}`;
    el.innerHTML =
      `<div class="notif-title">${escapeHtml(note.title)}</div>` +
      `<div class="notif-desc">${escapeHtml(note.description)}</div>`;
    el.hidden = false;
    // reflow so the slide-in transition runs from the hidden position
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    hideTimer = setTimeout(() => el.classList.remove('show'), 1750);
    removeTimer = setTimeout(() => { el.hidden = true; }, 2050);
  }

  return { show };
}
