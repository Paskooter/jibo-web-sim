# 07 — The `jibo` Runtime

Singleton at `global.jibo`. Detects Electron; builds an in-process plugin
registry; resolves a registry of network services (`jibo.records`); inits
every plugin in dep order via `orchestrator`; exposes ~30 sub-APIs on
`jibo.*`. Every `be` package does `require('jibo')` against this surface.

---

## 1. Module bootstrap — `packages/jibo/src/index.ts:21-58`

```ts
if (!root.jibo) {
    const classes = { events, plugins, Runtime, services, utils };
    if (electron) {
        // rendering FIRST — it puts PIXI on the global namespace, bt
        // needs PIXI at static-init time
        const rendering = require('./rendering');
        const bt = require('./bt');
        const flow = require('./flow');
        const sound = require('./sound');
        Object.assign(classes, { bt, flow, rendering, sound });
    }
    deprecation(classes);
    root.jibo = new Runtime(classes);
}
```

Electron detection — `utils/electron.ts:1`: `export default
!!(process.versions as any).electron;`. Browser port must polyfill it
truthy or `bt / flow / rendering / sound` never load and `jibo.face /
jibo.bt / jibo.sound` are `undefined`.

---

## 2. `Runtime` class — `packages/jibo/src/Runtime.ts`

### Singleton (`Runtime.ts:180, 296-302, 656-663`)

```ts
private static _instance:Runtime;
…
constructor(classes) {
    if (Runtime._instance) throw new Error("Jibo Singleton may only be initialized once.");
    Runtime._instance = this;
    …
}
static get instance():Runtime { return Runtime._instance; }
```

Everywhere else: `import Runtime from '../Runtime'; const jibo =
Runtime.instance;`. No DI.

### Public field declarations (`Runtime.ts:198-253`)

```ts
public RunMode: { SIMULATOR, REMOTELY, ON_ROBOT, UNIT_TESTS };
public utils, services, autobot, volume, globalEvents, bt, flow, kb, im,
       lps, ics, lifecycle, tts, performance, media, wifi, errors,
       secureTransferService, web, scheduler, face, rendering, system,
       session, options, systemManager, behaviorEmitter, timer, sound,
       loader, log, mim, analytics, records, registryHost, initTimer,
       animDB, action, versions, expression, embodied, remote, emotion,
       context, jetstream;
```

Typed slots the plugin install/init passes fill in.

### Constructor (`Runtime.ts:293-387`)

- `this.RunMode = RunMode;` (line 309).
- Wires stateless `jibo-service-clients` namespaces (lines 313-328):
  `system, kb, lps, ics, tts, performance, wifi, errors,
  secureTransferService, web, scheduler`. Not plugins — module
  namespaces; `ServiceClients.init` (called later via `ServicesPlugin`)
  drives their per-record init.
- `this.timer = new classes.utils.Timer();`
- `this.analytics = new EmptyAnalytics();`
- `this.globalEvents = new classes.services.GlobalEvents();`
- `this.remote = new RemoteService();`
- Electron path (332-351): `this.bt = new Factory(classes.bt);
  this.flow = new FlowExecutorFactory(classes.flow); PIXI.utils.skipHello();
  this.face = new FaceRenderer(this.timer); this.rendering = classes.rendering;
  this.behaviorEmitter = new classes.bt.BehaviorEmitter();`
- `this.session = new classes.services.SessionManager();`
- `this.systemManager = ServiceClients.systemManager;`
- `this._installPlugins();` (383) — see §4.
- `this.mim = MimManager.instance;`

### `init(opts, cb)` and `_init()` (`Runtime.ts:405-549`)

Three overloads coerced into one shape. Throws on second call. `_init(done)`:

1. `Runtime.isInitializing = true;`
2. Electron: `Runtime.ipcRenderer.send('get-context');` — renderer asks
   main process for `registryHost + token + context`. Reply arrives at
   `ipcRenderer.on('set-context', …)` inside `RegistryPlugin`.
3. `this._initPlugins(done)` — orchestrator dep walk.
4. On success in Electron + `options.display`: `Runtime.instance.face.init(display);`.
5. `Runtime.isInitialized = true; this.timer.start();`
6. `Runtime.ipcRenderer.send('init-done');` (final stamp).

### `Runtime.ipcRenderer` (`Runtime.ts:673-678`)

```ts
static get ipcRenderer(): any {
    if (!Runtime._ipcRenderer && electron)
        Runtime._ipcRenderer = require('electron').ipcRenderer;
    return Runtime._ipcRenderer;
}
```

Non-Electron browser: `Lifecycle.ts:20` has an `EventEmitter` fallback.
`RegistryPlugin` does **not** — must be shimmed.

---

## 3. `RunMode` enum

`Runtime.ts:54-63`:

```ts
const RunMode = {
    SIMULATOR: "SIMULATOR",
    REMOTELY:  "REMOTELY",
    ON_ROBOT:  "ON_ROBOT",
    UNIT_TESTS:"UNIT_TESTS"
};
```

Read at `Runtime.ts:479-487`:

