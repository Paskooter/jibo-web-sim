// .rule AST matcher.
//
// Generator-based backtracking walk of the AST built by parser.js. Yields
// each possible parse position the AST can reach starting from a given
// input position, so the caller can pick the first/longest/highest-priority
// match. For our purposes the FIRST successful end-of-input parse wins —
// matching the cloud's first-match-wins behaviour on the IntentRouter side.
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
  return text
    .toLowerCase()
    .replace(/[.,!?;:]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// Apply tag specs (from a node's .tags) against a sub-match's subFields,
// producing entity updates for the parent. `lit` tags drop their value as-is;
// `subfield` tags read SubRule._field from `subFields`.
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
    if (tag.key.startsWith('_')) sub[tag.key] = val;
    else ent[tag.key] = val;
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
      // Lowercased equality. Word may contain escapes / `'` / `@` etc.
      if (start < tokens.length && tokens[start] === node.word.toLowerCase()) {
        const ent = freshEnts(EMPTY); const sub = freshEnts(EMPTY);
        const tagged = applyTags(node.tags, ent, sub, { /* no sub */ });
        yield { end: start + 1, entities: tagged.entities, subFields: tagged.subFields };
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
        if (start < tokens.length && tokens[start] === v.toLowerCase()) {
          const tagged = applyTags(node.tags, EMPTY, EMPTY, {});
          yield { end: start + 1, entities: tagged.entities, subFields: tagged.subFields };
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
      const maxN = (typeof node.max === 'number') ? node.max : (tokens.length - start);
      for (let n = 0; n <= maxN; n += 1) {
        if (start + n > tokens.length) break;
        const tagged = applyTags(node.tags, EMPTY, EMPTY, {});
        yield { end: start + n, entities: tagged.entities, subFields: tagged.subFields };
      }
      return;
    }
    case 'opt': {
      // Try zero-match first, then a real match. (Zero-match keeps parent
      // pos at `start` with no entity updates.)
      yield { end: start, entities: EMPTY, subFields: EMPTY };
      for (const m of match(node.item, start, ctx, depth + 1)) {
        const tagged = applyTags(node.tags, m.entities, m.subFields, m.subFields);
        yield { end: m.end, entities: tagged.entities, subFields: tagged.subFields };
      }
      return;
    }
    case 'seq': {
      // Match each item in order. Generator-yielding so we backtrack on
      // failure of later items.
      yield* matchSeq(node.items, 0, start, EMPTY, EMPTY, ctx, depth);
      // After full sequence, apply seq-level tags too (rare — typically
      // tags hang off the inner items).
      // Handled inside matchSeq via the seq's own tags? — we'd attach to
      // the outermost group instead. Skip here.
      return;
    }
    case 'alt': {
      // Try each alternative in order; yield matches from each.
      for (const a of node.alts) {
        for (const m of match(a, start, ctx, depth + 1)) {
          const tagged = applyTags(node.tags, m.entities, m.subFields, m.subFields);
          yield { end: m.end, entities: tagged.entities, subFields: tagged.subFields };
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
        // values gracefully (undefined → not set).
        for (let n = 1; n <= 3; n += 1) {
          if (start + n > tokens.length) break;
          const tagged = applyTags(node.tags, EMPTY, EMPTY, { [node.name]: { /* no fields */ } });
          yield { end: start + n, entities: tagged.entities, subFields: tagged.subFields };
        }
        // Also try zero-match (factory might be optional in context).
        const tagged0 = applyTags(node.tags, EMPTY, EMPTY, { [node.name]: {} });
        yield { end: start, entities: tagged0.entities, subFields: tagged0.subFields };
        return;
      }
      // Real ref: match the sub-rule, then expose its subFields to our tags
      // under the sub-rule's name (so `{key=SubRule._field}` works).
      for (const m of match(target, start, ctx, depth + 1)) {
        const exposed = { [node.name]: m.subFields };
        const tagged = applyTags(node.tags, m.entities, m.subFields, exposed);
        yield { end: m.end, entities: tagged.entities, subFields: tagged.subFields };
      }
      return;
    }
    default:
      return;
  }
}

// Sequence helper — recursively threads through each item, accumulating
// entities + subFields. Yields on full completion of the sequence.
function* matchSeq(items, idx, pos, ents, subs, ctx, depth) {
  if (idx >= items.length) {
    yield { end: pos, entities: ents, subFields: subs };
    return;
  }
  for (const m of match(items[idx], pos, ctx, depth + 1)) {
    const nextEnts = mergeObj(ents, m.entities);
    const nextSubs = mergeObj(subs, m.subFields);
    yield* matchSeq(items, idx + 1, m.end, nextEnts, nextSubs, ctx, depth + 1);
  }
}
function mergeObj(a, b) {
  if (!a || !Object.keys(a).length) return b;
  if (!b || !Object.keys(b).length) return a;
  return Object.assign({}, a, b);
}

// Expand `[stem?suffix?suffix2]` into [stem, stem+suffix, stem+suffix+suffix2].
// `[salutation?s]` → ['salutation', 'salutations'].
// `[the?atre?atre]` → ['the','theatre','theatreatre'] (silly example).
// Each `?X` adds an optional suffix the matcher considers as a variant.
function expandCharClass(body) {
  const parts = body.split('?');
  const out = [parts[0]];
  let acc = parts[0];
  for (let i = 1; i < parts.length; i += 1) {
    acc += parts[i];
    out.push(acc);
  }
  return out;
}

// Public: try to match a TopRule (or any starting node) against the input
// tokens. Returns the first full-input match's {entities, subFields}, or
// null if no rule consumes everything plus the TopRule pattern allows
// the `$*`-wraps to slack against extra surrounding words.
export function matchRule(node, tokens, ctx) {
  const fullCtx = Object.assign({ tokens, rules: ctx.rules || {}, maxDepth: 250 }, ctx);
  for (const m of match(node, 0, fullCtx, 0)) {
    if (m.end === tokens.length) return { entities: m.entities, subFields: m.subFields };
  }
  return null;
}
