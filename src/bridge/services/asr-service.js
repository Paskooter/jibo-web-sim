// asr service — feeds simulated speech recognition to the skill.
//
// In the original simulator the ASRService received text typed into the chat
// input and emitted it as recognized speech (see jibo-cli chat-view / asr-view
// + skills-service-manager ASRService). Here the host (Chat tab) calls
// recognize(); we push an 'asr' 'speech' event to the skill shaped like the
// original word payload: { words, final, speaker }.
//
// Returns { service, recognize }:
//   service   — bridge-registered methods callable by the skill (none yet;
//               skills only subscribe to events in M3).
//   recognize — host-only entry point the Chat UI calls.

export function createAsrService({ emit }) {
  function recognize(text, opts = {}) {
    const { final = true, speaker = 'user' } = opts;
    emit('speech', { words: String(text), final, speaker });
  }
  return { service: {}, recognize };
}
