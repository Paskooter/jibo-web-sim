// nlu service — fulfils jibo.nlu.parseFromRule / compile / parseFromURI.
//
// The on-device NLU is a full FST grammar parser. Full FST is out of scope
// here — this is a lightweight intent matcher that returns the same result
// shape the public API promises:
//
//   { Input: string, NLParse: object, heuristic_score: number }
//
// Rule formats accepted:
//   - string:  pipe/newline-separated alternative phrases; the best
//              token-overlap match wins, its phrase is the matched "intent".
//   - object:  { intents: { name: ["phrase one", "phrase two", ...] } };
//              returns NLParse.intent = winning name.
//
// compile()/parseFromURI() let skills precompile a rule once: compile() stores
// the rule under a generated uri handle, parseFromURI() looks it up.

const compiled = new Map();   // uri -> normalized rule
let uriSeq = 0;

function tokens(s) {
  return String(s).toLowerCase().match(/[a-z0-9']+/g) || [];
}

// Token-overlap score in [0,1]: fraction of the phrase's tokens present in input.
function scorePhrase(inputTokens, phrase) {
  const pt = tokens(phrase);
  if (!pt.length) return 0;
  const set = new Set(inputTokens);
  let hit = 0;
  for (const t of pt) if (set.has(t)) hit++;
  return hit / pt.length;
}

function normalize(rule) {
  if (rule && typeof rule === 'object') {
    const intents = rule.intents || {};
    return Object.entries(intents).map(([name, phrases]) => ({
      name, phrases: Array.isArray(phrases) ? phrases : [phrases],
    }));
  }
  // string of alternatives
  const phrases = String(rule).split(/[|\n]/).map((s) => s.trim()).filter(Boolean);
  return phrases.map((p) => ({ name: p, phrases: [p] }));
}

function parse(normRule, text) {
  const inputTokens = tokens(text);
  let best = { name: null, score: 0 };
  for (const intent of normRule) {
    for (const phrase of intent.phrases) {
      const s = scorePhrase(inputTokens, phrase);
      if (s > best.score) best = { name: intent.name, score: s };
    }
  }
  return {
    Input: text,
    NLParse: best.name ? { intent: best.name } : {},
    heuristic_score: best.score,
  };
}

export function createNluService() {
  return {
    compile(rule) {
      const uri = `rule:${++uriSeq}`;
      compiled.set(uri, normalize(rule));
      return uri;
    },
    parseFromRule(rule, text) {
      return parse(normalize(rule), text);
    },
    parseFromURI(uri, text) {
      const norm = compiled.get(uri);
      if (!norm) throw new Error(`unknown rule uri: ${uri}`);
      return parse(norm, text);
    },
  };
}
