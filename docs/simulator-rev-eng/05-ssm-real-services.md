# SSM Real Services — Reference for Port Authors

Hardware-backed services from `/tmp/sdk/packages/skills-service-manager/src/services/`. `src/sim-services/` stubs out a subset; this doc lists what real behavior the stubs replace, HTTP/WS surface, cloud/hardware deps, and what a browser port has to fake. Citations `file:line` are relative to `…/skills-service-manager/src/`.

`services/log.ts:1-3` is just `parentLog.createChild('Svc')` — not a registered service.

---

## 1. `dev-shell`
- **Registered name**: `'dev-shell'` — `services/dev-shell/DevShell.ts:79`.
- **Class**: `DevShell extends HTTPWSService` — `DevShell.ts:62`. Helper: `TcpProxy` — `dev-shell/TcpProxy.ts:67-148`.

### Hardware/cloud deps
- `systemManager` for reboot/poweroff/version/master volume/OTA (`DevShell.ts:411, :427, :443, :481, :503, :525, :553, :595`).
- `wifi` client for list/select/add/remove networks (`:621-844`).
- `expression.indexRobot()` for body indexing (`:457`).
- `JiboSync.createServer` for `jibo sync` upload server (`:234`).

### HTTP routes (`routes()` at `DevShell.ts:111-147`)

Simulator-only:
- `POST /speak` `{words, final, heyJibo, speaker, speakerId}` — feeds `JetstreamServiceSim.onWordsReceived` and the chat view (`:847-905`).

Always:
- `POST /execute` `{script}` — broadcasts `{command:'execute', id, script}` to skill WS clients; awaits `execute-result` reply (`:912-963`).

On-robot only: `POST /check-update | /delete-skill | /delete-all | /diskspace | /download-update | /getvolume | /index | /install-update | /run | /poweroff | /reboot | /reset-proxy/:serverPort | /setvolume | /stop | /sync-skill | /version | /wifi-list | /wifi-current | /wifi-verify | /wifi-select | /wifi-add | /wifi-remove` (`:124-145`).

### WebSocket endpoints
- `/download-update` → `_otaSocket`, streaming OTA progress (`:151-156`).
- `/autobot` → `_autobotSocket`, mirrors `execute` & `autobot-log` for jibo-autobot (`:154, :199-205`).
- Default skill WS receives `{command:'execute', id, script}` (`:945-955`).

### Sim port stub needs
- Return 200 for `/speak` (route into fake jetstream). Return `{success:false}` for `/execute`. All other POSTs → `{status:'OK'}` no-op.

---

## 2. `error`
- **Registered name**: `'error-service'` — `services/error/ErrorService.ts:89`.
- **Class**: `ErrorService extends HTTPWSService` — `:36`. Data: `ErrorCodes.json` (rows like `"WIFI1-…": {code, description, title, message, tapAction, icon, spokenPromptOnError, spokenPromptOnResolution, priority, repeatTime}` — `ErrorCodes.json:3-26`).

### Hardware/cloud deps
- WS client to `system-monitoring-service` at `ws://host:port/errors/codes` for platform error codes (`ErrorService.ts:255-271`).
- Writes the full code dictionary into KB slice `/error-codes` (`:125-145`).
- Auto-sets `_mockErrorsEnabled = true` when `RUNMODE === SIMULATOR` (`:100-102`).

### HTTP routes (`:149-185`)
- `POST /mockErrorCodes` — enable/push fake codes (`:399-413`).
- `POST /errorCodeData` — full code dictionary (`:416-427`).
- `POST /getErrorCount` (`:388-395`).
- `POST /subscribeError` `{errorCode}` — long-poll resolution; disables req timeout (`:345-386`).
- `POST /processedError` `{errorCode}` — dismiss head, send to rescheduler (`:313-343`).
- `POST /disableSkillSwitching` `{disabled}` (`:273-290`).
- `POST /getCurrentErrorId` / `POST /getContents` (`:292-311`).

### Cross-service: when a new highest-priority error appears, builds `ListenResult{intent:'launch', entities:{skill:'@be/settings', errorId}}` and calls `GlobalManagerService.instance.handleSkillLaunch(parseResults)` — `:535-555`.

### Sim port stub needs
- Static empty queue. Return `{errorCount:0, currentErrorId:null, errorList:{}}`. Never auto-launch `@be/settings`.

---