```ts
public get runMode() {
    let runMode = process.env.runMode || process.env.RUNMODE;
    if (!runMode && process.platform === 'linux' && process.arch === 'arm')
        runMode = RunMode.ON_ROBOT;
    return runMode;
}
```

Set with `process.env.runMode = 'SIMULATOR'` before `jibo` is required.

### Every `runMode ===` check (grepped)

| File:line | Behaviour |
|---|---|
| `bt/behaviors/Mim.ts:1198` | `onRobot = ON_ROBOT \|\| REMOTELY \|\| UNIT_TESTS` (embedded vs cloud ASR routing) |
| `bt/mim/MimManager.ts:238` | UNIT_TESTS skip |
| `plugins/VersionsPlugin.ts:73, 82` | UNIT_TESTS skip; warn-on-robot if no `jibo-tbd` |
| `plugins/ServicesPlugin.ts:55` | UNIT_TESTS skip (no service init) |
| `plugins/InteractionMemoryPlugin.ts:19` | UNIT_TESTS skip |
| `plugins/ActionPlugin.ts:19` | UNIT_TESTS skip |
| `plugins/ExpressionPlugin.ts:27` | UNIT_TESTS skip |
| `plugins/DevShellPlugin.ts:35` | SIMULATOR forces itself on (in addition to `'int-developer' / 'developer'` modes) |
| `plugins/RadioPlugin.ts:21` | UNIT_TESTS uses fake serial (file otherwise commented out) |
| `plugins/VolumePlugin.ts:40, 147` | UNIT_TESTS skip KB volume load + save |
| `plugins/JetstreamPlugin.ts:18` | UNIT_TESTS skip |
| `plugins/ServiceRecordsPlugin.ts:21` | UNIT_TESTS skip (no records) |
| `plugins/MediaPlugin.ts:24` | UNIT_TESTS skip |
| `plugins/Lifecycle.ts:48` | UNIT_TESTS skip |
| `plugins/RegistryPlugin.ts:19` | UNIT_TESTS skip |
| `rendering/gui/TouchManager.ts:198` | `_isSim = (SIMULATOR)` — mouse-down fallback for cap-touch |

UNIT_TESTS short-circuit pattern (`MediaPlugin.ts:23-26`, typical):

```ts
init(done) {
    if (Runtime.instance.runMode === Runtime.instance.RunMode.UNIT_TESTS)
        return done();
    this.api.init(() => done(null, this.api));
}
```

Implication: **SIMULATOR does NOT short-circuit anything** except
`TouchManager` mouse fallback and `DevShellPlugin` self-enable.
Everything else needs mock backends on `127.0.0.1` — same pattern the
`jibo-be` E2E port uses.

---

## 4. Plugin registration & init

### `registerPlugin` signature (`Runtime.ts:267-291`)

```ts
public static registerPlugin(klass:PluginConstructor, id:string, options?) {
    options = Object.assign({depends:[], api:false, name:id, electron:false},
                            options || {});
    const plugin:InstalledPlugin = {
        pluginClass:klass, id,
        name:options.name, api:options.api,
        depends:options.depends, electron:options.electron,
        installed:false, initialized:false
    };
    Runtime._plugins.push(plugin);
    return plugin;
}
```

`InstalledPlugin` interface at `Runtime.ts:68-78`. Every plugin file
calls this at **module top level** — registration is an `import` side
effect. Import order in `plugins/index.ts` sorts the array but does not
control init order.

### Two-pass orchestrator

**Pass 1 — `_installPlugins()`** (`Runtime.ts:556-593`), runs in the
ctor:

```ts
orc.add(plugin.id, plugin.depends, (done) => {
    plugin.installed = true;
    plugin.instance = new plugin.pluginClass();
    if (plugin.api) this[plugin.name] = plugin.instance.api || plugin.instance;
    done();
});
```

`api:true` ⇒ slot `jibo[name]` immediately. If instance has `.api`, that
gets stored; otherwise the instance itself.

**Pass 2 — `_initPlugins()`** (`Runtime.ts:600-652`), from `init(cb)`:

```ts
orc.add(plugin.id, plugin.depends, (cb) => {
    plugin.instance.init((err, api) => {
        plugin.initialized = true;
        if (api) this[plugin.name] = api;  // init() may override slot
        cb(err);
    });
});
```

`Orchestrator` does topological-sorted parallel execution. No cycles.

### Full plugin / depends graph (every `registerPlugin` call)

