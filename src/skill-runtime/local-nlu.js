// Lightweight pattern-based NLU for offline operation.
//
// The bundle parses utterances cloud-side via an FST matcher built from each
// skill's launch rule. When no server is configured, that path is unavailable
// and typed input does nothing. This module provides a synthesized fallback:
// regex-matched phrases produce a turn-result shape identical to what the
// cloud returns, which the global manager routes the same way.
//
// Scope: only on-robot skills work offline. Cloud-skill matches (chitchat
// dance/twerk, report-skill news/weather, etc.) require the cloud's
// SKILL_ACTION response carrying a full mim graph — that can't be
// synthesized locally without porting the cloud skill servers. Those
// commands are silently ignored (with a log message) when offline.

// Per-skill entity expectations — what each on-robot skill reads from
// nlu.entities to drive its sub-skill / state-machine dispatch. Entries
// that omit a field default to the string "null" (per the cloud's
// convention — skills check `entities.X !== "null"`, NOT `entities.X != null`).
//
// Common default-null entity fields (so any skill that reads them without
// the cloud setting them gets the expected sentinel string rather than
// crashing). Every "is the entity set" check in the on-robot clock skill
// compares to the literal "null" string.
const COMMON_NULL_ENTITIES = {
  city: 'null',
  state: 'null',
  country: 'null',
  day_of_week: 'null',
  loopMemberReferent: 'null',
  loopmember: 'null',
  holiday: 'null',
  hours: 'null',
  minutes: 'null',
  seconds: 'null',
  time: 'null',
  ampm: 'null',
  date: 'null',
};

// Each entry: regex + intent + skillID + entities. The entities object is
// merged on top of COMMON_NULL_ENTITIES so per-intent fields override the
// defaults and unspecified fields get "null".
const INTENTS = [
  // Clock — speaks the current time/date/day. Reads system clock; no cloud.
  // The skill switches on entities.domain first, then nlu.intent.
  { match: /\b(what(?:'?s| is)? (?:the )?time|tell me the time|current time)\b/i,
    intent: 'askForTime', skillID: '@be/clock',
    entities: { domain: 'clock' } },
  { match: /\bwhat(?:'?s| is)? (?:the |today'?s )?date\b/i,
    intent: 'askForDate', skillID: '@be/clock',
    entities: { domain: 'clock' } },
  { match: /\bwhat day (is it|of the week is it|are we on)\b/i,
    intent: 'askForDay', skillID: '@be/clock',
    entities: { domain: 'clock' } },
  { match: /\bclock( menu)?\b/i,
    intent: 'menu', skillID: '@be/clock',
    entities: { domain: 'clock' } },

  // Main menu — opens the tile grid menu.
  { match: /\b(main )?menu\b/i,
    intent: 'openMainMenu', skillID: '@be/main-menu',
    entities: { domain: 'main-menu' } },
  { match: /\bshow me what you can do\b/i,
    intent: 'openMainMenu', skillID: '@be/main-menu',
    entities: { domain: 'main-menu' } },

  // Settings — opens the settings view.
  { match: /\b(open )?settings\b/i,
    intent: 'openSettings', skillID: '@be/settings',
    entities: { domain: 'settings' } },

  // Greetings — speaks a hello.
  { match: /^\s*(hi|hello|hey)( there)?( jibo)?[\s!.,?]*$/i,
    intent: 'greeting', skillID: '@be/greetings',
    entities: { domain: 'greetings' } },

  // Who am I — reads from kb.loop, identifies the current speaker.
  { match: /\b(who am i|what'?s my name|do you (know|recognize) me)\b/i,
    intent: 'whoAmI', skillID: '@be/who-am-i',
    entities: { domain: 'who-am-i' } },

  // Word of the day — speaks the bundled word + definition.
  { match: /\b(word of the day|teach me a word|new word|today'?s word)\b/i,
    intent: 'wordOfTheDay', skillID: '@be/word-of-the-day',
    entities: { domain: 'word-of-the-day' } },

  // Friendly tips — speaks a hint about what you can ask.
  { match: /\b(tips|friendly tips|what can i (say|ask|do))\b/i,
    intent: 'requestTips', skillID: '@be/friendly-tips',
    entities: { domain: 'friendly-tips' } },

  // Exercise — exercise/stretch routine.
  { match: /\b(exercise|workout|stretch|stretches)\b/i,
    intent: 'requestExercise', skillID: '@be/exercise',
    entities: { domain: 'exercise' } },

  // Gallery — show photos from kb.media.
  { match: /\b(gallery|show (me )?(my |the )?photos)\b/i,
    intent: 'openGallery', skillID: '@be/gallery',
    entities: { domain: 'gallery' } },

  // Tutorial — how-to walkthrough.
  { match: /\b(tutorial|how do i use you|teach me how to use you)\b/i,
    intent: 'requestTutorial', skillID: '@be/tutorial',
    entities: { domain: 'tutorial' } },

  // Introductions — speaker enrollment flow.
  { match: /\b(introduce yourself|introductions|let'?s introduce|introduce me|remember me)\b/i,
    intent: 'requestIntroductions', skillID: '@be/introductions',
    entities: { domain: 'introductions' } },

  // Idle — go to sleep / stop attending.
  { match: /\b(go to sleep|sleep now|stop listening|nap time)\b/i,
    intent: 'sleep', skillID: '@be/idle',
    entities: { domain: 'idle' } },
];

// Strip a leading "jibo" / "hey jibo" / "okay jibo" wake phrase so patterns
// can match cleanly. The cloud's parser does the same.
function stripWakeword(text) {
  return text.replace(/^\s*(hey |okay |ok |yo )?jibo[\s,.:;!?]*/i, '').trim();
}

// Returns a cloud-shaped TurnResult for the first matching pattern, or null.
//   { asr: {text, confidence}, nlu: {intent, entities, rules},
//     match: {skillID, launch, onRobot} }
// Mirrors what the global manager's turn-result handler expects in data.result
// when the cloud returns SUCCEEDED. The entities object includes
// COMMON_NULL_ENTITIES merged with the intent-specific entities so every field
// the consuming skill might read (`entities.city !== "null"` etc.) sees the
// expected sentinel.
export function localParse(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  const stripped = stripWakeword(trimmed);
  const target = stripped || trimmed;
  for (const entry of INTENTS) {
    if (entry.match.test(target)) {
      const entities = Object.assign({}, COMMON_NULL_ENTITIES, entry.entities || {});
      // NLParse + Input — same reason as in nlu/index.js. A few on-robot
      // skills read these directly off the result; without them, the init
      // state crashes on `valenceImpact` and hangs the bundle.
      const NLParse = Object.assign({}, entities, {
        intent: entry.intent,
        mimId: entities.mimId || '',
        valenceImpact: 0,
        confidenceImpact: 0,
        questionType: entities.questionType || 'null',
        loopmember: null,
        domain: entities.domain || '',
      });
      return {
        asr: { text: trimmed, confidence: 1 },
        nlu: { entities, intent: entry.intent, rules: ['launch'] },
        match: { skillID: entry.skillID, launch: true, onRobot: true },
        NLParse,
        Input: trimmed,
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