## 3. `expression`
- **Registered name**: `'expression'` — `services/expression/ExpressionService.ts:34`.
- **Class**: `ExpressionService extends RemoteService` — `:17` (RemoteService = the SRO framework, not `services/remote/RemoteService.ts`).

### Hardware/cloud deps
- `RegistryClient.getRecordByName('body')` → `ws://host:port` → `BodyPosVelOutput` (33 Hz pos/vel) + `LEDOutput` (33 Hz LED) from `animation-utilities` (`:101-118`).
- `DOFArbiter` priorities (hard-coded): `LowTest=1, Cleanup=2, Attention=3, Behavior/EmbodiedSpeech=5, EmbodiedListen/AttentionCommand=7, BargeIn=8, Test=9` (`:135-153`).
- `AttentionManager` with a mock Jibo body (`expression/attention/Jibo.ts:1-27`).

### DOF streaming (load-bearing for face/body sim)
- `Expression` ctor attaches `AuxOutput` whose delegate emits `'dofs'`(timestamp, dofValues, metadata) — `Expression.ts:36-52, :80-83`. Same tick emits `'kinematics'` `{base, eye, head}` from `animate.getKinematicFeatures()` (`:43-49`). These flow over the SRO RPC channel to skill code.

### SRO methods (called by skills via remote-object framework, not HTTP)
`createAnimation`, `createAndPlayAnimation` (load `.anim` JSON, mute/scale, build via `AnimationBuilder`) — `:97-109, :492-548`. `setAttentionMode`/`pushAttentionMode`/`getAttentionMode` — `:223-243`. `acquireTarget`, `awaitFace` — `:245-265`. `centerRobot`, `cleanup` — DOF-arbiter centering — `:267-305`. `indexRobot` — `expression/IndexRobot.ts:1-60` (pauses bodyOutput, polls DOF index counters, 15 s timeout). `setLEDColor`, `blink`, `acceptEmotionState`, `doCenterRobotOnDisconnect`, `isPerformingShutdownPose`, `destroyCaches`, `setDOFs` — `:140-331`.

### Handles
- `AnimationInstance` — emits `STARTED|STOPPED|EVENT|CANCELLED|REJECTED` (`AnimationInstance.ts:9-50`).
- `AcquireHandle`, `AwaitFaceHandle`, `AttentionHandle` — `expression/handles/*.ts`. 1 s sweep destroys handles past retain time (`Expression.ts:417-470`).

### onClose: sets attention OFF, optionally centers, emits `'system-reset'`, resets `BuilderCache` (`ExpressionService.ts:53-64`).

### Sim port stub needs
- Fake animate engine ticking at 33 Hz emitting `'dofs'`+`'kinematics'` (see `project_live_face_plan.md`).
- `indexRobot` → resolve `'SUCCEEDED'`. `setLEDColor`/`blink` → wire to renderer. `setAttentionMode`/`acquireTarget`/`awaitFace`/`centerRobot`/`cleanup` → no-op resolves. `createAndPlayAnimation` → emit STARTED then STOPPED.

---

## 4. `global-manager` — cloud-event → skill-relaunch hub

- **Registered name**: `'global-manager'` — `services/global-manager/GlobalManagerService.ts:63`.
- **Class**: `GlobalManagerService extends HTTPWSService` — `:33`.

### Hardware/cloud deps
- `jetstream.unsubscribeAllGlobals()`, then `jetstream.setHotwordMode(Custom_NLU_Added, ['globals/global_commands_launch'])` (`:20, :85-100`).
- Hooks `jetstream.events.skillSwitch.on(handleSkillLaunch)` (`:90`).

### HTTP routes
- `POST /global` `{action, canHandle}` — registers per-skill capability for a `GlobalCommand` (`:103-111, :315-334`).
- `POST /clean_relaunch` — fabricates a `'stop'` ListenResult and relaunches `@be/idle` (`:342-367`).

Response envelope: `{status, message, id, result, moreinfo}` (`:377-386`).

### WebSocket: `/globals` → `this.globalSocket`. Single socket — replaced on each new connect, cleared on `onClose` (`:113-118, :132-135`).

### Message vocabulary on `/globals` WebSocket
Envelope: `{status, message:<typeTag>, id:'', result:<payload>, moreinfo:''}`

