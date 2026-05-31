// asr service — feeds simulated speech recognition to the skill.
//
// The host (Chat tab) calls recognize(); we push an 'asr' 'speech' event
// to the skill shaped like a word payload: { words, final, speaker }.
//
// Returns { service, recognize }:
//   service   — bridge-registered methods callable by the skill (none yet).
//   recognize — host-only entry point the Chat UI calls.

export function createAsrService({ emit }) {
  function recognize(text, opts = {}) {
    const { final = true, speaker = 'user' } = opts;
    emit('speech', { words: String(text), final, speaker });
  }
  return { service: {}, recognize };
}
