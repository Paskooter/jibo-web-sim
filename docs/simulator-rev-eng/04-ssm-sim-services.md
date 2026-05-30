# SSM Sim-Services Reference

Every service under `/tmp/sdk/packages/skills-service-manager/src/sim-services/`. These are the simulator-side stubs that replace the C++/native hardware services in the original Electron sim. Each one extends `HTTPService` or `HTTPWSService` from `jibo-service-framework`, registers itself with the SSM `Registry`, and exposes HTTP routes and/or WebSocket endpoints on a single `http.Server` listening on its own port.

The set of these classes is wired up in `FactoryDeps.ts:76-90` as `SIMULATED_SERVICES`.

---

## audio — `AudioServiceSim`

- **Path** — `/tmp/sdk/packages/skills-service-manager/src/sim-services/audio/AudioServiceSim.ts`
- **Registry record** — `'audio'` (constructor: `super('audio', options, rootDir)` at `AudioServiceSim.ts:189`)
- **HTTP routes** (`routes()` at `AudioServiceSim.ts:204-224`):
  - `POST /beam` → `_beam` — `finishNoContent` 204 stub (`:275-277`).
  - `GET /beam/state` → `_beamState` — returns `{ts:[0,0], manual_override:false, selection:0}` (`:279-286`).
  - `GET /beam/info` → `_beamInfo` — adds one `{center:0,range:0}` beam (`:288-299`).
  - `GET /debug` → `_debugGet` — returns `_debugState = {injectWhiteNoise:false, injectSine:false}` (`:301-303`).
  - `POST /debug` → `_debugPost` — parses body as `DebugState`, replaces `_debugState`, 204 (`:305-316`).
  - `GET /diag` → `_diagGet` — returns `_diagState.diags` (default: single dummy diag `{name:'name', type:0, writable:true, value:[0,0]}` from `:173-182`) (`:318-320`).
  - `POST /diag` → `_diagPost` — merges `SEDiag` entries by `name` into `_diagState.diags` (`:322-341`).
  - Many other routes (`/levels`, `/log`, `/mixer`, `/mode`, `/loc_cfg`, `/loc_track`) are commented out at `:213-223`.
- **WebSocket paths** (`onConnection` at `:226-255`):
  - `/input_energy` — pushed onto `inputEnergyClients` (no events emitted by this service itself; `EventPlayback` writes here via `sendWsJson`). Other endpoints (`/detection`, `/streamState`, `/rin`, `/rout`, `/sin`, `/sout`, `/ref`) are commented out.
- **Internal state**: `_debugState`, `_diagState`, `inputEnergyClients: WebSocket[]`.
- **External calls**: none — fully self-contained.
- **Init**: `init()` only calls `super.init()` and logs (`:197-202`). `onMessage` is a no-op (`:257-259`). `pause`/`resume` only log (`:267-273`).

## body — `BodyService`

- **Path** — `/tmp/sdk/packages/skills-service-manager/src/sim-services/body/BodyService.ts`
- **Registry record** — `'body'` (`BodyService.ts:55`).
- **HTTP routes** — none added; only base routes from `HTTPService.routes()`.
- **WebSocket paths** (`onConnection` at `:113-126`):
  - `/axis_state` — pushed onto `stateSocketList`; every command and every tick sends a `BodyState` snapshot (`sendState()` at `:204-215`). `BodyState` = `{ts, pelvis:AxisState, torso:AxisState, neck:AxisState}` (`BodyState.ts:1-10`); each `AxisState` has `pos, inc_pos, vel, cur, pwm, status, vel_limit, acc_limit, cur_limit, mode, ref, ticks` (`AxisState.ts:1-15`).
  - `/axis_command` — pushed onto `commandSocketList`. `onMessage` routes inbound messages to `onAxisCommand` (`:92-99`).
  - `/led_command` — pushed onto `ledSocketList`. `onMessage` → `onLEDCommand`.
  - `/touch` — pushed onto `touchSocketList`. The service never emits anything on touch on its own — the simulator UI is expected to push touch events here.
- **Internal state**: `SimController` containing three `AxisVelocityControllerSim` instances for `pelvis`/`torso`/`neck` (`:20-24`, `:46`); current `BodyState` (`:45`); `ledState: [r,g,b]` (`:44`); `lastUpdate` timestamp; `updateLoop` 100 ms setTimeout chain.
- **`onAxisCommand`** (`:128-182`): given `data[dof] = {mode, value[0..2], acc_limit, vel_limit}` selects a controller:
  - `mode === 4` → `AxisVelocityControllerSim` (velocity-only) (`:135-141`),
  - `mode === 5` → `TrajectoryControllerSim` (`:142-156`),
  - `mode === 7` → `PosVelControllerSim` (`:157-170`),
  - else → zero-velocity stop (`:171-177`).
  All three from `animation-utilities` package. After updating, `updateState()` recomputes `pos`/`vel` per dof and `sendState()` broadcasts to all `/axis_state` clients.