| `message` tag | Sent from | `result` payload | Meaning |
|---|---|---|---|
| `'skill-relaunch'` | `handleSkillLaunch` when current skill is `@be/*` or same as target | `types.ListenResult` (asr, nlu, match, transID) | Skill re-inits in place. `match`={skillID, onRobot, isProactive?, skipSurprises?, cloudSkill?} (`:170-178`) |
| `'skill-launch'` | `handleSkillLaunch` for cross-skill switches | `types.ListenResult` | Kill current, launch new (`:180-184`) |
| `'global'` | `emitGlobal` when target skill registered `canHandle=true` | `types.ListenResult` | Forward global to skill (`:297-302`) |
| `'non-interrupting-global'` | `sendNonInterrupting` for `VOLUME`, `OVERHERE`, unrecognized | `{}` | "Saw it, not interrupting" (`:304-307`) |

### `handleSkillLaunch(result)` central dispatch (`:143-186`)
- Accepts `types.ListenResult` OR a `SkillSwitchResult` `{onRobot, skillID, isProactive, skipSurprises, transID, data}` from cloud DM.
- For cloud results: `match.skillID = onRobot ? skillID : '@be/nimbus'`, stamps `match.cloudSkill = skillID` for cloud-skill handoff.
- Branch: current skill name `=== skillName` or starts with `@be/` → `'skill-relaunch'`; else `'skill-launch'`.
- Also emits internal `this.skillRelaunch.emit(parse)` (`:174-175`).

### Default global-command fallback (`:215-282`) when skill `canHandle=false`
| Global command | Fallback |
|---|---|
| STOP, SLEEP, PAUSE, HOLDON, TURNAWAY, TURNAROUND | `@be/idle` |
| HELP, WHATCANIDO | `@be/friendly-tips` |
| VOLUME, OVERHERE, unknown | `non-interrupting-global` only |

### Public events
- `skillRelaunch: TypedEvent<ListenResult>` (`:48, :70`), `globalEvent: TypedEvent<ListenResult>` (`:54, :71`).

### Sim port stub needs
- Accept `/globals` WS, remember last socket.
- Implement `handleSkillLaunch(skillID)`: if currentSkill is `@be/*` or matches → `skill-relaunch`; else `skill-launch`. **Be is the universal launcher**, so a tile-click from sim lands on `skill-launch`.
- `POST /global` to remember `canHandle` per command/skill.
- `POST /clean_relaunch` → `skill-launch` of `@be/idle`.
- Always use the `{status, message, id, result, moreinfo}` envelope.

---

## 5. `kb` — knowledge base (file-backed JSON node graph)

- **Registered name**: `'kb'` — `services/kb/KBService.ts:69`. Class: `KBService extends HTTPWSService` — `:47`.
- Sync helpers: `LoopManager`, `RobotManager`, `HolidayManager`, `MediaListManager` — all subclass `SyncManager` (`kb/SyncManager.ts`, 522 lines).

### Data model
- Backed by `jibo-kb` library. Graph of `Node` objects keyed by `_id`, persisted to disk under `KnowledgeDatabase.getRootDirectory()`. On-robot: `/opt/jibo/Knowledge`; off-robot: `~/.jibo/kb` (sanity checks at `:556, :587, :999`).
- Slices are path-like: `/jibo/loop`, `/jibo/robot`, `/jibo/holidays`, `/jibo/media`, `/jibo/media-list`, `/error-codes`, etc.
- Each slice has a root `Node` (`kbdb.loadRoot`) with arbitrary `data` + child links. Assets (binary blobs) sit beside slice on disk, served at `/v1/kb/:kbname/asset/:filename` (`:267-283, :467-498`).

### Hardware/cloud deps
- Each `SyncManager` polls JSC cloud clients (`JSC.{Loop,Robot,Holiday,Media}`) on intervals — 2 h loop/media-list, 6 h robot/holidays (`LoopManager.ts:16, :88`, `RobotManager.ts:10, :32`, `HolidayManager.ts:10, :32`, `MediaListManager.ts:21`).
- `LoopManager` informs ASR/NLU of loop-member names (`LoopManager.ts:86-91`, `EnrollmentLoopInformer.ts:1-34`).
- Sync managers init only when `systemManager.getMode() !== 'oobe'` (`KBService.ts:118-167`).

### HTTP routes (`:229-356`)
Node API:
- `GET    /v1/kb/:kbname/node/load/:id` (`:237, :404-414`)
- `POST   /v1/kb/:kbname/node/load` body=`[ids]` (`:243, :417-427`)
- `GET    /v1/kb/:kbname/node/loadRoot` (`:249, :430-439`)
- `POST   /v1/kb/:kbname/node/save` body=node (`:255, :442-453`)
- `DELETE /v1/kb/:kbname/node/remove/:id` (`:261, :456-464`)