| id | slot (`name`) | `api` | `electron` | `depends` | source |
|---|---|---|---|---|---|
| `loader` | `loader` | yes | — | — | `Runtime.ts:682` |
| `fonts` | `fonts` | — | yes | `loader` | `FontsPlugin.ts:37` |
| `rendering` | `rendering` | — | yes | `loader` | `RenderingPlugin.ts:27` |
| `registry` | `registry` | — | — | — | `RegistryPlugin.ts:70` |
| `service-records` | `service-records` | — | — | `loader`, `registry` | `ServiceRecordsPlugin.ts:70` |
| `services` | `services` | — | — | `service-records` | `ServicesPlugin.ts:110` |
| `lifecycle` | `lifecycle` | yes | — | `service-records` | `Lifecycle.ts:116` |
| `dev-shell` | `dev-shell` | yes | — | `service-records` | `DevShellPlugin.ts:81` |
| `versions` | `versions` | yes | — | `services` | `VersionsPlugin.ts:173` |
| `volume` | `volume` | yes | — | `services`, `loader` | `VolumePlugin.ts:170` |
| `location` | `location` | — | — | `services` | `LocationPlugin.ts:20` |
| `media` | `media` | yes | — | `services` | `MediaPlugin.ts:35` |
| `im` | `im` | yes | — | `services` | `InteractionMemoryPlugin.ts:34` |
| `autobot` | `autobot` | yes | — | `services` | `AutobotPlugin.ts:77` |
| `expression` | `expression` | yes | — | `service-records` | `ExpressionPlugin.ts:48` |
| `anim-db` | `animDB` | yes | — | `expression` | `AnimDBPlugin.ts:39` |
| `action` | `action` | yes | — | `expression`, `services`, `anim-db` | `ActionPlugin.ts:30` |
| `emotion` | `emotion` | yes | — | `action` | `EmotionPlugin.ts:24` |
| `embodied` | `embodied` | yes | — | `anim-db`, `expression`, `emotion` | `EmbodiedPlugin.ts:31` |
| `context` | `context` | yes | — | `registry`, `emotion`, `location`, `action` | `context/ContextPlugin.ts:25` |
| `jetstream` | `jetstream` | yes | — | `service-records` | `JetstreamPlugin.ts:68` |
| `sound` | `sound` | yes | yes | — | `sound/SoundPlugin.ts:345` |

`RadioPlugin` (`plugins/RadioPlugin.ts:1-58`) is entirely commented out
and not in `plugins/index.ts:21`.

Topological order (no cycles):

1. `loader, registry, sound`
2. `fonts, rendering, service-records`
3. `services, lifecycle, dev-shell, expression, jetstream`
4. `versions, volume, location, media, im, autobot, anim-db`
5. `action` → 6. `emotion` → 7. `embodied, context`

---

## 5. Per-plugin notes

**`loader`** (`Runtime.ts:682`) — `new LoaderPlugin()` from
`jibo-loader`. Sound + Rendering register tasks on it.

**`fonts`** (`FontsPlugin.ts`) — electron-only, no API. Loads
`resources/fonts.css`, appends `<style>` to `<head>`, then `Promise.all`
over `document.fonts.load(…)` for Proxima Nova Soft (bold+normal),
Proxima Nova (bold), Proxima Nova Light (normal).

**`rendering`** (`RenderingPlugin.ts:11-20`) — electron-only, no API.
Ctor registers loader tasks: `ColorAlphaTask@40, TimelineTask@60,
ShapesTask@70, KeysTask@80, KeysDataTask@81, SpritesheetTask@90,
TextureTask@30, CompressedImageTask@25`. `init(done) { done(); }`. Slot
already set in `Runtime` ctor.

**`registry`** (`RegistryPlugin.ts`) — no API. UNIT_TESTS / non-electron
skip; if `jibo.options.registryHost` preset, use it; else install one
shot `ipcRenderer.on('set-context', (sender, initData) => { jibo.registryHost
= initData.registryHost; if (initData.token) jibo.session.token = …;
if (initData.context) jibo.electronContext = …;
RegistryClient.createInstance(host, port); done(); })`.

**`service-records`** (`ServiceRecordsPlugin.ts`) — no API. Retries
`jibo.loader.load({src: jibo.registryHost, format:'json', timeout:3000})`
up to `MAX_TRIES=5` with 2s waits, +1s timeout per attempt. On success:
`jibo.records = records.sort(systemManagerFirst)` (`system-manager` at
index 0).

**`services`** (`ServicesPlugin.ts`) — no API. See §6.

**`lifecycle`** — API slot. See §7.

**`dev-shell`** (`DevShellPlugin.ts:26-78`) — API slot.
`jibo.systemManager.getMode((err, mode) => { if (mode ===
'int-developer' || 'developer' || jibo.runMode === SIMULATOR) { new
WSClient('ws://127.0.0.1:' + record.port); on 'message' → if
cmd.command === 'execute': jibo.autobot.executeCommand(cmd); done(); }
else done(); })`.

**`versions`** (`VersionsPlugin.ts`) — API slot. Ctor: reads
`<root>/package.json` → `this.jibo = pkg.version; jibo.version =
this.jibo`. `init`: UNIT_TESTS skip; tries `require('/opt/jibo/Jibo/Skills/
jibo-tbd/package.json') → release`; fallback `'8.67.5309'` (warn only
on robot). If electron, XHR-GET `http://skills-service-host:port/
version` → `this.ssm`. Exposes `jibo/ssm/platform/release`,
`supported(version):boolean`, `requiresPlatform`, `packageInfo`,
`toJSON()`.

**`volume`** (`VolumePlugin.ts`) — API slot, extends `EventEmitter`.
`MAX_VOLUME=10, MIN_VOLUME=1, DEFAULT_VOLUME=7, HW_MIN_VOLUME=0.25,
HW_MAX_VOLUME=1`. `init` subscribes
`jibo.globalEvents.volume.on(onVoiceCommand)`; `Promise.all` over [KB
`/settings.volume` load (UNIT_TESTS skip), preload SFX_EndofBounds.m4a
+ SFX_VolumeIncDec.m4a]. `changeVolume(intent, value)` dispatches
`volumeUp / volumeDown / volumeToValue`; `_setVolume(cb?, silent?)`
calls `system.setMasterVolume(hw)`, plays SFX, persists KB, emits
`'change'`.

