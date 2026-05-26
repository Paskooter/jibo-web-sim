// Hello World — bundle entry (package.json "main"; loaded by index.html via the
// platform's jibo runtime). `jibo` is a global, as on a real robot.
//
// A hand-written equivalent of what jibo-cli's package-generator would scaffold
// (behavior-template). The original drives behavior via jibo.flow.run + .bt/.flow
// files; those subsystems aren't implemented in the web sim yet, so this skill
// uses the public jibo.* services directly: init, face, tts, asr, nlu, animate —
// the full Chat -> ASR -> NLU -> TTS loop, gesturing while it speaks.

// NLU rule: a few intents Jibo can recognize from typed/"spoken" input.
var CHAT_RULE = {
  intents: {
    greeting: ['hello', 'hi', 'hey jibo', 'good morning'],
    name: ['what is your name', 'who are you'],
    feeling: ['how are you', 'how do you feel'],
    capabilities: ['what can you do', 'help'],
    dance: ['dance', 'do a dance', 'show me a move'],
    look: ['look around', 'look', 'what do you see'],
    bye: ['goodbye', 'bye', 'see you later'],
  },
};

// Per-intent reply + the gesture to play while saying it.
var RESPONSES = {
  greeting: ['Hi there! It\'s great to meet you.', 'nodYes'],
  name: ['I\'m Jibo, the world\'s first social robot — now living in your browser.', 'greeting'],
  feeling: ['I\'m feeling wonderful, thanks for asking!', 'happy'],
  capabilities: ['I can look around, talk, and move my body. Watch this!', 'lookAround'],
  dance: ['Okay, here\'s a little dance!', 'happy'],
  look: ['Let me take a look around.', 'lookAround'],
  bye: ['Goodbye! Come back and chat with me any time.', 'shakeNo'],
};

// Speak a line and play a gesture at the same time.
function sayWithGesture(text, gesture, done) {
  if (gesture) jibo.animate.play(gesture);
  jibo.tts.speak(text, done);
}

jibo.init('face', function (err) {
  if (err) { console.error('[hello-world] init failed:', err); return; }

  jibo.face.setColor('#4ec9ff');
  jibo.face.lookForward();

  setTimeout(function () {
    sayWithGesture("Hello! I'm Jibo, running entirely in your browser.", 'greeting', function () {
      jibo.face.blink();
      jibo.tts.speak("Type something in the Chat tab and I'll do my best to respond.");
    });
  }, 700);

  // Listen for recognized speech, interpret it, and reply with a gesture.
  jibo.asr.on('speech', function (e) {
    if (!e || !e.final) return;
    jibo.nlu.parseFromRule(CHAT_RULE, e.words, function (nluErr, res) {
      var intent = !nluErr && res && res.NLParse ? res.NLParse.intent : null;
      var score = res ? res.heuristic_score : 0;
      var match = (intent && score >= 0.5) ? RESPONSES[intent] : null;
      if (match) {
        sayWithGesture(match[0], match[1]);
      } else {
        jibo.animate.play('nodYes');
        jibo.tts.speak("Hmm, I'm not sure I understood that — but I'm still learning!");
      }
    });
  });
});
