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
  // Expression  = AltExpr
  // AltExpr     = SeqExpr ('|' SeqExpr)*
  // SeqExpr     = Item+
  // Item        = ['?'] Atom Tags?
  // Atom        = '(' Expression ')' | RULEREF | STAR | STRING | ID | CHARCLASS
  // Tags        = '{' Tag '}' ('{' Tag '}')*   (consecutive {key=val} blocks)
  // Tag         = ID '=' (STRING | (ID '.' ID))

  function parseExpr() { return parseAlt(); }

  function parseAlt() {
    const left = parseSeq();
    if (peek().kind !== 'PIPE') return left;
    const alts = [left];
    while (peek().kind === 'PIPE') {
      pos += 1;
      alts.push(parseSeq());
    }
    return { type: 'alt', alts };
  }

  function parseSeq() {
    const items = [];
    while (canStartItem(peek())) items.push(parseItem());
    if (items.length === 0) throw new Error(`parser: empty sequence at ${peek().line}:${peek().col}`);
    if (items.length === 1) return items[0];
    return { type: 'seq', items };
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
  function parseTagBlock() {
    eat('LBRACE');
    const tags = [];
    while (peek().kind !== 'RBRACE') {
      const key = eat('ID').value;
      eat('EQ');
      // Value: STRING ('quoted'), or `SubRule._field` reference (single
      // ID token with embedded `.`, the lexer doesn't break on dots — we
      // split here). Tolerate either form.
      if (peek().kind === 'STRING') {
        tags.push({ key, kind: 'lit', value: eat('STRING').value });
      } else if (peek().kind === 'ID') {
        const raw = eat('ID').value;
        const dot = raw.indexOf('.');
        if (dot >= 0) {
          tags.push({ key, kind: 'subfield', subRule: raw.slice(0, dot), subField: raw.slice(dot + 1) });
        } else {
          // Bare identifier as a value — treat as a literal string (rare).
          tags.push({ key, kind: 'lit', value: raw });
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
