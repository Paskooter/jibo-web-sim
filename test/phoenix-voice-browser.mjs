// Browser e2e for M8 voice turns: real Chrome, FAKE MICROPHONE (Chrome's
// --use-file-for-fake-audio-capture), real sim UI. Clicking the chat panel's 🎤
// runs the robot audio path end-to-end: LISTEN (no mode) + mic PCM streamed by
// the hub-bridge → gateway VAD SOS/EOS → mock Parakeet /transcribe → routed turn.
//
// Run:  node test/phoenix-voice-browser.mjs
// Env:  PHOENIX_DIR, SECRET, HEADFUL=1, WAIT_MS

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import puppeteer from 'puppeteer';

const PHOENIX_DIR = process.env.PHOENIX_DIR || '/home/shell/work/phoenix';
const SECRET = process.env.SECRET || 'phx-it-secret';
const WAIT_MS = Number(process.env.WAIT_MS || 18000);
const P = { gateway: 9000, nlu: 7731, skills: 7734, sim: 8092 };
const SERVER_FIELD = 'localhost';
const FAKE_WAV = '/tmp/phx-fake-mic.wav';

const log = (...a) => console.log('[vx]', ...a);
let failures = 0;
const check = (name, cond, detail) => { if (cond) log('PASS', name); else { failures++; log('FAIL', name, detail != null ? `:: ${JSON.stringify(detail).slice(0, 300)}` : ''); } };

// 16 kHz 16-bit mono WAV: 600ms silence + 1.2s loud 440Hz tone + 2s silence.
// (Chrome loops the file; the gateway VAD only cares about the first cycle.)
function writeFakeMicWav() {
  const sr = 16000;
  const seg = (ms, fn) => {
    const n = Math.floor(sr * ms / 1000);
    const b = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i += 1) b.writeInt16LE(fn(i), i * 2);
    return b;
  };
  const silence = (ms) => seg(ms, () => 0);
  const tone = (ms) => seg(ms, (i) => Math.round(12000 * Math.sin(2 * Math.PI * 440 * i / sr)));
  const pcm = Buffer.concat([silence(600), tone(1200), silence(2000)]);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  writeFileSync(FAKE_WAV, Buffer.concat([h, pcm]));
}

