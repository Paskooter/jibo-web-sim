// In-browser GlobalManagerService — counterpart of the runtime's
// GlobalEvents plugin.
//
// The runtime expects a service registered under the name "global-manager".
// On init it opens a WebSocket to that record's host:port path /globals
// and listens for messages of shape `{status:'OK', message:<eventName>,
// id:'', result:<ListenResult JSON>, moreinfo:''}`.
// The four message types it understands map to GlobalEvents handlers:
//   - 'skill-relaunch'        → onSkillRelaunch  → jibo.globalEvents.skillRelaunch
//                               → redirect to <match.skillID>
//   - 'skill-launch'          → onSkillLaunch    → jibo.globalEvents.skillLaunch
//   - 'global'                → onGlobal        → fires GlobalCommand events
//                               (STOP / SLEEP / VOLUME / WHATCANIDO / HELP / etc.)
//   - 'non-interrupting-global' → onNonInterrupting (perception-only signals)
//
// On a real Jibo, the listen-service wraps the jetstream client and
// re-publishes its turn results into the /globals socket. We do the
// same in the browser: subscribe to jetstream-client.events.
// {localTurnResult, globalTurnResult} and broadcast a skill-relaunch
// (or global) to every connected /globals client whenever a turn
// yields a skill match.
//
// Match-source priority for typed/spoken input:
//   1. data.result.match.skillID  (cloud's intent-router decision)
//   2. data.result.nlu.entities.skill  (dialogflow entity — most deploys
//      emit this and leave hub-side match=null because no local
//      intent-router config is loaded)
//   3. domain heuristic — a tiny lookup of on-robot skills that the
//      cloud commonly tags via entity domain.

// Intents the bundle treats as global voice commands. EXACTLY the eight
// voice events (help, voiceStop, sleep, pause, whatCanIDo, holdOn,
// volume, overHere), mapped to the uppercase names onGlobal expects.
// YES/NO/REPEAT/THANKS/CANCEL are NOT global voice events — they're
// MIM-level intents handled by the active skill's Listen rules.
// Broadcasting them as 'global' triggers the bundle's onGlobal
// "No global event found: YES" error and starves the MIM of the
// response it's waiting for.
const GLOBAL_COMMANDS = new Set([
  'STOP', 'SLEEP', 'PAUSE', 'WHATCANIDO', 'HELP',
  'HOLDON', 'OVERHERE', 'VOLUME',
]);

// Map dialogflow `entities.domain` strings to on-robot skill IDs — a
// last-resort fallback when neither match.skillID nor entities.skill is
// set. Keep this minimal: every key here is observed in real cloud
// responses, and a wrong guess would launch the wrong skill, so we
// only list the unambiguous ones.
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

