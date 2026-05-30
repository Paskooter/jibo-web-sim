# 11 — `@be/be` meta-skill and `@be/be-framework` (`BeSkill`)

Renderer-side meta-skill that hosts every other be-skill. Be loads each skill module by npm-name, owns the skill-switch scheduler / lifecycle state machine, and bridges `jibo.action`'s skill-switch handler to `BeSkill#open`. `BeSkill` (`@be/be-framework`) is the abstract base every skill extends.

All paths absolute under `/tmp/sdk/skills/`.

---

## 1. `be` package metadata — `package.json#jibo` (`be/package.json:6-51`)

```json
"jibo": {
    "debug": {
        "asr":false, "embodiedListen":false, "attention":false, "idle":false,
        "embodiedSpeech":false, "resourceLeak":true, "showTimer":false,
        "noCacheDestroy":false, "skipRestore":false
    },
    "main": "index.html",
    "skills": [
        "@be/clock","@be/circuit-saver","@be/rosbridge","@be/jibo-be-control",
        "@be/idle","@be/main-menu","@be/settings","@be/create","@be/exercise",
        "@be/first-contact","@be/friendly-tips","@be/gallery","@be/hue-control",
        "@be/ifttt","@be/introductions","@be/remote","@be/nimbus","@be/restore",
        "@be/surprises","@be/surprises-date","@be/surprises-ota","@be/greetings",
        "@be/who-am-i","@be/tutorial","@be/radio","@be/word-of-the-day"
    ],
    "defaultSkill": "@be/idle",
    "eosSkill":     "@be/surprises",
    "firstSkill":   "@be/first-contact",
    "restoreSkill": "@be/restore"
}
```

`skills[]` — every skill instantiated at boot, keyed by npm package name. `defaultSkill` is the idle the scheduler falls back to. `eosSkill` is the Elements-of-Surprise router (§12). `firstSkill` is used on a fresh robot (KB `hasAlreadyLaunchedFirstContact === false`); `restoreSkill` when fresh-robot + backup-data. `debug.resourceLeak` enables `TimerSpy`; `debug.noCacheDestroy` makes `closeSkill` skip `jibo.loader.deleteCache`; `debug.skipRestore` bypasses restore on first boot.

---

## 2. `Be` class (`be/src/Be.ts`)

Constructor (`:60-194`):

- `(global as any).be = this;` (`:61`).
- Inserts `<div id="splash">` before `<div id="face">` (`:71-73`).
- `this.skills = {}` (`:80`), keyed by package name.
- Reads `package.json` via `jibo.utils.PathUtils.findRoot()` (`:83-86`).
- Skill construction loop (`:89-122`, §9).
- Picks the four special skills (`:129-150`): `this.idle = skills[defaultSkill]`, `this.firstSkill = skills[firstSkill]`, `this.restoreSkill = skills[restoreSkill]`, `this.eosSkill = skills[eosSkill] as SurpriseSkill`.
- `new SkillSwitchScheduler(this.idle)` (`:153`).
- For every skill (`:160-189`) wires three listeners:
  - `'exit'` → `Be#exit(skill, exitOptions, done)`
  - `'redirect'` → `Be#skillRedirect(skill, name, options)`
  - `'refresh'` → `Be#skillRedirect(skill, skill.assetPack, options)` (refresh ≡ redirect-to-self).
- Surprise elements collected into `eosCategories` and handed to EoS via `this.eosSkill.supplyCategories(eosCategories)` (`:192`).
- Missing `postInit` / `preload` stubbed to `(done)=>done()` (`:183-188`).

---

## 3. Boot flow

`Be#init(initDoneCallback)` (`Be.ts:202-278`) is what `index.html` calls. In order:

