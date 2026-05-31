// Postinstall hook: pull the companion launch-rule pack into ./rules.
//
// Runs after `npm install`. Skips when:
//   - ./rules already has content (manual download, custom pack, prior fetch)
//   - SKIP_RULE_FETCH is set in the env (CI, offline installs)
//
// Failures here never break npm install — we log a hint and exit 0. The
// simulator works without the pack (offline NLU just covers fewer skills),
// and the user can always re-run with `npm run fetch-rules`.

import { existsSync, mkdirSync, readdirSync, createWriteStream, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:https';

const RULES_REPO_TARBALL =
  'https://github.com/Paskooter/jibo-web-sim-rules/archive/refs/heads/main.tar.gz';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RULES_DIR = join(REPO_ROOT, 'rules');
const TMP_TARBALL = join(REPO_ROOT, 'rules', '.fetch.tar.gz');

function log(msg) { console.log(`[fetch-rules] ${msg}`); }

function ruleDirHasContent() {
  if (!existsSync(RULES_DIR)) return false;
  const entries = readdirSync(RULES_DIR).filter((n) => n !== '.gitkeep' && !n.startsWith('.fetch'));
  return entries.length > 0;
}

function downloadFollow(url) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET', headers: { 'User-Agent': 'jibo-web-sim postinstall' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        downloadFollow(new URL(res.headers.location, url).toString()).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }
      resolve(res);
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchToFile(url, dest) {
  const res = await downloadFollow(url);
  await new Promise((resolve, reject) => {
    const out = createWriteStream(dest);
    res.pipe(out);
    out.on('finish', () => out.close(resolve));
    out.on('error', reject);
    res.on('error', reject);
  });
}

function extractTar(tarball, into) {
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['xzf', tarball, '-C', into, '--strip-components=1'], { stdio: ['ignore', 'inherit', 'inherit'] });
    tar.once('error', reject);
    tar.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))));
  });
}

async function main() {
  if (process.env.SKIP_RULE_FETCH) {
    log('SKIP_RULE_FETCH set — skipping');
    return;
  }
  if (ruleDirHasContent()) {
    log('rules/ already populated — skipping (delete its contents to refetch)');
    return;
  }
  if (!existsSync(RULES_DIR)) mkdirSync(RULES_DIR, { recursive: true });

  log(`fetching ${RULES_REPO_TARBALL}`);
  await fetchToFile(RULES_REPO_TARBALL, TMP_TARBALL);
  log(`extracting into rules/`);
  await extractTar(TMP_TARBALL, RULES_DIR);
  try { unlinkSync(TMP_TARBALL); } catch (_) { /* */ }
  log('done');
}

main().catch((err) => {
  console.warn(`[fetch-rules] skipped: ${err && err.message ? err.message : err}`);
  console.warn('[fetch-rules]   run `npm run fetch-rules` later to retry, or pull manually:');
  console.warn(`[fetch-rules]   curl -sSL ${RULES_REPO_TARBALL} | tar xz -C rules --strip-components=1`);
  // Always exit 0 so npm install succeeds even without network.
});
