# 06 - jetstream-client and the Pegasus Hub protocol

Reference for `@jibo/jetstream-client` (every robot skill, Embodied Listen, and the SSM
use this to talk to the cloud hub) and the wire protocol it speaks.

Sources of truth:
- `/tmp/sdk/packages/jetstream-client/src/{Api,Client,CloudResponseRegistry,Events,HotwordMode,Request,Types,Utils,index}.ts`
- `/tmp/pegasus-phoenix/packages/hub/src/{HubService,listen/ListenTransactionHandler,intent/DecisionMediator,skill/SkillRequestMaker,config/SkillConfigManager,utils/MessagePreProcessor}.ts`
- `/tmp/pegasus-phoenix/packages/utils/src/service/{BaseService,JiboHeaders,PegasusWebSocket}.ts`
- `/tmp/jibo-be/node_modules/@jibo/interfaces/lib/{interfaces.js,dts/{service,hub/request,hub/MessageType}.d.ts}`

Naming: the package exposes itself under the runtime namespace `jibo.jetstream`.

---

## 1. Module surface (`Api.ts`)

Singleton + global emitter (`Api.ts:31,39`):

```ts
let client = new Client();
export let events: Events = client.events;
```

Public exports, signatures verbatim:

```ts
export async function init(options: types.HostOptions, log?: JiboLog): Promise<void>                                                  // Api.ts:48
export function close(): void                                                                                                          // Api.ts:62
export async function triggerProactive(data: types.ProactiveRequestData): Promise<request.ProactiveRequest>                            // Api.ts:72
export async function startLocalTurn(data: types.LocalTurnOptions): Promise<request.LocalTurnRequest>                                  // Api.ts:87
export async function mimicGlobalTurn(data: types.MimicGlobalTurnOptions): Promise<request.Request>                                    // Api.ts:102
export async function subscribeGlobal(data: types.SubscribeGlobalOptions): Promise<request.SubscribeGlobalRequest>                     // Api.ts:117
export async function unsubscribeAllGlobals(): Promise<void>                                                                           // Api.ts:132
export async function cancelAnyTurn(): Promise<void>                                                                                   // Api.ts:144
export async function setHJMode(mode: types.HJMode): Promise<void>                                                                     // Api.ts:159
export async function getHJMode(): Promise<types.HJMode>                                                                               // Api.ts:173
export function setHotwordMode(mode: types.HotwordListenMode, rules?: string[]): HotwordModeToken                                       // Api.ts:189-194 (5 overloads)
export function resetHotwordMode(): Promise<void>                                                                                       // Api.ts:203
export async function getCloudSkillResponse(transId: string): Promise<any>                                                              // Api.ts:215
export async function removeSpeakerModel(speakerID: string): Promise<void>                                                              // Api.ts:230
export async function startEnrollmentTurn(speakerID: string, number_of_utterances: number): Promise<request.EnrollmentTurnRequest>      // Api.ts:248
export async function initNameLearning(looperName: string): Promise<void>                                                               // Api.ts:269
export async function startNameLearningTurn(looperName: string, ignoreHJ?: boolean, rejectIfBusy?: boolean): Promise<request.NameLearningRequest> // Api.ts:286
export async function createSpeakerModel(speakerID: string, append?: boolean): Promise<types.SpeakerModelResult>                        // Api.ts:307
export async function removePendingSamples(speakerID: string): Promise<void>                                                            // Api.ts:330
export async function getEnrolledSpeakers(): Promise<string[]>                                                                          // Api.ts:352
export function _resetInstance()                                                                                                        // Api.ts:368 (test-only)
```

`index.ts:1-9` re-exports `Utils`, `Client`, `Events`, `HotwordModeToken` plus
namespaces `types`, `request`, `api`. Calls work as both `jibo.jetstream.X(...)` and
`jibo.jetstream.api.X(...)`.

