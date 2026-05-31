// Lightweight pattern-based NLU for offline operation.
//
// jibo-be parses utterances cloud-side via the pegasus IntentRouter (an FST
// matcher built from each skill's `*/launch.rule`). When no server is
// configured, that path is unavailable and typed input does nothing. This
// module provides a synthesized fallback: regex-matched phrases produce a
// turn-result shape identical to what the cloud returns, which
// GlobalManagerService routes the same way.
//
// Scope: only ON-ROBOT @be/* skills work offline. Cloud-skill matches
// (chitchat dance/twerk, report-skill news/weather, etc.) require the
// cloud's SKILL_ACTION response carrying a full mim graph — that can't
// be synthesized locally without porting the cloud skill servers. Those
// commands are silently ignored (with a log message) when offline.
//
// The match list intentionally undershoots the cloud's coverage — better
// to leave a phrase unmatched than to route it wrong. Add patterns as
// new skills get verified to work without cloud assistance.

// Each entry: a regex (matched case-insensitive against trimmed text) +
// the intent + skillID the cloud would return.
const INTENTS = [
  // @be/clock — speaks the current time/date. Reads system clock; no cloud.
  { match: /\b(what(?:'?s| is)? (?:the )?time|tell me the time|current time)\b/i,
    intent: 'askForTime', skillID: '@be/clock' },
  { match: /\bwhat(?:'?s| is)? (?:the |today'?s )?date\b/i,
    intent: 'askForDate', skillID: '@be/clock' },

  // @be/main-menu — opens the tile grid menu.
  { match: /\b(main )?menu\b/i,
    intent: 'openMainMenu', skillID: '@be/main-menu' },
  { match: /\bshow me what you can do\b/i,
    intent: 'openMainMenu', skillID: '@be/main-menu' },

  // @be/settings — opens the settings view.
  { match: /\b(open )?settings\b/i,
    intent: 'openSettings', skillID: '@be/settings' },

  // @be/greetings — speaks a hello.
  { match: /^\s*(hi|hello|hey)( there)?( jibo)?[\s!.,?]*$/i,
    intent: 'greeting', skillID: '@be/greetings' },

  // @be/who-am-i — reads from kb.loop and identifies the current speaker.
  { match: /\b(who am i|what'?s my name|do you (know|recognize) me)\b/i,
    intent: 'whoAmI', skillID: '@be/who-am-i' },

  // @be/word-of-the-day — speaks the bundled word + definition.
  { match: /\b(word of the day|teach me a word|new word|today'?s word)\b/i,
    intent: 'wordOfTheDay', skillID: '@be/word-of-the-day' },

  // @be/friendly-tips — speaks a hint about what you can ask.
  { match: /\b(tips|friendly tips|what can i (say|ask|do))\b/i,
    intent: 'requestTips', skillID: '@be/friendly-tips' },

  // @be/exercise — exercise/stretch routine.
  { match: /\b(exercise|workout|stretch|stretches)\b/i,
    intent: 'requestExercise', skillID: '@be/exercise' },

  // @be/gallery — show photos from kb.media.
  { match: /\b(gallery|show (me )?(my |the )?photos)\b/i,
    intent: 'openGallery', skillID: '@be/gallery' },

  // @be/tutorial — how-to walkthrough.
  { match: /\b(tutorial|how do i use you|teach me how to use you)\b/i,
    intent: 'requestTutorial', skillID: '@be/tutorial' },

  // @be/introductions — speaker enrollment flow.
  { match: /\b(introduce yourself|introductions|let'?s introduce|introduce me)\b/i,
    intent: 'requestIntroductions', skillID: '@be/introductions' },

  // @be/who-am-i additional triggers
  { match: /\b(remember me|introduce me)\b/i,
    intent: 'requestIntroductions', skillID: '@be/introductions' },

  // @be/idle — go to sleep / stop attending.
  { match: /\b(go to sleep|sleep now|stop listening|nap time)\b/i,
    intent: 'sleep', skillID: '@be/idle' },
];

// Strip a leading "jibo" / "hey jibo" / "okay jibo" wake phrase so patterns
// can match cleanly. The cloud's parser does the same.
function stripWakeword(text) {
  return text.replace(/^\s*(hey |okay |ok |yo )?jibo[\s,.:;!?]*/i, '').trim();
}

// Returns a cloud-shaped TurnResult for the first matching pattern, or null.
//   { asr: {text, confidence}, nlu: {intent, entities, rules},
//     match: {skillID, launch, onRobot} }
// Mirrors what global-manager.js _onTurnResult expects to see in
// data.result when the cloud returns SUCCEEDED.
export function localParse(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  const stripped = stripWakeword(trimmed);
  const target = stripped || trimmed;
  for (const entry of INTENTS) {
    if (entry.match.test(target)) {
      return {
        asr: { text: trimmed, confidence: 1 },
        nlu: { entities: {}, intent: entry.intent, rules: ['launch'] },
        match: { skillID: entry.skillID, launch: true, onRobot: true },
      };
    }
  }
  return null;
}

// List of known intent patterns for user-facing diagnostics (e.g. so the
// chat panel could surface "try saying: ..." hints). Kept simple — one
// example phrase per registered intent.
export const KNOWN_PHRASES = [
  'what time is it', 'what\'s the date', 'menu', 'settings',
  'hello', 'who am i', 'word of the day', 'tips',
  'exercise', 'gallery', 'tutorial', 'introductions', 'go to sleep',
];