1. `ModuleVersions.log` dumps every dep version.
2. `jibo.init({display:'face', analytics: new LibraryAnalytics()}, …)`.
3. `(window as any).Module = null` — kills emscripten leftover from `pixi-compressed-textures` (`:221`).
4. `loadLogConfig` (`:225`); `RegistryClient.createInstance(host, port)` (`:231`).
5. `NotificationsDispatcher.instance.init` → `Log.handleLogLevelNotifications`.
6. If `debug.resourceLeak`: `TimerSpy.instance.init(getCurrentSkillName)` (`:245-255`).
7. `this._skillSwitchScheduler.run()` (`:257`).
8. Jetstream reset (`:258-263`): `unsubscribeAllGlobals`, subscribe `globals/global_commands_launch`, `setHJMode('NORMAL_HJ')`.
9. `jibo.expression.indexRobot().then(() => BeSkill.init(this.initPlugins…))` (`:268-274`). On failure: `BeSkill.errorCode('F4-Index_timeout', …)`.

`Be#initPlugins(err)` (`:286-314`) runs every skill's `postInit(done)` via `jibo.loader.load(tasks, postInit)`. `Be#postInit(err)` (`:364-382`): `initAnalyticsContext()` sets ssm/be/platform/release version on `BeSkill.plugins.analytics.context`; `jibo.face.views.changeView({removeAll:true, leaveEmpty:true}, …)` clears the face stage; then `this.selectFirstSkill(this.launchFirstSkill.bind(this))`.

### `selectFirstSkill(callback)` (`Be.ts:389-443`)

Loads `/skills-config` KB root, checks backup data and current error id: `currentErrorId` → `@be/settings` with `{nlu:{entities:{errorId}}}`. Else if `firstTime` (`!rootNode.data.hasAlreadyLaunchedFirstContact`): `backupErr && !skipRestore` → retry after 2s; `hasBackupData && !skipRestore` → `restoreSkill`; else → `firstSkill`. Else → `idle`.

### `launchFirstSkill(firstSkill, opts, errorId, firstTime)` (`Be.ts:449-490`)

```ts
let firstSkillRedirectToken = this.redirect(new SkillSwitchData(firstSkill, firstSkillLaunchOptions));
firstSkillRedirectToken.onState(SkillLifecycleState.SKILL_OPENED, firstSkillHasOpened);
```

`firstSkillHasOpened` (`:451-462`) hides/removes `#splash`, calls `this.enableSkillSwitching()` (only when not error-skill mode), then `this.initDoneCallback()`. If `firstErrorId` set, an `onErrorResolved` chain re-runs `selectFirstSkill` after `LIFECYCLE_ENDED`.

### `enableSkillSwitching()` (`Be.ts:498-526`) — two cross-process bridges:

```ts
jibo.globalEvents.skillRelaunch.on(data => {
    this.redirect(new SkillSwitchData(this.skills[data.match.skillID], data));
});

jibo.action.setSkillSwitchHandler((skillName, skillData) => new Promise(resolve => {
    let token = this.redirect(new SkillSwitchData(this.skills[skillName], skillData));
    token.onState(SkillLifecycleState.SKILL_OPENED,    () => resolve(SUCCEEDED));
    token.onState(SkillLifecycleState.LIFECYCLE_ENDED, () => resolve(FAILED));
}));
```

`skillRelaunch` is SSM's NLU-rule firehose (`globals/*`); the action-system handler is the path *every other* skill-switch goes through (proactive, error, intent-launched).

---

## 4. `SkillSwitchScheduler` (`be/src/SkillSwitchScheduler.ts`)

Two-slot state machine: `_currentSkillLifecycle` (running) + `_pendingSkillLifecycle` (queued), each paired with a `…SkillRedirectToken`. Constructor (`:23-38`) flags `(this._updateMethod as any).isGlobalTimer = true` so TimerSpy doesn't charge the heartbeat. `run()` (`:40-42`) calls `_update()` once; `_recallUpdate()` (`:271-279`) arms `jibo.timer.setTimeout(this._updateMethod, 10)` — 10ms heartbeat.

### `requestSkillRedirect(requestedSkillSwitchData)` (`:48-128`)

Builds a `SkillLifecycle` + `SkillRedirectToken` for the request, marks `skillSwitchRequested()`, then the **four-branch dispatch**:

- **(A)** `!pending && !current` (`:60-66`) — install as pending.
- **(B)** `current && !pending` (`:67-82`) — if `canSkillSwitch(current, requested)` install as pending; else deny.
- **(C)** `!current && pending` (`:83-102`) — if `requested.priority >= pending.priority`, end old pending with `PENDING_SKILL_SWITCH_INTERRUPTED` and swap; else deny.
- **(D)** both (`:103-125`) — must beat pending priority AND survive `canSkillSwitch(current, requested)`; swap-or-deny.

