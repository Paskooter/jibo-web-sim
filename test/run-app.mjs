// Full-app headless test: loads the simulator, clicks "Start Jibo", switches to
// a skill via the picker, screenshots, and dumps console from all frames. This
// exercises the real host<->iframe bridge (so jibo.init etc. resolve), unlike
// loading skill-host.html in isolation.
//
// Usage: node test/run-app.mjs [skillDir] [waitMs] [shotPath]

import puppeteer from 'puppeteer';
import { existsSync, readdirSync } from 'node:fs';

const skillDir = process.argv[2] || '/external-skills/jibo-be';
const waitMs = Number(process.argv[3] || 16000);
const shot = process.argv[4] || '/tmp/sim-shot.png';
const base = process.env.SIM_URL || 'http://localhost:8080';

function findChrome() {
  const root = `${process.env.HOME}/.cache/puppeteer/chrome`;
  for (const v of (existsSync(root) ? readdirSync(root) : [])) {
    const p = `${root}/${v}/chrome-linux64/chrome`;
    if (existsSync(p)) return p;
  }
  return undefined;
}

const browser = await puppeteer.launch({
  headless: true,
  executablePath: findChrome(),
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1300, height: 820 });
const log = [];
const tag = (m) => log.push(`[${m.type ? m.type() : 'err'}] ${m.text ? m.text() : m}`);
page.on('console', (m) => tag(m));
page.on('pageerror', (e) => log.push(`[pageerror] ${e.message}\n${(e.stack || '').split('\n').slice(1, 5).join('\n')}`));

await page.goto(`${base}/`, { waitUntil: 'networkidle2', timeout: 30000 }).catch((e) => log.push(`[goto] ${e.message}`));
await page.waitForSelector('#start-gate', { timeout: 15000 }).then(() => page.click('#start-gate')).catch((e) => log.push(`[start] ${e.message}`));
await new Promise((r) => setTimeout(r, 2500));
// Switch to the requested skill via the picker.
await page.select('#skill-picker', skillDir).catch((e) => log.push(`[picker] ${e.message}`));
await new Promise((r) => setTimeout(r, waitMs));
// Optional: tap the eye (over the body screen) to exercise screen-touch -> MainMenu.
if (process.env.CLICK_EYE) {
  const [cx, cy] = (process.env.CLICK_EYE || '505,270').split(',').map(Number);
  await page.mouse.click(cx, cy).catch((e) => log.push(`[click] ${e.message}`));
  log.push(`[test] clicked eye at ${cx},${cy}`);
  await new Promise((r) => setTimeout(r, 5000));
}

await page.screenshot({ path: shot }).catch((e) => log.push(`[shot] ${e.message}`));
console.log(`screenshot: ${shot}`);
console.log('\n===== console =====');
console.log(log.join('\n'));
await browser.close();
