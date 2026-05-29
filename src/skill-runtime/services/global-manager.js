// In-browser GlobalManagerService — the SSM-side counterpart of jibo's
// GlobalEvents plugin.
//
// jibo-be's runtime expects a service registered under the name "global-manager"
// (jibo.js ServicesPlugin.serviceInit['global-manager']). On init it opens a
// WebSocket to that record's host:port path /globals and listens for messages
// of shape `{status:'OK', message:<eventName>, result:<ListenResult JSON>}`.
// The four message types it understands map to GlobalEvents handlers:
//   - 'skill-relaunch'        → onSkillRelaunch  → jibo.globalEvents.skillRelaunch
//                               → be (index.js)  → Be.redirect(<match.skillID>)
//   - 'skill-launch'          → onSkillLaunch    → jibo.globalEvents.skillLaunch
//   - 'global'                → onGlobal        → fires GlobalCommand events
//                               (STOP / SLEEP / VOLUME / WHATCANIDO / HELP / etc.)
//   - 'non-interrupting-global' → onNonInterrupting (perception-only signals)
//
// In a real Jibo, the SSM's listen-service + GlobalListen wraps jetstream-client
// and re-publishes its turn results into the /globals socket. We do the same in
// the browser: subscribe to jetstream-client.events.{localTurnResult,
// globalTurnResult} and broadcast a skill-relaunch (or global) to every
// connected /globals client whenever a turn yields a skill match.
//
// Match-source priority for typed/spoken input:
//   1. data.result.match.skillID  (cloud's IntentRouter decision)
//   2. data.result.nlu.entities.skill  (dialogflow entity — the user's pegasus
//      deploys mostly emit this and leave hub-side match=null because no local
//      IR config is loaded)
//   3. domain heuristic ("clock" → "@be/clock") — a tiny lookup of @be/*
//      skills that the cloud commonly tags via entity domain.

// Intents the runtime treats as global voice commands (not skill switches).
// Mirrors jibo/jibo-common-types.GlobalCommand — anything matching here goes
// through onGlobal instead of onSkillRelaunch.
const GLOBAL_COMMANDS = new Set([
  'STOP', 'SLEEP', 'WAKE', 'WHATCANIDO', 'HELP', 'CANCEL',
  'HOLDON', 'OVERHERE', 'YES', 'NO', 'REPEAT', 'THANKS',
]);

// Map dialogflow `entities.domain` strings to @be/* skill IDs — a last-resort
// fallback when neither match.skillID nor entities.skill is set. Keep this
// minimal: every key here is observed in real cloud responses, and a wrong
// guess would launch the wrong skill, so we only list the unambiguous ones.
const DOMAIN_TO_SKILL = {
  clock: '@be/clock',
  greetings: '@be/greetings',
  weather: '@be/personal-report',
  radio: '@be/radio',
  chitchat: '@be/chitchat',
  surprises: '@be/surprises',
  introductions: '@be/introductions',
  'main-menu': '@be/main-menu',
  settings: '@be/settings',
};

function resolveSkillID(result) {
  if (!result) return null;
  const match = result.match;
  if (match && typeof match.skillID === 'string' && match.skillID) return match.skillID;
  const nlu = result.nlu;
  const ent = nlu && nlu.entities;
  if (ent) {
    if (typeof ent.skill === 'string' && ent.skill) return ent.skill;
    if (typeof ent.domain === 'string' && DOMAIN_TO_SKILL[ent.domain]) {
      return DOMAIN_TO_SKILL[ent.domain];
    }
  }
  return null;
}

// Map a NLU intent to the canonical GlobalCommand name jibo.onGlobal expects
// (uppercase, with a few intent aliases). Returns null if the intent isn't a
// global voice command.
function resolveGlobalCommand(intent) {
  if (!intent || typeof intent !== 'string') return null;
  const up = intent.toUpperCase();
  if (GLOBAL_COMMANDS.has(up)) return up;
  // Anything starting "volume*" routes through the VOLUME event (see jibo.js
  // onGlobal: `if (action.match(/^volume/)) action = 'volume'`).
  if (/^volume/i.test(intent)) return 'VOLUME';
  return null;
}

