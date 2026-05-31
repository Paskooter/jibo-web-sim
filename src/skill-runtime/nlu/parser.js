// .rule DSL parser. Walks the token stream from lexer.js and builds an AST
// per rule. Output: { directives: [...], rules: { name: AstNode, ... } }.
//
// AST node kinds (all `{type, ...fields, tags?}`):
//   alt    — { type:'alt', alts: AstNode[] }                — `A | B | C`
//   seq    — { type:'seq', items: AstNode[] }               — `A B C`
//   opt    — { type:'opt', item: AstNode }                  — `?A`
//   lit    — { type:'lit', word: string }                   — bareword like "time"
//   star   — { type:'star', max?: number }                  — `$*` or `$wNN`
//   ref    — { type:'ref', name, prefix?: 'factory'|'handle' }  — `$Rule`, `$factory:X`
//   class  — { type:'class', body }                         — `[salutation?s]` → 'salutation'|'salutations'
//
// Every node may carry `.tags` — an array of {key, kind:'lit'|'subfield',
// value, subRule?, subField?} entity-assignment specs that fire when the
// node matches. Tags are attached during parsing per `{key=...}` blocks
// that immediately follow an item/group.

import { lex } from './lexer.js';

export function parse(source) {
  const tokens = lex(source);
  let pos = 0;
  const peek = (k = 0) => tokens[pos + k];
  const eat = (kind) => {
    const t = tokens[pos];
    if (t.kind !== kind) throw new Error(`parser: expected ${kind} got ${t.kind} (${t.value}) at ${t.line}:${t.col}`);
    pos += 1;
    return t;
  };

  const out = { directives: [], rules: {} };

  while (peek().kind !== 'EOF') {
    if (peek().kind === 'DIRECTIVE') { out.directives.push(peek().value); pos += 1; continue; }
    // Rule: Identifier = Expression ;
    const nameTok = eat('ID');
    eat('EQ');
    const body = parseExpr();
    eat('SEMI');
    out.rules[nameTok.value] = body;
  }
  return out;

  // ---- expression grammar ----
  // The `.rule` DSL binds `|` tighter than sequence — opposite of standard
  // regex/BNF. So `do i|we|you have` parses as `do (i|we|you) have`, not
  // `(do i)|(we)|(you have)`. Patterns throughout the on-robot launch rules
  // rely on this: e.g. `(what time is|will $w03 show ?be $w03 on)` is
  // `what time (is|will) $w03 show ?be $w03 on`, and
  // `(?$V_CANYOU get|give|access)` is `?$V_CANYOU (get|give|access)`.
  // Reading these with alt < seq drops most of the meaningful match.
  //
  // Expression  = SeqExpr
  // SeqExpr     = AltItem+
  // AltItem     = Item ('|' Item)*       (alt of single items — tight binding)
  // Item        = ['?'] Atom Tags?
  // Atom        = '(' Expression ')' | RULEREF | STAR | STRING | ID | CHARCLASS
  // Tags        = '{' Tag '}' ('{' Tag '}')*
  // Tag         = ID '=' (STRING | (ID '.' ID))

  function parseExpr() { return parseSeq(); }

  function parseAlt() {
    // Tight alternation: each alt arm is a single item (with optional tags),
    // NOT a full seq. To express "loose" alt across whole sequences, the
    // author must use explicit parens: `(A B) | (C D)`.
    const left = parseItem();
    if (peek().kind !== 'PIPE') return left;
    const alts = [left];
    while (peek().kind === 'PIPE') {
      pos += 1;
      alts.push(parseItem());
    }
    return { type: 'alt', alts };
  }

  function parseSeq() {
    // Each seq element is itself an AltItem (tight `X|Y|Z` chain) so that
    // `A B|C D` parses as `A (B|C) D`, not `(A B)|(C D)`.
    const items = [];
    while (canStartItem(peek())) items.push(parseAlt());
    if (items.length === 0) throw new Error(`parser: empty sequence at ${peek().line}:${peek().col}`);
    if (items.length === 1) return items[0];
    // `(X Y {tag=X._field})` — the trailing tag block on the LAST item is
    // semantically a group tag in the cloud's FST: it fires at the end of the
    // sequence with visibility into every prior item's subFields. We model this
    // by hoisting the last item's trailing tags up to the seq node, where the
    // matcher applies them against accumulated subFields after the full match.
    // Tags on non-last items stay local (e.g. `$X {a=b} $Y`).
    const seq = { type: 'seq', items };
    const last = items[items.length - 1];
    if (last.tags && last.tags.length) {
      seq.tags = last.tags;
      delete last.tags;
    }
    return seq;
  }
  function canStartItem(t) {
    return t.kind === 'ID' || t.kind === 'STRING' || t.kind === 'LPAREN' ||
           t.kind === 'RULEREF' || t.kind === 'STAR' || t.kind === 'CHARCLASS' ||
           t.kind === 'QMARK';
  }

  function parseItem() {
    let optional = false;
    if (peek().kind === 'QMARK') { pos += 1; optional = true; }
    const atom = parseAtom();
    // Consume any consecutive entity-tag blocks attached to this item.
    const tags = [];
    while (peek().kind === 'LBRACE') tags.push(...parseTagBlock());
    if (tags.length) atom.tags = (atom.tags || []).concat(tags);
    return optional ? { type: 'opt', item: atom } : atom;
  }

  function parseAtom() {
    const t = peek();
    if (t.kind === 'LPAREN') {
      pos += 1;
      const e = parseExpr();
      eat('RPAREN');
      return e;
    }
    if (t.kind === 'RULEREF') {
      pos += 1;
      return t.prefix
        ? { type: 'ref', name: t.value, prefix: t.prefix }
        : { type: 'ref', name: t.value };
    }
    if (t.kind === 'STAR') { pos += 1; return t.max != null ? { type: 'star', max: t.max } : { type: 'star' }; }
    if (t.kind === 'STRING') { pos += 1; return { type: 'lit', word: t.value }; }
    if (t.kind === 'ID') { pos += 1; return { type: 'lit', word: t.value }; }
    if (t.kind === 'CHARCLASS') { pos += 1; return { type: 'class', body: t.value }; }
    throw new Error(`parser: unexpected ${t.kind} (${t.value}) at ${t.line}:${t.col}`);
  }

  // `{key=value}{key2=value2}` — one tag-block per call, returns the list
  // of `{key,...}` specs (one block can hold multiple key=value pairs in
  // some dialects; the on-robot rules consistently use one pair per block).
  // `op` distinguishes `=` (set) from `+=` (append). Append concatenates the
  // value onto whatever the key already holds in the same scope (private
  // subFields or public entities), matching standard tag semantics.
  function parseTagBlock() {
    eat('LBRACE');
    const tags = [];
    while (peek().kind !== 'RBRACE') {
      const key = eat('ID').value;
      let op = 'set';
      if (peek().kind === 'PLUSEQ') { pos += 1; op = 'append'; }
      else eat('EQ');
      // Value: STRING ('quoted'), or `SubRule._field` reference (single
      // ID token with embedded `.`, the lexer doesn't break on dots — we
      // split here). Tolerate either form.
      if (peek().kind === 'STRING') {
        tags.push({ key, op, kind: 'lit', value: eat('STRING').value });
      } else if (peek().kind === 'ID') {
        const raw = eat('ID').value;
        const dot = raw.indexOf('.');
        if (dot >= 0) {
          tags.push({ key, op, kind: 'subfield', subRule: raw.slice(0, dot), subField: raw.slice(dot + 1) });
        } else {
          // Bare identifier as a value — treat as a literal string (rare).
          tags.push({ key, op, kind: 'lit', value: raw });
        }
      } else {
        throw new Error(`parser: tag value expected at ${peek().line}:${peek().col}`);
      }
      if (peek().kind === 'COMMA') pos += 1;     // tolerate `{a=1,b=2}` if it ever appears
    }
    eat('RBRACE');
    return tags;
  }
}