Assets:
- `GET    /v1/kb/:kbname/asset/:filename` (`:267, :478-482`)
- `POST   /v1/kb/:kbname/asset/:filename` (`:273, :485-490`)
- `DELETE /v1/kb/:kbname/asset/:filename` (`:279, :493-498`)

Slice management:
- `POST   /v1/kb/:kbname/create` (`:285, :501-510`)
- `GET    /v1/kb/:kbname/exists` (`:289, :513-522`)
- `DELETE /v1/kb/:kbname/remove/yesiamsure` (`:295, :530-564`)
- `DELETE /v1/removeall/yesiamsure` (`:299, :570-602`)

Loop / Media conveniences: `POST /v1/loop/{updatePhoneticName,enrollment,suspend}`, `GET /v1/loop/haskeybackup/:loopId`, `POST /v1/media/{storePhoto,downloadThumbnails,downloadPhoto,deletePhoto}` (`:307-349, :609-726`).

### WebSocket broadcasts (all clients, JSON-stringified — `:958-979`)
- `"MediaListChanged"` (from MediaListManager)
- `"HolidayChanged"` (from HolidayManager)
- `"RobotUpdated"` (from RobotManager)

### Concurrency: `REGULAR_REQUEST` (0) vs `BACKUP_RESTORE_REQUEST` (1). Backup defers all, regular defers only backup (`:370-401, :1006-1112`). Mainly matters if you implement backup/restore — most sims don't.

### Sim port stub needs
- In-memory `Map<sliceName, Map<nodeId, nodeJson>>`. Cover `node/load/:id`, `node/loadRoot`, `node/save` — that's 95 % of skill use.
- Always seed `/jibo/loop` (with one fake primary UserNode), `/jibo/settings`, `/error-codes`.
- `GET /v1/kb/:kbname/exists` → `{exists:true}` then lazily create.
- Assets → 404 acceptable. Cloud sync entirely skip. Don't broadcast `MediaListChanged` etc.

---

## 6. `media-manager`
- **Registered names**: `'media-manager'` + alias `'media-proxy'` — `services/media-manager/MediaManagerService.ts:72, :817-846`. Class: `extends HTTPService` — `:44`.

### Hardware/cloud deps
- `/var/jibo/credentials.json` or `~/.jibo/credentials.json` → `JSC.Media` + `JSC.Key` clients (`:751-780`).
- Symmetric encryption key from `/var/jibo/keys/keypair.json` (on-robot) or `~/.jibo/keys/`. Disables encryption if off-robot keypair missing (`:783-814`).
- Spawns `/usr/bin/gst-launch-1.0` for live audio RTP streaming over UDP (`:362-395`); `/usr/bin/killall` to stop (`:412-433`); `/usr/bin/amixer` to set ALSA `numid=6` on `hw:TLV320DAC3100` (`:445-470`).

### Storage layout
- On-robot: `/opt/jibo/Photos`, `…/upload`, `…/cache`, `/opt/jibo/Recordings`. Off-robot: under `~/.jibo/{photos,recordings}` (`:935-983`).
- 100 MB / 25 MB free cache budget on robot, 25 % of that off-robot (`:37-41, :103-107`).

### HTTP routes (`:123-135`)
- `POST /media-manager/adopt` `{contentIDs[], mediaType}` (`:242-266`)
- `POST /media-manager/upload` `{contentID, type, reference?, keepLocal?}` (`:179-239`)
- `POST /media-manager/download` `{contentID, type}` (`:269-292, :475-522`)
- `POST /media-manager/delete` `{contentID, type, deleteLocal?, deleteRemote?}` (`:295-335`)
- `POST /media-manager/audiostreamstart` `{ipAddress, port?}` (`:349-398`)
- `POST /media-manager/audiostreamstop` (`:412-433`)
- `POST /media-manager/speakerlevel` `{level}` (`:436-472`)
- `GET  /proxy/media/photo/get?id=<id>` — cached JPEG proxy with cloud-fetch fallback (`:526-580`).

### Events: `'_cacheSweep'` (test hook) (`:587`).

### Sim port stub needs
- 204 for all mutation endpoints. `/proxy/media/photo/get?id=…` → return a 1×1 PNG or your placeholder.