- **`onLEDCommand`** (`:184-188`): if `data.color` is a 3-element array, replaces `ledState`.
- **Render emission**: every 100 ms the `update()` tick (`:217-228`) emits `'update'` event on the EventEmitter with `{topSection_r, middleSection_r, bottomSection_r, lightring_redChannelBn_r, lightring_greenChannelBn_r, lightring_blueChannelBn_r}` — this is what the Electron renderer process listens to.
- **External calls**: `animation-utilities` for clock/controllers (`:2`). No HTTP outbound.
- **Init**: `super.init` then starts the 100 ms `updateLoop` (`:64-70`). `pause` clears the loop; `resume` re-arms it (`:77-90`). `reset()` recreates state and controllers (`:72-75`).

## event-playback — `EventPlayback`

- **Path** — `/tmp/sdk/packages/skills-service-manager/src/sim-services/event-playback/EventPlayback.ts`
- **Registry record** — NONE. This class extends `events.EventEmitter` directly, not `HTTPService` (`EventPlayback.ts:26-28`), so it does not register or open a port. It is purely an in-process orchestrator.
- **HTTP routes** — none.
- **WebSocket paths** — none of its own; it WRITES to OTHER services' sockets via `service.sendWsJson(socket, event.content)` (`:376-378`).
- **Internal state**: `_recordings: Recording[]` (each `Recording` = `{dir, eventFiles, eventQueue, lastTs, loaded, startTs, name, service, sockets, tsEpochMillis, tsProp, emitted}` per `types.ts:44-57`), `_playbackLoop`, `_playbackStart`, `_recordingStart`/`_recordingStop`, `_recordingTypes` derived from `options.recordings`.
- **External calls**: filesystem only — `fs.readdir`/`fs.stat`/`fs.readFile` per recording dir under `~/Desktop/recordings` by default (`:22, :89-92`).
- **Init** (`:71-87`): resolves each `definition.service` name out of `SIMULATED_SERVICES` (`:78`), capturing the live instance plus which `sockets` field on that instance receives the events. Exposes `this` as `global.EventPlayback` (`:84`).
- **load → start lifecycle** (`:89-156`):
  - Reads `timeConfigFile` (a `TimeConfig` JSON with `robot_utc_time`, `robot_boot_time`, etc., per `types.ts:4-11`) to compute `_rbTimeOffset`.
  - Walks each recording subdir, loads `*.json` files into `eventQueue`, sorted numerically.
  - `start()` calls `pauseServices()` on every involved `SSMService` (`:158-162`) before pumping events.
- **`_tick`** (`:266-308`): each tick refills queue, computes `elapsedTime`, then for each recording calls `_emitPastEvents` which iterates events whose `ts - recordingStart < elapsedTime` and pushes their `content` to `service[sockets]` (typed as a `WebSocket[]` or single `WebSocket`) (`:342-382`). When all events exhausted → `_ended` → `resumeServices()`.
- **`PlaybackService`** = `SSMService & HTTPWSService & {pause, resume}` (`types.ts:13-16`) — i.e. only WS-backed services can be replay targets.

## jetstream — `JetstreamServiceSim`

