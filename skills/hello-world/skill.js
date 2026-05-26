// Hand-written Hello World skill (classic script — `jibo` is a global provided
// by the skill runtime, as on a real robot). A minimal precursor to M5's full
// generated bundle; exercises jibo.init, jibo.face, jibo.tts, jibo.asr and
// jibo.nlu — the full Chat -> ASR -> NLU -> TTS loop.

// NLU rule: a few intents Jibo can recognize from typed/"spoken" input.
var CHAT_RULE = {
  intents: {
    greeting: ['hello', 'hi', 'hey jibo', 'good morning'],
    name: ['what is your name', 'who are you'],
    feeling: ['how are you', 'how do you feel'],
    capabilities: ['what can you do', 'help'],
    bye: ['goodbye', 'bye', 'see you later'],
  },
};

var REPLIES = {
  greeting: "Hi there! It's great to meet you.",
  name: "I'm Jibo, the world's first social robot — now living in your browser.",
  feeling: "I'm feeling wonderful, thanks for asking!",
  capabilities: "Right now I can look around, talk, and listen. More soon!",
  bye: "Goodbye! Come back and chat with me any time.",
};

jibo.init('face', function (err) {
  if (err) { console.error('[hello-world] init failed:', err); return; }

  jibo.face.setColor('#4ec9ff');
  jibo.face.lookForward();

  setTimeout(function () {
    jibo.tts.speak("Hello! I'm Jibo, running entirely in your browser.", function () {
      jibo.face.blink();
      jibo.tts.speak("Type something in the Chat tab and I'll do my best to respond.");
    });
  }, 700);

  // Listen for recognized speech from the Chat tab, interpret it, and reply.
  jibo.asr.on('speech', function (e) {
    if (!e || !e.final) return;
    jibo.face.lookAt(0.25, -0.15);
    jibo.nlu.parseFromRule(CHAT_RULE, e.words, function (nluErr, res) {
      var intent = !nluErr && res && res.NLParse ? res.NLParse.intent : null;
      var score = res ? res.heuristic_score : 0;
      var reply = (intent && score >= 0.5 && REPLIES[intent])
        ? REPLIES[intent]
        : "Hmm, I'm not sure I understood that — but I'm still learning!";
      jibo.tts.speak(reply, function () { jibo.face.lookForward(); });
    });
  });
});