---

## 7. `notifications`
- **Registered name**: `'notifications'` — `services/notifications/NotificationsService.ts:21`. Class: `extends HTTPWSService` — `:11`.
- No hardware deps. In-memory only.

### HTTP routes (`:54-81`)
- `POST   /notifications` → add `{...body, id:uuid}`, emit `'notification-created'` (`:83-93`).
- `PUT    /notifications/:id` → patch type/title/description, emit `'notification-updated'` (`:95-113`).
- `GET    /notifications` → full queue (`:115-118`).
- `DELETE /notifications/:id` → emit `'notification-deleted'` (`:120-135`).
- `DELETE /notifications` → emit `'notifications-all-deleted'` (`:137-145`).

### WebSocket: all clients receive `{eventName, event}` on every mutation (`:150-162`). Local `EventEmitter` fires same names (`:153`).

### Sim port stub needs
- Port the 167-line file verbatim — uses only `uuid` and HTTPWSService.

---

## 8. `performance`
- **Registered name**: `'performance'` — `services/performance/PerformanceService.ts:36`. Class: `extends HTTPWSService implements IPerformanceService` — `:20`.
- `instance` getter falls through to `PerformanceServiceSim.instance` when real one not instantiated (`:28-33`).

### HTTP: `POST /log` `{time, type, description?}` → broadcasts on every WS (`:58-90`).
### WebSocket: `{type:'time-ping', description:<pingId>}` → reply `{time:now(), type:'time-pong', description:<pingId>}` — Cristian's clock-sync (`:101-118`).

### Sim port: use `sim-services/performance/PerformanceServiceSim.ts` directly.

---

## 9. `remote` — Loop (remote-operation) gateway
- **Registered name**: `'remote'` — `services/remote/RemoteService.ts:33`. Class: `extends HTTPWSService` — `:17`.
- Supporting: `ConnectionManager` (external HTTPS port 8160), `AssetServer`+`VideoStreamer`+`PhotoHoster`.

### Hardware/cloud deps
- Listens for Loop iOS/Android app (formerly ROM) on port 8160 via `ConnectionManager.listen` (`ConnectionManager.ts:12, :55-76`). 10 s heartbeat, 20 s flatline (`:13-14`).
- `/request` HTTP for `SecurityController` to forward Access Control Object (`ConnectionManager.ts:62`).
- `/assets/<id>` serves photo/video assets from skills (`AssetServer.ts:6, :22-33`).

### WS protocol with skill process (single internal socket — `Messages.ts:1-38`)
Incoming envelope `{type:'message', status:<tag>, …}`:
- `'handleAsset'` + `asset.type:'video'|'photo'` → register `AssetServer` handler (`RemoteService.ts:48-51`).
- `'cancelAsset'` → remove handler.
- `'close'` → ConnectionManager.close(code, reason).
- `'launchSkill'` `result: ListenResult` → forward to `GlobalManagerService.handleSkillLaunch` (`:54-60`).

Outgoing to skill: `ConnectMessage{status:'connected', appData}`, `DisconnectMessage{status:'disconnected', wasError}`, `SendErrorMessage{status:'sendError', message}` (`Messages.ts:40-56`, `RemoteService.ts:90-115`). Otherwise raw pass-through (`:64-76, :117-119`).

### Sim port stub needs
- Open WS at `/remote`, never connect external client. Loop-using skills time out — same as a real robot without paired phone.
- If skill emits `launchSkill`, route to your `GlobalManagerService` sim.

---

## 10. `scheduler`
- **Registered name**: `'scheduler'` — `services/scheduler/SchedulerService.ts:38`. Class: `extends HTTPService` — `:30`.

### Hardware/cloud deps
- `node-schedule` for cron (`:162-220`). `OTAUpdater` for OTA pipeline (`:45, :57, :70-156`).
- `systemManager.onShutdown.once(_launchShutdownAnimation)` → triggers `@be/settings` with `intent:'shutdownAnimation'` (`:63, :326-332`).

### HTTP routes (`:67-156`)
- `POST /ota-update | /download-status | /backup-status | /backup-robot | /check-updates` (`:70-139`).
- `POST /add` `{schedule, skillData:{skill,domain,intent}}` → job calls `GlobalManagerService.handleSkillLaunch` with fabricated `ListenResult` (`:141, :223-273`).
- `POST /remove` `{jobId}`, `POST /list`, `POST /has-job` `{jobId}` (`:145-156, :275-324`).

