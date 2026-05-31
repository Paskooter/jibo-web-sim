// .rule AST matcher.
//
// Generator-based backtracking walk of the AST built by parser.js. Yields
// each possible parse position the AST can reach starting from a given
// input position, so the caller can pick the first/longest/highest-priority
// match. For our purposes the FIRST successful end-of-input parse wins —
// matching the cloud's first-match-wins behaviour on the intent-router side.
//
// Each yielded result is { end: number, entities: object, subFields: object }:
//   end       — input position after the match
//   entities  — entity tags collected (the parent skill reads from .entities)
//   subFields — `_field` private tags exposed back to the parent for
//               sub-rule field reads (e.g. {key=Sub._field} on the parent
//               picks up `_field` from the sub-rule's subFields).
//
// The matcher takes a `ctx` with:
//   rules        — { ruleName: AstNode }   the rule registry (from parser.js)
//   tokens       — string[]                 lowercased + tokenized input
//   factoryHook  — optional (name) => AstNode|null for $factory:NAME refs;
//                  returns null to treat as `$*` (any words)
//   handleHook   — same idea for $handle:NAME refs (e.g. crew names)
//   maxDepth     — safeguard against runaway recursion (default 200)

const EMPTY = Object.freeze({});

function freshEnts(prev) { return Object.assign({}, prev); }

