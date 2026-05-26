// Hand-written Hello World skill (classic script — `jibo` is a global provided
// by the skill runtime, as on a real robot). A minimal precursor to M5's full
// generated bundle; it exercises jibo.init, jibo.face, and jibo.tts.

jibo.init('face', (err) => {
  if (err) { console.error('[hello-world] init failed:', err); return; }

  jibo.face.setColor('#4ec9ff');
  jibo.face.lookForward();

  setTimeout(() => {
    jibo.tts.speak("Hello! I'm Jibo, running entirely in your browser.", (e) => {
      if (e) return;
      jibo.face.blink();
      jibo.face.lookAt(0.4, -0.2);
      jibo.tts.speak("The face you see is projected onto my screen in 3D.", () => {
        jibo.face.lookForward();
      });
    });
  }, 700);
});