function startMockParakeet(transcript) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        srv._hits = (srv._hits || 0) + 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ transcript }));
      });
    });
    srv.listen(0, () => resolve(srv));
  });
}

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
async function startGatewayStack(parakeetUrl) {
  process.env.ETCO_server_hubTokenSecret = SECRET;
  process.env.NET_parser = `localhost:${P.nlu}`;
  process.env.NET_skills = `localhost:${P.skills}`;
  process.env.ETCO_server_parakeetUrl = parakeetUrl;
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
  writeFakeMicWav();
  const parakeet = await startMockParakeet('what time is it');
  const stack = await startGatewayStack(`http://localhost:${parakeet.address().port}`);
  startSim();
  await waitForHttp(`http://localhost:${P.gateway}/healthcheck`);
  await waitForHttp(`http://localhost:${P.sim}/`);
  log('stack up; launching browser with fake mic');

  const browser = await puppeteer.launch({
    headless: !process.env.HEADFUL,
    executablePath: findChrome(),
    args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist',
      '--use-fake-ui-for-media-capture',
      '--use-fake-device-for-media-capture',
      `--use-file-for-fake-audio-capture=${FAKE_WAV}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  const allLogs = [];
  page.on('console', (m) => allLogs.push(m.text()));
  page.on('pageerror', (e) => allLogs.push(`[pageerror] ${e.message}`));
  const frameLogs = () => allLogs; // iframe console is captured on the same page

  await page.evaluateOnNewDocument((server) => {
    try { localStorage.setItem('jibo-server', server); } catch { /* */ }
    window.__speak = [];
    try { const s = speechSynthesis; const o = s.speak.bind(s); s.speak = (u) => { window.__speak.push(u && u.text ? String(u.text).slice(0, 80) : '?'); try { return o(u); } catch (e) { /* */ } }; } catch { /* */ }
    // This box's headless Chrome exposes no audio devices (no ALSA/Pulse), so
    // Chrome's --use-file-for-fake-audio-capture cannot work. Shim ONLY the
    // device layer: getUserMedia returns a WebAudio-synthesized stream
    // (600 ms silence -> 1.2 s 440 Hz tone -> silence). Everything downstream —
    // the hub-bridge capture/downsample/WS streaming, gateway VAD, Parakeet
    // POST, routing — is fully real.
    try {
      if (navigator.mediaDevices) {
        navigator.mediaDevices.getUserMedia = async () => {
          const ctx = new (window.AudioContext || window.webkitAudioContext)();
          const sr = ctx.sampleRate;
          const buf = ctx.createBuffer(1, Math.floor(sr * 3.8), sr);
          const d = buf.getChannelData(0);
          const toneStart = Math.floor(sr * 0.6); const toneEnd = Math.floor(sr * 1.8);
          for (let i = toneStart; i < toneEnd; i += 1) d[i] = 0.7 * Math.sin(2 * Math.PI * 440 * (i - toneStart) / sr);
          const srcNode = ctx.createBufferSource();
          srcNode.buffer = buf;
          const dest = ctx.createMediaStreamDestination();
          srcNode.connect(dest);
          srcNode.start();
          return dest.stream;
        };
      }
    } catch (e) { console.warn('[vx-shim] gum shim failed', e.message); }
  }, SERVER_FIELD);

  await page.goto(`http://localhost:${P.sim}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#start-gate', { timeout: 15000 }).then(() => page.click('#start-gate')).catch((e) => log('start gate:', e.message));
  await sleep(WAIT_MS);   // let jibo-be boot

  await page.click('[data-tab="chat"]').catch(() => {});
  const micBtn = await page.$('.chat-panel .chat-mic');
  check('mic button present', !!micBtn);
  await micBtn.click();
  log('clicked mic; streaming fake audio');
  await sleep(12000);

  const speak = await page.evaluate(() => window.__speak || []).catch(() => []);
  const heardRows = await page.$$eval('.chat-msg.chat-user', (els) => els.map((e) => e.textContent)).catch(() => []);
  const logs = frameLogs();
  const voiceStarted = logs.some((l) => l.includes('[voice] startLocalTurn audio'));
  const micStreaming = logs.some((l) => l.includes('mic streaming'));
  const switches = [];
  for (const l of logs) { const m = /(?:switching skill|BeSkill open)\s+(@be\/[\w-]+)/.exec(l); if (m) switches.push(m[1]); }

  log('parakeet hits:', parakeet._hits || 0, '| speak:', speak.slice(0, 3), '| heard rows:', heardRows.slice(-3));
  check('voice turn started (boot.js handler)', voiceStarted);
  check('hub-bridge streamed the mic', micStreaming, logs.filter((l) => l.includes('[hub-bridge]')).slice(-6));
  check('gateway VAD reached Parakeet (>=1 transcription)', (parakeet._hits || 0) >= 1);
  check('transcript echoed to chat', heardRows.some((t) => t.includes('what time is it')), heardRows);
  check('turn routed: @be/clock launched or Jibo spoke', switches.includes('@be/clock') || speak.length > 0, { switches, speak });

  await page.screenshot({ path: '/tmp/phoenix-voice.png' }).catch(() => {});
  if (failures) { log('--- last 50 logs ---'); logs.slice(-50).forEach((l) => log('  ', l.slice(0, 220))); }

  await browser.close();
  for (const c of procs) c.kill();
  parakeet.close();
  try { stack.g.wss.close(); stack.g.service.server.close(); stack.nluSrv.close(); stack.skillsSrv.close(); } catch { /* */ }
  log(failures ? `DONE with ${failures} FAILURE(S)` : 'ALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('[vx] harness error:', e); for (const c of procs) c.kill(); process.exit(2); });
