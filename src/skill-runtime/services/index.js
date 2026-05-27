// Registry of local service implementations for the in-memory bus.
//
// Faithful in-browser stand-ins for the original simulator's service processes
// (skills-service-manager). Each service is registered by the same name jibo-be's
// RegistryClient looks it up by. Implementations are ported incrementally; until a
// real impl lands, a stub provides records + no-op RPCs so discovery + connection
// work (jibo-be connects, calls resolve) without the per-crash hacks.

import { ServiceBus } from './service-bus.js';

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
      const body = key ? routes[key] : {};
      return { status: 200, body };
    },
  };
}
// Response shapes match what each client validates (jibo-service-clients). Robot is
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
};

// Service names jibo-be discovers/connects to (from skills-service-manager + the
// runtime's lookups). 'expression' is the eye/animation engine we build on
// animation-utilities; 'server' is the notifications endpoint.
const SERVICE_NAMES = [
  'registry', 'system-manager', 'kb', 'body', 'expression',
  'tts', 'asr', 'listen', 'nlu', 'lps', 'media', 'notifications',
  'skills-service', 'dev-shell', 'performance', 'wifi', 'server',
  'media-proxy', 'jetstream', 'gl', 'error-service', 'secure-transfer',
  'location', 'im', 'emotion', 'embodied', 'context', 'autobot', 'action', 'volume',
];

// Build + install the bus with all services. `realImpls` maps name -> impl to
// override stubs as services get ported.
export function installServiceBus(requireFn, realImpls = {}) {
  const bus = new ServiceBus();
  const impls = Object.assign({}, REAL_HTTP, realImpls);
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