**`location`** (`LocationPlugin.ts`) — no API. `HomeLocation.init();
done();` — sync, fills `jibo.utils.Location.jiboHome`.

**`media`** (`MediaPlugin.ts`) — API slot. Ctor: `this.api = new Media
()`. UNIT_TESTS skip; `this.api.init(() => done(null, this.api))`.
`Media` wraps `mediaManager / media` from `jibo-service-clients`
(camera, take-photo).

**`im`** (`InteractionMemoryPlugin.ts`) — API slot = `im.api` from
`jibo-interaction-memory`. UNIT_TESTS skip; sync `im.api.init(jibo);
done();` in try/catch.

**`autobot`** (`AutobotPlugin.ts`) — API slot. In RELEASE,
`Object.defineProperty(this, 'log', {value: no-op, configurable:false,
writable:false})` locks down logs. `init(done) { done(null, this); }`.
`executeCommand(cmd)` (DEBUG): `process.nextTick(() => { eval(cmd.script);
client.send({command:'execute-result', result, id, success:true}); })`;
errors → `success:false`. Client is `jibo['dev-shell']._client`.

**`expression`** (`ExpressionPlugin.ts:23-44`) — API slot. UNIT_TESTS
skip; find `records.find(r => r.name === 'expression')` — error if
missing. Then `this.api.init(record.port, jibo).then(() => {
this.api.events.dofs.on((data) =>
Runtime.instance.face.eye.display(data.timestamp, data.dofValues,
data.metadata)); return this.api.setSkillRoot(process.cwd()); })`. **This
is the contract that makes the eye animate.**

**`anim-db`** (`AnimDBPlugin.ts`) — API slot `jibo.animDB` (id
`'anim-db'`, name `'animDB'`). Resolves `jibo-anim-db-animations` next
to package; on parse error, logs and `done()` without error.

**`action`** (`ActionPlugin.ts`) — UNIT_TESTS skip; `action.api.init
({jibo})`.

**`emotion`** (`EmotionPlugin.ts`) — `emotion.api.init({jibo})`. No
UNIT_TESTS guard, but `action` dep has one.

**`embodied`** (`EmbodiedPlugin.ts`) — `embodied.api.init(jibo)`. On
error: log + **swallow** (`done()` without error).

**`context`** (`plugins/context/ContextPlugin.ts:12-22`) —
`context.api.init().then(done).catch(done)`. The `api` (`api.ts:139-171`)
wraps a singleton `ContextProvider`: `getContext(speakers?,
omitLoop=false): Promise<Context>` merges on-robot + active CloudSkill
session; `updateSkillContext(data); resetSkillContext()`.

**`jetstream`** (`JetstreamPlugin.ts`) — UNIT_TESTS skip; find
`records.find(r => r.name === 'jetstream')`; error if missing;
`this.api.init({hostname:'localhost', port:record.port})`. DEBUG wires
log handlers on `events.error / sos / eos / hjHeard /
localTurnStarted / localTurnResult / globalTurnStarted /
globalTurnResult / skillSwitch`.

**`sound`** (`sound/SoundPlugin.ts:345`) — API slot, electron-only. See §10.

---

## 6. `ServicesPlugin` deep dive (`plugins/ServicesPlugin.ts`)

Three in-process handlers + delegation to `ServiceClients.init`.

`serviceInit` map (lines 31-47):

```ts
this.serviceInit = {
    'global-manager': (svc, cb) => jibo.globalEvents.init(svc, cb),
    kb: (svc, cb) => jibo.kb.init(svc, (err) => {
        if (!err) { jibo.kb.initLoop(); jibo.kb.initMedia(); }
        cb(err);
    }),
    remote: (svc, cb) => jibo.remote.init(svc, cb)
};
```

`init(done)` (50-107): UNIT_TESTS skip; iterate `jibo.records`, push a
task per matching `serviceInit[name]`; push one final task that calls
`ServiceClients.init(Runtime.instance, jibo.records, callback,
wrapFn)`. `async.parallel` runs all of them.

`ServiceClients.init` (in `jibo-service-clients`) loops `records`, inits
each of `tts, lps, system, system-manager, wifi, errors, secure-transfer,
web, scheduler, performance, …` against its `host:port`. Per-task
errors are swallowed.

---

## 7. `GlobalEvents` — `/globals` socket

`services/events/GlobalEvents.ts`. Extends `EventContainer`.

### `init(svc, cb)` (159-176)

```ts
service.host = '127.0.0.1';   // hard override
const globalUrl     = "ws:" + service.host + ":" + service.port + "/globals";
this._httpInterface = "http://" + service.host + ":" + service.port;
this._globalSocket  = new WSClient(globalUrl);
this._globalSocket.on('message', d => this.onMessage(d));
this.shared.init();
cb();
```

### Event surface (ctor 43-156)

