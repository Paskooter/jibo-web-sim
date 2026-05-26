// Fortune Teller — a second hand-written skill (bundle entry). Demonstrates the
// multi-skill picker: a distinct skill loaded into the same runtime.

var FORTUNES = [
  'Good things are coming your way.',
  'Today is a wonderful day to learn something new.',
  'A pleasant surprise is waiting for you.',
  'Trust your instincts — they will guide you well.',
  'An old friend will reconnect with you soon.',
  'Your curiosity will lead you somewhere delightful.',
];

function tellFortune() {
  var f = FORTUNES[Math.floor(Math.random() * FORTUNES.length)];
  jibo.animate.play('happy');
  jibo.tts.speak('I see your future... ' + f);
}

jibo.init('face', function (err) {
  if (err) { console.error('[fortune-teller] init failed:', err); return; }

  jibo.face.setColor('#b388ff');   // a mystical purple eye
  jibo.face.lookForward();

  setTimeout(function () {
    jibo.tts.speak('Greetings. I am the Fortune Teller. Ask me to tell your fortune!');
  }, 700);

  // Any input -> a fortune. Tapping the face also gives one.
  jibo.asr.on('speech', function (e) { if (e && e.final) tellFortune(); });
  jibo.face.gestures.addStageGesture('tap', tellFortune);
});
