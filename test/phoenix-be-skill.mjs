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
      // resolve on a terminal frame OR a (possibly non-final) SKILL_ACTION (multi-turn turn 1).
      if (m.final || m.type === 'SKILL_ACTION') { clearTimeout(timer); ws.close(); resolve(frames); }
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

// Mock Parakeet /transcribe (the real one is a LAN NeMo host; the gateway only
// needs the REST contract: multipart WAV in -> {transcript} out).
import http from 'node:http';
function startMockParakeet(transcript) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        srv._lastBytes = Buffer.concat(chunks).length;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ transcript }));
      });
    });
    srv.listen(0, () => resolve(srv));
  });
}

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
      // NOTE: today-suffixed variants ("what is the date today") go to GQA in the
      // REFERENCE too (oracle: "what day is it today" -> generalWhatQuestions);
      // the bare form is the clock-owned phrasing.
      ['what is the date', '@be/clock'],
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

  // --- report intent split: news/weather requests must NOT speak the personal report ----
  // (mirrors reference IntentSplitNode: requestNews -> news only, requestWeatherPR -> weather only)
  for (const [text, mustNotMatch] of [['tell me the news', /personal report/i], ['tell me the weather', /personal report/i]]) {
    const frames = await runTurn([listen('CLIENT_ASR'), context(), clientASR(text)], `tid:split:${text.replace(/\s+/g, '_')}`);
    const act = frames.find((f) => f.type === 'SKILL_ACTION');
    const esml = act && act.data.action && act.data.action.config.jcp.children[0].config.play.esml || '';
    check(`CLIENT_ASR "${text}" -> report-skill subskill (not the full report)`,
      act && act.data.skill.id === 'report-skill' && !mustNotMatch.test(esml), { skill: act && act.data.skill.id, esml });
  }

  // --- chitchat intent responses: dance/twerk answer with real MIM content ----
  for (const [text, esmlRe] of [['do a dance', /<anim cat='dance'/], ['twerk', /twerk/i]]) {
    const frames = await runTurn([listen('CLIENT_ASR'), context(), clientASR(text)], `tid:cc:${text.replace(/\s+/g, '_')}`);
    const act = frames.find((f) => f.type === 'SKILL_ACTION');
    const esml = act && act.data.action && act.data.action.config.jcp.children[0].config.play.esml || '';
    check(`CLIENT_ASR "${text}" -> chitchat-skill responds in character`,
      act && act.data.skill.id === 'chitchat-skill' && esmlRe.test(esml), { skill: act && act.data.skill.id, esml: esml.slice(0, 120) });
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

  // --- M8 server-side ASR: robot-style audio streaming -----------------------
  // Exactly what an unmodified robot does (hub-client AudioStreamSession): LISTEN
  // with NO mode, CONTEXT, then binary 16 kHz 16-bit mono PCM in 6400-byte chunks
  // every 100 ms, with trailing zero (silence) chunks after the utterance until
  // the transaction finishes. Expect REAL SOS (on VAD speech), EOS (on 700 ms
  // silence), then the routed final LISTEN.
  {
    const parakeet = await startMockParakeet('what time is it');
    process.env.ETCO_server_parakeetUrl = `http://localhost:${parakeet.address().port}`;

    const pcm = (amp, ms) => {
      const samples = Math.floor(16000 * ms / 1000);
      const b = Buffer.alloc(samples * 2);
      for (let i = 0; i < samples; i += 1) b.writeInt16LE((i % 2 ? 1 : -1) * amp, i * 2);
      return b;
    };
    const frames = await new Promise((resolve, reject) => {
      const url = `ws://localhost:${P.sim}/__cloud-ws?upstream=${encodeURIComponent(`localhost:${P.gateway}`)}&path=${encodeURIComponent('/listen')}&transID=${encodeURIComponent('tid:audio')}`;
      const ws = new WebSocket(url);
      const got = [];
      const timer = setTimeout(() => { ws.close(); reject(new Error('audio turn timeout')); }, 15000);
      let pump = null;
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'LISTEN', msgID: 'l', ts: Date.now(), data: { lang: 'en-US', hotphrase: false, rules: ['launch'] } }));
        ws.send(JSON.stringify(context()));
        // utterance: 300ms silence, 600ms speech, then endless trailing silence
        const schedule = [pcm(0, 100), pcm(0, 100), pcm(0, 100),
          pcm(8000, 100), pcm(8000, 100), pcm(8000, 100), pcm(8000, 100), pcm(8000, 100), pcm(8000, 100)];
        let i = 0;
        pump = setInterval(() => {
          const chunk = i < schedule.length ? schedule[i] : pcm(0, 200); // hub-client chunks are 6400B = 200ms
          i += 1;
          try { ws.send(chunk, { binary: true }); } catch { /* closing */ }
        }, 100);
      });
      ws.on('message', (d, isBinary) => {
        if (isBinary) return;
        const m = JSON.parse(d.toString());
        got.push(m);
        if (m.final) { clearInterval(pump); clearTimeout(timer); ws.close(); resolve(got); }
      });
      ws.on('error', (e) => { clearInterval(pump); clearTimeout(timer); reject(e); });
    });
    parakeet.close();
    delete process.env.ETCO_server_parakeetUrl;

    const types = frames.map((f) => f.type);
    check('audio: SOS/EOS/LISTEN stream from real VAD', JSON.stringify(types) === JSON.stringify(['SOS', 'EOS', 'LISTEN']), types);
    const sos = frames.find((f) => f.type === 'SOS');
    check('audio: SOS carries REAL timing (not -1)', sos && sos.timings && sos.timings.total >= 0, sos && sos.timings);
    const lr = frames.find((f) => f.type === 'LISTEN');
    check('audio: transcript routed to @be/clock', lr && lr.final === true && lr.data.match && lr.data.match.skillID === '@be/clock', lr && lr.data && lr.data.match);
    check('audio: ASR transcript in the LISTEN result', lr && lr.data.asr && lr.data.asr.text === 'what time is it', lr && lr.data && lr.data.asr);
  }

  // --- multi-turn GraphSkill: color-skill (LISTEN_LAUNCH final:false -> LISTEN_UPDATE) ----
  {
    const t1 = await runTurn([listen('CLIENT_NLU'), context(), clientNLU('favoriteColorChat', {})], 'tid:color1');
    const act1 = t1.find((f) => f.type === 'SKILL_ACTION');
    check('multi-turn t1: color-skill SKILL_ACTION non-final (asks the question)', act1 && act1.data.skill.id === 'color-skill' && act1.data.final === false, act1 && act1.data && { id: act1.data.skill && act1.data.skill.id, final: act1.data.final });
    const session = act1 && act1.data.skill.session;
    check('multi-turn t1: session carried for resume', !!(session && session.id), session);

    // turn 2: robot echoes the skill session in CONTEXT and answers "blue" (raw ASR).
    const ctx2 = { type: 'CONTEXT', msgID: 'c2', ts: Date.now(), data: { general: { release: '1.9.0' }, runtime: { loop: { users: [] }, dialog: {}, perception: {} }, skill: { id: 'color-skill', session } } };
    const t2 = await runTurn([listen('CLIENT_ASR'), ctx2, clientASR('blue')], 'tid:color2');
    const act2 = t2.find((f) => f.type === 'SKILL_ACTION');
    const esml2 = act2 && act2.data.action && act2.data.action.config.jcp.children[0].config.play.esml;
    check('multi-turn t2: LISTEN_UPDATE resumes -> final SKILL_ACTION mentioning "blue"', act2 && act2.data.final === true && /blue/.test(esml2 || ''), { final: act2 && act2.data.final, esml: esml2 });
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