Deny ends the requested lifecycle with `SKILL_SWITCH_REQUEST_DENIED`. Callers always get a token; on denial it's already `LIFECYCLE_ENDED` with the reason on `skillLifecycleEndState`.

### `_update()` (`:130-269`) — runs every 10ms

No pending → `_recallUpdate()` and return (`:131-134`).

**Branch 1: same skill ⇒ refresh** (`:144-178`) when `current.skill === pending.skill`. Sequence: `pending.startSkillOpen()` → `pending.skill.open(opts, true /*refresh*/, currentName, currentOpts)` → `current.skillLifecycleEnded(SKILL_REFRESHED)` → swap pending into current slot → `current.skillOpened()`. On exception: both lifecycles `SKILL_REFRESH_FAILED`, scheduler self-recovers via `requestSkillRedirect(new SkillSwitchData(this._idleSkill, {}))` (`:165-174`).

**Branch 2: different skill ⇒ close-then-open** (`:179-268`):

```ts
SkillSwitchUtil.closeSkill(skillToClose, pendingSkillName)
  .then(() => { _currentSkillLifecycle.skillLifecycleEnded(SKILL_EXITED);
                return this._completeAction(); })  // jibo.action.addBeSkillSwitchGoal
  .then(() => {
      let prev = _currentSkillLifecycle;
      _currentSkillLifecycle    = _pendingSkillLifecycle;
      _currentSkillRedirectToken = _pendingSkillRedirectToken;
      _pendingSkillLifecycle = _pendingSkillRedirectToken = null;
      TimerSpy.instance.getCurrentSkillNameCallback = ()=>currentSkill.assetPack;
      _currentSkillLifecycle.startSkillOpen();
      return SkillSwitchUtil.openNewSkill(prev, _currentSkillLifecycle);
  })
  .then(() => _currentSkillLifecycle.skillOpened(),
        err => { /* SKILL_OPEN_FAILED → requestSkillRedirect(idle) */ });
```

Close failure → `SKILL_CLOSE_FAILED` (`:253-263`). Open failure recovers to idle (`:247`).

### `_completeAction()` (`:281-321`) / `destroy()` (`:323-336`)

`_completeAction`: 10ms-interval poll on `_pendingSkillLifecycle`; submits `jibo.action.addBeSkillSwitchGoal({skillName, skillOptions, beSkillPriority, beSkillPreferences:{cancelOrientOnStart:false}})`; resolves on `GoalFinishedStatus.SUCCEEDED`. If the pending slot changes mid-flight it discards the prior goal's listeners and registers a new goal — keeps in sync with the action system when a higher-priority redirect arrives mid-close. `destroy()` sets `_destroyed`, cancels timeout, closes the current skill.

---

## 5. `SkillSwitchUtil` (`be/src/SkillSwitchUtil.ts`)

Stateless helpers. Both timeouts 5s (`:15-16`).

### `canSkillSwitch(currentData, newData)` (`:22-39`)

```ts
if (current.priority > new.priority) {
    if (new.options?.match?.isProactive) return false;  // proactive can't bump higher-priority
    return current.skill.isInterruptible;
}
return true;
```

### `closeSkill(skill, pendingSkillName?)` (`:41-106`)

Resolves after `skill.close(resolve, pendingSkillName)` or rejects after 5s ("skill took too long to close. Force closing."). Either path: `skill.skipSurprisesExternal=false` (`:53`); on error → `jibo.face.reset()` + `jibo.loader.assetManager.cancelAll()` (`:72-74`); sanity-check `activeCache === skill.assetPack` (`:81-83`); if `!debug.noCacheDestroy` → `jibo.loader.deleteCache(skill.assetPack)` (`:87-89`); `jibo.expression.destroyCaches(skill.assetPack)` (`:91`); `jibo.loader.activeCache=null; jibo.embodied.speech.setPaths(null)` (`:95-96`); if `debug.resourceLeak` → `TimerSpy.instance.checkSkillCleanup()` (`:98-101`); always `BeSkill.plugins.analytics.skillExit(pendingSkillName)` (`:104`).

