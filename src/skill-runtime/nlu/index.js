// Public NLU registry + parse entrypoint.
//
// Usage:
//   import { createRegistry } from './nlu/index.js';
//   const reg = createRegistry();
//   await reg.loadSkill('@be/clock', '/path/or/url/to/launch.rule');
//   await reg.loadSkill('@be/main-menu', ...);
//   const result = reg.parse('what time is it');
//   //  → { asr, nlu:{intent,entities,rules}, match:{skillID, launch, onRobot} }
//
// The returned object matches the cloud's IntentRouter shape so
// GlobalManagerService._onTurnResult can be fed directly. If no rule
// matches, returns null (caller falls back to local-nlu.js regex matcher).

import { parse as parseRules } from './parser.js';
import { matchRule, tokenize } from './matcher.js';

export function createRegistry() {
  // Per-skill loaded data: { skillID: { rules: {ruleName: AstNode}, topRuleName: string } }.
  // topRuleName is whatever the rule file declared first (typically 'TopRule').
  const skills = [];

  async function loadSkill(skillID, ruleSourceOrUrl, opts = {}) {
    let source = ruleSourceOrUrl;
    if (/^https?:|^\//.test(ruleSourceOrUrl)) {
      const r = await fetch(ruleSourceOrUrl);
      if (!r.ok) throw new Error(`loadSkill ${skillID}: HTTP ${r.status} ${ruleSourceOrUrl}`);
      source = await r.text();
    }
    const ast = parseRules(source);
    // First rule defined is the entry point (the `.rule` files all start
    // with `TopRule = ...;` per convention; we don't hardcode the name in
    // case some skill uses a different one).
    const ruleNames = Object.keys(ast.rules);
    const topRuleName = ast.rules.TopRule ? 'TopRule' : ruleNames[0];
    if (!topRuleName) throw new Error(`loadSkill ${skillID}: no rules in source`);
    skills.push({
      skillID,
      onRobot: opts.onRobot !== false,        // default true; pass {onRobot:false} for cloud-only routing
      rules: ast.rules,
      topRule: ast.rules[topRuleName],
      directives: ast.directives,
    });
  }

  function parse(text) {
    const tokens = tokenize(text);
    if (tokens.length === 0) return null;
    // Score every skill's best full-input match and pick the most specific
    // overall — a clock rule like `what time is it` beats a friendly-tips rule
    // shaped as `$* do $*` because the former matches 4 literal tokens vs the
    // latter's 1. On ties, earlier-registered skills win.
    let winner = null;
    for (const skill of skills) {
      const m = matchRule(skill.topRule, tokens, { rules: skill.rules });
      if (!m) continue;
      const spec = m.specificity || 0;
      if (!winner || spec > winner.specificity) winner = { skill, m, specificity: spec };
    }
    if (!winner) return null;
    const ent = winner.m.entities || {};
    return {
      asr: { text, confidence: 1 },
      nlu: {
        entities: ent,
        intent: ent.intent || ent.action || '',
        rules: ['launch'],
      },
      match: {
        skillID: ent.skill || winner.skill.skillID,
        launch: true,
        onRobot: winner.skill.onRobot,
        cloudSkill: ent.cloudSkill,
      },
    };
  }

  return { loadSkill, parse, _skills: skills };
}