export class GlobalManagerService {
  constructor() {
    this.clients = new Set();   // server-side Sockets for connected /globals clients
    this.bus = null;
    this.port = null;
    this._serverEntry = null;
    this._jsApi = null;
    this._jsBound = false;
  }

  // ServiceBus integration: gets called once on register. We use it to learn
  // our port, register a __wsServers entry for /globals, and start polling for
  // jetstream-client to come up (jet-stream init() runs after the bus install).
  attachBus({ bus, name, port }) {
    this.bus = bus;
    this.name = name;
    this.port = port;
    this._installWsServer();
    this._waitForJetstream();
  }

  // RPC channel (RemoteClient) — global-manager has no method-RPC surface, but
  // jibo-client-framework still requires a `handle` for the bus to wire it.
  handle() { return undefined; }

  // HTTP surface (jibo.js GlobalEvents.announceGlobalHandler posts JSON to
  // `${host}:${port}/global` whenever a GlobalCommand listener is added or
  // removed). The real SSM uses this to tell the cloud which intents the
  // robot is currently willing to handle; we don't need that information —
  // our jetstream-events binding sees every turn anyway — but the runtime
  // expects a 2xx so the XHR doesn't error. Reply 200, no body.
  handleHttp() {
    return { status: 200, body: '' };
  }

  // Register a /globals WS endpoint on our port. cjs-require's fake WebSocket
  // tries `__wsServers.find(s => s.match(url))` for non-cloud paths; the
  // matching server's onConnection gets the peer Socket. jibo.js's GlobalEvents
  // builds its URL as `"ws:" + host + ":" + port + "/globals"` (note: no `//`),
  // so the regex tolerates both `ws:host:port/path` and `ws://host:port/path`.
  _installWsServer() {
    if (typeof window === 'undefined') return;
    if (!window.__wsServers) window.__wsServers = [];
    const port = this.port;
    const self = this;
    this._serverEntry = {
      match(url) {
        // Accept both "ws://host:port/globals" and the "ws:host:port/globals"
        // shape jibo.js GlobalEvents.init builds (it omits the `//`).
        const stripped = String(url).replace(/^wss?:\/?\/?/, '');
        const slash = stripped.indexOf('/');
        const authority = slash === -1 ? stripped : stripped.slice(0, slash);
        const path = slash === -1 ? '/' : stripped.slice(slash);
        const portStr = authority.split(':').pop();
        return Number(portStr) === port && path === '/globals';
      },
      onConnection(serverSock) {
        self.clients.add(serverSock);
        console.log('[global-manager] /globals client connected (total=' + self.clients.size + ')');
        if (typeof serverSock.on === 'function') serverSock.on('close', () => {
          self.clients.delete(serverSock);
          console.log('[global-manager] /globals client disconnected (total=' + self.clients.size + ')');
        });
      },
    };
    window.__wsServers.push(this._serverEntry);
  }

  // Bind to jetstream-client's events once the runtime has it. The cloud
  // bridge in cjs-require lives in the same iframe, so events flow through
  // the same module instance — once `jibo.jetstream.events` exists we can
  // subscribe directly.
  _waitForJetstream() {
    if (typeof window === 'undefined') return;
    const tryBind = () => {
      if (this._jsBound) return;
      const js = window.jibo && window.jibo.jetstream;
      const ev = js && js.events;
      if (!ev) { setTimeout(tryBind, 100); return; }
      this._jsApi = js;
      ev.localTurnResult.on((d) => this._onTurnResult(d, false));
      ev.globalTurnResult.on((d) => this._onTurnResult(d, true));
      this._jsBound = true;
      console.log('[global-manager] bound to jetstream events');
    };
    setTimeout(tryBind, 100);
  }