// Map a NLU intent to the canonical GlobalCommand name onGlobal expects
// (uppercase, with a few intent aliases). Returns null if the intent
// isn't a global voice command.
function resolveGlobalCommand(intent) {
  if (!intent || typeof intent !== 'string') return null;
  const up = intent.toUpperCase();
  if (GLOBAL_COMMANDS.has(up)) return up;
  // Anything starting "volume*" routes through the VOLUME event.
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
  // our port, register a __wsServers entry for /globals, and start polling
  // for the jetstream client to come up (its init runs after the bus install).
  attachBus({ bus, name, port }) {
    this.bus = bus;
    this.name = name;
    this.port = port;
    this._installWsServer();
    this._waitForJetstream();
  }

  // RPC channel (RemoteClient) — global-manager has no method-RPC surface,
  // but the bus still requires a `handle` to wire it.
  handle() { return undefined; }

  // HTTP surface — GlobalEvents.announceGlobalHandler posts JSON to
  // `${host}:${port}/global` whenever a GlobalCommand listener is added
  // or removed. On-device this tells the cloud which intents the robot
  // is currently willing to handle; we don't need that information —
  // our jetstream-events binding sees every turn anyway — but the runtime
  // expects a 2xx so the XHR doesn't error. Reply 200, no body.
  handleHttp() {
    return { status: 200, body: '' };
  }

  // Register a /globals WS endpoint on our port. The fake WebSocket in
  // cjs-require tries `__wsServers.find(s => s.match(url))` for non-cloud
  // paths; the matching server's onConnection gets the peer Socket.
  // GlobalEvents builds its URL as `"ws:" + host + ":" + port + "/globals"`
  // (note: no `//`), so the regex tolerates both `ws:host:port/path`
  // and `ws://host:port/path`.
  _installWsServer() {
    if (typeof window === 'undefined') return;
    if (!window.__wsServers) window.__wsServers = [];
    const port = this.port;
    const self = this;
    this._serverEntry = {
      match(url) {
        // Accept both "ws://host:port/globals" and the "ws:host:port/globals"
        // shape GlobalEvents.init builds (it omits the `//`).
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

  // Bind to the jetstream client's events once the runtime has it. The
  // cloud bridge in cjs-require lives in the same iframe, so events
  // flow through the same module instance — once `jibo.jetstream.events`
  // exists we can subscribe directly.
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
    // Status mirrors the jetstream-client TurnResultType — SUCCEEDED is
    // the only status that carries a usable ListenResult. FAILED/TIMEDOUT/
    // etc. surface through SharedGlobalEvents.noGlobalMatch downstream.
    if (!data || data.status !== 'SUCCEEDED') return;
    const result = data.result;
    if (!result) return;

    // Order matters here. The hub commonly returns BOTH a global-command
    // intent (e.g. whatCanIDo / help) AND a concrete skill match (with
    // onRobot=true) — the hub has already chosen the skill to handle
    // the global. If we broadcast as
    // global first, the bundle's onGlobal fires but never launches a
    // skill, so the orphan cloud SKILL_ACTION sits in the CloudResponseRegistry
    // and gets culled at 10s. Any turn with a usable match.skillID
    // routes as a skill (re)launch. Skill match takes priority; the
    // global path is the FALLBACK for matchless turns (volume up, etc.).
    const intent = (result.nlu && result.nlu.intent) || '';
    const skillID = resolveSkillID(result);
    if (!skillID) {
      const globalCmd = resolveGlobalCommand(intent);
      if (globalCmd) {
        console.log('[global-manager] -> global', globalCmd);
        this._broadcast({ status: 'OK', message: 'global', id: '', result: this._serializeResult(result), moreinfo: '' });
        return;
      }
      console.log('[global-manager] no skill match (intent=', intent, ') — dropping');
      // No skill match and not a global command — the runtime's
      // noGlobalMatch path handles it locally. Nothing to push.
      return;
    }

    // Cloud-container skills (chitchat / personal-report / news /
    // answer) have match.onRobot=false and a name not in the on-robot
    // skills map. The local handler is the nimbus skill — it reads
    // match.cloudSkill and awaits
    // listenResult.cloudSkillResponse (a Promise<SKILL_ACTION-data>),
    // which the jetstream client already stamped onto
    // `result.cloudSkillResponse` in emitLocalTurnResult.
    //
    // CRITICAL: we cannot round-trip through the /globals JSON broadcast
    // for cloud matches. JSON.stringify strips the Promise, and
    // GlobalEvents.onSkillRelaunch then calls
    // `jetstream.getCloudSkillResponse(transID)` to re-add the entry —
    // but the registry's add() DELETES any existing entry and returns
    // its promise, so the SKILL_ACTION arriving later finds no entry
    // and resolves a different one entirely. Nimbus's await sits on
    // the now-orphan promise until the 8s "Cloud Skill Response
    // Timeout" fires. Skirt this by emitting skillRelaunch directly
    // with the in-memory result (cloudSkillResponse Promise intact).
    const rawMatchID = (result.match && result.match.skillID) || skillID;
    const isLocalBeSkill = typeof rawMatchID === 'string' && rawMatchID.startsWith('@be/');
    const isCloudSkill = (result.match && result.match.onRobot === false) || !isLocalBeSkill;

    if (isCloudSkill) {
      const directResult = result;       // KEEP the in-memory ListenResult with cloudSkillResponse
      directResult.match = directResult.match || {};
      directResult.match.cloudSkill = rawMatchID;
      directResult.match.skillID = '@be/nimbus';
      // onRobot stays false — redirect doesn't read it, but anything
      // downstream that does will see the truthful "cloud" mark.
      if (directResult.nlu && !directResult.nlu.skill) directResult.nlu.skill = '@be/nimbus';
      console.log('[global-manager] -> skillRelaunch.emit @be/nimbus (cloud=' + rawMatchID + ') direct');
      try {
        if (this._jsApi && this._jsApi.events) {
          // (no-op: just for diagnostics; the real handle is below)
        }
        const ge = (typeof window !== 'undefined' && window.jibo && window.jibo.globalEvents);
        if (ge && ge.skillRelaunch && typeof ge.skillRelaunch.emit === 'function') {
          ge.skillRelaunch.emit(directResult);
        } else {
          console.warn('[global-manager] jibo.globalEvents.skillRelaunch not available; falling back to /globals');
          const enriched = this._serializeResult(directResult);
          this._broadcast({ status: 'OK', message: 'skill-relaunch', id: '', result: enriched, moreinfo: '' });
        }
      } catch (e) { console.warn('[global-manager] direct skillRelaunch failed:', e && e.message); }
      return;
    }

    // On-robot skill: the /globals broadcast path is safe — there's no
    // Promise to preserve, onSkillRelaunch's getCloudSkillResponse only
    // fires when !match.onRobot, and the redirect can find this.skills[id].
    const enriched = this._serializeResult(result);
    enriched.match = enriched.match || {};
    enriched.match.skillID = rawMatchID;
    if (enriched.match.onRobot === undefined) enriched.match.onRobot = true;
    if (enriched.nlu && !enriched.nlu.skill) enriched.nlu.skill = rawMatchID;
    console.log('[global-manager] -> skill-relaunch', rawMatchID, '(clients=' + this.clients.size + ')');
    // Envelope is {status, message:<tag>, id, result, moreinfo}.
    // GlobalEvents.onMessage only reads .status + .message + .result,
    // but match the full shape so anything that re-broadcasts/proxies
    // our payload sees an identical envelope.
    this._broadcast({ status: 'OK', message: 'skill-relaunch', id: '', result: enriched, moreinfo: '' });
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
      // NLParse + Input mirror the NLU output shape that on-robot
      // skills read directly (e.g. chitchat's InitState.addEmotionInfo
      // hits `data.asrResult.NLParse.valenceImpact`). They survive the
      // JSON round-trip only if both this serializer AND the bundle-side
      // ListenResult.fromJSON preserve them; boot.js monkey-patches the
      // latter (see patchListenResultFromJSON).
      NLParse: result.NLParse || null,
      Input: result.Input || (result.asr && result.asr.text) || '',
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
