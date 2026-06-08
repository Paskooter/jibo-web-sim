// Full-browser e2e: drive the REAL jibo-web-sim browser app against the Phoenix gateway.
//
// Boots the Phoenix stack (gateway+nlu+skills) in-process + the sim server, launches headless
// Chrome, points the sim's Server field at the gateway, starts Jibo, loads jibo-be, and types a
// turn. Verifies the browser's cloud bridge actually reached the gateway (gateway-side WS
// connection count) and captures the [hub-bridge] trace + Jibo's spoken/chat output.
//
// Run:  node test/phoenix-browser.mjs [skillDir] [utterance]
// Env:  PHOENIX_DIR, SECRET, HEADFUL=1, WAIT_MS

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import puppeteer from 'puppeteer';

const PHOENIX_DIR = process.env.PHOENIX_DIR || '/home/shell/work/phoenix';
const SECRET = process.env.SECRET || 'phx-it-secret';
const SKILL_DIR = process.argv[2] || '/skills/jibo-be';
const UTTERANCE = process.argv[3] || 'what time is it';
// Optional: assert the turn launched this specific on-robot skill (e.g. '@be/gallery').
// Useful for skills that show a screen instead of speaking.
const EXPECT_SKILL = process.argv[4] || process.env.EXPECT_SKILL || '';
const WAIT_MS = Number(process.env.WAIT_MS || 18000);
// The sim hard-codes the hub at <server-field>:9000 (live-eye.js: api.init({port:9000})),
// so the gateway MUST listen on 9000 and the Server field is the host only.
const P = { gateway: 9000, nlu: 7721, skills: 7724, sim: 8091 };
const SERVER_FIELD = process.env.SERVER_FIELD || 'localhost';

const log = (...a) => console.log('[bx]', ...a);
let failures = 0;
const check = (name, cond, detail) => { if (cond) log('PASS', name); else { failures++; log('FAIL', name, detail != null ? `:: ${JSON.stringify(detail).slice(0, 300)}` : ''); } };

function findChrome() {
  const root = `${process.env.HOME}/.cache/puppeteer/chrome`;
  for (const v of (existsSync(root) ? readdirSync(root) : [])) {
    const p = `${root}/${v}/chrome-linux64/chrome`;
    if (existsSync(p)) return p;
  }
  return undefined;
}

async function waitForHttp(url, ms = 12000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url); if (r.ok || r.status === 404) return; } catch { /* */ } await sleep(150); }
  throw new Error(`timeout waiting for ${url}`);
}

const procs = [];
async function startGatewayStack() {
  process.env.ETCO_server_hubTokenSecret = SECRET;
  process.env.NET_parser = `localhost:${P.nlu}`;
  process.env.NET_skills = `localhost:${P.skills}`;
  delete process.env.ETCO_hub_disableAuth;
  const nlu = await import(`${PHOENIX_DIR}/packages/nlu/src/index.js`);
  const skills = await import(`${PHOENIX_DIR}/packages/skills/src/index.js`);
  const gw = await import(`${PHOENIX_DIR}/packages/gateway/src/index.js`);
  const nluSrv = await nlu.start(P.nlu);
  const skillsSrv = await skills.start(P.skills);
  const g = await gw.start(P.gateway);
  let connections = 0;
  g.wss.on('connection', () => { connections++; });
  return { nluSrv, skillsSrv, g, conn: () => connections };
}

function startSim() {
  const child = spawn('node', ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(P.sim), HUB_AUTH_SECRET: SECRET },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(child);
  child.stderr.on('data', (d) => process.env.BX_VERBOSE && process.stdout.write(`[sim-err] ${d}`));
}

