# 03 — SSM Top-Level Orchestration (Factory, Init, Process Model)

Source root: `/tmp/sdk/packages/skills-service-manager/` (paths relative unless `/`-prefixed).

SSM orchestrates every service (HTTP/WS endpoints), brings up a registry +
RegistryClient, inits a fixed set of clients (`BodyClient`, jibo-service-clients,
expression, jetstream), then unblocks the renderer (jibo-be). Built on the
`orchestrator` npm package (gulp-style task graph).

---

## 1. Top-level entry — `index.ts`

`src/index.ts:1-65` exports a default object with `Factory` + every exposed
service class (`TTSService`, `LPSService`, `BodyService`, `JetstreamServiceSim`,
`SkillsService`, `GlobalManagerService`, `MediaService`, `MediaManagerService`,
`KBService`, `WifiService`, `SchedulerService`, `TcpProxy`, `Debouncer`,
`GetConfig`, `ErrorService`, `SecureTransferServiceSim`, `SecurityControllerService`,
`ExpressionService`, `RemoteService`, `ScreenScheduler`, `rootLog`, plus
`RegistryClient`/`HTTPService`/`HTTPWSService` re-exports).

`index.ts:1-5` forces Node `ws` onto `global.WebSocket` (libchromium throttle
workaround — skip in browser). `export function start()` (`63-65`) is dead.

Real process entrypoints (each `jibo-*.js` shim → `lib/` → src):

- `jibo-ssm.js` → `processes/ssm/{index,MainProcess}.ts` + `startup/index.js`
- `jibo-mms.js` → `processes/mms/{index,MMSProcess}.ts`
- `jibo-scs.js` → `processes/scs/{index,SCSProcess}.ts`
- `jibo-expression.js` → `processes/expression/index.ts`
- `skill-main.js` → `processes/skills/{index,MainProcess}.ts` (Electron renderer)

SSM main (`processes/ssm/MainProcess.ts:50-61`) → `startup/index.js` →
`new GetConfig().getConfig(...)` → `new Factory(config, rootDir, mode).init(cb)`
(`startup/index.js:34-72`).

`GetConfig` (`src/init/GetConfig.ts:1-21`):
1. `SystemManagerClient.createInstance('127.0.0.1', 8585)`
2. `systemManager.getMode(cb)` → mode
3. Returns `/usr/local/etc/jibo-ssm/jibo-ssm-${mode}.json`

Modes shipped: `developer`, `int-developer`, `normal`, `oobe`.

---

## 2. Configuration shape

`src/FactoryDeps.ts:142-157`:

```ts
export interface Client  { port: number; host: string; }
export interface Service { port: number; }
export interface Configuration {
    RegistryClient?: Client;
    RegistryService?: Service;
    services: SSMServiceConfigs;
    platformVersion?: string;
    logging: any;
}
```

Helpers (`FactoryDeps.ts:42-45`):

```ts
export type SSMServices       = {[name: string]: SSMServiceClass};
export type SSMServiceConfigs = {[name: string]: ServiceOptions};
export type SSMServiceDeps    = {[name: string]: string[]};
export type Callback          = (err?: Error) => void;
```

- **`RegistryClient`** — `{host,port}`. If `host` missing, Factory shells out to
  `bin/utils/get-robot-host.sh` (`Factory.ts:135-156`). Shipped: `127.0.0.1:8181`.
- **`RegistryService`** — `{port}`. Present only when SSM hosts its own registry
  (simulator/jibo-cli). All shipped configs omit it.
- **`services`** — `name → ServiceOptions`. Passed verbatim to
  `new Class(opts, rootDir)`. Presence gates whether `init()` runs
  (`Factory.ts:191-196`); a missing service is constructible but never inited.
- **`platformVersion`** — semver range. `versionCheck()` (`utils/Version.ts`)
  vs `systemManager.getVersion()`. All shipped: `">=3.1.0"`.
- **`logging`** — opaque blob handed to `Log.loadConfig(conf.logging)`
  (`Factory.ts:59-65`). See §9.

Example services block (`configs/jibo-ssm-normal.json`): `KBService`,
`GlobalManagerService`, `SkillsService{startSkill:'@be/be',singleSkill:true,port:8779}`,
`NotificationsService`, `ErrorService`, `SchedulerService`, `PerformanceServiceSim`,
`RemoteService`, `WifiService`. `developer` / `int-developer` add `DevShell`
(8686) and `PerformanceService` (10003). `SkillsServiceOptions.startSkill` is
the only options field Factory itself reads (`Factory.ts:354-357`).

