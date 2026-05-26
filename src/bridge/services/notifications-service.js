// notifications service — banner notifications ({ type, title, description }).
//
// Matches the original simulator's NotificationsService surface: a
// 'notification-created' event and the type set the notifications-view styled
// (message / battery / alarm / twitter; jibo-cli notifications-view.tsx). The
// skill creates one via jibo.notifications.create; the host shows the banner
// and echoes a 'created' event back to the skill.
//
// Returns { service, push }:
//   service — skill-callable (create) registered on the bridge.
//   push    — host-only entry (Notifications tab).

const TYPES = ['message', 'battery', 'alarm', 'twitter'];

function normalize(note) {
  note = note || {};
  return {
    type: TYPES.includes(note.type) ? note.type : 'message',
    title: note.title || 'Notification',
    description: note.description || '',
  };
}

export function createNotificationsService({ emit, onShow }) {
  function publish(note) {
    const n = normalize(note);
    onShow(n);
    emit('created', n);
    return n;
  }
  return {
    service: { create(note) { return publish(note); } },
    push: publish,
  };
}