async function main() {
  const stack = await startGatewayStack();
  startSim();
  await waitForHttp(`http://localhost:${P.gateway}/healthcheck`);
  await waitForHttp(`http://localhost:${P.sim}/`);
  log('stack up; launching browser');

  const browser = await puppeteer.launch({
    headless: !process.env.HEADFUL,
    executablePath: findChrome(),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  const bridge = [];
  const allLogs = [];
  page.on('console', (m) => {
    const t = m.text();
    allLogs.push(t);
    if (t.includes('[hub-bridge]')) bridge.push(t);
  });
  page.on('pageerror', (e) => allLogs.push(`[pageerror] ${e.message}`));

  // Point the sim at our gateway before any script runs, and instrument TTS.
  await page.evaluateOnNewDocument((server) => {
    try { localStorage.setItem('jibo-server', server); } catch { /* */ }
    window.__speak = [];
    const wrap = () => { try { const s = speechSynthesis; if (s && s.speak && !s.__w) { s.__w = 1; const o = s.speak.bind(s); s.speak = (u) => { window.__speak.push(u && u.text ? String(u.text).slice(0, 80) : '?'); try { return o(u); } catch (e) { /* */ } }; } } catch { /* */ } };
    wrap();
  }, SERVER_FIELD);

  await page.goto(`http://localhost:${P.sim}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#start-gate', { timeout: 15000 }).then(() => page.click('#start-gate')).catch((e) => log('start gate:', e.message));
  await sleep(2500);

  // Confirm the server field took our value.
  const serverVal = await page.$eval('#server-addr', (el) => el.value).catch(() => '');
  check('server field set to gateway', serverVal === SERVER_FIELD, serverVal);

  // Pick jibo-be (default, but be explicit) and let it boot.
  const options = await page.$$eval('#skill-picker option', (os) => os.map((o) => o.value));
  log('picker options:', options.join(', ') || '(none yet)');
  if (options.includes(SKILL_DIR)) await page.select('#skill-picker', SKILL_DIR).catch((e) => log('select:', e.message));
  await sleep(WAIT_MS);

  // Type a turn into the chat panel.
  const chatInput = await page.$('.chat-panel input');
  check('chat input present', !!chatInput);
  if (chatInput) {
    await page.click('[data-tab="chat"]').catch(() => {});
    await chatInput.type(UTTERANCE, { delay: 10 });
    await page.keyboard.press('Enter');
    log(`typed: "${UTTERANCE}"`);
  }
  await sleep(8000);

  const speak = await page.evaluate(() => window.__speak || []).catch(() => []);
  const jiboChat = await page.evaluate(() => Array.from(document.querySelectorAll('.chat-msg.chat-jibo')).map((e) => e.textContent.slice(0, 80))).catch(() => []);

  // On-robot skill launches are logged by the sim's SkillSwitchScheduler/Util.
  const switches = [];
  for (const l of allLogs) { const m = /(?:switching skill|BeSkill open)\s+(@be\/[\w-]+)/.exec(l); if (m) switches.push(m[1]); }

  log('--- [hub-bridge] trace ---'); bridge.slice(0, 30).forEach((l) => log(' ', l.slice(0, 200)));
  log('gateway WS connections seen:', stack.conn());
  log('jibo speak calls:', speak.length, speak.slice(0, 6));
  log('jibo chat msgs:', jiboChat.length, jiboChat.slice(0, 6));
  log('be-skill switches:', Array.from(new Set(switches)).join(', ') || '(none)');

  check('browser cloud bridge reached the gateway', stack.conn() > 0, { connections: stack.conn(), bridge: bridge.slice(0, 6) });
  check('hub returned a TURN_RESULT for the turn', bridge.some((l) => l.includes('TURN_RESULT')), bridge.slice(0, 8));
  if (EXPECT_SKILL) {
    check(`launched skill ${EXPECT_SKILL}`, switches.includes(EXPECT_SKILL), { switches, speak, jiboChat });
  } else {
    check('be-skill launched (Jibo responded)', (speak.length + jiboChat.length) > 0, { speak, jiboChat });
  }

  await page.screenshot({ path: '/tmp/phoenix-browser.png' }).catch(() => {});
  log('screenshot: /tmp/phoenix-browser.png');

  if (failures && !process.env.BX_QUIET) { log('--- last 40 page logs ---'); allLogs.slice(-40).forEach((l) => log('  ', l.slice(0, 200))); }

  await browser.close();
  for (const c of procs) c.kill();
  try { stack.g.wss.close(); stack.g.service.server.close(); stack.nluSrv.close(); stack.skillsSrv.close(); } catch { /* */ }
  log(failures ? `DONE with ${failures} FAILURE(S)` : 'ALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('[bx] harness error:', e); for (const c of procs) c.kill(); process.exit(2); });
