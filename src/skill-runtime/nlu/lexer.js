// .rule DSL lexer.
//
// Tokenizes a jibo-nlu `.rule` source file into a flat token stream the
// parser walks. Covers the dialect actually used by the on-robot @be/*
// launch rules — see the cloned be/<skill>/launch.rule files for examples.
//
// Token kinds:
//   ID            — bareword identifier (rule names, rule contents)
//   RULEREF       — `$RuleName`, `$factory:name`, `$handle:name`, `$wNN`
//   STAR          — `$*` (kleene)
//   STRING        — `'literal'`
//   LBRACE/RBRACE — `{` `}` (entity-tag block)
//   LPAREN/RPAREN — `(` `)`
//   PIPE          — `|` (alternation)
//   QMARK         — `?` (optional)
//   EQ            — `=` (rule definition or entity assignment)
//   SEMI          — `;`
//   DOT           — `.` (sub-rule field access in entity tag values)
//   COLON         — `:` (factory/handle prefix separator)
//   DIRECTIVE     — `!ident = value;` (e.g. `!use_equivalent_words = true;`)
//   CHARCLASS     — `[chars?s]` (character-level pattern; rare)
//   EOF
//
// Comments: `#` to end-of-line. Section headers like `### TIME DOMAIN ###`
// also start with `#`. Both are skipped.
//
// Escapes: `\X` represents a literal `X` (used for `\@` in skill names).

