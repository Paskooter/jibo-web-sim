// tts service — fulfils jibo.tts.speak / stop.
//
// Utterances are QUEUED: each speak() waits its turn and only starts once the
// previous one has finished speaking, so calls never talk over each other.
// Completion is driven by the Web Speech audio's onend when audio is playing
// (so the queue waits for the real end of speech), and by a timing estimate
// when there's no audio (e.g. SpeechSynthesis unavailable). A subtitle bar
// shows the current text, per-word 'word' events fire, and 'start'/'stop'
// events drive the talking eye. Implements the public TTSService shape
// (speak/stop, 'word'/'stop' events).
//
// Note on audio: browsers block audio until the user interacts with the page;
// the host gates skill start behind a click so the greeting is audible.
//
// `emit(event, data)` pushes a 'tts' event to the skill; `onSubtitle(text)`
// updates host UI (null clears it).

const WORDS_PER_MIN = 165;          // a calm Jibo speaking pace
const MIN_WORD_MS = 180;

export function createTtsService({ emit, onSubtitle }) {
  const synth = (typeof window !== 'undefined') ? window.speechSynthesis : null;
  const queue = [];                 // [{ text, options, resolve }]
  let current = null;               // item currently speaking
  let timers = [];
  let token = 0;                    // bumped per utterance to void stale timers

  function clearTimers() {
    for (const t of timers) clearTimeout(t);
    timers = [];
  }

  // Finish the current utterance, resolve its speak(), and advance the queue.
  // `cancelAudio` cuts in-flight audio (interrupts/stop); a natural finish
  // lets any audio tail play out.
  function finishCurrent(cancelAudio) {
    if (!current) return;
    clearTimers();
    if (cancelAudio && synth) synth.cancel();
    onSubtitle(null);
    emit('stop', {});
    const done = current.resolve;
    current = null;
    token++;
    done();
    playNext();
  }

  function playNext() {
    if (current || queue.length === 0) return;
    current = queue.shift();
    const myToken = ++token;
    const { text, options } = current;
    const stretch = (options && options.duration_stretch) || 1;

    const words = String(text).trim().split(/\s+/).filter(Boolean);
    const perWord = Math.max(MIN_WORD_MS, 60000 / WORDS_PER_MIN) * stretch;

    onSubtitle(text);
    emit('start', { text });

    let t = 0;
    words.forEach((word, i) => {
      timers.push(setTimeout(() => {
        if (myToken === token) emit('word', { token: word, index: i, count: words.length });
      }, t));
      t += perWord;
    });
    const estimatedEnd = t + 400;

    let usedAudio = false;
    if (synth && words.length) {
      try {
        const u = new SpeechSynthesisUtterance(text);
        u.rate = Math.max(0.5, Math.min(2, 1 / stretch));
        u.pitch = (options && typeof options.pitch === 'number')
          ? Math.max(0, Math.min(2, 0.6 + options.pitch))   // jibo pitch ~0.42 -> ~1.0
          : 1.0;
        // The queue advances when the audio actually finishes.
        u.onend = () => { if (myToken === token) finishCurrent(false); };
        u.onerror = () => { if (myToken === token) finishCurrent(false); };
        synth.cancel();
        synth.speak(u);
        usedAudio = true;
        // Safety net: if onend never arrives (some browsers drop it), end well
        // after the expected duration so the queue can't stall forever.
        timers.push(setTimeout(() => {
          if (myToken === token) finishCurrent(true);
        }, Math.max(estimatedEnd * 2, estimatedEnd + 4000)));
      } catch (_) {
        usedAudio = false;
      }
    }

    if (!usedAudio) {
      // No audio: drive completion by the timing estimate.
      timers.push(setTimeout(() => {
        if (myToken === token) finishCurrent(false);
      }, estimatedEnd));
    }
  }

  function speak(text, options = {}) {
    return new Promise((resolve) => {
      queue.push({ text, options, resolve });
      playNext();
    });
  }

  function stop() {
    // Drop anything queued (resolve so awaiters don't hang) and stop current.
    const dropped = queue.splice(0);
    for (const item of dropped) item.resolve();
    finishCurrent(true);
    return Promise.resolve();
  }

  return { speak, stop };
}
