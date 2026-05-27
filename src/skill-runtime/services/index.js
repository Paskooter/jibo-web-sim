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
  return { name, handle() { return undefined; } };
}

// Service names jibo-be discovers/connects to (from skills-service-manager + the
// runtime's lookups). 'expression' is the eye/animation engine we build on
// animation-utilities; 'server' is the notifications endpoint.
const SERVICE_NAMES = [
  'registry', 'system-manager', 'kb', 'body', 'expression',
  'tts', 'asr', 'listen', 'nlu', 'lps', 'media', 'notifications',
  'skills-service', 'dev-shell', 'performance', 'wifi', 'server',
  'media-proxy', 'jetstream', 'gl',
];

// Build + install the bus with all services. `realImpls` maps name -> impl to
// override stubs as services get ported.
export function installServiceBus(requireFn, realImpls = {}) {
  const bus = new ServiceBus();
  for (const name of SERVICE_NAMES) {
    bus.register(name, realImpls[name] || stubService(name));
  }
  // Allow extra real services not in the default list.
  for (const name of Object.keys(realImpls)) {
    if (!bus.services.has(name)) bus.register(name, realImpls[name]);
  }
  bus.install(requireFn);
  return bus;
}