---

## 3. Orchestrator setup — dep graph

Constructor body (`Factory.ts:58-82`):

```
_createOrchestrator → _instantiateServices(conf.services)
→ _addRegistryServiceTask → _addRegistryClientTask
→ _addSimulatedServicesInitTasks → _addSharedClientsTask
→ _addPlatformClientsTask → _addRealServicesInitTasks
→ _addSyncManagersTask → _addNotificationsDispatcherTask
→ _addLateClientsTask → _addAnalyticsTask
→ _addBackgroundUtilsTask → _addAllTask
```

`_instantiateServices` (`Factory.ts:104-119`) is sync and pre-orchestrator: for
each `name` in `conf.services`, looks up
`REAL_SERVICES[name] || SIMULATED_SERVICES[name]` and calls `new Class(opts, rootDir)`.
Each constructor sets `Class._instance=this`. **No init yet.**

### Task graph (`name : [deps]`)

| Task | Deps | Source |
|---|---|---|
| `RegistryService` | — | `Factory.ts:124` |
| `RegistryClient` | `RegistryService` | `Factory.ts:164-167` |
| **each `SIMULATED_SERVICES[name]`** | `RegistryClient` + `SIMULATED_SERVICE_DEPS[name]` | `Factory.ts:186-198` |
| `SharedClients` | `RegistryClient, SystemManagerService` | `Factory.ts:205-207` |
| `PlatformClients` | `SharedClients, BodyService, LPSService` | `Factory.ts:239-242` + `FactoryDeps.ts:98-102` |
| **each `REAL_SERVICES[name]`** | `PlatformClients` + `REAL_SERVICE_DEPS[name]` | `Factory.ts:254-271` |
| `SyncManagers` | `ErrorService, KBService` | `Factory.ts:282` |
| `NotificationsDispatcher` | `NotificationsService, ServerService` | `Factory.ts:292-294` |
| `LateClients` | `AudioServiceSim, ExpressionService, MediaManagerService, WifiService, JetstreamServiceSim` | `Factory.ts:321` + `FactoryDeps.ts:113-119` |
| `Analytics` | `ALL_CLIENTS_AND_SERVICES` | `Factory.ts:334` |
| `BackgroundUtils` | `ALL_CLIENTS_AND_SERVICES` | `Factory.ts:348` |
| `All` (sink) | `ALL_CLIENTS_AND_SERVICES + Analytics, BackgroundUtils, SyncManagers` | `Factory.ts:365` + `FactoryDeps.ts:135-140` |

`ALL_CLIENTS_AND_SERVICES` = all REAL_SERVICES keys + all SIMULATED_SERVICES
keys + `LateClients, NotificationsDispatcher, PlatformClients, RegistryClient,
RegistryService, SharedClients` (`FactoryDeps.ts:121-130`).

Simulated services + extra deps (`FactoryDeps.ts:76-95`):
`AudioServiceSim`, `BodyService`, `EventPlayback (+AudioServiceSim,BodyService,LPSService)`,
`LPSService`, `MediaService`, `PerformanceServiceSim`, `SecureTransferServiceSim`,
`ServerService`, `SkillsServiceSim (+GlobalManagerService)`, `SystemManagerService`,
`SystemMonitoringServiceSim`, `TTSService (+PerformanceService)`, `JetstreamServiceSim`.

Real services + extra deps (`FactoryDeps.ts:62-74`):
`DevShell:[SkillsService,TTSService,WifiService]`,
`ErrorService:[KBService]` (comment: also uses GMS; excluded to avoid cycle),
`GlobalManagerService:[LateClients]`, `MediaManagerService:[MediaService]`,
`RemoteService:[GlobalManagerService,SecurityControllerService]`,
`SchedulerService:[GlobalManagerService,KBService]`,
`SecurityControllerService:[NotificationsDispatcher,ServerService]`,
`SkillsService:[GlobalManagerService,PerformanceService]`,
`WifiService:[ErrorService]`. Others get `[PlatformClients]` only.

### Critical path

```
RegistryService → RegistryClient → SharedClients → PlatformClients
  → (real services) → GlobalManagerService → SkillsService
```

`GlobalManagerService` also waits on `LateClients` (which needs
`ExpressionService+AudioServiceSim+MediaManagerService+WifiService+JetstreamServiceSim`).
`MediaManagerService` waits on `MediaService`. `WifiService→ErrorService→KBService`.
Net: **`SkillsService` is one of the last things to init**.

---

## 4. Init phases — chronological