// Tokenize an input string into lowercased word tokens. Matches the
// cloud's tokenization closely enough — strip punctuation, split on
// whitespace, lowercase. Contractions get split on apostrophe to mirror
// the cloud which sees `i'm` as `i 'm` or `i'm` per its tokenizer; we
// keep them whole and let rules handle `i\'m` literals as one token.
export function tokenize(text) {
  if (!text) return [];
  // Strip apostrophes: typed input frequently lacks them ("whats" vs "what's"),
  // and ASR transcripts vary. Comparing both sides apostrophe-free in `lit`
  // matching makes `what's` in the rule and "whats" in the input equivalent.
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[.,!?;:]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}
// Same strip applied to rule lits so they compare equal to tokenized input.
function _norm(s) { return String(s).toLowerCase().replace(/['’]/g, ''); }

// Apply tag specs (from a node's .tags) against a sub-match's subFields,
// producing entity updates for the parent. `lit` tags drop their value as-is;
// `subfield` tags read SubRule._field from `subFields`. `op` is 'set' (the
// `=` operator, overwriting) or 'append' (the `+=` operator, concatenating
// to whatever the same key already holds in this scope). Append is how
// on-robot rules compose mim ids from a prefix plus the matched entity name.
function applyTags(tags, prevEntities, prevSubFields, subFields) {
  if (!tags || tags.length === 0) return { entities: prevEntities, subFields: prevSubFields };
  const ent = freshEnts(prevEntities);
  const sub = freshEnts(prevSubFields);
  for (const tag of tags) {
    let val;
    if (tag.kind === 'lit') val = tag.value;
    else val = (subFields[tag.subRule] && subFields[tag.subRule][tag.subField]) || (subFields[tag.subField] !== undefined ? subFields[tag.subField] : undefined);
    if (val === undefined) continue;
    // Keys starting with `_` are private to the rule — they propagate to the
    // parent via subFields, NOT into the public entities map.
    const target = tag.key.startsWith('_') ? sub : ent;
    if (tag.op === 'append') {
      const prev = target[tag.key];
      target[tag.key] = (prev === undefined ? '' : String(prev)) + String(val);
    } else {
      target[tag.key] = val;
    }
  }
  return { entities: ent, subFields: sub };
}

// Generator: yield {end, entities, subFields} for each successful match
// of `node` starting at `start` in `ctx.tokens`. Recursive via rule refs.
function* match(node, start, ctx, depth) {
  if (depth > (ctx.maxDepth || 200)) return;
  const { tokens } = ctx;

  switch (node.type) {
    case 'lit': {
      // Lowercased + apostrophe-stripped equality (see tokenize/_norm).
      // specificity: 1 — a literal token in the rule counts toward specificity,
      // which the registry uses to break ties between candidate skills.
      if (start < tokens.length && tokens[start] === _norm(node.word)) {
        const ent = freshEnts(EMPTY); const sub = freshEnts(EMPTY);
        const tagged = applyTags(node.tags, ent, sub, { /* no sub */ });
        yield { end: start + 1, entities: tagged.entities, subFields: tagged.subFields, specificity: 1 };
      }
      return;
    }
    case 'class': {
      // `[salutation?s]` → "salutation" or "salutations" (the `?` makes the
      // suffix optional). Generalized: parse body into a base + optional
      // suffix groups separated by `?`. Match the produced word(s) against
      // the next input token.
      const variants = expandCharClass(node.body);
      for (const v of variants) {
        if (start < tokens.length && tokens[start] === _norm(v)) {
          const tagged = applyTags(node.tags, EMPTY, EMPTY, {});
          yield { end: start + 1, entities: tagged.entities, subFields: tagged.subFields, specificity: 1 };
        }
      }
      return;
    }
    case 'star': {
      // Kleene-star: yield 0..N word matches. `max` caps the count (for `$wNN`);
      // unbounded otherwise. Yield SHORTEST first (lazy) so callers favour
      // tight matches; alternatives like `?a` after `$*` then naturally fill
      // in. Without lazy, `$*` eagerly grabs everything and adjacent literals
      // never match.
      // specificity: 0 — star matches don't count, so longest-match across
      // skills picks the rule that's filled with literal content, not the one
      // that wraps a single literal in `$* X $*`.
      const maxN = (typeof node.max === 'number') ? node.max : (tokens.length - start);
      for (let n = 0; n <= maxN; n += 1) {
        if (start + n > tokens.length) break;
        const tagged = applyTags(node.tags, EMPTY, EMPTY, {});
        yield { end: start + n, entities: tagged.entities, subFields: tagged.subFields, specificity: 0 };
      }
      return;
    }
    case 'opt': {
      // Try zero-match first, then a real match. (Zero-match keeps parent
      // pos at `start` with no entity updates.)
      yield { end: start, entities: EMPTY, subFields: EMPTY, specificity: 0 };
      for (const m of match(node.item, start, ctx, depth + 1)) {
        const tagged = applyTags(node.tags, m.entities, m.subFields, m.subFields);
        yield { end: m.end, entities: tagged.entities, subFields: tagged.subFields, specificity: m.specificity || 0 };
      }
      return;
    }
    case 'seq': {
      // Match each item in order, backtracking on failure of later items.
      // Apply seq-level tags (hoisted from the trailing `(X Y {tag})` block
      // by the parser) AFTER the full sequence has matched, with visibility
      // into all accumulated subFields — that's how `{intent=Sub._field}`
      // group tags work in the cloud's compiler.
      for (const m of matchSeq(node.items, 0, start, EMPTY, EMPTY, 0, ctx, depth)) {
        const tagged = applyTags(node.tags, m.entities, m.subFields, m.subFields);
        yield { end: m.end, entities: tagged.entities, subFields: tagged.subFields, specificity: m.specificity || 0 };
      }
      return;
    }
    case 'alt': {
      // Try each alternative in order; yield matches from each.
      for (const a of node.alts) {
        for (const m of match(a, start, ctx, depth + 1)) {
          const tagged = applyTags(node.tags, m.entities, m.subFields, m.subFields);
          yield { end: m.end, entities: tagged.entities, subFields: tagged.subFields, specificity: m.specificity || 0 };
        }
      }
      return;
    }
    case 'ref': {
      let target = null;
      // Factory / handle references: ask the host hooks; otherwise treat
      // as a wildcard so the parse can continue (and the entity tag that
      // references the sub-rule's field gets `null` since there's no sub).
      if (node.prefix === 'factory') {
        target = ctx.factoryHook ? ctx.factoryHook(node.name) : null;
      } else if (node.prefix === 'handle') {
        target = ctx.handleHook ? ctx.handleHook(node.name) : null;
      } else {
        target = ctx.rules[node.name];
      }
      if (!target) {
        // Fallback: match 1..3 words greedily (factory slots typically span
        // a short noun phrase). The lit-vs-subfield tag eval handles missing
        // values gracefully (undefined → not set). specificity: 0 because we
        // didn't actually verify factory content — counted as a wildcard.
        for (let n = 1; n <= 3; n += 1) {
          if (start + n > tokens.length) break;
          const tagged = applyTags(node.tags, EMPTY, EMPTY, { [node.name]: { /* no fields */ } });
          yield { end: start + n, entities: tagged.entities, subFields: tagged.subFields, specificity: 0 };
        }
        // Also try zero-match (factory might be optional in context).
        const tagged0 = applyTags(node.tags, EMPTY, EMPTY, { [node.name]: {} });
        yield { end: start, entities: tagged0.entities, subFields: tagged0.subFields, specificity: 0 };
        return;
      }
      // Real ref: match the sub-rule, then expose its subFields to our tags
      // under the sub-rule's name (so `{key=SubRule._field}` works on this
      // ref's own tags). Also merge that namespace INTO the returned subFields
      // so an enclosing seq's group-level tag can later read `SubRule._field`
      // — the matchSeq accumulator will carry the namespaced map up.
      for (const m of match(target, start, ctx, depth + 1)) {
        const exposed = { [node.name]: m.subFields };
        const tagged = applyTags(node.tags, m.entities, m.subFields, exposed);
        const subsForParent = Object.assign({}, tagged.subFields, exposed);
        yield { end: m.end, entities: tagged.entities, subFields: subsForParent, specificity: m.specificity || 0 };
      }
      return;
    }
    default:
      return;
  }
}

// Sequence helper — recursively threads through each item, accumulating
// entities + subFields. Yields on full completion of the sequence.
// Specificity sums across items so a seq of literals out-scores a seq with
// the same overall length but more wildcard kleene/factory slots.
function* matchSeq(items, idx, pos, ents, subs, specSoFar, ctx, depth) {
  if (idx >= items.length) {
    yield { end: pos, entities: ents, subFields: subs, specificity: specSoFar };
    return;
  }
  for (const m of match(items[idx], pos, ctx, depth + 1)) {
    const nextEnts = mergeObj(ents, m.entities);
    const nextSubs = mergeObj(subs, m.subFields);
    yield* matchSeq(items, idx + 1, m.end, nextEnts, nextSubs, specSoFar + (m.specificity || 0), ctx, depth + 1);
  }
}
function mergeObj(a, b) {
  if (!a || !Object.keys(a).length) return b;
  if (!b || !Object.keys(b).length) return a;
  return Object.assign({}, a, b);
}

// Expand a char-class body into all literal word variants. The char-class
// body accepts the same constructs as the outer rule grammar — concatenation,
// `|` alternation, `?X` optionals, `(...)` grouping — applied
// character-by-character with no inter-token space. So:
//   `[salutation?s]`   → ['salutation', 'salutations']
//   `[danc(e|(ing))]`  → ['dance', 'dancing']
//   `[do?(ing)]`       → ['do', 'doing']
//   `[is?(n\'t)]`      → ['is', "isn't"]
//   `[ha(s|(ve))?(n\'t)]` → ['has','have',"hasn't","haven't"]
// Implementation: recursive descent over the body that returns the full set
// of strings each subexpression can produce. Cross-products on concatenation,
// union on `|`, `['', X]` on `?X`.
function expandCharClass(body) {
  let pos = 0;
  function parseAlt() {
    const out = [...parseSeq()];
    while (pos < body.length && body[pos] === '|') {
      pos += 1;
      out.push(...parseSeq());
    }
    return out;
  }
  function parseSeq() {
    let acc = [''];
    while (pos < body.length && body[pos] !== '|' && body[pos] !== ')') {
      const part = parseItem();
      if (!part.length) continue;
      const next = [];
      for (const a of acc) for (const b of part) next.push(a + b);
      acc = next;
    }
    return acc;
  }
  function parseItem() {
    if (body[pos] === '?') {
      pos += 1;
      const sub = parseAtom();
      return ['', ...sub];
    }
    return parseAtom();
  }
  function parseAtom() {
    if (body[pos] === '(') {
      pos += 1;
      const r = parseAlt();
      if (body[pos] === ')') pos += 1;
      return r;
    }
    let s = '';
    while (pos < body.length && !/[?()|]/.test(body[pos])) {
      if (body[pos] === '\\' && pos + 1 < body.length) { s += body[pos + 1]; pos += 2; continue; }
      s += body[pos]; pos += 1;
    }
    return [s];
  }
  return parseAlt();
}

// Public: try to match a TopRule against the input tokens. Returns the BEST
// full-input match — highest specificity (sum of literal/class tokens matched
// along the path). On ties, returns the first one discovered, mirroring the
// cloud's first-best behaviour. Returns null when no full match exists.
export function matchRule(node, tokens, ctx) {
  const fullCtx = Object.assign({ tokens, rules: ctx.rules || {}, maxDepth: 250 }, ctx);
  let best = null;
  for (const m of match(node, 0, fullCtx, 0)) {
    if (m.end !== tokens.length) continue;
    const spec = m.specificity || 0;
    if (!best || spec > best.specificity) {
      best = { entities: m.entities, subFields: m.subFields, specificity: spec };
    }
  }
  return best;
}