`GlobalEvent` (LAST_HANDLER mode, with `onNoListeners` that notifies SSM):
`voiceStop`(`STOP`), `help`, `sleep`, `pause`, `volume`, `whatCanIDo`,
`holdOn`, `overHere`, `touchStop`(`'TOUCH'`).

`voiceEvents` array (137-146) = the 8 voice commands (no `touchStop`).
Passed to `setGlobalEvents` (203-216) which wires `onNoListeners /
onAddedListener` so SSM is told whenever the in-process listener count
crosses zero.

`TypedEvent` (regular fan-out): `global`(`'Any global event'` — raised
after matching voiceEvent fires), `skillLaunch`(`'skill-launch'`),
`skillRelaunch`(`'skill-relaunch'`), `shared` (a `SharedGlobalEvents`).

### `eventHandlers` (150-155)

```ts
this.eventHandlers = {
    'global'                 : this.onGlobal.bind(this),
    'skill-launch'           : this.onSkillLaunch.bind(this),
    'skill-relaunch'         : this.onSkillRelaunch.bind(this),
    'non-interrupting-global': this.onNonInterrupting.bind(this),
};
```

`onMessage(data)` (224-234) requires `data.status === 'OK'`, dispatches
by `data.message`:

- `onGlobal` (242-289): `ListenResult.fromJSON(data.result)`, collapse
  `^volume*` → `'volume'`, emit matching voiceEvent, emit
  `this.global({name, data})`, `analytics.track('Global Stop' /
  'Go To Sleep' / 'Volume')`.
- `onSkillLaunch` (342): `skillLaunch.emit(ListenResult.fromJSON(...))`.
- `onSkillRelaunch` (297-330): pull `match.skillID`; if `transID &&
  !match.onRobot`, attach `cloudSkillResponse =
  jibo.jetstream.getCloudSkillResponse(transID)`. Analytics: `HELP /
  WHATCANIDO → 'WCYD'`, `@be/main-menu → 'Main Menu'`.
- `onNonInterrupting`: `shared.nonInterruptingGlobal.emit()`.

### `announceGlobalHandler` (184-195)

```ts
private announceGlobalHandler(action, canHandle) {
    let body = {action, canHandle};
    let req  = new XMLHttpRequest();
    req.open("POST", this._httpInterface + '/global', true);
    req.send(JSON.stringify(body));
}
```

Driven by `setGlobalEvents`: listener added → `POST {canHandle:true}`;
listener count → 0: `POST {canHandle:false}`.

### `SharedGlobalEvents` (`services/events/SharedGlobalEvents.ts`)

Four `TypedEvent`s (anyone can listen, no LAST_HANDLER):
`hjOnly` (only HJ was heard), `noGlobalMatch` (no match vs global
grammar), `nonInterruptingGlobal` (non-interrupting global handled —
volume etc.), `screenGesture` (TouchManager).

`shared.init()` (called from `GlobalEvents.init`) bridges
`jibo.jetstream.events.globalTurnResult` → `hjOnly` (TIMEOUT/FAILED or
SUCCEEDED w/ `GARBAGE / SOS_TIMEOUT / MAX_SPEECH_TIMEOUT` annotation),
`noGlobalMatch` (`noMatch` or launch-rule with no skill match); also
`jetstream.events.hjOnly → this.hjOnly.emit()`.

---

## 8. `Lifecycle`

`plugins/Lifecycle.ts`. Extends `EventEmitter`. API slot
`jibo.lifecycle`.

**IPC fallback (10-20):**

```ts
class IPC extends EventEmitter {
    public send(channel, ...args) { this.emit(`send-${channel}`, args); }
}
const ipc = Runtime.ipcRenderer || new IPC();
```

In a browser, `ipc.send('finished')` becomes `emit('send-finished',
[])` — this is the hook for a non-electron host to observe lifecycle.

**`init(done)` (43-79):** UNIT_TESTS skip; find `skills-service` record →
`_skillServiceHost = 'ws://127.0.0.1:' + record.port`. `new WSClient`:
on `'open'` → `send({command:'initDone'})`; on `'message'` →
`onMessage`. `this.once('init', done)` — `done` only fires when SSM
sends `{command:'show'}`.

**`onMessage` (95-107):**
- `'shutdown'`: `this.emit('shutdown'); setTimeout(() =>
  ipc.send('finished'), 100);`
- `'show'`: `ipc.send('show'); this.emit('init');` (satisfies `done`).

**`finished()` (84-89):** `this._client.send({command:'finished'});
ipc.send('finished');`.

**`onShutdown()` (109-113):** bound on `ipc.on('shutdown', …)`,
forwards `this._client.send({command:'shutdown'})`.

---

## 9. Behavior tree (`bt/`)

`bt/index.ts:14-25` exports `behaviors, decorators, Status, Factory,
Blackboard, BehaviorTree, BehaviorEmitter, Behavior, BaseElement,
ParentBehavior, Decorator`.

### `Factory` (`bt/Factory.ts`)

Built in `Runtime` ctor (electron): `this.bt = new Factory(classes.bt)`.
Holds `_behaviors:{[ns]:{[className]:Constructor}}`. Ctor calls
`registerCore()` (93): for every key in `behaviors + decorators`,
`register(name, 'core', classRef)`.

