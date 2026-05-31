// Registry of local service implementations for the in-memory bus.
//
// Faithful in-browser stand-ins for the on-device service processes
// the runtime would otherwise talk to. Each service is registered by
// the same name the runtime's RegistryClient looks it up by.
// Implementations are ported incrementally; until a real impl lands,
// a stub provides records + no-op RPCs so discovery + connection
// work without the per-crash hacks.

import { ServiceBus } from './service-bus.js';
import { GlobalManagerService } from './global-manager.js';
import { ttsService } from './tts-service.js';

// A default service impl: RPCs resolve to undefined (degrade gracefully), no events.
function stubService(name) {
  return { name, handle() { return undefined; }, handleHttp() { return { status: 200, body: {} }; } };
}

// HTTP services (clients use raw XHR to http://host:<port>/<path>). Faithful
// minimal responses so the framework's state queries succeed offline.
function httpService(name, routes) {
  return {
    name,
    handle() { return undefined; },
    handleHttp(method, path) {
      const key = Object.keys(routes).find((re) => new RegExp(re).test(path));
      const v = key ? routes[key] : {};
      // A route value may be a body, or {status, body} for non-200 (e.g. 204).
      if (v && typeof v === 'object' && 'status' in v && 'body' in v) return v;
      return { status: 200, body: v };
    },
  };
}
// Response shapes match what each service client validates. Robot is
// in a normal interactive mode, on wifi, with no pending errors/backups. Specific
// routes are matched before the '' catch-all (insertion order).
const REAL_HTTP = {
  'system-manager': httpService('system-manager', {
    '/mode': { mode: 'normal' },
    '/version': { version: '12.0.0' },
    '/time/current': { time: Date.now() },
    '/time/zone': { timezone: 'UTC' },
  }),
  wifi: httpService('wifi', {
    '/verify_connection': { errorCode: 0, code: 0, success: true },
    '/get_saved_networks': { networks: [] },
    '': { connected: true, online: true, errorCode: 0 },
  }),
  'error-service': httpService('error-service', {
    '/getCurrentErrorId': { currentErrorId: null },
    '/getErrorCount': { errorCount: 0 },
    '': {},
  }),
  'secure-transfer': httpService('secure-transfer', {
    '/hasBackupData': { isReady: false },
    '': {},
  }),
  // MediaManagerService — on-device the service registers both
  // 'media-manager' AND alias 'media-proxy', with HTTP routes for
  // adopt/upload/download/delete/audiostreamstart/audiostreamstop/
  // speakerlevel and a /proxy/media/photo/get?id=<id> photo proxy.
  // We 200/no-op them since skills don't crash on the response shape,
  // only on the lack of a record. The same impl is registered under
  // both names so jibo.media's record lookup AND the service-client
  // mediaManager.init (which keys on 'media-manager') both succeed.
  'media-manager': httpService('media-manager', { '': '' }),
  'media-proxy': httpService('media-proxy', { '': '' }),
  // RemoteService — on-device this hosts a /remote WS for Loop
  // iOS/Android pairing. The remote skill connects + waits; no client
  // ever pairs in the sim, so we 200 the HTTP surface and return empty
  // success to keep the skill's init from throwing.
  remote: httpService('remote', { '': { status: 'OK' } }),
  // SchedulerService — exposes /add /remove /list /has-job for cron
  // (the OTA update check is scheduled via this). Return empty-list
  // canned-OK so 'list' calls resolve and 'has-job' reports false
  // without crashing.
  scheduler: httpService('scheduler', {
    '/list': { jobs: [] },
    '/has-job': { hasJob: false },
    '': { status: 'OK' },
  }),
  // TTSService — Web Speech driver behind the full embodied-dialog speak
  // pipeline. See services/tts-service.js for the contract; /tts_speak
  // now blocks for the real duration of speech so the timeline + per-word
  // expression animations pace correctly.
  tts: ttsService,
  // Body HTTP side (LED backlight / fan settings): GET /settings -> current
  // settings (200 + JSON); POST /settings -> 204.
  body: {
    name: 'body',
    handle() { return undefined; },
    handleHttp(method, path) {
      if (/\/settings/.test(path)) {
        if (method === 'POST') return { status: 204, body: '' };
        return { status: 200, body: { lcd_backlight: 1, fan_mode: 0, fan_speed: 0 } };
      }
      return { status: 200, body: {} };
    },
  },
};

// Service names the runtime discovers/connects to. 'media-proxy' is an
// alias the real MediaManagerService also registers itself under.
// 'expression' is the eye/animation engine we build on animation-utilities;
// 'server' is the notifications endpoint; 'global-manager' is the
// cloud-event-to-skill-relaunch bridge that drives skill redirects.
// Sim-only auxiliary services (jetstream, asr, listen, nlu, media, gl,
// im, emotion, embodied, context, autobot, action, volume, location)
// are stubbed for the runtime's service-discovery iteration to succeed
// without a record-miss.
const SERVICE_NAMES = [
  'registry', 'system-manager', 'kb', 'body', 'expression',
  'tts', 'asr', 'listen', 'nlu', 'lps', 'media', 'notifications',
  'skills-service', 'dev-shell', 'performance', 'wifi', 'server',
  'media-manager', 'media-proxy', 'jetstream', 'gl', 'error-service', 'secure-transfer',
  'location', 'im', 'emotion', 'embodied', 'context', 'autobot', 'action', 'volume',
  'global-manager', 'remote', 'scheduler',
];

// Real impls bundled with the bus (overlay onto REAL_HTTP + caller realImpls).
const REAL_SERVICES = {
  'global-manager': new GlobalManagerService(),
};

// Build + install the bus with all services. `realImpls` maps name -> impl to
// override stubs as services get ported.
export function installServiceBus(requireFn, realImpls = {}) {
  const bus = new ServiceBus();
  const impls = Object.assign({}, REAL_HTTP, REAL_SERVICES, realImpls);
  for (const name of SERVICE_NAMES) {
    bus.register(name, impls[name] || stubService(name));
  }
  // Allow extra real services not in the default list.
  for (const name of Object.keys(impls)) {
    if (!bus.services.has(name)) bus.register(name, impls[name]);
  }
  bus.install(requireFn);
  bus.installHttpInterceptor();
  return bus;
}
