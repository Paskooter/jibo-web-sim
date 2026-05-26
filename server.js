// Tiny Express dev server for the simulator. Serves the repo root as static
// files. No build step, no bundler — index.html + ESM does the rest.

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

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
// No `extensions` fallback here: the CommonJS require shim probes extensionless
// paths (e.g. `index`) and must get a 404 — not index.html — so it can fall
// through to `index.js`.
app.use('/external-skills', express.static(EXTERNAL_SKILLS));

app.use(express.static(__dirname, { extensions: ['html'] }));

app.listen(PORT, HOST, () => {
  console.log(`jibo-web-sim dev server listening on http://${HOST}:${PORT}/`);
});