Trigger: `factory.init(cb)` → `orchestrator.start('All', cb)` (`Factory.ts:84-87`).
Sibling tasks run in **parallel** within a phase.

1. **Sync pre-orchestrator** — `_instantiateServices` runs every constructor.
2. **Registry** — `RegistryService` task (no-op if config omits) →
   `RegistryClient.createInstance(host, port)` (`Factory.ts:176`).
3. **Sim services start** — each `SIMULATED_SERVICES[name].instance.init(done)`
   parallel-gated on `RegistryClient` + extra deps. Binds HTTP/WS ports,
   self-registers via `HTTPService` base.
4. **SharedClients** — find `system-manager` in registry →
   `ServiceClients.init({}, [sysMgrRec])` → `SystemManagerClient.createInstance` →
   `versionCheck(platformVersion, done)` (`Factory.ts:208-234`).
5. **PlatformClients** — `ClientInitializer.getClientInits(['body'], cb)` →
   `async.parallel(tasks, done)` (`Factory.ts:239-251`). Creates `BodyClient` +
   body record in `jibo-service-clients`.
6. **Real services start** — each `REAL_SERVICES[name].instance.init(done)`
   parallel-gated on `PlatformClients` + extra deps.
7. **SyncManagers** — `KBService.instance.initSyncManagers(...)`. **Errors
   swallowed** — `done()` always called bare (`Factory.ts:282-287`).
8. **NotificationsDispatcher** — `NotificationsDispatcher.instance.init(...)` →
   `Log.handleLogLevelNotifications(dispatcher, true)`. The `true` **persists
   log-level changes to disk; only SSM passes true** (`Factory.ts:296-313`).
9. **LateClients** — `ClientInitializer.getClientInits(LATE_CLIENTS, cb)` →
   inits `audio,expression,media-manager,wifi,media,jetstream` clients.
   Unblocks `GlobalManagerService`.
10. **Analytics** — `Analytics.createInstance().init(done)`.
11. **BackgroundUtils** —
    `BackgroundUtilsManager.initAll(mode, services.SkillsService?.startSkill)`.
    Triggers `LocationManager` (5s delay) + `ScreenScheduler` (developer mode w/o startSkill).
12. **All** sink — `startup/index.js` cb fires, view hidden, `postSemaphore()`
    posts `/jibo-startup-${pid}.event`, `SkillsService` `show`/`hide` wired.

Every `instance.init(done)` is async (callback). `ClientInitializer` runs its
own `async.parallel` (`Factory.ts:248`, `ClientInitializer.ts:76-79`).

---

## 5. `ClientInitializer.mapping`

`ClientInitializer.getClientInits(serviceNames, cb)`
(`ClientInitializer.ts:35-81`) called twice:

- `PLATFORM_CLIENTS = ['body']` (`FactoryDeps.ts:97`)
- `LATE_CLIENTS = ['audio','expression','media-manager','wifi','media','jetstream']`
  (`FactoryDeps.ts:104-111`)

For each: `_waitForService(name)` polls
`RegistryClient.getRecordByName(name, cb)` every 500ms up to 120 attempts
(1 min); throws after (`ClientInitializer.ts:83-98`). Then `switch(record.name)`
(`ClientInitializer.ts:49-67`):

| record.name | Init |
|---|---|
| `expression` | `expression.init(record.port, {})` — `jibo-expression-client` |
| `jetstream` | `jetstream.init({hostname, port}, log)` — `@jibo/jetstream-client` |
| `body` | `BodyClient.createInstance('127.0.0.1', record.port)` **then fall-through** to push record into `jiboServiceClients[]` |
| `audio` / `media` / `media-manager` / `wifi` | push record into `jiboServiceClients[]` |

Final: `services.init({}, jiboServiceClients, done)` — bulk-init via
`jibo-service-clients`. All inits run via `async.parallel`.

Notes:
- Strings are **registry record names** (`HTTPService('expression',...)`),
  not class names.
- `BodyClient` is the only custom client class; others come from
  `jibo-service-clients` / `jibo-expression-client` / `@jibo/jetstream-client`.
- Registry record shape: `{name, host, port, path?, ttl?, tls?}`
  (`RegistryService.ts:114-127`).

---

## 6. Service lifecycle

`src/SSMService.ts:3-10`:

```ts
export interface SSMService {
    init(callback: (err?: Error) => void): void;
}
export interface SSMServiceClass {
    instance: SSMService;
    new(options: ServiceOptions, rootDir: string): SSMService;
}
```

`instantiateService` (`SSMService.ts:12-18`) = `new Class(opts, rootDir)`.