export function lex(source) {
  const tokens = [];
  let i = 0;
  const N = source.length;
  let line = 1, col = 1;
  function advance(n = 1) {
    for (let k = 0; k < n; k += 1) {
      if (source.charCodeAt(i + k) === 10) { line += 1; col = 1; }
      else col += 1;
    }
    i += n;
  }
  function push(kind, value, extra) {
    const t = { kind, value, line, col };
    if (extra) Object.assign(t, extra);
    tokens.push(t);
  }
  function isIdStart(ch) { return /[A-Za-z_]/.test(ch); }
  function isIdCont(ch) { return /[A-Za-z_0-9-]/.test(ch); }
  // Literal-word start: alphas, digits (for "4th", "1980"), backslash
  // (for escaped `\@`), or an apostrophe (for words starting with quotes
  // in escape sequences — rare).
  function isWordStart(ch) { return /[A-Za-z0-9_\\]/.test(ch); }
  function isWordChar(ch) { return /[A-Za-z0-9_'\\@/.-]/.test(ch); }

  while (i < N) {
    const ch = source[i];

    // Whitespace.
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { advance(); continue; }

    // Comment to end-of-line (covers both `#` and `### section ###`).
    if (ch === '#') {
      while (i < N && source[i] !== '\n') advance();
      continue;
    }

    // Directive: `!ident = value;`. We just skip to the next `;` and
    // remember the directive name + raw value for downstream interp.
    if (ch === '!') {
      const start = i;
      advance(); // consume !
      let body = '';
      while (i < N && source[i] !== ';') { body += source[i]; advance(); }
      if (i < N) advance(); // consume ;
      push('DIRECTIVE', body.trim());
      continue;
    }

    // Rule reference / kleene / factory / handle / bounded-kleene.
    if (ch === '$') {
      advance(); // consume $
      // Kleene star
      if (source[i] === '*') { advance(); push('STAR', '*'); continue; }
      // Bounded kleene: `$wNN` (any digits after w). Treat as STAR with cap.
      if (source[i] === 'w' && /[0-9]/.test(source[i + 1] || '')) {
        advance(); // w
        let n = '';
        while (/[0-9]/.test(source[i] || '')) { n += source[i]; advance(); }
        push('STAR', 'w' + n, { max: parseInt(n, 10) });
        continue;
      }
      // Identifier (potentially with `:subname` for factory/handle).
      if (isIdStart(source[i])) {
        let name = '';
        while (i < N && isIdCont(source[i])) { name += source[i]; advance(); }
        let prefix = null;
        let subname = null;
        if (source[i] === ':') {
          advance();
          subname = '';
          while (i < N && isIdCont(source[i])) { subname += source[i]; advance(); }
          prefix = name; name = subname; subname = null;
        }
        push('RULEREF', name, prefix ? { prefix } : null);
        continue;
      }
      throw new Error(`lexer: unexpected after $ at line ${line}:${col}`);
    }

    // Quoted string.
    if (ch === "'") {
      advance();
      let s = '';
      while (i < N && source[i] !== "'") {
        if (source[i] === '\\' && i + 1 < N) { s += source[i + 1]; advance(2); }
        else { s += source[i]; advance(); }
      }
      if (i < N) advance(); // closing '
      push('STRING', s);
      continue;
    }

    // Character class `[abc?d]` — used for word variations like `[salutation?s]`
    // meaning "salutation" or "salutations". Capture the raw body; the
    // parser/matcher interprets it as `salutation | salutations`.
    if (ch === '[') {
      advance();
      let body = '';
      while (i < N && source[i] !== ']') { body += source[i]; advance(); }
      if (i < N) advance(); // ]
      push('CHARCLASS', body);
      continue;
    }

    // Punctuation.
    if (ch === '(') { advance(); push('LPAREN', '('); continue; }
    if (ch === ')') { advance(); push('RPAREN', ')'); continue; }
    if (ch === '{') { advance(); push('LBRACE', '{'); continue; }
    if (ch === '}') { advance(); push('RBRACE', '}'); continue; }
    if (ch === '|') { advance(); push('PIPE', '|'); continue; }
    if (ch === '?') { advance(); push('QMARK', '?'); continue; }
    if (ch === '=') { advance(); push('EQ', '='); continue; }
    if (ch === ';') { advance(); push('SEMI', ';'); continue; }
    // DOT is NOT emitted as a separate token — `.` is part of identifiers
    // (so `D_TIME._intent` is one ID the parser splits) and part of
    // literal words (so `u.s.a.` matches literally). The parser handles
    // splitting on `.` when reading a tag value identifier.
    if (ch === ',') { advance(); push('COMMA', ','); continue; }
    if (ch === ':') { advance(); push('COLON', ':'); continue; }

    // Weight annotation: `~N` (FST cost for the preceding alternative).
    // Irrelevant for first-match-wins semantics — skip it.
    if (ch === '~') {
      advance();
      while (/[0-9.]/.test(source[i] || '')) advance();
      continue;
    }

    // FST weight block: `<1.0>`, `<0.5>` etc. The compiler uses these to
    // score alternatives. For first-match-wins parsing we drop them.
    if (ch === '<' && /[0-9.]/.test(source[i + 1] || '')) {
      advance();
      while (i < N && source[i] !== '>') advance();
      if (i < N) advance(); // closing >
      continue;
    }

    // `+` is FST concatenation in weighted-form (equivalent to a sequence).
    // Drop standalone occurrences; sequences naturally form by adjacency.
    if (ch === '+') { advance(); continue; }

    // `@=` is an alternate rule-definition operator (subtree-macro
    // variant). We emit a regular EQ — semantics differ subtly but
    // for matching they're close enough; rules using @= tend to be
    // ifttt-style macros we don't fully execute anyway.
    if (ch === '@' && source[i + 1] === '=') {
      advance(2); push('EQ', '='); continue;
    }

    // Identifier / bareword literal. Words may contain digits (for "4th",
    // "1980"), quoted contractions like `i\'m`, escaped `@` characters
    // (`\@be/clock`), and slashes (`@be/clock`). We accumulate the run of
    // word characters AND inline `\X` escape sequences into a single ID token.
    if (isWordStart(ch)) {
      let w = '';
      while (i < N) {
        if (source[i] === '\\' && i + 1 < N) {
          w += source[i + 1]; advance(2);
          continue;
        }
        if (isWordChar(source[i])) { w += source[i]; advance(); continue; }
        break;
      }
      if (w === '') throw new Error(`lexer: empty word at line ${line}:${col}`);
      push('ID', w);
      continue;
    }

    throw new Error(`lexer: unexpected character ${JSON.stringify(ch)} at line ${line}:${col}`);
  }

  push('EOF', null);
  return tokens;
}
