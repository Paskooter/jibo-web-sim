// Integration test: jibo-web-sim <-> Phoenix gateway, at the sim server's cloud-proxy level.
//
// This drives the sim's real /__cloud-ws WebSocket proxy (server.js) — which signs the HS256
// Bearer JWT and injects X-JIBO-* headers exactly as the browser cloud path does — against a live
// Phoenix stack (gateway + nlu + skills). It sends the same frames the sim's browser builds for a
// turn (LISTEN + CONTEXT + CLIENT_NLU) and asserts the hub response stream.
//
// Run:  node test/phoenix-be-skill.mjs
// Env:  PHOENIX_DIR (default /home/shell/work/phoenix), SECRET, ports.

import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { setTimeout as sleep } from 'node:timers/promises';

const PHOENIX_DIR = process.env.PHOENIX_DIR || '/home/shell/work/phoenix';
const SECRET = process.env.SECRET || 'phx-it-secret';
const P = { gateway: 7710, nlu: 7711, skills: 7714, history: 7713, sim: 8090 };

const log = (...a) => console.log('[it]', ...a);
let failures = 0;
function check(name, cond, detail) {
  if (cond) log('PASS', name);
  else { failures++; log('FAIL', name, detail != null ? `:: ${JSON.stringify(detail)}` : ''); }
}

async function waitForHttp(url, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return true; } catch { /* retry */ }
    await sleep(150);
  }
  throw new Error(`timeout waiting for ${url}`);
}