### Sim port stub needs
- In-memory `/add`/`/remove`/`/list`/`/has-job` map; never fire jobs. All OTA endpoints → `{status:'OK', data:[]}`.

---

## 11. `security-controller`
- No own port. Class: `SecurityControllerService implements SSMService` — `services/security-controller/SecurityControllerService.ts:51`. The internal HTTPS server it spawns registers as `'security-controller'` (`SecurityServer.ts:31`).

### Hardware/cloud deps
- `JSC.ROM.setupServer({ipAddress})` for server private key + cert (`:252-266`).
- `systemManager` `/dynamic_firewall` POST to open/close TCP 7160 on robot firewall (`:322-348`).
- Listens for `'RomConnectionRequested'` / `'CommandRequest'` notifications via `NotificationsDispatcher` (`:111-114`).

### Behavior: on CommandRequest, posts ACO to `127.0.0.1:8160/request` (the ConnectionManager). If accepted, fetches cert from `ROM.setupServer`, spawns `SecurityServer` (TLS-pinned HTTPS+WS proxy → 8160) on port 7160, opens firewall, times out after 60 s with no client (`:119-205`). `SecurityServer` mTLS-checks client cert fingerprint and proxies to ConnectionManager (`SecurityServer.ts:23-60`).

### Sim port: skip entirely.

---

## 12. `skills`
- **Registered name**: `'skills-service'` — `services/skills/SkillsService.ts:48`. Class: `extends HTTPWSService` — `:37`.

### Hardware/cloud deps
- `SystemManagerClient.{list, getSkillRecordByName, launch, terminate}` to fork/kill skill node processes (`:64, :78, :240, :263, :286, :297, :308`).
- `ScreenScheduler.stopTimerAndTurnOn() / start()` for screen-off idle timer (`:62, :213, :245, :411`).
- `PerformanceService.instance.log()` perf timestamps (`:235, :255, :264`).
- `DevToolsClient` proxies `localhost:9191` and `:12345` for Chrome devtools (`:109-133`).

### Public state: `currentSkill: SkillRecord` (`:41`).

### HTTP routes (`:97-226`)
- `GET  /skill/list` → wraps `SystemManagerClient.list` (`:100-107`)
- `GET  /devtools` / `GET  /ssm-devtools` (mode==='int-developer' only) (`:109-133`)
- `GET  /version` → SSM package version (`:135-139`)
- `POST /launch-dev` `{command}` (`:141-179`)
- `GET  /mode` → `{mode, electron}` (`:183-190`)
- `POST /terminate` `{command}` (`:192-218`)
- `POST /reset-proxy/:serverPort` (`:220-225`)

### WS messages from skill
- `command:'initDone'` → emit `'hide'`, send `{command:'show'}` back (`:326-332`).
- `command:'finished'` → if `@be/be`, auto-relaunch `@be/idle` via `GlobalManagerService` (`:333-341`).

### `launch(skillName, parse, callback)` — perf-logged steps: `getSkillRecordByName`, optional terminate-current, `SystemManagerClient.launch(name)`, `stopTimerAndTurnOn` (`:234-275`).
### `terminate(callback)` — if currentSkill terminate it, else list+iterate to clean zombies (`:284-316`).
### `onWipeRequest` — rimrafs `/opt/home/*` skill homes (`:353-407`).

### Sim port stub needs
- Track `currentSkill = {name, path}` (default `@be/be` per `sim-services/skills/SkillsServiceSim.ts:32-35`).
- `launch(name)` → set currentSkill, post `{command:'show'}` to skill WS, emit `'hide'` on `initDone`.
- `terminate()` → null. Skip devtools routes. Wire `launch`/`finished` into your `GlobalManagerService` sim.

---

## 13. `wifi`
- **Registered name**: `'wifi'` — `services/wifi/WifiService.ts:59`. Class: `extends HTTPWSService` — `:42`.

### Hardware/cloud deps
- `WiFiManager` shells out via `SystemManagerClient.sendWifiRequest(method, path, body, cb)` → `wpa_cli` (`:773-781`).
- Watches `/sys/kernel/debug/ieee80211/phy0/wlcore/corrupted_packets`; sends `REASSOCIATE` on change (15 s throttle, on-robot only) (`:35-36, :80-82, :754-801`).
- `PingService`, `IFconfigService`, `SpeedTestService` spawn `/usr/bin/ping`, `/usr/sbin/ifconfig`, node-speedtest (`wifi/stats/*.ts`).

