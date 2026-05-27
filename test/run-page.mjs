// Load a single sim page directly (no app shell), wait, screenshot, dump console
// from all frames. Used to iterate on the real-jibo-face experiment.
//
// Usage: node test/run-page.mjs [path] [waitMs] [shotPath]

import puppeteer from 'puppeteer';
import { existsSync, readdirSync } from 'node:fs';

const pagePath = process.argv[2] || '/test/realface.html';
const waitMs = Number(process.argv[3] || 20000);
const shot = process.argv[4] || '/tmp/realface.png';
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
page.on('console', (m) => log.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => log.push(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) => log.push(`[reqfail] ${r.url()} ${r.failure() && r.failure().errorText}`));
page.on('response', (r) => { if (r.status() === 404) log.push(`[404] ${r.url()}`); });

// Stream logs live so a hang/kill still shows progress, and don't block on
// network idle (the face render loop keeps the page "busy" forever).
page.on('console', (m) => process.stdout.write(`[${m.type()}] ${m.text()}\n`));
try {
  await page.goto(`${base}${pagePath}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => log.push(`[goto] ${e.message}`));
  await new Promise((r) => setTimeout(r, waitMs));
  await page.screenshot({ path: shot }).catch((e) => log.push(`[shot] ${e.message}`));
  console.log(`screenshot: ${shot}`);
} finally {
  console.log('\n===== (deferred) =====');
  console.log(log.join('\n'));
  await browser.close();
}