- **Path** — `/tmp/sdk/packages/skills-service-manager/src/sim-services/jetstream/JetstreamServiceSim.ts`
- **Registry record** — `'jetstream'` (`:171`).
- **HTTP routes** (`routes()` at `:196-288`, all `POST`, all reply JSON via `prepareResponse`):
  - `/proactive/trigger` → `onProactiveTrigger` (`:722-758`): assigns `requestID`, replies `{requestID}`, starts a `HubClient.startProactiveSession` against the configured hub (`createHubOptions('/proactive')`), subscribes events, posts context.
  - `/listen/mimic_global_turn` → `onMimicGlobalTurn` (`:826-837`): cancels current turn, forces `State.GLOBAL_TURN`, calls `startSpeechTurn`.
  - `/listen/start_local_turn` → `onStartLocalTurn` (`:839-854`): if `state===IDLE` starts a local turn with `turnOptions = req.body`. Else 503 BUSY.
  - `/listen/cancel_local_turn` → `onCancelLocalTurn` (`:856-880`): cancels active local/enrollment/pronunciation turn if `req.body.requestID` matches.
  - `/listen/update_local_turn` → `onUpdateLocalTurn` (`:882-918`): feeds `clientASR` or `clientNLU` from `req.body` into `updateSpeechTurn`.
  - `/listen/subscribe_global` → `onSubscribeGlobal` (`:920-937`): body is `types.SubscribeGlobalOptions` (`nluRules`, `exclusive`); pushes `{requestID, rules}` onto `activeGlobalRules` or `activeExclusiveGlobalRules`; returns `{requestID}`.
  - `/listen/unsubscribe_global` → `onUnsubscribeGlobal` (`:939-956`): removes by `requestID`.
  - `/listen/unsubscribe_all_globals` → `onUnsubscribeAllGlobals` (`:958-967`): empties both arrays.
  - `/listen/set_hj_mode` → `onSetHJMode` (`:969-985`): body `{mode: 'NORMAL_HJ'|'IGNORE_HJ'|'ONLY_HJ'}`, stores `hjMode`.
  - `/listen/get_hj_mode` → `onGetHJMode` (`:987-993`): returns `{mode: hjMode}`.
  - `/listen/cancel_any_turn` → `onCancelAnyTurn` (`:995-1008`): closes active turn, sets state IDLE.
  - `/listen/start_enrollment_turn` → `onStartEnrollmentTurn` (`:1023-1038`): if IDLE, creates `EnrollmentTurn`, state → `VOICE_ENROLLMENT_TURN`.
  - `/enroll/create_speaker_model` → `onCreateSpeakerModel` (`:1040-1046`): stub 200.
  - `/enroll/remove_speaker_model` → `onRemoveSpeakerModel` (`:1048-1054`): stub 200.
  - `/enroll/get_utterance_count` → `onGetUtteranceCount` (`:1056-1062`): returns `{utterance_count:0}`.
  - `/enroll/get_enrolled_speakers` → `onGetEnrolledSpeakers` (`:1064-1070`): returns `{speakers:[]}`.
  - `/pronunciation/init_pronunciation_learning` → `onInitPronunciationLearning` (`:1072-1080`): stores `currentWordToLearn`.
  - `/listen/start_pronunciation_learning_turn` → `onStartPronunciationTurn` (`:1082-1098`): creates `PronunciationTurn` if IDLE and word matches.
- **WebSocket paths** (`onConnection` at `:187-194`):
  - `/events` — `eventsClientSockets`. Every `writeToJetStreamClient` (`:340-349`) writes a `types.ServiceEvent` JSON: `{type, requestID, transID, ts, data}`. Emitted types include `HJ_HEARD`, `TURN_STARTED`, `SOS`, `EOS`, `TURN_RESULT`, `SKILL_ACTION`, `SKILL_REDIRECT`, `PROACTIVE`, `SPEAKER_ID`, `ERROR` (see `:493-605`, `:736-746`, `:765-786`, `:813-823`).
  - `/vad` — `vadClientSockets`. Nothing is ever pushed (no `vadClientSockets` `.send` in source).
