// Headless browser test harness — loads a skill into the simulator's in-place
// loader and dumps the page console + errors. Lets us see how an original
// bundle (e.g. jibo-be) actually behaves in a real browser.
//
// Usage:
//   node test/run-skill.mjs [dir] [entry] [waitMs]
//   node test/run-skill.mjs /external-skills/jibo-be index.html 10000
//
// Requires the dev server running (npm start) and puppeteer + its Chrome
// installed (npx puppeteer browsers install chrome).

import puppeteer from 'puppeteer';
import { existsSync, readdirSync } from 'node:fs';

const dir = process.argv[2] || '/external-skills/jibo-be';
const entry = process.argv[3] || 'index.html';
const waitMs = Number(process.argv[4] || 10000);
const base = process.env.SIM_URL || 'http://localhost:8080';
const url = `${base}/skill-host.html?dir=${encodeURIComponent(dir)}&entry=${encodeURIComponent(entry)}`;

// Locate the puppeteer-installed Chrome.
function findChrome() {
  const root = `${process.env.HOME}/.cache/puppeteer/chrome`;
  if (!existsSync(root)) return undefined;
  for (const v of readdirSync(root)) {
    const p = `${root}/${v}/chrome-linux64/chrome`;
    if (existsSync(p)) return p;
  }
  return undefined;
}

const browser = await puppeteer.launch({
  headless: true,
  executablePath: findChrome(),
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
const log = [];
page.on('console', (m) => log.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => log.push(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) => log.push(`[reqfail] ${r.url()} ${r.failure()?.errorText || ''}`));

console.log(`loading ${url}`);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => log.push(`[goto] ${e.message}`));
await new Promise((r) => setTimeout(r, waitMs));

console.log('\n===== page console =====');
console.log(log.join('\n'));
await browser.close();