- `create(uri, overrides?)` (132-250): if `uri` is `string`,
  `require(treePath)`; else treat as factory function. Walks flattened
  tree object, constructs each node with `new Constructor({name,
  emitter, blackboard, assetPack, ...node.options})`, wires children +
  decorators, returns `new BehaviorTree(root, blackboard, notepad,
  result, emitter)`.
- `run(uri, overrides?, onFinished?)`: `create` plus attaches
  `Runtime.instance.timer.on('update', doUpdate)` and `behaviorTree.on
  ('start'/'stop'/'destroy', …)` for global-timer ticking, then
  `behaviorTree.start()`.

### Behaviors (`bt/behaviors/index.ts`)

| Behavior | Purpose |
|---|---|
| `Blink` | Plays a single blink animation; succeeds immediately. |
| `ExecuteScript` | Runs a synchronous JS function; always succeeds. |
| `ExecuteScriptAsync` | Runs JS that resolves via `succeed` / `fail` callbacks. |
| `LookAt` | Acquires gaze on a `Point3D` / `Person` / `screen` via expression `AcquireHandle`. |
| `Mim` | Drives the MultiModal Interaction Manager (Embodied prompt/listen/generate). |
| `Menu` | Renders a `MenuView` via `jibo.face.views`; resolves with the chosen option. |
| `Null` | Stays `IN_PROGRESS` forever; only a decorator can change its status. |
| `Parallel` | Runs children in parallel; ALL succeed → succeed, ANY fail → fail. |
| `PlayAnimation` | Loads a `.keys` file via loader, plays via `expression` `Playback`. |
| `PlayAudio` | Loads via loader (SoundTask) and plays through `jibo.sound`. |
| `Random` | Picks one child at random; runs only that one. |
| `ReadBarcode` | Uses camera + barcode detector; resolves via `onBarcode(err, data)`. |
| `Sequence` | Runs children in order; fail on first failure, succeed if all succeed. |
| `Subtree` | Loads another `.bt` file as a single behavior. |
| `SubtreeJs` | Like `Subtree` but path / notepad evaluated at start. |
| `Switch` | Runs children in order; succeed on first success. |
| `TakePhoto` | Calls `jibo.media.takePhoto(...)`; resolves via `onPhoto(url)`. |
| `TextToSpeech` | `jibo.tts.say(words)`; emits `onWord` per word. |
| `TextToSpeechJs` | Like TTS but `getWords()` evaluated at start. |
| `TimeoutJs` | `Null` + `TimeoutSucceedJs`: succeeds after `getTime()` ms. |
| `Listen` | Cloud listen w/ `heyJibo`, `detectEnd`, `incremental`, `authenticateSpeaker` opts; via `SucceedOnListen`. |
| `ListenJs` | Listen with all opts as functions; via `SucceedOnListenJs`. |
| `ListenEmbedded` | Local embedded-grammar listen via `SucceedOnEmbedded`. |

### Decorators (`bt/decorators/index.ts`)

| Decorator | Effect |
|---|---|
| `Case` | Succeed/fail conditional, used for `Switch` cases. |
| `FailOnCondition` | Fail when conditional returns `true`. |
| `StartOnAnimEvent` | Hold start until an animation `keys` event fires. |
| `StartOnCondition` | Hold start until conditional is `true`. |
| `StartOnEvent` | Hold start until `eventName` fires on tree emitter. |
| `SucceedOnCondition` | Succeed when conditional is `true`. |
| `SucceedOnEmbedded` | Succeed when an embedded listener resolves. |
| `SucceedOnEvent` | Succeed when `eventName` fires on tree emitter. |
| `SucceedOnListen` | Succeed when a cloud listen resolves. |
| `SucceedOnListenJs` | Same but options evaluated each start. |
| `TimeoutFail` | Fail after `timeout` ms. |
| `TimeoutSucceed` | Succeed after `timeout` ms. |
| `TimeoutSucceedJs` | Like `TimeoutSucceed` but `getTime()` per-start. |
| `WhileCondition` | Restart behavior while conditional is `true`. |

### Common types

- `Status` (`bt/Status.ts`): `FAILED / SUCCEEDED / IN_PROGRESS / INTERRUPTED`.
- `Blackboard` — per-tree shared state.
- `BehaviorEmitter` — per-tree emitter (used by `StartOnEvent` / `SucceedOnEvent`).
- `MimManager.instance` — singleton plumbed at `Runtime.ts:386`
  (`this.mim = MimManager.instance`). The `bt/mim/` directory contains
  the full MIM port: flows, prompts, GenerateListConfig, delegates,
  AsrMetadata, WeightedRotation, analytics.

---

## 10. Rendering (`rendering/`)

`rendering/index.ts:1-32`. Top side-effects (1-9): `require('pixi.js'),
'pixi-animate', 'pixi-compressed-textures'`; `PIXI.glCore.VertexArrayObject
.FORCE_NATIVE = true`. Exports: `FaceRenderer, tasks, animation, tween,
input, gui, eye`.

Init sequence:

