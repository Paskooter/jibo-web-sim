// Tiny Express dev server for the simulator. Serves the repo root as static
// files. No build step, no bundler — index.html + ESM does the rest.

import express from 'express';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket as WS } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';

// Pegasus hub auth: it accepts a Bearer JWT signed with HS256 using
// process.env.ETCO_server_webTokenSecret. The default dev/local secret +
// credentials are public defaults baked into hub-client-cli
// (packages/hub-client-cli/utils/authentication.ts + resources/credentials.json).
// Override via env if the user's deployment changes them.
const HUB_SECRET = process.env.HUB_AUTH_SECRET || 'uHGhXhdXzBybGX7YHuEwAFZC';
const HUB_CREDENTIALS = {
  id: process.env.HUB_AUTH_ID || 'hub-client-account-id',
  accessKeyId: process.env.HUB_AUTH_ACCESS_KEY_ID || 'hub-client-access-key-id',
  secretAccessKey: process.env.HUB_AUTH_SECRET_ACCESS_KEY || 'hub-client-secret-access-key',
  friendlyId: process.env.HUB_AUTH_FRIENDLY_ID || 'hub-client-friendly-id',
};
const HUB_BEARER = (() => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(HUB_CREDENTIALS);
  const sig = crypto.createHmac('sha256', HUB_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
})();
// Expose the friendlyId so the iframe/bridge can stamp CONTEXT.general explicitly
// if it ever wants to skip the hub's auto-fill path.
const HUB_AUTH_PUBLIC = { id: HUB_CREDENTIALS.id, friendlyId: HUB_CREDENTIALS.friendlyId };

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
// Compat patch (must precede the static handler): jibo's CRN texture-decode
// worker posts its decoded texture back to the main thread as a TRANSFERABLE
// (`postMessage({...}, [dxtData.buffer])`), but that buffer is a view into the
// emscripten heap and isn't detachable in our Chrome — the worker's postMessage
// throws and ANY .crn asset load (e.g. the MainMenu button atlas) hangs forever.
// Serve the worker with the transfer list dropped so the buffer is
// structured-cloned (copied) instead — identical result, just not zero-copy.
// Served at its real URL (not a blob) so the worker's relative .crn XHR still
// resolves against its http origin.
app.get(/webgl-texture-util\.js$/, (req, res, next) => {
  const prefix = '/external-skills/';
  if (!req.path.startsWith(prefix)) { next(); return; }
  const abs = normalize(join(EXTERNAL_SKILLS, req.path.slice(prefix.length)));
  if (!abs.startsWith(normalize(EXTERNAL_SKILLS))) { next(); return; }
  let src;
  try { src = readFileSync(abs, 'utf8'); } catch (_) { next(); return; }
  res.type('application/javascript').send(src.replace(/,\s*\[\s*dxtData\.buffer\s*\|\|\s*dxtData\s*\]\s*\)/g, ')'));
});

// @be/* skills reference animation textures (White_Eye.png etc.) under their
// own animations/textures/ folder but the directory doesn't exist in their
// bundle — the textures live in jibo-anim-db-animations/animations/textures/.
// Animations themselves come from the shared anim-db (KeysAnimation loads
// them by name from the global manifest), and their texture refs are
// resolved relative to the *playing skill's* assetPack root, so each
// consuming skill needs the same redirect. Nimbus hit this first (M57);
// @be/idle, @be/clock, @be/main-menu, @be/first-contact etc. all use the
// same anim-db named animations and reproduce the same ENOENT.
//
// Match any @be/<skill>/animations/textures/<subpath> and probe the
// anim-db copy. The capture is greedy on the subpath because anim-db
// textures are organized in subdirectories (e.g. jibojis/coin-flip/
// coin-tails.png) — not just leaf filenames.
app.get(/\/@be\/[^/]+\/animations\/textures\/(.+)$/, (req, res, next) => {
  const m = /\/@be\/[^/]+\/animations\/textures\/(.+)$/.exec(req.path);
  if (!m) { next(); return; }
  const subpath = m[1];
  const fallback = `/external-skills/jibo-be/node_modules/jibo-anim-db-animations/animations/textures/${subpath}`;
  // Probe disk to avoid an infinite loop if the fallback is also missing.
  try {
    const abs = normalize(join(EXTERNAL_SKILLS, fallback.slice('/external-skills/'.length)));
    if (existsSync(abs)) return res.redirect(302, fallback);
  } catch (_) { /* fall through */ }
  next();
});

app.use('/external-skills', express.static(EXTERNAL_SKILLS, { index: false, redirect: false }));