Every async exported call is gated on `events.connect` (`Api.ts:73-76` pattern):
`if (!client.connected) await events.connect.waitFor(5000)` — resolves on next
connect or 5 s timeout, then the POST proceeds.

---

## 2. `Client.init` — sockets and reconnect

`Client.init` (`Client.ts:69-110`):

1. Saves `options`/`JiboLog`.
2. Starts a 10 s interval (`REGISTRY_CULL_TIME = 10000`, `Client.ts:8,75-78`) tagged
   `(callback as any).isGlobalTimer = true` so Be's TimerSpy ignores it.
3. Opens two plain-`ws://` sockets via `jibo-client-framework`'s `WSClient`
   (`Client.ts:81-107`):

```ts
this.eventWS = new WSClient(`ws://${this.options.hostname}:${this.options.port}/events`);
this.eventWS.once('open', () => resolve());                                 // init resolves on first connect
this.eventWS.on('close', () => { this.connected=false; this.emitError(new Error('Jetstream Websocket closed')); this.cancelAllRequests(); });
this.eventWS.on('open',  () => { this.connected=true;  this.events.connect.emit(); });
this.eventWS.on('message', this.handleMessage);
this.vadWS = new WSClient(`ws://${this.options.hostname}:${this.options.port}/vad`);
this.vadWS.on('close', () => this.emitError(new Error('Jetstream VAD Websocket closed')));
this.vadWS.on('message', this.handleVAD);
```

Reconnect lives inside `WSClient`. On every disconnect, `cancelAllRequests`
(`Client.ts:357-376`) injects a synthetic `TURN_RESULT { status: FAILED, message:
'Jetstream disconnected' }` into every outstanding request, clears `_requests`, and
emits `localTurnResult` + `globalTurnResult` for cleanup.

`/events` and `/vad` are the *on-robot Jetstream* daemon URLs, not the cloud hub.
The browser sim collapses both ends.

---

## 3. Outgoing API — paths + payloads

All POSTs go through `Utils.sendPostRequest` (`Utils.ts:21-75`): JSON body, manual
`Content-Length`, empty body coerced to `{}` (`Utils.ts:59-61`). HTTP 417 retries up
to `MAX_RETRIES = 5` (`Utils.ts:4,49-54`) — a documented Jetstream-side quirk.

Each call returns a `Request`-derived object whose constructor inserts itself into
`client._requests` keyed by `response.requestID` (extracted via
`Client.getRequestID`, `Client.ts:137-142`; throws if missing).

| Caller | HTTP path | Payload | Returns |
|---|---|---|---|
| `triggerProactive(data)` | `POST /proactive/trigger` | `data: ProactiveRequestData` | `ProactiveRequest` |
| `startLocalTurn(data)` | `POST /listen/start_local_turn` | `LocalTurnOptions` | `LocalTurnRequest` |
| `mimicGlobalTurn(data)` | `POST /listen/mimic_global_turn` | `MimicGlobalTurnOptions` | `Request` |
| `subscribeGlobal(data)` | `POST /listen/subscribe_global` | `SubscribeGlobalOptions` | `SubscribeGlobalRequest` |
| `unsubscribeAllGlobals()` | `POST /listen/unsubscribe_all_globals` | `{}` | `void` |
| `cancelAnyTurn()` | `POST /listen/cancel_any_turn` | `{}` | `void` |
| `setHJMode(mode)` | `POST /listen/set_hj_mode` | `{ mode }` | `void` |
| `getHJMode()` | `POST /listen/get_hj_mode` | `{}` -> `{ mode }` | `HJMode` |
| `removeSpeakerModel(speakerID)` | `POST /enroll/remove_speaker_model` | `{ speakerID }` | `void` |
| `startEnrollmentTurn(id, n)` | `POST /listen/start_enrollment_turn` | `{ speakerID, number_of_utterances }` | `EnrollmentTurnRequest` |
| `initNameLearning(name)` | `POST /pronunciation/init_pronunciation_learning` | `{ word_to_learn }` | `void` |
| `startNameLearningTurn(name, ignoreHJ, rejectIfBusy)` | `POST /listen/start_pronunciation_learning_turn` | `{ word_to_learn, ignoreHJ, rejectIfBusy }` | `NameLearningRequest` |
| `createSpeakerModel(id, append)` | `POST /enroll/create_speaker_model` | `{ speakerID, append }` | `SpeakerModelResult` |
| `removePendingSamples(id)` | `POST /enroll/remove_pending_samples` | `{ speakerID }` | `void` |
| `getEnrolledSpeakers()` | `POST /enroll/get_enrolled_speakers` | `{}` -> `{ speakers }` | `string[]` |
| `LocalTurnRequest.cancel()` | `POST /listen/cancel_local_turn` | `{ requestID }` | `boolean` |
| `LocalTurnRequest.update(asrOrNlu, meta)` | `POST /listen/update_local_turn` | `LocalTurnUpdate` (`Request.ts:227-232`) | `void` |
| `SubscribeGlobalRequest.unsubscribe()` | `POST /listen/unsubscribe_global` | `{ requestID }` | `boolean` |
| `EnrollmentTurnRequest.cancel()` | `POST /listen/cancel_local_turn` | `{ requestID }` | `boolean` |
| `NameLearningRequest.cancel()` | `POST /listen/cancel_local_turn` | `{ requestID }` | `boolean` |

The enrollment/pronunciation cancels share `/listen/cancel_local_turn` with plain local
cancels (`Request.ts:196,349,440`).

---

## 4. `Client.handleMessage` dispatch

`handleMessage` (`Client.ts:175-315`) is the entire inbound side. Events use
`BaseServiceEvent<type, data>` (`Types.ts:226-232`):

```ts
export interface BaseServiceEvent<T extends ServiceEventType, D> {
    type: T;
    requestID: string;   // 'GLOBAL' or a turn requestID
    transID: string;
    ts: number;
    data: D;
}
```

`GLOBAL_REQUEST = 'GLOBAL'` (`Types.ts:22`).
`ServiceEventType` (`Types.ts:191-204`): `EOS, SOS, ERROR, SPEAKER_ID, HJ_HEARD,
HJ_ONLY, SKILL_ACTION, SKILL_REDIRECT, TURN_STARTED, TURN_RESULT, PROACTIVE,
SPEAKER_ENROLLMENT`.

The switch (`Client.ts:204-291`):

```ts
case ERROR:           this.emitError(new Error(event.data.message)); break;
case SOS:             this.events.sos.emit(); break;
case EOS:             this.events.eos.emit(); break;
case SPEAKER_ID:      this.events.speakerID.emit(event.data); break;
case TURN_STARTED:
    if (this._requests.has(event.requestID)) this.events.localTurnStarted.emit(event.transID);
    else                                    this.events.globalTurnStarted.emit();
    break;