- **Internal state**: `state: State` (`CONNECTING_TO_CONTEXT|IDLE|GLOBAL_TURN|LOCAL_TURN|VOICE_ENROLLMENT_TURN|PRONUNCIATION_TURN|WAITING_FOR_HUB|ERROR` — `:28-37`), `hjMode`, `activeTurn: Turn`, `activeProactiveSession`, `activeGlobalRules[]`, `activeExclusiveGlobalRules[]`, `requestIDCounter`, `currentWordToLearn`, `wordsRecievedQueue: PromiseQueue`, `events = new Events()` (custom `localTurnStarted`, `hjHeard` from `:132-135`).
- **External calls**:
  - **Hub** (`@jibo/hub-client`) — `HubClient.startListenSession` / `startProactiveSession`. Hub options default `{hostname:'localhost', port:9000, auth.secret:'dev-hub-token-secret', auth.credentials:{id:'foo',...}}` (`:89-104`). Overridable via `process.env.JetstreamSim_hubHost`, `JetstreamSim_hubPort`, `ETCO_server_hubTokenSecret`, or `options.hubHost`/`hubPort`/`secret` (`createHubOptions` at `:788-811`).
  - **Context service** (over local HTTP) — `connectToContextService` (`:657-684`) polls `RegistryService.instance.registry.records` every 100 ms for a record named `'context'` (looking for jibo-be's hosted service); times out after 20 s. Then `HTTPClient('127.0.0.1', record.port).sendRequest('POST', '/context', ...)` (`:689-712`) called before any turn to inject context into Hub.
- **Init** (`:176-185`): `super.init()` then fire-and-forget `connectToContextService()` to await the `context` Registry record.
- **`onWordsReceived(speech)`** (`:294-326`): the public entry point the simulator UI uses to inject ASR text. Detects `'hey jibo'`, manages state machine, calls `startSpeechTurn`/`updateSpeechTurn`. Serialized by `wordsRecievedQueue` (a `PromiseQueue` from `jibo-cai-utils`).
- **Turn classes** (`Turns.ts:7-52+`): `Turn` (abstract), `HubListenTurn`, `EnrollmentTurn`, `PronunciationTurn`. `HubListenTurn` wraps a `hub_session.ListenClientSession` and enforces `sosTimeout` / `maxSpeechTimeout` / `earlyEOS` matching.

## log — `log.ts` (top-level helper, not a service)

- **Path** — `/tmp/sdk/packages/skills-service-manager/src/sim-services/log.ts`
- Just `import parentLog from '../log'; export default parentLog.createChild('Sim');` (`log.ts:1-2`). Used by every sim-service as its logger child.

## lps — `LPSService`

- **Path** — `/tmp/sdk/packages/skills-service-manager/src/sim-services/lps/LPSService.ts`
- **Registry record** — `'lps'` (`:48`).
- **HTTP routes** (`:235-240`):
  - `POST /lps/barcode` → `onBarcode` (`:247-249`): `finishNoContent` 200.
  - `POST /lps/demand_detect` → `onDemandDetect` (`:251-254`): writes raw `0` body, 200.
  - `POST /lps/faces` → `onFaces` (`:242-245`): returns `JSON.stringify(visualAwareness.entities)` (note: not wrapped in object).
- **WebSocket paths** (`onConnection` at `:216-224`):
  - `/lps/visual_awareness` → assigned to single `visualSocket` slot. Every 100 ms tick (`update()` at `:256-276`) pushes the full `VisualAwareness` (an object holding `entities: Entity[]` plus timestamp). Each `Entity` carries `Point3 position`, `Tracker3D`, `Ray`, `Tracker2D`, `Rectangle` etc. (`VisualAwareness.ts:36-100+`).
  - `/lps/audible_awareness` → assigned to single `audibleSocket`. Same tick pushes `AudioAwareness` = `{entities: AudioEntity[]}` where each `AudioEntity` = `{ts, type, id, position:Point3, confidence}` (`AudioAwareness.ts:7-26`). A pending one-time event (e.g. simulated HJ) is merged in once and dropped (`:265-270`).
- **Internal state**: `visualAwareness: VisualAwareness`, `audioAwareness: AudioAwareness`, transient `oneTimeAudioAwareness`, `currentAudioId`, `lastUpdate`, `updateLoop`.
- **Public API for the simulator UI**:
  - `triggerSimulatedHJEvent()` (`:99-110`): pushes an `AudioEntity(type=1)` at `(1, 0, 0.7)` into a one-shot pipe.
  - `triggerAudioEvent(position)` / `triggerAudioEventEnd()` (`:112-129`): emits `'audio-event-start'`/`'audio-event-end'` and adds/removes an entity with 3 s delay.
  - `updateTarget(target)` (`:182-197`): adds/updates a visual `Entity`; touches `visualAwareness` timestamp; emits `'update'`.
  - `removeEntity(id)` (`:199-209`), `setTargetId`, `getEntities`, `getAudioEntityFromId`, etc.
- **External calls**: `animation-utilities` `Clock.currentTime` only. No HTTP outbound.
- **Init** (`:61-68`): super.init then 100 ms `updateLoop`. `pause/resume` toggle the loop (`:70-83`).

## media — `MediaService`

- **Path** — `/tmp/sdk/packages/skills-service-manager/src/sim-services/media/MediaService.ts`
- **Registry record** — `'media'` (`:43`).
- **Base class** — `HTTPService` only (no WebSockets) (`:31`).
- **HTTP routes** (`:64-74`):
  - `POST /media/photo` → `onPhoto` (`:120-133`): generates `uuid.v4()` contentId, pushes to `contentIds`, returns `{id, width:1920, height:1080, expiration:Date.now()+60000, stored:false}`. Stores a fake source path under one of 4 bundled images chosen by `contentId[0] & 0x3` from `<pkg>/resources/images/pic{1..4}.jpg` (`:308-312`).
  - `GET /media/photo` and `GET /media/photo/get` → `onPhotoGet` (`:257-268`): looks up `query.id`; reads jpg from cache or from `mediaRootDir`, sends as `image/jpeg`.
  - `POST /media/photo/store` → `onPhotoStore` (`:140-174`): body `{id?, buffer?, thumbnails:{key:[w,h]}}`. Writes the original photo and each thumbnail (resized via `jimp`) under `mediaRootDir`. If `options.serverMediaService` is true, also uploads to cloud via `JSC.Media.create` (`:241-255`). Returns `{id, thumbnails:{key:id}}`.
  - `POST /media/recording/start` → `onRecordingStart` (`:272-292`): generates fake recording id `YYYY-MM-DD:HH:MM:SS<uuid>.(AX|AV)` based on `body.video`; pushes onto `recordings[]`; emits `'recording-start'`.
  - `POST /media/recording/control` → `onRecordingStop` (`:294-299`): emits `'recording-stop'`, 200.
  - `POST /media/recording/play` → `onRecordingPlay` (`:301-306`): emits `'recording-play'`, 200.
- **WebSocket paths** — none.
- **Internal state**: `contentIds: string[]`, `recordings: any[]`, `lastPicturePath` (test-only).
- **`mediaRootDir`** (`:100-103`): `$HOME/.jibo/photos`.
- **External calls**: filesystem (`fs`, `mkdirp`), `jimp` for resizing, optionally `JSC.Loop` + `JSC.Media` cloud upload (`:241-255`).

## performance — `PerformanceServiceSim`

- **Path** — `/tmp/sdk/packages/skills-service-manager/src/sim-services/performance/PerformanceServiceSim.ts`
- **Registry record** — `'performance'` (`:13`).
- **Base class** — `HTTPService`.
- **HTTP routes** — none beyond base `_M_` health/errors.
- **WebSocket paths** — none.
- **Init** (`:25-28`): does NOT call `super.init()`. Just logs and calls callback. This means it never actually opens its port — it's a pure in-process stub used only for `log(time, type, description)` no-op calls from elsewhere (`:30-32`, called e.g. from `TTSService.ts:72`).
- **External calls**: none.

## registry — `RegistryService`

- **Path** — `/tmp/sdk/packages/skills-service-manager/src/sim-services/registry/RegistryService.ts`
- **Registry record** — `'registry'` (`:21`). Note: in `HTTPService.init` (`HTTPService.ts:173-177`) the special-case `if (this.name === 'registry') callback()` means the registry service does NOT register itself — it IS the registry.
- **HTTP routes** (`:31-60`, overrides base entirely — no `_M_/*` routes):
  - `GET /registry` → returns the entire `Registry` instance (`{records: RegistrationRecord[]}`) (`:32-34`).
  - `PUT /registry` → `req.body` is a `RegistrationRecord`; calls `registry.put(entry)`; 204 (`:36-40`).
  - `POST /registry` → `req.body` is a `RegistrationRecord`. If no record with that `name`, returns 500 error. Else `registry.post(entry)` updates host/port/path/ttl/tls. 204 (`:42-52`).
  - `DELETE /registry` → `req.body.name`; `registry.delete(name)`; 204 (`:54-59`).
- **WebSocket paths** — none.
- **Internal state**: `registry: Registry` with `records: RegistrationRecord[]` (`:14`, `Registry` class at `:64-128`). A `RegistrationRecord` per `jibo-service-framework/index.ts:29-36` is `{name, host, port, path, ttl?, tls?}`.
- **External calls**: none.
- **Init** — uses base `HTTPService.init` which short-circuits the registration step for the registry itself.

## secure-transfer — `SecureTransferServiceSim`

- **Path** — `/tmp/sdk/packages/skills-service-manager/src/sim-services/secure-transfer/SecureTransferServiceSim.ts`
- **Registry record** — `'secure-transfer'` (`:19`).
- **HTTP routes** (`:47-57`):
  - `GET /UGCKeyReady` → returns `{status:'OK', isReady: _isUGCKeyReadyToggle}` (default false) (`:50-52`, `:60-66`).
  - `GET /hasBackupData` → returns `{status:'OK', isReady: _hasBackupDataToggle}` (default false) (`:54-56`, `:69-75`).
- **WebSocket paths** — none ever inspected (no `client.url ===` branches; `onMessage` is no-op).
- **Internal state**: `_isUGCKeyReadyToggle: boolean`, `_hasBackupDataToggle: boolean`. Public `toggleBackupDataExists`/`toggleUGCKeyReady` setters used by simulator UI (`:39-45`).

## server — `ServerService`

- **Path** — `/tmp/sdk/packages/skills-service-manager/src/sim-services/server/ServerService.ts`
- **Registry record** — `'server'` (`:35`).
- **HTTP routes** — none added; only base `_M_/*` (override at `:107-109` only calls super).
- **WebSocket paths** (`onConnection` at `:82-93`):
  - `/server/notifications` → pushed onto `notificationsClients[]`. Every incoming cloud notification (from `jscNotificationClient.connect(...).on('message')`) is broadcast to all of them (`messageReceived` at `:112-120`).
  - `/server/notifications/status` → pushed onto `statusClients[]`. Service never writes here.
- **Internal state**: `notificationsClients[]`, `statusClients[]`, `jscNotificationClient`, `deviceId`.
- **External calls**:
  - Reads `~/.jibo/credentials.json` and `~/.jibo/identity.json` synchronously at init (`:151-160`).
  - `JSC.config.update(credentials)` then `new JSC.Notification().connect({deviceId})` — this is the **real** Jibo cloud notifications hub. The sim subscribes for real if creds are present (`:55-67`).
- **Init** (`:46-74`): calls `_initCredentials`; if missing creds, logs warning and resolves anyway. Otherwise wires `jscNotificationClient` `.connect(params)` with `params.deviceId = identity.name`.
- **Bug note**: `onClose` (`:96-104`) uses `while (i = arr.indexOf(...) > -1)` — operator precedence makes `i` always boolean. Harmless but worth knowing.

## skills — `SkillsServiceSim`

- **Path** — `/tmp/sdk/packages/skills-service-manager/src/sim-services/skills/SkillsServiceSim.ts`
- **Registry record** — `'skills-service'` (`:28`).
- **HTTP routes** (`:86-94`):
  - `GET /version` → reads sibling `package.json` via `findRoot(__dirname)` and returns `{version: packageInfo.version}`.
- **WebSocket paths**: no `client.url ===` branches. Instead, **inbound** WS messages drive a state machine via `onMessage` (`:48-84`):
  - `command === 'initDone'`: if `options.skillsBaseDir` exists and points to a directory with `package.json`, reads it, sets `currentSkill.name`/`path`, then sends back `{command:'show'}`. If no `skillsBaseDir`, just sends `{command:'show'}` immediately.
  - `command === 'finished'`: if `currentSkill.name === '@be/be'`, synthesizes a relaunch NLU result and calls `GlobalManagerService.instance.handleSkillLaunch({status:'GOT-PARSE', nlu:{entities:{skill:'@be/idle'}}})` (`:72-83`).
  - Every received command also emits `'command'` on the EventEmitter for listeners.
- **Internal state**: `currentSkill: SkillRecord` (defaults to `{name:'@be/be', path:'/'}`).
- **External calls**: `GlobalManagerService.instance` (a non-sim service in SSM).

## system-manager — `SystemManagerService`

- **Path** — `/tmp/sdk/packages/skills-service-manager/src/sim-services/system-manager/SystemManagerService.ts`
- **Registry record** — `'system-manager'` (`:38`).
- **HTTP routes** (`:54-71`):
  - `GET /credentials` → `onGetCredentials` (`:190-223`): reads `~/.jibo/credentials.json`; if absent, writes `DEFAULT_TESTING_CREDENTIALS = {secretAccessKey:'W5dxPYf...', accessKeyId:'3MRGwcKU...', region:'stg-entrypoint'}` (`:20-24`) to disk and returns it. Also auto-rotates if it sees the old testing key.
  - `POST /credentials` → `onSetCredentials` (`:225-229`): stub, 204.
  - `GET /identity` → `onGetIdentity` (`:231-239`): returns `{guid:uuid, name:'opal-sage-victor-valley', cpuid:uuid, wifi_mac:uuid}`.
  - `GET /mode` → `onGetMode` (`:241-246`): returns `{mode:'normal'}`.
  - `POST /mode` → `onSetMode` (`:248-251`): stub, 204.
  - `GET /version` → `onGetVersion` (`:253-258`): returns `{version:'Jibo Release Version: Release-3.1.0\n'}`.
  - `POST /system/wipe` → `onWipe` (`:118-124`).
  - `POST /system/backup` → `onBackup` (`:101-107`).
  - `POST /system/restore` → `onRestore` (`:136-142`). All three iterate `RegistryClient.instance.getRecords` and POST `/_M_/system/<op>` (with `{directory: ~/.jibo/backup/<name>}`) to each other service in parallel via `XMLHttpRequest` (`:144-187`).
  - `POST /power/off` → `onPoweroff` (`:265-268`): 204.
  - `POST /power/reboot` → `onReboot` (`:260-263`): 204.
  - `POST /logs/upload` → `onForceLogs` (`:270-275`): returns `{result:'success'}`.
  - `POST /wifi/wpa` → `onWifi` (`:277-280`): returns `{response:'COMPLETED;ip_address='}`.
  - `GET /dynamic_firewall` → `onGetDynamicFirewall` (`:282-285`): returns stored mode.
  - `POST /dynamic_firewall` → `onSetDynamicFirewall` (`:287-291`): stores `req.params.mode` (note: uses `params`, not `body`).
- **WebSocket paths**: extends `HTTPWSService` but `onMessage` is no-op (`:73-75`). No `client.url` branches.
- **Internal state**: `dynamicFirewallMode: string`.
- **External calls**: filesystem (creds), `XMLHttpRequest` to each other registered service for backup/restore/wipe ops.

## system-monitoring — `SystemMonitoringServiceSim`

- **Path** — `/tmp/sdk/packages/skills-service-manager/src/sim-services/system-monitoring/SystemMonitoringServiceSim.ts`
- **Registry record** — `'system-monitoring-service'` (`:18`, comment notes this name matches the platform-side service path).
- **HTTP routes** — none; doesn't override `routes()`.
- **WebSocket paths** — none inspected (`onMessage` only logs `"SystemMonitoringServiceSim::OnMessage"`).
- **Internal state**: none.
- **External calls**: none.
- **Init**: inherits base. Doesn't even override `init()`. This is the most minimal stub of all.

## tts — `TTSService`

- **Path** — `/tmp/sdk/packages/skills-service-manager/src/sim-services/tts/TTSService.ts`
- **Support**: `TTSPromptParser.ts` — converts an annotated prompt string to a `[prompt, tokens]` pair with timing.
- **Registry record** — `'tts'` (`:106`).
- **HTTP routes** (`:157-179`):
  - `POST /tts_token_times` → `onTokenTimes` (`:191-206`): body `{prompt}`; constructs `TTSPromptParser(this.mode)`, calls `createPromptAndTokens(prompt)`, returns `{tokentimes: {tokens: promptTokens[1]}}`.
  - `POST /tts_speak` → `onSpeak` (`:208-233`): body `{prompt}`; stops any in-flight `TokenWorker`; parses prompt; if `mode === Incremental` uses real-time pacing (`speed=1000`), else fires all tokens via `setImmediate` chain. Spawns a `TokenWorker` (`:35-82`) that ticks tokens out by their `.start` time, emits a `'token'` event for each on the service EventEmitter, and on the WS sends a final `{token:'',timestamp:0,status:'STOP'}` packet. Reply is deferred — `TokenWorker.stop()` calls `sendJson(res, {Status:'OK', Message:'Speaking TTS'}, 204)` to close the HTTP response after the last token.
  - `GET /tts_stop` → `onStop` (`:244-252`): replies `{Status:'OK', Message:'Stopping TTS'}` 200, stops worker, sends `STOP` packet on `tokensSocket`.
  - `POST /tts_lex` → `onGetPOSTokens` (`:254-279`): body `{text}`; uses `pos.Lexer.lex(text)` with custom regexes (urls, ids, numbers, spaces, emails, punctuation — `Regexs` at `:20-28`); returns `{tokens:[]}`.
  - `POST /tts_pos_tagging` → `onGetPOSTags` (`:281-307`): body `{tokens}`; uses `pos.Tagger.tag(tokens)`; returns `{tokentags}`.
- **WebSocket paths** (`onConnection` at `:147-155`):
  - `/tts_tokens` → assigned to single `tokensSocket`. Each token tick writes `{token, timestamp, status, moreinfo:[]}` packets via `returnType()` (`:182-189`). End of utterance writes `status:'STOP'`.
  - `/tts_phones` → `phonesSocket` slot; never written to in source.
- **Internal state**: `mode: TTSPlaybackMode` (`Incremental` default — `:95`), `tokensSocket`, `phonesSocket`, `currentWorker: TokenWorker`, `lexer: pos.Lexer`, `tagger: pos.Tagger`.
- **External calls**: calls `PerformanceService.instance.log(Date.now(), 'TTS', 'SPEAK_REQUEST_COMPLETE')` after each utterance (`:72`).
- **Public API**: `setMode(mode)` (`:117-124`), `toggleDevMode()` (`:126-134`, deprecated).

---

## Cross-cutting

### Base classes (`/tmp/sdk/packages/jibo-service-framework/src/`)

- **`HTTPService`** (`HTTPService.ts:23`) — extends Node's `EventEmitter`. Owns a `connect` app, `Router`, and `http.Server`. `init()` finds a free port via `HTTPService.getPort()` (`:51-77`), `listen`s, then unless `name === 'registry'` calls `_register()` which uses `RegistryClient.instance.deleteRecord` then `addNewRecord` (`:434-465`). Refreshes every 10 s (`REFRESH_DURATION = 10000`, `TTL = 30` — `:18-19`). Base routes (`:253-259`):
  - `GET /_M_/errors` → returns `new ServiceErrors()` (empty error list).
  - `GET /_M_/health` → returns `{}`.
  - `POST /_M_/system/backup` → 204 stub.
  - `POST /_M_/system/restore` → 204 stub.
  - `POST /_M_/system/wipe` → 204 stub.
  Every sim-service inherits these (registry is the exception — it overrides `routes()` entirely without `super.routes(url)`).
- **`HTTPWSService`** (`HTTPWSService.ts:12`) — adds a `ws.WebSocket.Server({server: this.server})` so the same port serves both HTTP and WS upgrades. In `onConnection` it stamps `client.url = request.url` and adds it to `this.connections` (`:33-46`). Concrete classes override `onConnection`/`onClose`/`onMessage` to dispatch per `client.url`. Provides `sendWsJson(client, json)` (`:54-83`) and `broadcast(message)` (`:90-93`).
- Sim-services by base class:
  - `HTTPService`: `RegistryService`, `MediaService`, `PerformanceServiceSim` (init never opens port).
  - `HTTPWSService`: `AudioServiceSim`, `BodyService`, `JetstreamServiceSim`, `LPSService`, `SecureTransferServiceSim`, `ServerService`, `SkillsServiceSim`, `SystemManagerService`, `SystemMonitoringServiceSim`, `TTSService`.
  - `EventEmitter` only (not a registered service): `EventPlayback`.

### Combined WebSocket path set

These are every URL the SSM exposes for incoming WS upgrades, organized by service:

- audio: `/input_energy` (active); commented-out: `/detection`, `/streamState`, `/rin`, `/rout`, `/sin`, `/sout`, `/ref`
- body: `/axis_state`, `/axis_command`, `/led_command`, `/touch`
- jetstream: `/events`, `/vad`
- lps: `/lps/visual_awareness`, `/lps/audible_awareness`
- server: `/server/notifications`, `/server/notifications/status`
- tts: `/tts_tokens`, `/tts_phones`

Services with no `client.url ===` branches but which still accept WS upgrades (because they extend `HTTPWSService`): `secure-transfer`, `skills-service`, `system-manager`, `system-monitoring-service`. They just don't dispatch on path — `skills-service` reads command-payload messages on any connection (`SkillsServiceSim.ts:48-84`).

### Combined HTTP path set

Per service (every route added beyond `/_M_/errors`, `/_M_/health`, `/_M_/system/{backup,restore,wipe}` which every `HTTPService` inherits, except `registry`):

- audio: `POST /beam`, `GET /beam/state`, `GET /beam/info`, `GET/POST /debug`, `GET/POST /diag`
- body: (none)
- jetstream: `POST /proactive/trigger`, `POST /listen/mimic_global_turn`, `POST /listen/start_local_turn`, `POST /listen/cancel_local_turn`, `POST /listen/update_local_turn`, `POST /listen/subscribe_global`, `POST /listen/unsubscribe_global`, `POST /listen/unsubscribe_all_globals`, `POST /listen/set_hj_mode`, `POST /listen/get_hj_mode`, `POST /listen/cancel_any_turn`, `POST /listen/start_enrollment_turn`, `POST /enroll/create_speaker_model`, `POST /enroll/remove_speaker_model`, `POST /enroll/get_utterance_count`, `POST /enroll/get_enrolled_speakers`, `POST /pronunciation/init_pronunciation_learning`, `POST /listen/start_pronunciation_learning_turn`
- lps: `POST /lps/barcode`, `POST /lps/demand_detect`, `POST /lps/faces`
- media: `POST /media/photo`, `GET /media/photo`, `POST /media/photo/store`, `GET /media/photo/get`, `POST /media/recording/start`, `POST /media/recording/control`, `POST /media/recording/play`
- performance: (none — port never opened either)
- registry: `GET /registry`, `PUT /registry`, `POST /registry`, `DELETE /registry` — replaces base routes entirely
- secure-transfer: `GET /UGCKeyReady`, `GET /hasBackupData`
- server: (none added)
- skills-service: `GET /version`
- system-manager: `GET/POST /credentials`, `GET /identity`, `GET/POST /mode`, `GET /version`, `POST /system/wipe`, `POST /system/backup`, `POST /system/restore`, `POST /power/off`, `POST /power/reboot`, `POST /logs/upload`, `POST /wifi/wpa`, `GET/POST /dynamic_firewall`
- system-monitoring-service: (none)
- tts: `POST /tts_token_times`, `POST /tts_speak`, `GET /tts_stop`, `POST /tts_lex`, `POST /tts_pos_tagging`

### Port allocation & registry naming

- Every service is given `ServiceOptions = {port, register?}` at construction by `FactoryDeps`/SSM bootstrapping. `HTTPService.getPort()` will try the requested port, falling back to an OS-assigned port if unavailable (`HTTPService.ts:51-77`).
- Registry record name = constructor arg 1 of `super(name, options, rootDir)`. The full name list (and the name jibo-be / `RegistryClient` will look up) is exactly: `audio`, `body`, `jetstream`, `lps`, `media`, `performance`, `registry`, `secure-transfer`, `server`, `skills-service`, `system-manager`, `system-monitoring-service`, `tts`. Note: the skills service is registered as `skills-service` (with hyphen), and system monitoring as `system-monitoring-service` (with `-service` suffix), but most others use the bare name.