  _onTurnResult(data, isGlobal) {
    console.log('[global-manager] turn result:', isGlobal ? 'GLOBAL' : 'LOCAL', 'status=', data && data.status, 'intent=', (data && data.result && data.result.nlu && data.result.nlu.intent), 'match=', (data && data.result && data.result.match));
    // Status mirrors jetstream-client TurnResultType — SUCCEEDED is the only
    // status that carries a usable ListenResult. FAILED/TIMEDOUT/etc. surface
    // through SharedGlobalEvents.noGlobalMatch on the be side.
    if (!data || data.status !== 'SUCCEEDED') return;
    const result = data.result;
    if (!result) return;

    const intent = (result.nlu && result.nlu.intent) || '';
    const globalCmd = resolveGlobalCommand(intent);
    if (globalCmd) {
      // Volume etc. — match isn't needed; onGlobal reads result.nlu.intent.
      console.log('[global-manager] -> global', globalCmd);
      this._broadcast({ status: 'OK', message: 'global', result: this._serializeResult(result) });
      return;
    }

    const skillID = resolveSkillID(result);
    if (!skillID) {
      console.log('[global-manager] no skill match (intent=', intent, ') — dropping');
      // No skill match and not a global command — be's noGlobalMatch path
      // handles it locally. Nothing to push.
      return;
    }

    // The hub may set match.onRobot=false for cloud-container skills
    // (chitchat-skill / personal-report-skill / news / answer). Those names
    // never appear in @be/be's skills map (it keys by @be/* package names),
    // so a naive redirect crashes Be.redirect with "Cannot read properties
    // of undefined (reading 'assetPack')". For those, the local handler is
    // @be/nimbus — it reads match.cloudSkill + awaits cloudSkillResponse
    // to execute the cloud container's SKILL_ACTION payload.
    //
    // Two fields drive nimbus's open():
    //  - match.skillID — rewritten to '@be/nimbus' so be/index.js's
    //    skillRelaunch handler can find this.skills[skillID].
    //  - listenResult.cloudSkillResponse — a Promise<SKILL_ACTION-data>.
    //    NOT set here; GlobalEvents.onSkillRelaunch (jibo.js:19634) stamps
    //    it from `jetstream.getCloudSkillResponse(transID)` IFF
    //    !match.onRobot. So we MUST leave match.onRobot=false (not flip
    //    it to true) — otherwise nimbus opens with an undefined
    //    cloudSkillResponse and throws "Nimbus launched without complete
    //    ListenResult; unable to proceed!".
    // The original cloud-skill name is preserved on match.cloudSkill so
    // nimbus reads it in its Open state.
    const enriched = this._serializeResult(result);
    enriched.match = enriched.match || {};
    const rawMatch = enriched.match.skillID || skillID;
    const isLocalBeSkill = typeof rawMatch === 'string' && rawMatch.startsWith('@be/');
    let routedSkillID;
    if (enriched.match.onRobot === false || !isLocalBeSkill) {
      enriched.match.cloudSkill = rawMatch;
      routedSkillID = '@be/nimbus';
      enriched.match.skillID = '@be/nimbus';
      enriched.match.onRobot = false;     // keep so cloudSkillResponse gets wired
    } else {
      routedSkillID = rawMatch;
      enriched.match.skillID = rawMatch;
      if (enriched.match.onRobot === undefined) enriched.match.onRobot = true;
    }
    // Mirror the nlu.skill field that @be/be-framework.onSkillRelaunch reads
    // (skillData.nlu.skill — see be-framework lib line ~190).
    if (enriched.nlu && !enriched.nlu.skill) enriched.nlu.skill = routedSkillID;
    console.log('[global-manager] -> skill-relaunch', routedSkillID, enriched.match.cloudSkill ? '(cloud=' + enriched.match.cloudSkill + ')' : '', '(clients=' + this.clients.size + ')');

    this._broadcast({ status: 'OK', message: 'skill-relaunch', result: enriched });
  }

  // ListenResult instances expose getters (text, intent) — flatten to plain
  // data so JSON.stringify produces the same shape onSkillRelaunch's
  // ListenResult.fromJSON expects: { asr, nlu, match }.
  _serializeResult(result) {
    if (!result) return null;
    return {
      asr: result.asr || null,
      nlu: result.nlu || null,
      match: result.match || null,
      // pass through optional fields the cloud may stamp
      transID: result.transID,
      state: result.state,
    };
  }

  _broadcast(obj) {
    if (!this.clients.size) return;
    const text = JSON.stringify(obj);
    for (const sock of this.clients) {
      try { sock.send(text); } catch (_) { /* client gone */ }
    }
  }
}

export default GlobalManagerService;
