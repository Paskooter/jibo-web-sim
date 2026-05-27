// Tiny Express dev server for the simulator. Serves the repo root as static
// files. No build step, no bundler — index.html + ESM does the rest.

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { readdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();

// Disable any caching so edits are picked up on refresh.
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// Dev-only: serve external skill bundles for in-place compatibility testing
// (e.g. the original jibo-be), kept OUT of the repo. Point EXTERNAL_SKILLS at a
// directory of unpacked bundles; defaults to /tmp.
const EXTERNAL_SKILLS = process.env.EXTERNAL_SKILLS || '/tmp';
// The CommonJS require shim probes extensionless paths (`index`) and bare
// directories (`node_modules/@be/clock`). Disable the `extensions`/`index`/
// `redirect` fallbacks so those 404 instead of returning a directory's
// index.html — letting the shim fall through to `.js` / package.json `main`.
app.use('/external-skills', express.static(EXTERNAL_SKILLS, { index: false, redirect: false }));

// Recursive file manifest for a served skill dir. The CommonJS require shim uses
// this to resolve modules WITHOUT probing (each missing probe is a console 404),
// which otherwise floods the devtools console with thousands of failed requests.
app.get('/__list', (req, res) => {
  const root = String(req.query.root || '');
  const prefix = '/external-skills/';
  if (!root.startsWith(prefix)) { res.json({ files: [] }); return; }
  const baseAbs = normalize(join(EXTERNAL_SKILLS, root.slice(prefix.length)));
  if (!baseAbs.startsWith(normalize(EXTERNAL_SKILLS))) { res.status(400).json({ files: [] }); return; }
  const files = [];
  const walk = (absDir, urlDir) => {
    let entries;
    try { entries = readdirSync(absDir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const url = `${urlDir}/${e.name}`;
      if (e.isDirectory()) walk(join(absDir, e.name), url);
      else files.push(url);
    }
  };
  walk(baseAbs, root.replace(/\/$/, ''));
  res.json({ files });
});

app.use(express.static(__dirname, { extensions: ['html'] }));

app.listen(PORT, HOST, () => {
  console.log(`jibo-web-sim dev server listening on http://${HOST}:${PORT}/`);
});