1. Side-effects on `require` (`index.ts:40`).
2. `Runtime` ctor electron path (`Runtime.ts:332-343`):
   `PIXI.utils.skipHello(); this.face = new FaceRenderer(this.timer);
   this.rendering = classes.rendering;`.
3. After registry + `_initPlugins`: `Runtime.instance.face.init(display);`
   (`Runtime.ts:541`).

### `FaceRenderer extends PIXI.WebGLRenderer` (`rendering/FaceRenderer.ts`)

Statics: `WIDTH=1280, HEIGHT=720`. Owns `stage:PIXI.Container,
_eye:EyeContainer, _views:ViewManager, _gestures:GestureManager,
_timer:Timer`.

Ctor (105-240):

- Wraps `textureManager.updateTexture / destroyTexture` for GPU texture
  lifecycle logging. Exposes `window.listGpuTextures` (DEBUG) and
  `window.loseWebGLContext` (manual GL drop).
- `webglcontextlost`: pause, disable views, destroy eye, delete loader
  caches (`ViewManager.GLOBAL_CACHE`, `eye.CACHE_ID`), then
  `Runtime.instance.lifecycle.finished()` to bail back to idle.
- `webglcontextrestored`: recreate `EyeContainer`, call `init
  (parentNode, false)`, unpause, again `lifecycle.finished()`.
- Force `WEBGL_compressed_texture_s3tc` extension load.
- `_timer.on('update', this.update)`.
- `plugins.prepare.limiter = new PIXI.prepare.TimeLimiter(10)`.

`init(element, prepWorkers=true)` (249-259):

```ts
element.appendChild(this.view);
this._views.init(null, prepWorkers);
this._eye.init();
this.paused = false;
```

`update(elapsed)` (303-326): `TweenManager.update; views.update;
render(stage)`. On render error: reset views, destroy+recreate eye,
`lifecycle.finished()`.

Getters: `views, gestures, tween` (`= TweenManager`), `eye, paused`.

### `EyeContainer` (`rendering/eye/EyeContainer.ts`)

Extends `PIXI.Container`, implements `IAuxOutput`. Owns: `eye:Eye,
eyeOverlay:EyeOverlay, background:Background, backgroundBorder:
PIXI.Graphics, glow:GlowFilter, lighting:LightFilter`. `CACHE_ID =
'global-eye'`. Default textures (`Default_Eye.png`,
`JiBO_eye_customizer_44.png`, `JiBO_BG_00.png`) come from
`animation-utilities`.

`Eye.display(timestamp, dofValues, metadata?)` (`rendering/eye/Eye.ts:
21-66`): writes 9 vertex DOFs (`vertexJoint1_t…9_t` + `_2`) via
`conversion.toPixelsX/Y` into `points[i].x/.y`; translates by
`eyeSubRootBn_t`; sets `tint = rgb2hex(eye_redChannelBn_r,
eye_greenChannelBn_r, eye_blueChannelBn_r)`, `alpha =
eye_alphaChannelBn_r`, `visible = eyeVisibilityBn_r`, `rotation =
-eyeSubRootBn_r`.

This is the function `ExpressionPlugin` wires the DOF stream into
(`ExpressionPlugin.ts:34-36`):

```ts
this.api.events.dofs.on((data) =>
    Runtime.instance.face.eye.display(data.timestamp, data.dofValues,
                                      data.metadata));
```

Our port replaces the cloud expression service with an eye-bridge that
pushes synthetic DOFs directly into `face.eye.display`.

### `ViewManager` (`rendering/gui/ViewManager.ts`)

Owns the view stack. Views: `EyeView, MenuView, ImageView, ContactsView,
TextView`. Components: `Element, ElementGroup, Label, Button,
StandardButton, MenuButton, ContactButton, List, Clip, ContentButton`.
`DEFAULT_TRANS_TIME = 550`. Public API: `ChangeOptions` (65-75: `remove /
removeAll / removeTo / removeToInclude / leaveEmpty / addView / pause /
transitionClose / transitionOpen`), `AssetDescriptor` (84-90: `{id,
type, src, upload?, cache?}`), `ViewProcess`, `ViewProcessResult`,
`stage, init(_, prepWorkers), disabled, reset(), destroyBorder(),
destroy(), update(elapsed)`.

### `TouchManager` (`rendering/gui/TouchManager.ts`)

Singleton. `enum GESTURE { TAP='tap', SWIPE_DOWN='swipeDown',
SWIPE='swipeDown', SWIPE_UP='swipeUp', PAN='pan' }`. Listens for
HammerJS events on the PIXI view. `_isSim = (runMode === SIMULATOR)`
(198) — sim mode forwards mouse-down to mimic cap-touch.

### `GestureManager` (`rendering/input/GestureManager.ts`)

Wraps Hammer's `Manager` around the canvas. Static event-name constants:
`PAN, PANSTART, PANMOVE, PANEND, PANCANCEL, PANLEFT, PANRIGHT, …`.
HammerJS only `require`d if `electron` is truthy.

---

## 11. Sound (`sound/`)

`sound/index.ts:1-21` exports `Sound, SoundContext, ChainBuilder,
SoundPlugin, SoundInstance, SoundUtils, tasks`.