### `openNewSkill(currentLifecycle, newLifecycle)` (`:117-190`)

Setup (`:131-144`): `jibo.loader.basePath = jibo.sound.basePath = newSkill.rootPath`; `jibo.loader.addCache(newSkill.assetPack)`; `jibo.loader.activeCache = newSkill.assetPack`; `jibo.embodied.speech.setPaths(newSkill.assetPack)`; if `newSkillOptions?.asr?.text` → `jibo.mim.silentMenus = false`.

Open (`:146-160`): `log.info("BeSkill open", oldSkillName, newSkillName, newSkillOptions)` (canonical log shape `"BeSkill open" <prev> <curr> <options>`) → `BeSkill.open(oldSkillName, newSkill.assetPack, newSkillOptions, cb)` (runs every open-hook) → `newSkill.preload(cb)`.

Finalize (`:175-188`): `BeSkill.plugins.analytics.skillEntry(...)` → `newSkill.skipSurprisesExternal = newSkillOptions?.match?.skipSurprises` → `newSkill.open(newSkillOptions, false /*refresh*/, currentSkillName, currentSkillOptions)`.

---

## 6. `SkillSwitchData` / `SkillRedirectToken`

**`SkillSwitchData`** (`be/src/SkillSwitchData.ts`) wraps `(skill, options)` and computes a numeric priority. Options shape (`:6`): `type Options = Partial<jibo.jetstream.types.ListenResult> & {lastSkill?: string, exitOptions?: ExitOptions};`. Constructor (`:13-27`) defensively defaults `options.asr = {text:'', confidence:1}` and ensures `options.nlu.entities = {}`.

Priority table (`SkillSwitchData.ts:41-73`): `@be/restore=7`, `@be/settings`+`nlu.intent==='wipe'=6`, `@be/settings`+`nlu.entities.errorId=5`, `@be/tutorial`/`@be/first-contact=4`, `@be/clock`+`finished`+`alarm|timer=3`, default=2, `match.isProactive=1`, `@be/idle=0`.

**`SkillRedirectToken`** (`be/src/SkillRedirectToken.ts`) wraps a `SkillLifecycle`. Getters: `skillLifecycleState`, `skillLifecycleEndState`, `skillSwitchData`. Methods: `addOnSkillLifecycleStateChange(cb)` (`:28`), `addOnSkillLifecycleEnd(cb)` (`:34`), `onState(targetState, cb)` (`:40-50`) — if already at-or-past target, fires cb sync; else listens for the exact transition. This is the API call sites use (`Be.ts:465`, `:512`, `:517`) to wait for `SKILL_OPENED` / `LIFECYCLE_ENDED`.

---

## 7. `BeSkill` (`be-framework/src/BeSkill.ts`) — `EventEmitter` subclass

Globals shim (`:11-17`): `if (!global._jiboBeSkill) global._jiboBeSkill = {plugins:{_deprecated:false}, openHooks:[]};` — plugins + open-hooks are shared across every `BeSkill` instance via this one global.

### Static surface

- `static plugins` `:94` / `static openHooks` `:101` — both alias the global shim.
- `static errorCode(code, message='')` `:163-168` — logs `Code: '<code>', Message: '<message>'` via `ErrorCode` child log. Used by Be: `'F4-Index_timeout'` at `Be.ts:273`.
- `static registerPlugin(name, plugin)` `:176-179` / `static registerOpenHook(hook)` `:186-188`.
- `static open(lastSkill, nextSkill, results, done)` `:202-211` — `Promise.all(openHooks.map(h => new Promise(h(...))))` then `done`.
- `static init(done)` `:220-239` resolves queued plugins in chain order. `be-framework/src/main.ts:1-17` registers them in this order: `onScreenTimer`, `tunable`(@DEBUG), `analytics`, `context`, `holiday`. Open-hooks (import side effects): `embodied`, `attention`, `interactionMemory`.