case TURN_RESULT:
    if (event.data.status === SUCCEEDED && typeof event.data.result === 'string')
        event.data.result = JSON.parse(event.data.result);
    if (event.data.result && 'asr' in event.data.result)
        event.data.result = new types.ListenResult(result.asr, result.nlu, result.match);
    event.data.transID = event.transID;
    if (event.data.global || event.requestID === 'GLOBAL') {
        if (data.status === SUCCEEDED && data.result.match)
            this.emitSkillSwitch(data.result.match, data.result.asr, data.result.nlu, event.transID);
        this.events.globalTurnResult.emit(event.data);
    } else {
        this.emitLocalTurnResult(event.data);
    }
    break;
case HJ_HEARD:        this.events.hjHeard.emit(); break;
case HJ_ONLY:         this.events.hjOnly.emit(); break;
case SKILL_ACTION:
    shouldPassToRequest = false;                                    // suppress per-request delivery
    this.cloudSkillResponseRegistry.resolve(event.transID, event.data);
    break;
case SKILL_REDIRECT:  this.emitSkillSwitch(event.data.match, event.data.asr, event.data.nlu, event.transID); break;
case PROACTIVE:
    if (event.data.match) {
        const nlu = { rules: [], intent: '', entities: {} };
        const asr = { text: '', confidence: 1 };
        this.emitSkillSwitch(event.data.match, asr, nlu, event.transID);
    }
    break;
