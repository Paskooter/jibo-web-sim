// Smoke test for the persisted-settings feature (settings.json via /__settings).
//
// Part 1 (HTTP only): GET/PUT round-trip, validation errors, corrupt-file
// fallback — against a throwaway server on its own port and SETTINGS_FILE, so
// your real settings.json is never touched.
// Part 2 (browser): a saved wakeWord=true comes up ticked and arms the
// detector on page load (mic shimmed to a synthesized stream, as in
// wake-smoke.mjs); an unknown saved skill silently falls back; ticking the box
// writes the file. Autoplay policy is left at Chrome's default on purpose, so
// the 16 kHz capture AudioContext's state is observed honestly.
//
// Usage: node test/settings-smoke.mjs   (starts its own sim server)

import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 18080 + Math.floor(Math.random() * 500);
const base = `http://localhost:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'jibo-settings-'));
const file = join(dir, 'settings.json');
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); };

function findChrome() {
  const root = `${process.env.HOME}/.cache/puppeteer/chrome`;
  for (const v of (existsSync(root) ? readdirSync(root) : [])) {
    const p = `${root}/${v}/chrome-linux64/chrome`;
    if (existsSync(p)) return p;
  }
  return undefined;
}

const sim = spawn('node', ['server.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT), SETTINGS_FILE: file },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const simErr = [];
sim.stderr.on('data', (d) => simErr.push(String(d)));
sim.stdout.on('data', (d) => process.env.ST_VERBOSE && process.stdout.write(`[sim] ${d}`));
const cleanup = () => { sim.kill(); rmSync(dir, { recursive: true, force: true }); };
process.on('exit', cleanup);

for (let i = 0; i < 50; i++) {
  try { if ((await fetch(base + '/')).ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 200));
}

const put = (body, type = 'application/json') =>
  fetch(base + '/__settings', { method: 'PUT', headers: { 'Content-Type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const get = async () => (await fetch(base + '/__settings')).json();

// ---- Part 1: HTTP ---------------------------------------------------------
const initial = await get();
check('file created with defaults on first start', existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).wakeWord === false);
check('GET returns defaults', initial.wakeWord === false && initial.server === '' && initial.skill === '');

let r = await put({ wakeWord: true, server: 'hub.local' });
check('PUT partial update -> 200', r.status === 200);
const after = await get();
check('GET reflects update, keeps other keys', after.wakeWord === true && after.server === 'hub.local' && after.skill === '');
check('file on disk updated', JSON.parse(readFileSync(file, 'utf8')).server === 'hub.local');

r = await put({ nope: 1 });
check('unknown key -> 400', r.status === 400);
r = await put({ wakeWord: 'yes' });
check('wrong type -> 400', r.status === 400);
r = await put('{not json');
check('malformed JSON -> 400', r.status === 400);
r = await put({ wakeWord: false }, 'text/plain');
check('non-JSON content type -> 415', r.status === 415);
check('rejected writes left settings alone', (await get()).wakeWord === true);

writeFileSync(file, '{ corrupt');
check('corrupt file -> defaults', (await get()).wakeWord === false);
writeFileSync(file, JSON.stringify({ wakeWord: 'bad', server: 'ok.host', stray: 1 }));
const partial = await get();
check('invalid entries dropped, valid kept', partial.wakeWord === false && partial.server === 'ok.host' && !('stray' in partial));

// ---- Part 2: browser ------------------------------------------------------
writeFileSync(file, JSON.stringify({ wakeWord: true, skill: 'no-such-skill' }));
const browser = await puppeteer.launch({
  headless: true,
  executablePath: findChrome(),
  timeout: 60000,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  await page.evaluateOnNewDocument(() => {
    window.__ctxs = [];
    const Orig = window.AudioContext;
    window.AudioContext = class extends Orig { constructor(o) { super(o); window.__ctxs.push(this); } };
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new window.AudioContext();
      return ctx.createMediaStreamDestination().stream;
    };
  });
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => document.getElementById('wake-toggle')?.checked === true, { timeout: 15000 })
    .then(() => check('saved wakeWord=true -> checkbox ticked on load', true))
    .catch(() => check('saved wakeWord=true -> checkbox ticked on load', false));
  await page.waitForFunction(() => /Always-on/.test(document.getElementById('wake-toggle')?.title || ''), { timeout: 60000 })
    .then(() => check('detector armed without a click', true))
    .catch(() => check('detector armed without a click', false, logs.filter((l) => /wake|error/i.test(l)).slice(-5).join(' | ')));
  const states = await page.evaluate(() => window.__ctxs.filter((c) => c.sampleRate === 16000).map((c) => c.state));
  console.log(`INFO  16 kHz capture AudioContext state(s) with no user gesture: ${JSON.stringify(states)}`);
  check('capture AudioContext is running (not autoplay-suspended)', states.length > 0 && states.every((s) => s === 'running'), JSON.stringify(states));

  check('checkbox is locked until Start Jibo', await page.evaluate(() => document.getElementById('wake-toggle').disabled === true));

  // Start Jibo loads the saved skill into the iframe; an unknown one must fall
  // back to a real bundle (the picker itself can never hold an unknown value).
  await page.waitForSelector('#start-gate', { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('#skill-picker option').length > 0, { timeout: 15000 });
  await page.click('#start-gate');
  const src = await page.waitForFunction(() => document.getElementById('skill-iframe')?.src || false, { timeout: 30000 })
    .then((h) => h.jsonValue()).catch(() => '');
  await page.waitForFunction(() => document.getElementById('wake-toggle').disabled === false, { timeout: 30000 })
    .then(() => check('checkbox unlocks once Jibo is started', true))
    .catch(() => check('checkbox unlocks once Jibo is started', false));
  check('unknown saved skill falls back to a real one', /dir=/.test(src) && !/no-such-skill/.test(src), src);

  await page.click('#wake-toggle');
  await new Promise((r) => setTimeout(r, 500));
  check('unticking writes wakeWord=false to the file', JSON.parse(readFileSync(file, 'utf8')).wakeWord === false);
} finally {
  await browser.close();
}

if (simErr.length) console.log('--- sim stderr ---\n' + simErr.join(''));
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