In addition, `Be.ts:674-679` registers a debug open-hook used by Dentist: `registerOpenHook((old,new,res)=>(resolve)=>{jibo.performance.log('BeSkillOpen', JSON.stringify({newSkill:new,oldSkill:old,result:res})); resolve();});`.

### Instance contract

Constructor (`:241-283`) sets `assetPack`, `rootPath`, builds a `Log` prefixed `Be.<PascalCased>` (e.g. `Be.Clock`). If `!this.assetPack` (standalone) calls `this.init()`. Methods:

- `open(result?, refresh?, prevName?, prevOpts?)` `:405-409` **MUST override**.
- `close(done, pendingSkillName?)` `:427-431` **MUST override**.
- `refresh(result?)` `:416-419` — fixed, emits `'refresh'`. **Cannot override.**
- `redirect(skillName, options)` `:452-457` — sets `_isInterruptible=true`, emits `'redirect'`. **Cannot override.**
- `exit(exitOptions?)` `:438-444` — sets `_isInterruptible=true`, emits `'exit'`.
- `postInit(done)` `:366-368` / `preload(done)` `:376-378` / `destroy(done)` `:477-479` — no-op defaults.
- `get isInterruptible()` `:391-393`. `track(event, data?)` `:467-469` → `BeSkill.plugins.analytics.skillEvent`.

`Be#_validateSkill` (`Be.ts:639-666`) enforces these override rules.

### Standalone `init()` (`BeSkill.ts:291-359`)

Used when a skill loads without Be. Boots jibo → `BeSkill.init` → `this.postInit` → `BeSkill.open` → `this.preload`, then wires its own `skillRelaunch` listener and `action.setSkillSwitchHandler` that re-call `this.open(skillData, true /*refresh*/)` when the matched name equals `this.assetPack`. Adds `this.on('refresh', …)` and invokes `this.open(null, false)`. This is the "inner-skill refresh" path — when Be is not the host, the skill listens for `skillRelaunch` and refreshes itself.

---

## 8. Skill lifecycle states

`SkillLifecycleState` (`be/src/SkillLifecycleState.ts:3-18`) — ordered; (with one exception) monotonic per lifecycle:

```ts
enum SkillLifecycleState {
    NONE = 0, SKILL_SWITCH_REQUESTED = 1, SKILL_SWITCH_PENDING = 2,
    SKILL_START_OPEN = 4 /* skips 3 */, SKILL_OPENED = 5, LIFECYCLE_ENDED = 6,
};
```

Guards in `SkillLifecycle` (`be/src/SkillLifecycle.ts:65-108`): each `skillSwitchRequested / skillSwitchPending / startSkillOpen / skillOpened` only fires if the previous state matches; `skillLifecycleEnded` is unconditional (idempotent `:98-100`).

`SkillLifecycleEndState` (`be/src/SkillLifecycleEndState.ts:4-22`):

```ts
enum SkillLifecycleEndState {
    NONE = 0,
    PENDING_SKILL_SWITCH_INTERRUPTED = 1,  // bumped out of pending by another skill
    SKILL_SWITCH_REQUEST_DENIED      = 2,  // priority/interruptible check failed
    SKILL_REFRESH_FAILED = 3, SKILL_OPEN_FAILED = 4, SKILL_CLOSE_FAILED = 5,
    SKILL_EXITED = 6,   // normal close-then-open completed
    SKILL_REFRESHED = 7 // normal same-skill refresh completed
};
```

`SkillLifecycle._setSkillLifecycleState` (`:110-125`) fans out to every `onSkillLifecycleStateChangeCallback`; `skillLifecycleEnded` also fires `onSkillLifecycleEnd` callbacks (`:127-137`).

---

## 9. Skill load (`Be.ts:89-122`)

```ts
const SkillExport = require(id);
let Skill = (typeof SkillExport === 'function')        ? SkillExport
          : (typeof SkillExport.Skill === 'function')  ? SkillExport.Skill
          : (() => { throw new Error(`Error loading skill: ${id}. Incorrect exports`); })();
const skill = new Skill({ assetPack: id,
                          rootPath:  path.dirname(jibo.utils.PathUtils.resolve(id)) });
if (!this._validateSkill(skill)) throw new Error('not a valid BeSkill');
this.skills[id] = skill;
```

