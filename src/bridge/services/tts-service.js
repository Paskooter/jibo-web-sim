// tts service — fulfils jibo.tts.speak / stop.
//
// No real speech synthesis (yet); we model timing so the rest of the system
// behaves correctly: a subtitle bar shows the text, per-word 'word' events
// fire on a schedule (the shim uses 'start'/'stop' to drive the talking eye),
// and speak() resolves when the utterance "finishes". Mirrors the public
// TTSService shape (speak/stop, 'word'/'stop' events) from
// sdk-archive/jibo/src/services/TTSService.ts.
//
// `emit(event, data)` pushes a 'tts' event to the skill; `onSubtitle(text)`
// updates host UI (null clears it).

const WORDS_PER_MIN = 165;          // a calm Jibo speaking pace
const MIN_WORD_MS = 180;

export function createTtsService({ emit, onSubtitle }) {
  let timers = [];
  let activeToken = 0;
  let activeResolve = null;          // resolves the current speak()'s promise

  function clearTimers() {
    for (const t of timers) clearTimeout(t);
    timers = [];
  }

  // End the current utterance: clear subtitle, tell the skill, resolve speak().
  // No-op when nothing is speaking, so idle stop()s don't emit spurious events.
  function end() {
    clearTimers();
    if (!activeResolve) return;
    onSubtitle(null);
    emit('stop', {});
    const resolve = activeResolve;
    activeResolve = null;
    activeToken++;                   // invalidate any straggler timers
    resolve();
  }

  function speak(text, options = {}) {
    return new Promise((resolve) => {
      end();                         // interrupt anything already speaking
      activeResolve = resolve;
      const token = ++activeToken;
      const stretch = (options && options.duration_stretch) || 1;

      const words = String(text).trim().split(/\s+/).filter(Boolean);
      const perWord = Math.max(MIN_WORD_MS, 60000 / WORDS_PER_MIN) * stretch;

      onSubtitle(text);
      emit('start', { text });

      let t = 0;
      words.forEach((word, i) => {
        timers.push(setTimeout(() => {
          if (token !== activeToken) return;
          emit('word', { token: word, index: i, count: words.length });
        }, t));
        t += perWord;
      });

      timers.push(setTimeout(() => {
        if (token === activeToken) end();
      }, t + 120));
    });
  }

  function stop() {
    end();
    return Promise.resolve();
  }

  return { speak, stop };
}