- **Construct**: `_instance=this`, attach WS handlers; do NOT call `super.init`.
- **`init(cb)`**: typically `super.init(cb)` (from `HTTPService`/`HTTPWSService`)
  binds port + registers in registry; then service-specific setup.
- **No `shutdown` interface.** Process death = cleanup.

Shutdown: no SIGTERM/SIGINT handlers in Factory or startup. Subprocess SIGINT
handlers commented out (`processes/mms/MMSProcess.ts:18-22`,
`processes/scs/SCSProcess.ts:16-22`). Skill renderer `app.quit()` on
`onFinished` (`processes/skills/MainProcess.ts:63-65`).

Startup-time cleanup (not shutdown): SSM main calls
`SystemManagerClient.instance.list()` and `terminate()`s any running skill
before `makeSSM()` (`processes/ssm/MainProcess.ts:25-44`).

Singleton discipline: every service constructor throws if `_instance` exists
(`RegistryService.ts:22-24`, `ServerService.ts:36-38`, `SystemManagerService.ts:39-41`).

---

## 7. Process model — multi-process

| Process | Entry | Hosts |
|---|---|---|
| `jibo-ssm` | `processes/ssm/{index,MainProcess}.ts` + `startup/` | Factory + all REAL_SERVICES except MMS/SCS/Expression |
| `jibo-mms` | `processes/mms/{index,MMSProcess}.ts` | `MediaManagerService` only, port 8488, static root `static/media-manager-service` |
| `jibo-scs` | `processes/scs/{index,SCSProcess}.ts` | `SecurityControllerService` only |
| `jibo-expression` | `processes/expression/index.ts` | `ExpressionService` only, port 10015 (sets `global.realThree=true`) |
| skill renderer | `processes/skills/{index,MainProcess}.ts` | Electron BrowserWindow 1281×721 frameless, one per skill, spawned by SystemManager |

Every subprocess does the same boot dance
(`processes/mms/index.ts`, `processes/scs/index.ts`,
`processes/expression/index.ts`):

1. `RegistryClient.createInstance('127.0.0.1', 8181)`
2. Look up `system-manager` → `SystemManagerClient.createInstance`
3. `systemManager.getMode()` → load `/usr/local/etc/jibo-ssm/jibo-ssm-${mode}.json`
4. `Log.loadConfig(config.logging)`
5. Instantiate + `init` the one service
6. Post `node-semaphore('/jibo-startup-${pid}.event')`

SSM main also stands up `TcpProxy(9222, 9191)` (Chrome devtools) and
`TcpProxy(10223, 12345)` for Electron renderer debug
(`processes/ssm/MainProcess.ts:53-58`).

**Browser port**: no subprocesses. Collapse all 4 node processes + the
renderer into one window. Registry = in-memory JS object; client inits =
thin proxies/no-ops.

---

## 8. `sim-services/` vs `services/`

NOT sim-vs-real-impl per service. It's: which services have a firmware/C++/cloud
impl on the real robot (sim is the stand-in) versus which SSM hosts itself
on the robot too.

`src/services/` (REAL — hosted by SSM on robot): `dev-shell, error, expression,
global-manager, kb, media-manager, notifications, performance, remote,
scheduler, security-controller, skills, wifi`.

`src/sim-services/` (SIMULATED stand-ins for board/firmware/cloud): `audio,
body, event-playback, jetstream, lps, media, performance, registry,
secure-transfer, server, skills (SkillsServiceSim), system-manager,
system-monitoring, tts`.

**Both sim+real impls:**
- `performance` — `PerformanceService` (real) + `PerformanceServiceSim` (sim).
  Configs enable both via `"PerformanceService"` + `"PerformanceServiceSim":{}`.
- `skills` — `SkillsService` (real) + `SkillsServiceSim` (sim). Shipped
  configs run real; sim added by `jibo-cli`'s simulator entry.

`PLATFORM_CLIENTS=['body']` and `LATE_CLIENTS` include a mix —
`media-manager`/`expression`/`wifi` are real services but their **client
records** are still registry-discovered like everything else.

Porter guidance: sim impls are generally closer to browser-only needs
(in-memory, no hardware). Port those; for services without a sim (`kb`,
`global-manager`, `notifications`, `scheduler`, `error`, `remote`,
`security-controller`, `expression`, `dev-shell`), port the real impl with
hardware/syslog/child-process bits gutted.

---

## 9. Logging — `src/log.ts`

Three lines (`src/log.ts:1-5`):