// Run one turn through the sim proxy; collect hub frames until `final`.
function runTurn(msgs, transID, path = '/listen') {
  return new Promise((resolve, reject) => {
    const url = `ws://localhost:${P.sim}/__cloud-ws?upstream=${encodeURIComponent(`localhost:${P.gateway}`)}&path=${encodeURIComponent(path)}&transID=${encodeURIComponent(transID)}`;
    const ws = new WebSocket(url);
    const frames = [];
    const timer = setTimeout(() => { ws.close(); reject(new Error('turn timeout')); }, 12000);
    ws.on('open', () => msgs.forEach((m) => ws.send(JSON.stringify(m))));
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      frames.push(m);
      if (m.final) { clearTimeout(timer); ws.close(); resolve(frames); }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

const context = () => ({
  type: 'CONTEXT', msgID: 'c', ts: Date.now(),
  data: { general: { release: '1.9.0' }, runtime: { loop: { users: [] }, dialog: {}, perception: {} }, skill: null },
});
const listen = (mode) => ({ type: 'LISTEN', msgID: 'l', ts: Date.now(), data: { lang: 'en-US', hotphrase: false, rules: ['launch'], mode } });
const clientNLU = (intent, entities = {}) => ({ type: 'CLIENT_NLU', msgID: 'n', ts: Date.now(), data: { rules: ['launch'], intent, entities } });
const clientASR = (text) => ({ type: 'CLIENT_ASR', msgID: 'n', ts: Date.now(), data: { text } });

const procs = [];
function startGatewayStack() {
  // gateway/nlu/skills started in-process by importing the workspace packages.
  process.env.ETCO_server_hubTokenSecret = SECRET;
  process.env.NET_parser = `localhost:${P.nlu}`;
  process.env.NET_skills = `localhost:${P.skills}`;
  process.env.NET_history = `localhost:${P.history}`;
  delete process.env.ETCO_hub_disableAuth;
  return import(`${PHOENIX_DIR}/packages/nlu/src/index.js`).then(async (nlu) => {
    const skills = await import(`${PHOENIX_DIR}/packages/skills/src/index.js`);
    const history = await import(`${PHOENIX_DIR}/packages/history/src/index.js`);
    const gw = await import(`${PHOENIX_DIR}/packages/gateway/src/index.js`);
    const nluSrv = await nlu.start(P.nlu);
    const skillsSrv = await skills.start(P.skills);
    const historySrv = await history.start(P.history);
    const g = await gw.start(P.gateway);
    return { nluSrv, skillsSrv, historySrv, g };
  });
}

function startSim() {
  const child = spawn('node', ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(P.sim), HUB_AUTH_SECRET: SECRET },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(child);
  child.stdout.on('data', (d) => process.env.IT_VERBOSE && process.stdout.write(`[sim] ${d}`));
  child.stderr.on('data', (d) => process.stdout.write(`[sim-err] ${d}`));
  return child;
}

async function main() {
  const stack = await startGatewayStack();
  startSim();
  await waitForHttp(`http://localhost:${P.gateway}/healthcheck`);
  await waitForHttp(`http://localhost:${P.sim}/`);
  log('stack up: gateway, nlu, skills, sim');

  // --- be-skill (onRobot) turn: "what time is it" -> @be/clock --------------
  {
    const frames = await runTurn([listen('CLIENT_NLU'), context(), clientNLU('askForTime', { skill: '@be/clock' })], 'tid:clock');
    const types = frames.map((f) => f.type);
    check('be-skill: SOS/EOS/LISTEN stream', JSON.stringify(types) === JSON.stringify(['SOS', 'EOS', 'LISTEN']), types);
    const lr = frames.find((f) => f.type === 'LISTEN');
    check('be-skill: final LISTEN', lr && lr.final === true, lr && lr.final);
    check('be-skill: routed to @be/clock onRobot', lr && lr.data.match && lr.data.match.skillID === '@be/clock' && lr.data.match.onRobot === true, lr && lr.data.match);
  }

  // --- cloud skill turn: "who is ada lovelace" -> answer-skill SKILL_ACTION --
  {
    const frames = await runTurn([listen('CLIENT_NLU'), context(), clientNLU('generalWhoQuestions', { person: 'ada lovelace' })], 'tid:answer');
    const types = frames.map((f) => f.type);
    check('cloud: SOS/EOS/LISTEN/SKILL_ACTION stream', JSON.stringify(types) === JSON.stringify(['SOS', 'EOS', 'LISTEN', 'SKILL_ACTION']), types);
    const lr = frames.find((f) => f.type === 'LISTEN');
    check('cloud: non-final LISTEN, answer-skill match', lr && lr.final === false && lr.data.match.skillID === 'answer-skill', lr && lr.data.match);
    const act = frames.find((f) => f.type === 'SKILL_ACTION');
    check('cloud: final SKILL_ACTION with JCP', act && act.final === true && act.data.action.config.jcp.type === 'SEQUENCE', act && act.data && act.data.action && act.data.action.type);
  }

  // --- cloud report-skill + chitchat-skill (distinct hosted skills) ----------
  for (const [intent, skillId] of [['launchPersonalReport', 'report-skill'], ['aprilFools', 'chitchat-skill']]) {
    const frames = await runTurn([listen('CLIENT_NLU'), context(), clientNLU(intent, {})], `tid:${skillId}`);
    const lr = frames.find((f) => f.type === 'LISTEN');
    const act = frames.find((f) => f.type === 'SKILL_ACTION');
    check(`cloud: "${intent}" -> ${skillId} match`, lr && lr.data.match && lr.data.match.skillID === skillId, lr && lr.data && lr.data.match);
    check(`cloud: ${skillId} returns its own SKILL_ACTION`, act && act.final === true && act.data.skill.id === skillId && act.data.action.config.jcp.type === 'SEQUENCE', act && act.data && act.data.skill);
  }

  // --- be-skills via raw CLIENT_ASR (the real browser path: gateway does NLU) ----
  // Each utterance must NLU+route to the expected on-robot be-skill.
  {
    const cases = [
      ['what time is it', '@be/clock'],
      ['what is the date today', '@be/clock'],
      ['hello jibo', '@be/greetings'],
      ['im home', '@be/greetings'],
      ['who am i', '@be/who-am-i'],
      ['what features do you have', '@be/friendly-tips'],
      ['open the main menu', '@be/main-menu'],
      ['open settings', '@be/settings'],
      ['take a picture', '@be/create'],
      ['show me the gallery', '@be/gallery'],
      ['lets play circuit saver', '@be/circuit-saver'],
      ['trigger the lights', '@be/ifttt'],
    ];
    for (const [text, skillID] of cases) {
      const frames = await runTurn([listen('CLIENT_ASR'), context(), clientASR(text)], `tid:asr:${skillID}`);
      const lr = frames.find((f) => f.type === 'LISTEN');
      check(`CLIENT_ASR "${text}" -> ${skillID} onRobot`, lr && lr.final === true && lr.data.match && lr.data.match.skillID === skillID && lr.data.match.onRobot === true, lr && lr.data && lr.data.match);
    }
  }

  // --- cloud skills via raw CLIENT_ASR (gateway NLU routes to a cloud skill) ----
  for (const [text, skillId] of [['tell me my personal report', 'report-skill'], ['who is ada lovelace', 'answer-skill']]) {
    const frames = await runTurn([listen('CLIENT_ASR'), context(), clientASR(text)], `tid:casr:${skillId}`);
    const act = frames.find((f) => f.type === 'SKILL_ACTION');
    check(`CLIENT_ASR "${text}" -> ${skillId} SKILL_ACTION`, act && act.data && act.data.skill && act.data.skill.id === skillId, act && act.data && act.data.skill);
  }

  // --- global turn: bare CLIENT_NLU, no LISTEN/CONTEXT (mimic_global_turn) ----
  {
    const frames = await runTurn([clientNLU('askForTime', { skill: '@be/clock' })], 'GLOBAL');
    const lr = frames.find((f) => f.type === 'LISTEN');
    check('global turn (bare CLIENT_NLU) routes to @be/clock', lr && lr.final === true && lr.data.match && lr.data.match.skillID === '@be/clock', lr && lr.data && lr.data.match);
  }

  // --- no-match turn: unknown intent -> final LISTEN match:null -------------
  {
    const frames = await runTurn([listen('CLIENT_NLU'), context(), clientNLU('totallyUnknownIntent', {})], 'tid:none');
    const lr = frames.find((f) => f.type === 'LISTEN');
    check('no-match: final LISTEN with match null', lr && lr.final === true && lr.data.match === null, lr && lr.data.match);
  }

  // --- proactive channel (/proactive): TRIGGER + CONTEXT -> filter -> PROACTIVE --
  // contextRules make SURPRISE+morning+known-person eligible for report-skill only, and
  // NEW_ARRIVAL eligible for @be/greetings only (greetings requires TRIGGER_SOURCE != SURPRISE).
  {
    const proCtx = () => ({
      type: 'CONTEXT', msgID: 'pc', ts: Date.now(),
      data: { general: { release: '1.9.0' }, runtime: { loop: { users: [] }, dialog: {}, perception: { speaker: 'looper-1', peoplePresent: [{ id: 'looper-1' }] }, location: { iso: '2026-06-08T09:00:00-04:00' } }, skill: null },
    });
    const trigger = (src, looperID) => ({ type: 'TRIGGER', msgID: 'tg', ts: Date.now(), data: { triggerSource: src, triggerData: { looperID } } });

    const s = await runTurn([trigger('SURPRISE', 'looper-1'), proCtx()], 'tid:pro-surprise', '/proactive');
    const sPro = s.find((f) => f.type === 'PROACTIVE');
    check('proactive SURPRISE -> report-skill match (cloud, non-final)', sPro && sPro.data.match && sPro.data.match.skillID === 'report-skill' && sPro.data.match.isProactive === true && sPro.final === false, sPro && sPro.data);
    const sAct = s.find((f) => f.type === 'SKILL_ACTION');
    check('proactive report-skill returns SKILL_ACTION', sAct && sAct.final === true && sAct.data.skill.id === 'report-skill', sAct && sAct.data && sAct.data.skill);

    const a = await runTurn([trigger('NEW_ARRIVAL', 'looper-1'), proCtx()], 'tid:pro-arrival', '/proactive');
    const aPro = a.find((f) => f.type === 'PROACTIVE');
    check('proactive NEW_ARRIVAL -> @be/greetings onRobot match (final)', aPro && aPro.final === true && aPro.data.match && aPro.data.match.skillID === '@be/greetings' && aPro.data.match.onRobot === true, aPro && aPro.data);
  }

  log(failures ? `DONE with ${failures} FAILURE(S)` : 'ALL CHECKS PASSED');
  for (const c of procs) c.kill();
  // close in-process servers
  try { stack.g.wss.close(); stack.g.service.server.close(); stack.nluSrv.close(); stack.skillsSrv.close(); stack.historySrv.close(); } catch { /* */ }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('[it] harness error:', e); for (const c of procs) c.kill(); process.exit(2); });
