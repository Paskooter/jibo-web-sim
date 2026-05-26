// lps service — Local Perceptual Space (Jibo's model of things around it):
// look-at targets and transient audio events.
//
// The original LPSService tracked perceived entities and exposed queries like
// getClosestAudibleEntity() plus 'audio-event-start'/'audio-event-end' events
// (jibo-cli lps-view + audio-event.ts; jibo/dts/lps.d.ts). Here the host (LPS /
// Audio tabs, or viewport clicks) drives them; we hold the state, notify the
// skill, and the look-at controller turns Jibo toward the active target.
//
// Returns { service, setTarget, fireAudioEvent, clearAudioEvent }:
//   service        — skill-callable methods registered on the bridge.
//   setTarget      — host: set/clear the persistent look-at target.
//   fireAudioEvent — host: register a transient audio entity.
//   clearAudioEvent— host: it has finished.

export function createLpsService({ emit }) {
  let target = null;       // persistent look-at target { x, y, z } | null
  let audible = null;      // current audio entity | null

  return {
    service: {
      getTarget() { return target; },
      getClosestAudibleEntity() { return audible; },
    },
    setTarget(v) {
      target = v ? { x: v.x, y: v.y, z: v.z } : null;
      if (target) emit('target', target);
      else emit('target-lost', {});
    },
    fireAudioEvent(entity) {
      audible = entity;
      emit('audio-event-start', entity);
    },
    clearAudioEvent(entity) {
      if (audible && audible.id === entity.id) audible = null;
      emit('audio-event-end', { id: entity.id });
    },
  };
}