```ts
import {Log} from 'jibo-log';
const log = new Log('SSM');
export default log;
```

Every module does `parentLog.createChild('Name')`. Process name set via
`Log.processName='ssm'` (`Factory.ts:44`); each subprocess overrides
(`processes/mms/index.ts:10` `'mms'`, `processes/expression/index.ts:19` `'exp'`,
`processes/skills/MainProcess.ts:6` `'skill'`).

`Log.loadConfig(conf.logging)` (`Factory.ts:60`) feeds `console` and
`syslog` (UDP 127.0.0.1:514). Namespace-scoped levels. `developer`:
console+syslog `info`. `normal`: console `none`, syslog `info`.
`int-developer`: raises `SSM.Client.ASR`/`C.AsrService` to syslog `debug`.

Runtime level changes: `Log.handleLogLevelNotifications(dispatcher, true)`
in SSM only; the `true` **persists** to disk. Subprocesses pass `false`/implicit.

Browser port: stub `jibo-log` with a logger supporting `.createChild`,
`.info/.warn/.error/.debug/.iferr(err, msg)`.

---

## 10. `background/` + `static/`

`src/background/index.ts`:

```ts
import './location/LocationManager';
import './screen/ScreenScheduler';
```

Side-effect imports. Each registers with `BackgroundUtilsManager`
(`src/utils/BackgroundUtilsManager.ts`) at module load:
- `ScreenScheduler` id `'screen'` (`ScreenScheduler.ts:63-69`): if
  `mode.indexOf('developer')>-1` and no `startSkill`, start 5-min blank timer
  (`TIME_TO_BLANK = 1000*5*60`).
- `LocationManager` id `'location'` (`LocationManager.ts:498-503`):
  `setTimeout(LocationManager.init, 5000)`. Wi-Fi scan → geolocate → timezone → KB save.

`BackgroundUtilsManager.initAll(mode, startSkill)` fires every callback during
the `BackgroundUtils` task (`Factory.ts:346-361`). `Factory.ts:19` does
`import './background'`. `BackgroundUtilsManager.register`
(`utils/BackgroundUtilsManager.ts:6-16`) warns on post-init register, silently
drops duplicate ids.

`static/` (top-level) = **bundled HTML+JS assets served by services**:
- `static/skills-service/index.html` — load-mask UI from `SkillsService`
  (React bundle, source `src/static/skills/index.tsx`).
- `static/performance/index.html` — `PerformanceService` UI
  (source `src/static/performance/index.tsx`).
- `static/error-service/index.html` — error UI (source `src/static/error/index.tsx`).
- `static/debug/index.html` — tiny debug page.

`src/static/` = React/TS sources. Browser port: render these as inline React
components in the sim shell.

---

## 11. Gotchas

- `Factory.ts:44` — `Log.processName='ssm'` MUST run before any
  `parentLog.createChild` (process name captured at child construction).
- `Factory.ts:282-287` — `SyncManagers` swallows errors; KB sync failure
  does NOT abort startup.
- `Factory.ts:92-101` — `orchestrator.onAll` logs every task event; source of
  "Orchestrator: <src> <task>: <msg>" log lines.
- `FactoryDeps.ts:132-134` (comment) — "orchestrator does not run tasks that
  don't have anything depending on them" → why `ALL_TASKS` exists and `'All'`
  depends on it.
- `FactoryDeps.ts:66` — explains the `ErrorService ↔ GlobalManagerService`
  cycle that's intentionally broken in deps.
- Orchestrator accepts `add(name, fn)` and `add(name, deps, fn)`; missing
  deps default to `[]`.
- Service file shape: `class X extends HTTPService implements SSMService {
  private static _instance; static get instance; constructor(opts, rootDir);
  init(cb); routes(url); }`. Constructors throw if `_instance` exists.

### TL;DR

- Single `Factory`, ~365 lines, dep-graph orchestrator.
- Config = `{RegistryClient, services, platformVersion, logging}`.
- Pre-construct everything (sync), then init in dep order.
- Phases: **registry → sim services → SharedClients → PlatformClients →
  real services → SyncManagers + NotifDispatcher → LateClients →
  GlobalManager → SkillsService → Analytics + BackgroundUtils**.
- `ClientInitializer` is the only thing wiring `body`/`expression`/`jetstream`/
  `audio`/`media`/`media-manager`/`wifi` clients.
- 5 processes on robot; browser port = one window.
- No shutdown hooks; startup-time skill cleanup via SystemManagerClient.
- `sim-services/` is the right base; stub `jibo-log`.