**`SoundPlugin` (`sound/SoundPlugin.ts`)** — `id='sound', api:true,
electron:true`, no deps. Holds `_sounds:{[alias]:Sound}` + global
`SoundContext`. Ctor: `new SoundContext(); Runtime.instance.loader.
register(SoundTask, 50);`. `init(done) { done(); }`. Methods: `add,
addMap, remove, pauseAll/resumeAll/muteAll/unmuteAll/removeAll/stopAll,
exists, sound(alias), play, stop, pause, resume, destroy`. `play(alias,
opts?)` (287-294) also fires
`Runtime.instance.performance.log('JiboSoundPlayEvent', alias)`.

**`SoundContext` (`sound/SoundContext.ts`)** — single per-process
`AudioContext`: `_ctx = new AudioContext(); _gainNode = ctx.createGain
(); _compressor = ctx.createDynamicsCompressor();`. Chain: `gain →
compressor → ctx.destination`. `muted, volume, paused` drive
`gainNode.gain.value` and `ctx.suspend/resume()`.

**`Sound` (`sound/Sound.ts`)** — ctor (86+) coerces options to defaults
(`autoPlay:false, block:false, src:null, preload:false, volume:1,
panning:0, complete:null, loaded:null, loop:false, useXHR:false`); builds
`_chain = new ChainBuilder(_ctx).bufferSource().gainNode().analyser().
panner()`. Methods: `play(opts), stop, pause, resume, destroy`.

**`SoundInstance` (`sound/SoundInstance.ts`)** — pool-backed
(`static _pool`); `static create(chain)` pops from pool or constructs.
Owns `AudioBufferSourceNode, _startTime, _paused, _currentPosition`.
Emits when source ends.

**`SoundTask` (`sound/tasks/SoundTask.ts`)** — extends `Task` from
`jibo-loader`. `static test(asset)` matches audio. Reads via `fs` or
`XMLHttpRequest` (`useXHR`), decodes via `_ctx.decodeAudioData`,
registers the `AudioBuffer` on the alias.

---

## 12. Flow & Utils

**Flow** (`flow/index.ts:12-23`): `FlowExecutorFactory, FlowExecutor,
FlowRootFactory, FlowExceptionInfo, Activity, Procedure, State,
ActivityImplementation, activities (= FlowClasses), core (=
jibo-flow-core)`. `Runtime` ctor builds `this.flow = new
FlowExecutorFactory(classes.flow)` (electron only). Every `.flow`
ultimately constructs `bt` behaviors via `Factory.create`.

**Utils** (`utils/index.ts:1-28`): `Timer, DelayedCall, perf, PathUtils,
WipeUtil, Location, LocationUtils, Timezone, DateTime, DateTimeUtils`.
Key consumers: `Timer` (Runtime.timer; `_init` starts it; everyone
subscribes `'update'` ticks here — FaceRenderer.update, bt Factory.run);
`DelayedCall` (EyeContainer `ANIM_REMOVAL_DELAY=100ms`);
`PathUtils.findRoot(__dirname)` (FontsPlugin, VolumePlugin,
VersionsPlugin); `Location.jiboHome` (filled by `HomeLocation.init` in
LocationPlugin).

---

## 13. Final `jibo.*` after init

After `_installPlugins()` (sync, ctor): `loader, rendering, sound, bt,
flow, face, timer, utils, services, RunMode, kb, lps, ics, tts,
performance, wifi, errors, secureTransferService, web, scheduler,
globalEvents, remote, session, systemManager, system, behaviorEmitter,
analytics, log, mim`.

After `_initPlugins()` (post `init(cb)`): `versions, volume, media, im,
autobot, expression, animDB, action, emotion, embodied, context,
jetstream, lifecycle, ['dev-shell']`.

Also after `init`: `records:RegistrationRecord[], registryHost:string,
electronContext:any, Runtime.isInitialized=true`, `jibo.timer` running.

---

## 14. Browser-port hooks

1. `process.env.runMode = 'SIMULATOR'` before requiring `jibo`.
2. Force `electron` truthy in `utils/electron.ts:1`.
3. Stub `Runtime.ipcRenderer` (EventEmitter) so `RegistryPlugin` gets
   `set-context` with `{registryHost, token, context}`; `init-done /
   finished / show / shutdown` no-op.
4. Fake registry at `jibo.registryHost` returning every record name
   used: `skills-service, system-manager, global-manager, kb, remote,
   expression, jetstream, dev-shell` + everything `ServiceClients.init`
   walks.
5. Open four WS sockets: `skills-service` (Lifecycle), `global-manager`
   (`/globals` + `POST /global`), `dev-shell` (sim only), `remote`
   (RemoteService command-library protocol).
6. Emulate `expression` so `expression.api.init` resolves and
   `events.dofs` fires — or bypass and push DOFs straight into
   `Runtime.instance.face.eye.display(...)` from an eye-bridge.
7. Emulate `jetstream` so `JetstreamPlugin.init` resolves and
   `SharedGlobalEvents.shared.init` can map turn-results to `hjOnly /
   noGlobalMatch`.
8. Mock KB endpoints so `VolumePlugin.init` can load `/settings` root.