case SPEAKER_ENROLLMENT: this.events.speakerEnrollment.emit(event.data); break;
default: this.log.warn(`Unknown event type received: '${event.type}'`);
```

After the switch (`Client.ts:297-313`), unless `shouldPassToRequest === false`, the
event is delivered to the per-request emitter found by `_requests.get(event.requestID)`.
`ERROR` to a known request goes to `request.error.emit(...)` instead of
`request.events`. Unknown non-GLOBAL `requestID`s are silently swallowed (the comment
at `Client.ts:309-312` explains: SSM and Be are two clients that do not share
state).

`emitLocalTurnResult` (`Client.ts:347-355`) mutates `data` in place: stamps
`data.result.transID = data.transID`, and if `data.result.match` is present, attaches
`data.result.cloudSkillResponse = this.getCloudSkillResponse(data.transID)` so the
ListenResult ships with a pending promise the SSM will later resolve via SKILL_ACTION.

`handleVAD` (`Client.ts:317-319`) just `events.vad.emit(event)`.

---

## 5. `CloudResponseRegistry` + the M47 bug

Entries (`CloudResponseRegistry.ts:4-8`) are `{ timestamp, transID,
response: ExtPromiseWrapper<SkillActionData> }`, map keyed by `transID`.

```ts
// CloudResponseRegistry.ts:18-28
add(transID: string): Promise<any> {
    let existing = this.registry.get(transID);
    if (existing) {
        this.registry.delete(transID);                 // (!) deletes even if still pending
        return existing.response.promise;
    } else {
        return this.createEntry(transID).response.promise;
    }
}