For a browser port: module is found by `require(id)` where `id` is the npm name (e.g. `"@be/clock"`). Two valid export shapes: the export *is* the constructor, or `.Skill` on the export. Constructed once with `{assetPack:<id>, rootPath:<dirname(resolved index)>}`. A failed skill is silently dropped (caught, logged) — the rest keep loading.

---

## 10. `be/index.html` (`:1-34`)

The full bootstrap body — just CSS for `#face` (1280×720) and `#splash` (bg `./resources/JiboSplash.png`), a `<div id="face">`, and the script:

```html
<script>
  const Be = require("./index");
  let be = new Be();
  be.init(()=>{ be.log.info("Finished running Be init"); });
</script>
```

Host is Electron (renderer): `require()` resolves `./index` → `index.js` (bundled `src/index.ts → Be`). No `process.env.RUNMODE` / `window.__JIBO_ELECTRON__` reference here — runtime detection lives in `jibo.runMode` (used by `loadLogConfig` `be/src/log.ts:17` and `ModuleVersions.log` `be/src/ModuleVersions.ts:25-26`). DOM contract: `<div id="face">` mount; Be adds the splash `<div>` itself.

---

## 11. Redirect / exit / refresh paths

Three semantic entry points on `Be` — all funnel through `requestSkillRedirect`.

**`Be#redirect(SkillSwitchData)`** (`Be.ts:596-598`) — lowest level: `return this._skillSwitchScheduler.requestSkillRedirect(skillSwitchData)`. Called by `launchFirstSkill` (`:464`), `enableSkillSwitching` (`:502`,`:509`), `Be#exit` (`:560`,`:565`), `Be#skillRedirect` (`:582`).

**`Be#exit(exitingSkill, exitOptions={}, done)`** (`Be.ts:542-568`) — called when a skill emits `'exit'`:
1. Only the *current* skill may `exit`; else warn-and-return.
2. `skipEoS = !!(exitOptions.noElementsOfSurprise || exitOptions.globalNoMatch)`.
3. If `!skipEoS && currentSkill !== idle && currentSkill !== eosSkill && !currentSkill.isElementOfSurprise && !currentSkill.skipSurprisesExternal` → redirect into `eosSkill` with `{lastSkill: currentSkill.assetPack}`. Else redirect to `idle` with `{exitOptions}`.

`redirectToken.addOnSkillLifecycleEnd(done)` chains the caller's callback.

**`Be#skillRedirect(redirectingSkill, name, options)`** (`Be.ts:570-586`) — called when a skill emits `'redirect'` or `'refresh'`. Only the current skill may redirect. `log.info("REDIRECT: skill redirect: ", name, options); this.redirect(new SkillSwitchData(skill, options));`. The `'refresh'` wire-up (`Be.ts:172-175`) passes `skill.assetPack` as the target — refresh ≡ redirect-to-self, handled by scheduler branch 1 (`open(opts, refresh=true, …)` without close).

`BeSkill#exit / #redirect / #refresh` (`BeSkill.ts:438-457`, `:416-419`) forcibly set `this._isInterruptible = true` — a skill self-terminating opts into being interrupted.

---

## 12. `eosSkill` / surprises end-of-skill flow

EoS skill = `@be/surprises`. At construction every skill with `isElementOfSurprise === true` is pushed to `eosCategories` and passed to EoS via `this.eosSkill.supplyCategories(eosCategories)` (`Be.ts:178-181`, `:192`). When a non-idle, non-EoS, non-element skill emits `'exit'` and didn't opt out (`skipSurprisesExternal` or `exitOptions.noElementsOfSurprise|globalNoMatch`), `Be#exit` redirects into EoS with `{lastSkill: currentSkill.assetPack}` (`Be.ts:560`). EoS plays a surprise tied to a `SurpriseElement` and exits, falling back to idle (or another surprise) under the same rules.

`skipSurprisesExternal` is set at open time (`SkillSwitchUtil.ts:181`): `newSkill.skipSurprisesExternal = newSkillOptions?.match?.skipSurprises` — and reset to `false` in every `closeSkill` (`:53`). The upstream `match.skipSurprises` is a single-shot suppressor.

---

