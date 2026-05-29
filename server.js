// Tiny Express dev server for the simulator. Serves the repo root as static
// files. No build step, no bundler — index.html + ESM does the rest.

import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket as WS } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';

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