### HTTP routes (`:107-137`)
- `POST /remove_all | /remove_network | /select_network | /add_network | /get_current_network | /get_saved_networks | /verify_connection` (`:110-136, :334-454, :507-651`).

### `onHealth` override: `GET /health` returns combined `{ssid, strength, speed, ip_address, ping, config, speedtest, error}` with 29 s timeout race (`:280-332`).

### WebSocket `/wifi_events` → `{eventName, data}` envelopes; key event `'error'` (`:156-169`).

### Sim port stub needs
- `get_current_network` → `{status:'OK', stats:{ssid:'sim', strength:100, speed:300, ip_address:'127.0.0.1'}}`.
- `get_saved_networks` → `{status:'OK', networks:[]}`. Mutation endpoints → `{status:'OK'}` no-op. `/health` → static all-OK.

---

# Diff vs `sim-services/`

Source: `super('<name>',…)` calls in `sim-services/*` (verified via grep, see this doc's research notes).

| Real (`super` name) | Sim counterpart (`super` name) | Same name? | Notes |
|---|---|---|---|
| `dev-shell` | — | — | Real-only. Sim port needs thin stub. |
| `error-service` | — | — | Real-only. |
| `expression` | — | — | Real-only. Sim must fake 33 Hz DOF/kinematics stream. |
| `global-manager` | — | — | Real-only. **Critical** — sim must implement WS message vocabulary. |
| `kb` | — | — | Real-only. Sim needs in-memory node store + asset 404. |
| `media-manager` (alias `media-proxy`) | `sim-services/media/MediaService.ts` → `media` | **NO** (different name) | Sim service is for TTS audio playback only. Port must keep both names alive if SDK clients use either. |
| `notifications` | — | — | Trivial; port real one verbatim. |
| `performance` | `sim-services/performance/PerformanceServiceSim.ts` → `performance` | **YES** | Real service falls through to sim when uninstantiated. |
| `remote` | — | — | Real-only. Loop/ROM pairing. |
| `scheduler` | — | — | Real-only. Stub `/add`/`/list` in memory. |
| `security-controller` | `sim-services/secure-transfer` → `secure-transfer` | **NO** (different purpose) | Skip in sim. |
| `skills-service` | `sim-services/skills/SkillsServiceSim.ts` → `skills-service` | **YES** | Sim mostly good; extend `launch`/`terminate` to route through your `GlobalManagerService`. |
| `wifi` | — | — | Real-only. Return canned OK. |

### Sim-only services (no real counterpart — must be ported as the "soft" layer)

| Sim service | `super` name | Notes |
|---|---|---|
| `audio/AudioServiceSim` | `audio` (`:189`) | WebAudio target. |
| `body/BodyService` | `body` (`:55`) | Receives `BodyPosVelOutput` from `expression`. |
| `event-playback/EventPlayback` | (none) | Records/replays UI events for autobot. |
| `jetstream/JetstreamServiceSim` | `jetstream` (`:171`) | Fakes ASR/NLU + cloud DM `skillSwitch`. Hub protocol equivalent. |
| `lps/LPSService` | `lps` (`:48`) | Local Perception System (face/voice detect). |
| `media/MediaService` | `media` (`:43`) | TTS audio playback. |
| `registry/RegistryService` | `registry` (`:21`) | Holds `RegistrationRecord` map. |
| `secure-transfer/SecureTransferServiceSim` | `secure-transfer` (`:19`) | OAuth token store. |
| `server/ServerService` | `server` (`:35`) | Cloud DM proxy. |
| `system-manager/SystemManagerService` | `system-manager` (`:38`) | `getMode`, `getVersion`, skill list/launch/terminate. |
| `system-monitoring/SystemMonitoringServiceSim` | `system-monitoring-service` (`:18`) | `ErrorService` connects here at `/errors/codes`. |
| `tts/TTSService` | `tts` (`:106`) | SSML→audio. Used by `DevShell._say` to force Test mode. |

### Bottom line

Sim port has a same-name counterpart for **2 of 13** real services (`performance`, `skills-service`). Everything else needs a fresh stub keyed on registry name `dev-shell | error-service | expression | global-manager | kb | media-manager | notifications | remote | scheduler | security-controller | wifi` (and alias `media-proxy`).