// CloudResponseRegistry.ts:35-48
resolve(transID, skillResponse) {
    let entry = this.registry.get(transID);
    const hadEntry = !!entry;
    if (!entry) entry = this.createEntry(transID);     // park resolved promise
    entry.response.resolve(skillResponse);
    if (hadEntry) this.registry.delete(transID);
}
```

`cull(maxAgeMs)` (`CloudResponseRegistry.ts:54-64`) rejects every entry older than
`maxAgeMs` with `Error('Timeout of ${maxAgeMs} ms reached. Culling cloud response')`,
called every 10 s. Worst-case lifetime: `(0, 20 s]`.

**The M47 bug.** `add`'s `existing` branch assumes the only collision is "resolve
already parked a result; consumer collecting it" — safe to delete because the promise
is settled. But if `add` runs *twice while still pending* (SSM re-arms before
SKILL_ACTION), the registry entry is dropped while the promise is unresolved. Both
callers hold the unresolved promise; when SKILL_ACTION later arrives,
`resolve()` finds no entry (`registry.get(transID)` is undefined), `createEntry`s a
fresh orphan, resolves *that*, and the orphan is culled 10 s later. The two
originally-awaited promises never settle. Fix at port: only `delete` in the
`existing` branch when `ExtPromiseWrapper.settled` is true.

---

## 6. `LocalTurnRequest` lifecycle

`Request.ts:131-239`. `RequestStatus` (`Request.ts:23-28`):
`ACTIVE -> {FINISHED, CANCELED, ERROR}`. Ctor registers `this` in `client._requests`;
builds a Promise that listens for `TURN_RESULT` on `this.events`.
SUCCEEDED/FAILED/INTERRUPTED/CANCELED/TIMEOUT resolve, everything else rejects.
Terminal handlers delete from `_requests` (`Request.ts:172-184`). Resolution uses
`process.nextTick(...)` — browser port should use `queueMicrotask`.

`cancel()` (`Request.ts:192-208`): sets `status = CANCELED`, POSTs
`/listen/cancel_local_turn { requestID }`, synth-resolves CANCELED. On HTTP failure
calls `forceEnd()` (`Request.ts:73-79`) which resolves locally and tells
`Client.forceEndTurns(...)` to fake a FAILED on `events.localTurnResult` for cleanup.

`update(asrOrNlu, meta)` (`Request.ts:223-238`): packs
`{ requestID, clientASR?, clientNLU?, meta }` into `LocalTurnUpdate` (`Types.ts:319-324`)
and POSTs `/listen/update_local_turn`. String -> `clientASR`, object -> `clientNLU`.
Documented race (`Request.ts:213-216`): if the hub finishes first, the update is
silently dropped.

---

## 7. `HotwordMode`

Modes (`Types.ts:137-144`, numeric priority — `0` highest):

```ts
export enum HotwordListenMode { Disabled = 0, HJ_Only, ASR_Only, Custom_NLU_Only, Custom_NLU_Added, Normal }
```

Server-side equivalent (`Types.ts:170-174`):

```ts
export enum HJMode { NORMAL_HJ = 'NORMAL_HJ', IGNORE_HJ = 'IGNORE_HJ', ONLY_HJ = 'ONLY_HJ' }
```

Token store: 5-element array of arrays (`HotwordMode.ts:8-14`) keyed by `mode`;
`previousMode` caches the active one. `generateToken(mode, rules)`
(`HotwordMode.ts:171-187`): `Normal` -> self-resolved no-op; else push into
`ACTIVE_TOKENS[mode]`, call `updateMode(mode)`, expose its promise as
`token.activated`.

`updateMode(newMode)` (`HotwordMode.ts:238-302`):
- Leaving `ASR_Only`: unsubscribe the saved `asrOnlyRequest`.
- `Disabled` -> `setHJMode(IGNORE_HJ)`. `HJ_Only` -> `setHJMode(ONLY_HJ)`.
- `ASR_Only` -> unsubscribe every `Custom_NLU_Only` token's global, then
  `subscribeGlobal({ nluRules: [], exclusive: true })`.
- `Custom_NLU_*`/`Normal`: per unsubscribed token,
  `subscribeGlobal({ nluRules: token.rules, exclusive: mode===Custom_NLU_Only })`
  (`HotwordMode.ts:304-324`).
- If leaving `Disabled`/`HJ_Only`: `setHJMode(NORMAL_HJ)` after globals are wired.

`release()` (`HotwordMode.ts:97-106`) cleans listeners, unsubscribes the global, then
`removeToken` picks the next-highest-priority occupied bucket and re-applies its mode.
`resetMode()` (`HotwordMode.ts:190-201`) drops every token, returns to `Normal`.
`onReconnect` (`HotwordMode.ts:326-337`) nulls every `globalRequest`, sets
`previousMode = Normal`, then re-runs `updateMode(prevMode)` to rebuild subscribes on
the new socket.

---

## 8. Hub-side protocol (`/listen` WebSocket)

Hub registers `/listen` and `/v1/listen` against `ListenHandler` (`HubService.ts:58-63`).

### Headers

`JiboHeaders` (`JiboHeaders.ts:16-37`) reads three case-insensitive HTTP headers from
the WS upgrade — literal strings from
`/tmp/jibo-be/node_modules/@jibo/interfaces/lib/interfaces.js:601-603`:

```js
transID: "x-jibo-transid",
robotID: "x-jibo-robotid",
loggingConfig: "x-jibo-logging-config"
```

`toHeader()` sets `transID` unconditionally; others when truthy. Same headers are
forwarded on outbound skill HTTP calls (`SkillRequestMaker.ts:115`).

### Envelope

`BaseMessage` (`service.d.ts:6-19`):

```ts
export interface BaseMessage<T extends string, D> { type: T; msgID: UUID; ts: number; data: D; }
export declare type BaseResponse<T, D> = BaseMessage<T, D> & { final?: boolean; timings?: Timings };
```

Requests (`MessageType.d.ts:1-8`):

```ts
export declare enum RequestType {
    LISTEN = "LISTEN", CONTEXT = "CONTEXT", TRIGGER = "TRIGGER",
    CMD_RESULT = "CMD_RESULT", CLIENT_ASR = "CLIENT_ASR", CLIENT_NLU = "CLIENT_NLU",
}
```

Responses (`MessageType.d.ts:9-20`):

```ts
export declare enum ResponseType {
    EOS = "EOS", SOS = "SOS", LISTEN = "LISTEN",
    SKILL_REDIRECT = "SKILL_REDIRECT", SKILL_ACTION = "SKILL_ACTION",
    NLU = "NLU", ASR = "ASR", COMMAND = "COMMAND",
    PROACTIVE = "PROACTIVE", ERROR = "ERROR",
}
```

`ListenMessageData` (`request.d.ts:11-24`): `{ hotphrase, rules, mode?, asr?, agents? }`
where `mode: ListenMessageMode = 'CLIENT_ASR' | 'CLIENT_NLU'`.

### `ListenTransactionHandler` state machine (`ListenTransactionHandler.ts:26-35`):

```ts
enum State { WAIT_LISTEN, WAIT_CLIENT_ASR, WAIT_CLIENT_NLU, ASR, NLU, ROUTE, DONE, STOP }
```

Allowed transitions (`ListenTransactionHandler.ts:213-240`):
`WAIT_LISTEN -> {ASR, WAIT_CLIENT_ASR, WAIT_CLIENT_NLU}`;
`{ASR, WAIT_CLIENT_*} -> NLU`;
`{ASR, NLU, WAIT_CLIENT_*} -> ROUTE`;
`{ROUTE, ASR} -> DONE`;
`STOP` from any. Bad transitions logged at info and dropped.

Hardcoded timeouts (`ListenTransactionHandler.ts:37-43`): `TIMEOUT_ASR=40000`,
`TIMEOUT_PARSER=10000`, `TIMEOUT_CONTEXT=5000`, `TIMEOUT_SKILL=10000`.

`handleListenMessage` (`ListenTransactionHandler.ts:269-285`):
- no `mode` -> `ASR` (audio required).
- `mode==CLIENT_ASR` -> synthetic SOS (`totalTime=-1`), then `WAIT_CLIENT_ASR`; a
  `CLIENT_ASR` fills `asrData = { text, confidence: 1 }` -> `NLU`.
- `mode==CLIENT_NLU` -> synthetic SOS, `WAIT_CLIENT_NLU`; a `CLIENT_NLU` fills
  `nluData`, empty `asrData`, synth EOS -> `ROUTE`.

`performRouting` (`ListenTransactionHandler.ts:369-401`):
1. Await CONTEXT (5 s).
2. `intentRouter.getSkillIDFromNLU(nluData)` -> `Decision`.
3. Run through `mediateDecision(...)` (see §9).
4. If no decision but `context.data.skill.id` is set and `!listenMessage.data.hotphrase`,
   route to the running skill as an update.
5. Else emit final `ListenResponse` with `match: null`.

`emitListenResult` (`ListenTransactionHandler.ts:713-734`) sends
`{ type: 'LISTEN', msgID, ts, data: { asr, nlu, match }, final, timings: { total, asr, nlu } }`.
On-robot skills get only a final LISTEN — hub does not call them. Cloud skills get a
non-final LISTEN match plus a follow-up SKILL_ACTION (or one SKILL_REDIRECT chase) via
`SkillRequestMaker.skillLaunchOrUpdate` posting to the skill's `URL` with the
JiboHeaders forwarded (`SkillRequestMaker.ts:97-101,110-117`).

---

## 9. Hub `release`-sensitivity in `DecisionMediator.mediateDecision`

`DecisionMediator.ts:17-78`. Rewrites the decision iff both:
- `semver.lt(version, '1.9.0')` where `version = semver.valid(semver.coerce(release))`,
  and `release === 'RELEASE_NOT_FOUND'` is coerced to `'1.9.0'`
  (`DecisionMediator.ts:6-7,20-22`), and
- `decision.skillID === 'report-skill'` (`DecisionMediator.ts:26`).

Rewrite table on `nlu.intent`:

| `nlu.intent` | New `skillID` | New `memo` |
|---|---|---|
| `launchPersonalReport` | `chitchat-skill` | `{ mim: 'KU_GiveMeA', type: 'ScriptedResponse' }` |
| `requestWeatherPR` | `answer` | (none) |
| `requestCommute` | `chitchat-skill` | `{ mim: 'RA_JBO_Traffic', type: 'ScriptedResponse' }` |
| `requestCalendar` | `chitchat-skill` | `{ mim: 'RA_JBO_Calendar', type: 'ScriptedResponse' }` |
| `requestNews` | `news` | (none) |
| anything else | `chitchat-skill` | `{ mim: 'KU_AreYouAbleTo', type: 'ScriptedResponse' }` |

Returning `undefined` keeps the original decision
(`ListenTransactionHandler.ts:383-387`):

```ts
const alteredDecision = mediateDecision(decision, this.asrData, this.nluData, context.data.general.release);
if (alteredDecision) this.logger.debug(`Decision Mediator altered ...`);
const finalDecision = alteredDecision || decision;
```

Trap for the sim: `MessagePreProcessor.preProcessContextMessage`
(`MessagePreProcessor.ts:24-31`) defaults `release: '1.8.0'` if CONTEXT does not stamp
one — every `report-skill` decision then hits the fajita rewrite. This is the
"fajita fallback" referenced in M55 (commit `0011993`). Always stamp
`context.data.general.release = '1.9.0'` (or newer).

---

## 10. Auth flow

JWT Bearer, validated by `BaseService.checkAuthentication` (`BaseService.ts:58-78`):
require `Authorization: Bearer <token>`; require `process.env.ETCO_server_hubTokenSecret`
to be set; call `jsonwebtoken.verify(token, secret)` which defaults to HS256.
Decoded payload is `IAuthDetails` (`service.d.ts:34-43`):

```ts
export interface IAuthDetails {
    id: string;             // robot account ID
    accessKeyId: string;
    secretAccessKey: string;
    friendlyId?: string;
}
```

WS auth runs inside `verifyClient` (`BaseService.ts:172-191`): on failure, reject
upgrade with `401`; on success, stash on `req.auth`, later promoted to `ws.auth`
(`BaseService.ts:267`).

### `disableAuth` mode

When `HubConfig.disableAuth=true` (`HubService.ts:39-41`, typically env
`ETCO_hub_disableAuth=true`), `verifyClient` skips auth entirely (`BaseService.ts:173`)
and `ws.auth` stays undefined. `MessagePreProcessor.preProcessContextMessage`
(`MessagePreProcessor.ts:22-30`) falls back:

```ts
const auth = socket.auth;
const defaults: jibo.data.GeneralData = {
    accountID: auth ? auth.id : "anonymous-account",
    robotID:   auth ? auth.friendlyId : "anonymous-robot",
    lang: "en", release: "1.8.0",
    remoteAddress: socket.remoteAddress
};
```

It also skips `MessageValidator.validateGeneralData(...)`
(`MessagePreProcessor.ts:43-46`) since there is no auth to validate against. For HTTP
routes, `httpPathHandler.authenticationRequired` is honored only when `!disableAuth`
(`BaseService.ts:143`).

Browser sim profile: `disableAuth=true`; no `Authorization` header; the three
`x-jibo-*` headers (transID, robotID, loggingConfig) are still sent so the hub
logger has them.

---

## 11. File index

All sources cited above (paths absolute). See the top of this file for the full list.
