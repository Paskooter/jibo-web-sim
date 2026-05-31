// Public NLU registry + parse entrypoint.
//
// Usage:
//   import { createRegistry } from './nlu/index.js';
//   const reg = createRegistry();
//   await reg.loadSkill('clock', '/path/or/url/to/launch.rule');
//   await reg.loadSkill('main-menu', ...);
//   const result = reg.parse('what time is it');
//   //  → { asr, nlu:{intent,entities,rules}, match:{skillID, launch, onRobot} }
//
// The returned object matches the cloud's intent-router shape so the global
// manager's turn-result handler can be fed directly. If no rule matches,
// returns null (caller falls back to local-nlu.js regex matcher).

import { parse as parseRules } from './parser.js';
import { matchRule, tokenize } from './matcher.js';

export function createRegistry() {
  // Per-skill loaded data: { skillID: { rules: {ruleName: AstNode}, topRuleName: string } }.
  // topRuleName is whatever the rule file declared first (typically 'TopRule').
  const skills = [];
  // Loaded factory grammars: name -> { rules, topRule }. Used by matcher's
  // factoryHook to expand `$factory:NAME` against real grammar instead of the
  // 1-3-word wildcard fallback. Factory names match the file basename (e.g.
  // `yes_no.grm` registers as `yes_no`, matched by `$factory:yes_no`).
  const factories = {};

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

  // Load a factory grammar (yes_no.grm, date.grm, etc.) so `$factory:NAME`
  // refs in skill rules match real content instead of falling back to wildcards.
  // Factory grammars are the same .rule DSL.
  async function loadFactory(name, sourceOrUrl) {
    let source = sourceOrUrl;
    if (/^https?:|^\//.test(sourceOrUrl)) {
      const r = await fetch(sourceOrUrl);
      if (!r.ok) throw new Error(`loadFactory ${name}: HTTP ${r.status} ${sourceOrUrl}`);
      source = await r.text();
    }
    const ast = parseRules(source);
    const ruleNames = Object.keys(ast.rules);
    const topRuleName = ast.rules.TopRule ? 'TopRule' : ruleNames[0];
    if (!topRuleName) throw new Error(`loadFactory ${name}: no rules in source`);
    factories[name] = { rules: ast.rules, topRule: ast.rules[topRuleName] };
  }

  // factoryHook (used by matcher.js) — looks up a factory by name and returns
  // its top rule AST so it gets expanded inline. The factory's own sub-rules
  // are available via the same `rules` map merged into the matcher context.
  function factoryHook(name) {
    const f = factories[name];
    return f ? f.topRule : null;
  }

  function parse(text) {
    const tokens = tokenize(text);
    if (tokens.length === 0) return null;
    // Merge each skill's rule map with factory sub-rules so factory inner
    // refs (e.g. YES, NO inside yes_no.grm) resolve during the walk.
    const factoryRules = {};
    for (const f of Object.values(factories)) Object.assign(factoryRules, f.rules);
    // Score every skill's best full-input match and pick the most specific
    // overall — a clock rule like `what time is it` beats a friendly-tips rule
    // shaped as `$* do $*` because the former matches 4 literal tokens vs the
    // latter's 1. On ties, earlier-registered skills win.
    let winner = null;
    for (const skill of skills) {
      const mergedRules = Object.assign({}, factoryRules, skill.rules);
      const m = matchRule(skill.topRule, tokens, { rules: mergedRules, factoryHook });
      if (!m) continue;
      const spec = m.specificity || 0;
      if (!winner || spec > winner.specificity) winner = { skill, m, specificity: spec };
    }
    if (!winner) return null;
    const ent = winner.m.entities || {};
    const intent = ent.intent || ent.action || '';
    // NLParse + Input mirror the cloud's NLU output shape that on-robot
    // skills read directly off the result object. The chitchat init reads
    // `data.asrResult.NLParse.valenceImpact` during processing — with NLParse
    // undefined the flow executor throws an unhandled rejection and the bundle
    // hangs in an endless requestAnimationFrame loop. Populate it from
    // entities + sensible defaults (so jibo.expression sees finite numbers).
    // Tag values like `{valenceImpact='0.5'}` come through entities as strings;
    // coerce to numbers. `Input` is the raw text the skill reads for analytics
    // / readback. The cloud puts NLParse alongside asr/nlu/match — same shape
    // the on-robot skills construct themselves when redirecting.
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
    const NLParse = Object.assign({}, ent, {
      intent,
      mimId: ent.mimId || ent.contentMimID || '',
      valenceImpact: num(ent.valenceImpact),
      confidenceImpact: num(ent.confidenceImpact),
      questionType: ent.questionType || 'null',
      loopmember: ent.loopmember || null,
      domain: ent.domain || '',
    });
    return {
      asr: { text, confidence: 1 },
      nlu: {
        entities: ent,
        intent,
        rules: ['launch'],
      },
      NLParse,
      Input: text,
      match: {
        skillID: ent.skill || winner.skill.skillID,
        launch: true,
        onRobot: winner.skill.onRobot,
        cloudSkill: ent.cloudSkill,
      },
    };
  }

  return { loadSkill, loadFactory, parse, _skills: skills, _factories: factories };
}