// Recursive file manifest for a served skill dir. The CommonJS require shim uses
// this to resolve modules WITHOUT probing (each missing probe is a console 404),
// which otherwise floods the devtools console with thousands of failed requests.
// Supports both external bundles (/external-skills/...) and in-repo demo skills
// (/skills/...). With a manifest in hand the shim treats every path outside the
// skill root as known-missing, eliminating the require()-walk's higher-up
// node_modules/ probes (e.g. /node_modules/pixi.js → 404 cascade in SHIM mode).
app.get('/__list', (req, res) => {
  const root = String(req.query.root || '');
  let baseAbs = null;
  if (root.startsWith('/external-skills/')) {
    baseAbs = normalize(join(EXTERNAL_SKILLS, root.slice('/external-skills/'.length)));
    if (!baseAbs.startsWith(normalize(EXTERNAL_SKILLS))) { res.status(400).json({ files: [] }); return; }
  } else if (root.startsWith('/skills/')) {
    baseAbs = normalize(join(__dirname, root.replace(/^\//, '')));
    if (!baseAbs.startsWith(normalize(join(__dirname, 'skills')))) { res.status(400).json({ files: [] }); return; }
  } else {
    res.json({ files: [] }); return;
  }
  // Files are { url, size } so the browser shim can satisfy fstat() WITHOUT
  // pre-fetching every file body. chitchat's postInit walks ~3900 mim files
  // via FileUtils.findAllFilesWithExt and only checks isFile/isDirectory —
  // sending sizes here lets open() return a lazy fd whose body is fetched
  // only on first read.
  const files = [];
  const walk = (absDir, urlDir) => {
    let entries;
    try { entries = readdirSync(absDir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const url = `${urlDir}/${e.name}`;
      if (e.isDirectory()) walk(join(absDir, e.name), url);
      else {
        let size = 0;
        try { size = statSync(join(absDir, e.name)).size; } catch (_) { /* keep 0 */ }
        files.push({ url, size });
      }
    }
  };
  walk(baseAbs, root.replace(/\/$/, ''));
  res.json({ files });
});

// Cross-origin image proxy. Skill SKILL_ACTIONs (notably news from
// report-skill) reference remote thumbnail/article images by absolute URL.
// PIXI loads them through HTMLImageElement with crossOrigin='anonymous', but
// most public image servers don't return Access-Control-Allow-Origin — the
// image displays in <img> tags but texImage2D refuses to upload it as a
// WebGL texture ("SecurityError: image element contains cross-origin data").
// Once the upload fails, the sprite's _texture stays null and PIXI's
// SpriteRenderer.flush crashes every frame reading baseTexture → endless
// console spam.
// /__img?url=<encoded> fetches the remote image server-side and replays
// the bytes back as same-origin, side-stepping CORS entirely.
app.get('/__img', (req, res) => {
  const target = String(req.query.url || '');
  if (!/^https?:\/\//i.test(target)) { res.status(400).type('text/plain').send('bad url'); return; }
  const libFor = (u) => (u.startsWith('https') ? https : http);
  const proxyOne = (url, allowRedirect) => {
    libFor(url).get(url, { headers: { 'User-Agent': 'jibo-web-sim' } }, (upstream) => {
      if (allowRedirect && upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
        const loc = upstream.headers.location;
        const next = /^https?:\/\//i.test(loc) ? loc : new URL(loc, url).toString();
        upstream.resume();           // discard the redirect body
        proxyOne(next, false);
        return;
      }
      res.status(upstream.statusCode || 502);
      for (const [k, v] of Object.entries(upstream.headers)) {
        if (/^(transfer-encoding|connection|content-security-policy|access-control-allow-origin)$/i.test(k)) continue;
        res.setHeader(k, v);
      }
      res.setHeader('Access-Control-Allow-Origin', '*');
      upstream.pipe(res);
    }).on('error', (e) => res.status(502).type('text/plain').send(e.message));
  };
  proxyOne(target, true);
});

// Same-origin proxy to a Pegasus cloud backend, to dodge CORS. The iframe sends
// `/__cloud<path>` with `X-Cloud-Upstream: <host>:<port>` (or `?upstream=`); we
// forward the request to that upstream and stream the response back. Browsers
// don't enforce CORS on the server-to-server hop, so the original jibo cloud
// (designed for Electron, no CORS) works unmodified through the proxy.
app.use('/__cloud', express.raw({ type: '*/*', limit: '32mb' }), (req, res) => {
  const upstream = String(req.headers['x-cloud-upstream'] || req.query.upstream || '').trim();
  if (!upstream || !/^[\w.-]+(:\d+)?$/.test(upstream)) {
    res.status(400).type('text/plain').send('missing or invalid X-Cloud-Upstream');
    return;
  }
  const [uhost, uportStr] = upstream.split(':');
  const uport = uportStr ? Number(uportStr) : 80;
  // Forward all headers except hop-by-hop + the cloud-upstream pointer itself.
  const fwdHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (/^(host|connection|content-length|x-cloud-upstream|origin|referer)$/i.test(k)) continue;
    fwdHeaders[k] = v;
  }
  fwdHeaders.host = upstream;
  if (!fwdHeaders.authorization) fwdHeaders.authorization = `Bearer ${HUB_BEARER}`;
  const upreq = http.request({
    host: uhost, port: uport, path: req.url || '/', method: req.method, headers: fwdHeaders,
  }, (upres) => {
    res.status(upres.statusCode || 502);
    for (const [k, v] of Object.entries(upres.headers)) {
      if (/^(transfer-encoding|connection)$/i.test(k)) continue;
      res.setHeader(k, v);
    }
    upres.pipe(res);
  });
  upreq.on('error', (e) => { res.status(502).type('text/plain').send(`upstream error: ${e.message}`); });
  if (req.body && req.body.length) upreq.write(req.body);
  upreq.end();
});

// Browser defaults to fetching /favicon.ico — a 204 keeps the address bar
// from showing a 404 and stops devtools from logging it on every reload.
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.use(express.static(__dirname, { extensions: ['html'] }));

const server = app.listen(PORT, HOST, () => {
  console.log(`jibo-web-sim dev server listening on http://${HOST}:${PORT}/`);
});

// WebSocket proxy to a Pegasus hub. Browsers can't set custom WS-upgrade headers
// (the hub requires X-JIBO-transID per connection and uses a new socket per
// turn), so the browser opens
//   ws://<sim>/__cloud-ws?upstream=<host>:<port>&path=<p>&transID=<id>[&robotID=<r>]
// and the server upgrades both sides and pipes frames between them, injecting
// the X-JIBO-transID / X-JIBO-robotID headers on the upstream handshake.
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, sock, head) => {
  if (!req.url || !req.url.startsWith('/__cloud-ws')) { sock.destroy(); return; }
  const u = new URL(req.url, 'http://x');
  const upstream = u.searchParams.get('upstream');
  const path = u.searchParams.get('path') || '/';
  const transID = u.searchParams.get('transID') || '';
  const robotID = u.searchParams.get('robotID') || 'web-sim-robot';
  if (!upstream || !/^[\w.-]+(:\d+)?$/.test(upstream)) { sock.destroy(); return; }
  wss.handleUpgrade(req, sock, head, (clientWS) => {
    const upstreamWS = new WS(`ws://${upstream}${path}`, {
      headers: {
        Authorization: `Bearer ${HUB_BEARER}`,
        'X-JIBO-transID': transID,
        'X-JIBO-robotID': robotID,
      },
    });
    let opened = false;
    const cleanup = () => { try { clientWS.close(); } catch (_) {} try { upstreamWS.close(); } catch (_) {} };
    upstreamWS.on('open', () => { opened = true; });
    // The hub sends FRAME_TEXT (ClientCloudConnection.cpp:242). The `ws` library
    // delivers all frames as Buffer by default, and forwarding a Buffer via
    // clientWS.send(buf) emits a BINARY frame -- browsers then expose ev.data as
    // a Blob and jetstream-client's JSON.parse fails. Honor isBinary in both
    // directions: relay text as string, binary as Buffer.
    const relay = (sink, data, isBinary) => { try { sink.send(isBinary ? data : data.toString('utf8'), { binary: !!isBinary }); } catch (_) { /* sink closed */ } };
    const pending = [];
    clientWS.on('message', (data, isBinary) => { if (opened) relay(upstreamWS, data, isBinary); else pending.push([data, isBinary]); });
    upstreamWS.on('open', () => { for (const [d, b] of pending) relay(upstreamWS, d, b); pending.length = 0; });
    upstreamWS.on('message', (data, isBinary) => relay(clientWS, data, isBinary));
    upstreamWS.on('close', cleanup);
    clientWS.on('close', cleanup);
    upstreamWS.on('error', (e) => { try { clientWS.send(JSON.stringify({ type: 'ERROR', data: { message: 'upstream WS error: ' + e.message } })); } catch (_) {} cleanup(); });
    clientWS.on('error', cleanup);
  });
});
