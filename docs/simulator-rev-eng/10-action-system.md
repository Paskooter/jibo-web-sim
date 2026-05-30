# jibo-action-system — Goal/Action Arbitration + Proactive

Reverse-engineered from `/tmp/sdk/packages/jibo-action-system/src/`.
Top-level: `jibo.action` exports `{ action, motivation, common, goal, api, proactive }`
(`src/index.ts:19-26`). Skill-facing surface in `src/api.ts`; engine in
`src/common/ActionRuntime.ts`. One `ActionRuntime` lives at `api._runtime`.

## 1. ActionRuntime

`api.ts:45,57,70-74`:
```ts
export let _runtime: ActionRuntime;
export let events: PublicActionEvents;
export function init(options): Promise<void> {
    _runtime = new ActionRuntime();
    events = new PublicActionEvents(_runtime.events);
    return _runtime.init(options);
}
```
`_runtime` is meant for "testing and special circumstances" (`api.ts:39-44`).

**Field-init** (`common/ActionRuntime.ts:72-108`): `goals=new GoalSet(this)`,
`actions=new ActionSystem(this)`, `motivations=new MotivationSystem(this)`,
`proactive: OpportunityDetector = null` ← stays null until init() decides,
`events=new ActionEvents()`, `memory=new Memory(this)`, `goalProviders=[]`,
`dateProvider=new DefaultDateProvider()`, `_updater=new Updater()`.

**`init({jibo})` algorithm** (`ActionRuntime.ts:126-191`):
1. Cache `jibo`, default `autoUpdate=true`.
2. Install fixed providers (133-140): `HJGoalProvider` (kept as `hjGoalProvider`
   so `configure({orientToHJ})` can toggle it), `HJNoMatchGoalProvider`,
   `HJOnlyGoalProvider`, `SnuggleGoalProvider`, `HeadTouchGoalProvider`.
3. Branch on `pegasusProactiveTrigger` (142-155):
   - `true` → `this.proactive = new OpportunityDetector(this)`,
     `setDisableProactiveTrigger(...)`, `proactive.init()`.
   - `false` → `proactive` stays null; install `ProactiveGreetingGoalProvider`.
4. `goalProviders.forEach(gp => gp.init())`.
5. `_updater` ticks (161-166): `motivations.update()` every **1000 ms**,
   `this.update()` every **1000 ms**, and **iff `pegasusProactiveTrigger`** →
   `proactive.update()` every **100 ms** (10 Hz).
6. `events.goalAdded → handleIncomingGoal`.
7. If `autoUpdate`: `jibo.timer.on('update', updateAll)` and stamp
   `(updateAll as any).isGlobalTimer = true` so Be's TimerSpy lets it persist
   across skill teardown.
8. Bind jetstream listen state: `globalTurnStarted → HJ_TRIGGERED_LISTEN`,
   `globalTurnResult → NOT_LISTENING` (179-187).
9. `TunableDebug.setup(this)`.

**`pegasusProactiveTrigger`** — quoted from `package.json`:
```json
"options": { "pegasusProactiveTrigger": true, "disableProactiveTrigger": false }
```
Reader at `ActionRuntime.ts:43-57` (defaults to `false`; throws if package.json
unreadable). Shipped values mean the OpportunityDetector path is live and the
10 Hz `proactive.update()` loop is on.

**`_updater`** (`common/Updater.ts:24-63`) — `addUpdateable(fn, intervalMs)`
pushes `{update,last,interval}`; `update()` fires entries where
`(now - last) > interval`. Pump: `updateAll = () => this._updater.update()`
(`ActionRuntime.ts:320`).

**`update()`** (`ActionRuntime.ts:272-277`):
```ts
update() { if (!this.activeGoals.length) { this.pursueNextGoal(); } }
```

**`handleIncomingGoal`** (279-315) — preemption gate. `!isEligible` → queued.
No active goals → `pursueNextGoal`. Else: if any same-or-higher-priority
active goal can't run in parallel with incoming → drop incoming. Else cancel
all lower-priority conflicting actives (`Promise.all(cancelGoalDrivenAction)`)
then `achieveGoal`.

**`achieveGoal`** (353-392) — `ActionSystem.chooseAction` → goal `SELECTED`
→ wrap in `GoalDrivenAction` → push to `activeGoals` and re-sort ascending
by priority → run; `postAction` schedules `pursueNextGoal()` on `process.nextTick`.

## 2. GoalSet

`goal/GoalSet.ts:28-170`. Holds `goals: Goal[]` + `GoalParallelism` registry.

**Allowed parallel pairs** (constructor 34-44):

| A | B | predicate |
|---|---|---|
| `BeSSWGoal` | `SSWGoal` | same `data.skillName` |
| `BeSSWGoal` | `HeadTouchGoal` | — |
| `HeadTouchGoal` | `SSWGoal` | — |
| `BeSSWGoal` | `HJOnlyGoal` | — |
| `SnuggleGoal` | `AnimationGoal` | — |
| `HJGoal` | `HeadTouchGoal` | — |

Anything not listed is mutually exclusive. `canBeAchievedInParallel` checks
both orderings + predicate (`GoalParallelism.ts:39-62`).

**`addGoal(goal)`** (50-108) — for non-`REGULAR` priorityType, walk same-class
goals: higher-priority incoming cancels old; lower-priority incoming dropped;
equal-priority + `SINGLETON_KEEP_FIRST` drops incoming; equal-priority +
`SINGLETON_KEEP_LAST` cancels old.

**`chooseGoal(state)`** (114-155) — partition into culled/eligible/next, cull
stale (`setFinishedStatus(CULLED)`), sort eligible descending by priority,
**break ties via `Math.random() > 0.5`** (141-149).

**Priority table** (`goal/GoalPriority.ts:5-18`):
```
HeyJibo:12  HeadTouch:12  BeSkillSwitch:11  SkillSwitch:10
Animation:9  Snuggle:9  FindPerson:8  HJOnly:7
Default:5  Circadian:4  Proactive:4  Motivation:3
```
`BeSSWGoal` self-bumps to `HeyJibo+1=13` when
`data.beSkillPreferences.cancelOrientOnStart` (`BeSSWGoal.ts:24-29`).

## 3. ActionSystem

`action/ActionSystem.ts:44-106`. `chooseAction(state, goal, eligibleActions?)`:
1. If `goal.options.action` set, call provider and accept if eligible.
2. Else `this.policy.selectAction(goal, state)` (BasicPolicy).
3. Fallback: filter registry by `isEligible(state)`.
4. `MotivationGoal` branch (72-104): score eligible actions as
   `Σ action.getDriveEffect(d.name) * d.value` over drives-above-threshold;
   pick lowest negative score, epsilon-tie via `_.sample`.

**BasicPolicy** (`action/policies/BasicPolicy.ts:47-105`):

| Goal | Action |
|---|---|
| `HJGoal` in `@be/idle` | `HJOrient(parent, hjData.primary.position)` |
| `HJGoal` not idle | `BasicLookat(parent, position)` |
| `BeSSWGoal` | `BeSkillSwitchAction(parent, goal.data)` |
| `HJOnlyGoal` | `SSWAction → @be/greetings` (`intent:'heyJibo'`) |
| `SSWGoal` | `SSWAction(parent, data.skillName, data.skillOptions)` |
| `AnimationGoal` | `AnimationAction(parent, data)` |
| `FindPersonGoal` | `SearchAction(parent)` |
| `HeadTouchGoal` while listening | `HeadTouch(parent, shouldQuitSkill)` |
| `HeadTouchGoal` not-idle | `HeadTouch(parent, true)` |
| `HeadTouchGoal` idle+not-listening | none → `events.secondhandTouchStop.emit` |
| `SnuggleGoal` | `Snuggle(parent, snuggleGoal.type)` |

## 4. MotivationSystem

`motivation/MotivationSystem.ts:50-52`:
```ts
this.drives.set(DriveName.SOCIAL,  new WakingDrive(this.parent, DriveName.SOCIAL,  1/120));        // 0→1 over 2 h
this.drives.set(DriveName.PLAYFUL, new WakingDrive(this.parent, DriveName.PLAYFUL, 1/360, false)); // 0→1 over 6 h, shouldCauseGoal=false
//this.drives.set(DriveName.HELPFUL, new Drive(DriveName.HELPFUL)); // currently unused
```
`DriveName` enum: `common/Types.ts:288-292`.

**`update()`** (62-78) — 1000 ms tick. Each drive `update()`s; any drive with
`shouldCauseGoal=true` over threshold → emit `MotivationGoal` via the private
`MotivationGoalProvider`.

`WakingDrive.update()` (`drives/WakingDrive.ts:22-32`) gates on
`circadian ∈ {ALERT, RELAXED}`; else pins `ratePerMin=0` **and resets
`_value=0`**. `Drive.computeDriveIncrement` (`Drive.ts:80-95`) uses wall-clock
`Date.now()` deltas — tick-cadence-independent.

`applyMotivationalEffects(action)` (85-89) is called by
`GoalDrivenAction.run()` after `SUCCEEDED`, walking
`action.options.driveEffects` (clamped 0..1, `Drive.ts:71-73`).

## 5. Goal classes

All extend `goal/Goal.ts:45-183`. Base: `options.{priority, priorityType,
maxAttempts, action?, criteria?}`; `isEligible(state)` honors
`criteria.{startTime, endTime, currentSkill, personPresent}` (145-168);
`canBeCulled(state)` honors `endTime` (176-182).

**`HJGoal`** (`goals/HJGoal.ts:18-26`) — priority 12, `SINGLETON_KEEP_LAST`,
carries `hjData: HJData`. From `HJGoalProvider` on
`lps.identity.events.hjEvent`. Action: `HJOrient` (idle) or `BasicLookat`.

**`HJOnlyGoal`** (`goals/HJOnlyGoal.ts:18-36`) — priority 7. Self-culls after
10 s. From `HJOnlyGoalProvider` on `globalEvents.shared.hjOnly` when idle.
Action: `SSWAction → @be/greetings` (`intent='heyJibo'`).

**`BeSSWGoal`** (`goals/BeSSWGoal.ts:14-31`) — **critical**:
```ts
constructor(parent, public data: BeSSWGoalData, name=`Be Skill Switch Goal: '${data.skillName}'`) {
    super(parent, name, {
        priority: GoalPriority.BeSkillSwitch,           // 11
        criteria: data.criteria,
        priorityType: GoalPriorityType.SINGLETON_KEEP_LAST
    });
    if (data.beSkillPreferences) {
        if (data.beSkillPreferences.cancelOrientOnStart) {
            this.options.priority = GoalPriority.HeyJibo + 1;  // 13
        }
    }
}
```
Issued by Be (`api.addBeSkillSwitchGoal`, `api.ts:155-160`) during a Be skill
switch. Action: `BeSkillSwitchAction` (immediate success — pure marker so
lower-priority goals get preempted before the actual switch lands). Parallel
with `SSWGoal` (same skillName), `HeadTouchGoal`, `HJOnlyGoal`.

**`SSWGoal`** (`goals/SSWGoal.ts:16-25`) — priority 10, `SINGLETON_KEEP_LAST`.
From `api.addSkillSwitchGoal`, `HJNoMatchGoalProvider`,
`OpportunityDetector.triggerGreeting`, `ProactiveGreetingGoalProvider`,
`HeadTouch` (when quitting). Action: `SSWAction`.

**`AnimationGoal`** (`goals/AnimationGoal.ts:16-31`) — priority 9, caller-passed
`priorityType` (typically `REGULAR`). Name: `Play Animation Goal [cat:…]` or
`[name:…]`. Action: `AnimationAction`.

**`FindPersonGoal`** (`goals/FindPersonGoal.ts:16-23`) — priority 8. From
`api.addFindPersonGoal`. Action: `SearchAction`.

**`HeadTouchGoal`** (`goals/HeadTouchGoal.ts:24-43`) — priority 12,
`SINGLETON_KEEP_FIRST`, `maxAttempts:1`. Self-culls after 0.5 s. From
`HeadTouchGoalProvider` on `globalEvents.touchStop`. Action: `HeadTouch` or
fizzles to `events.secondhandTouchStop` (idle+not-listening).

**`SnuggleGoal`** (`goals/SnuggleGoal.ts:13-21`) — priority 9,
`SINGLETON_KEEP_LAST`. `type ∈ {HATCH_OPEN, HATCH_CLOSE, PLUG, UNPLUG,
AXIS_FAULT}`. From `SnuggleGoalProvider`. Action: `Snuggle`.

**`MotivationGoal`** (`goals/MotivationGoal.ts:18-52`) — priority 3,
`SINGLETON_KEEP_FIRST`, `maxAttempts:1`. `isEligible` requires `@be/idle` AND
≥1 drive above threshold; `canBeCulled` when none above threshold. From
`MotivationSystem.goalProvider`. Action via score-by-drive-effect branch.

## 6. Action classes

All extend `action/Action.ts:23-197`. `ActionStatus.{RUNNING, NOT_RUNNING}`
(`Types.ts:90-93`); `ActionResult.{SUCCEEDED, FAILED, CANCELED, TIMEOUT}`
(`Types.ts:76-81`). Default timeout 30 s (`Action.ts:15`).

`GoalDrivenAction` (`action/GoalDrivenAction.ts:23-76`) owns the (goal, action)
pair. On `SUCCEEDED`: goal `SUCCEEDED`, apply motivational effects, remove
goal. On TIMEOUT/CANCELED/FAILED: bump `attempts` and re-arm under
`maxAttempts`, else `FAILED` + remove.

**`BeSkillSwitchAction`** (`actions/BeSkillSwitchAction.ts:8-28`):
```ts
protected async runInternal(): Promise<ActionResult> {
    this.parent.currentSkillName = this.goalData.skillName;
    return ActionResult.SUCCEEDED;
}
```
Marker action; immediate success.

**`SSWAction`** (`actions/SSWAction.ts:14-48`) — `await process.nextTick`,
`HeadTouch.resetHoldToQuitTime()`, then
`await parent.skillSwitcher(skillName, skillData)` (installed via
`api.setSkillSwitchHandler`). Maps `Status.SUCCEEDED→SUCCEEDED`, else `FAILED`.

**`AnimationAction`** (`actions/AnimationAction.ts:15-74`) — `data.category` →
`jibo.animDB.query({category, includeMeta, includeSomeMeta, excludeMeta})` +
`_.sample(matching)`; or `data.name` → `jibo.animDB.getAnimByName`. Builds
`AnimConfig { cache: jibo.face.eye.CACHE_ID }`, optional L/R via
`Math.random() > 0.5`, optional `mutes:{AUDIO:false, SCREEN:true, BODY:true}`
when `data.muteAudio`. `anim.play(animConfig)` then await playback.
`cancelInternal` → `this.instance.stop()`.

**`BasicLookat`** (`actions/BasicLookat.ts:15-78`) — pushes
`AttentionMode.COMMAND`, `acquireTarget({position: {x, y, z: max(0.7, pos.z)}})`,
await handle, release mode, emit `parent.events.oriented` (75), return
`SUCCEEDED`/`FAILED`.

**`EmitHeadPat`** (`actions/EmitHeadPat.ts:14-24`) — emits
`parent.events.headPat.emit(this.data)` and returns `SUCCEEDED`.
**Not selected by BasicPolicy**; secondhand-touch path uses
`events.secondhandTouchStop` directly.

**`HJOrient`** (`actions/HJOrient.ts:16-148`) — `jibo-state-machine`-driven:
`ChooseOrientationPoint → AttendToInitialFace | AttendToHJ → HaveReceivedResult
→ WaitForSignals → AttendToFoundFace → WaitForResults → Done`. Pushes
`AttentionMode.COMMAND`; consults `parent.memory.getHJData()` for an alternate
position <60 s old (60-65); races
`jetstream.events.{globalTurnResult, hjOnly}` for result arrival (75-87).
State-machine helpers in `actions/LookatClasses.ts`.

**`HeadTouch`** (`actions/HeadTouch.ts:31-159`):
```ts
public static MILLISECONDS_TO_HOLD_TOUCH = 1000;
```
Plays `touch-on.m4a`, awaits `touchOff.waitFor(MILLISECONDS_TO_HOLD_TOUCH)`.
Short release → `FAILED`. Sustained → plays `touch-off.m4a`,
`jetstream.cancelAnyTurn`; if `shouldQuitSkill`, fire
`SSWGoal('@be/idle', …, 'Hold Switch to Idle Goal')` and resolve from its
result; else resolve `SUCCEEDED`. Duration mutable via
`api.setHoldHeadToQuitDuration` / `api.resetHoldToQuitTime`
(`api.ts:242-256`).

**`Snuggle`** (`actions/Snuggle.ts:39-61`) — maps `SnuggleType →
AnimationGoalData` (`category:'system-states'` + meta), issues child
`AnimationGoal` via `parent.goals.addGoal`, resolves from
`goal.events.finished`.

**`YesNoState`** — **not in this package.** Only `ListenState.{HJ_TRIGGERED_LISTEN,
NOT_LISTENING}` (`common/Types.ts:45-48`) exists, toggled by jetstream
handlers (`ActionRuntime.ts:179-187`). Yes/no affordance lives in
`jibo-embodied-dialog`.

## 7. Goal providers

Base: `GoalProvider` (`goal/GoalProvider.ts:17-46`). `provideGoal(goal)` sets
`goal.provider = this` and forwards into `parent.goals.addGoal`.

**`HJGoalProvider`** (`goalproviders/HJGoalProvider.ts`) — listens on
`jibo.lps.identity.events.hjEvent` (42). Emits `HJGoal(parent, hjData)` and
persists hjData via `parent.memory.setHJData` (63-66). Toggleable via
`setListening` (driven by `ActionRuntime.configure({orientToHJ})`).

**`HJNoMatchGoalProvider`** (`goalproviders/HJNoMatchGoalProvider.ts`) —
listens on `jibo.globalEvents.shared.noGlobalMatch` (42). Only fires in
`@be/idle` and only if `ASRAnnotation !== GARBAGE` (49-50). Emits an `SSWGoal`
relaunching `@be/idle` with `skillOptions: new HJNoMatch(text)`
(`intent:'hjNomatch'`, 17-28), `criteria:{currentSkill:'@be/idle'}`.

**`HJOnlyGoalProvider`** (`goalproviders/HJOnlyGoalProvider.ts`) — listens on
`jibo.globalEvents.shared.hjOnly` (26). Builds `HJOnlyGoal` with
`criteria.currentSkill='@be/idle'`, but only `provideGoal`s when already idle
(33-43). BasicPolicy then runs `SSWAction → @be/greetings`.

**`SnuggleGoalProvider`** (`goalproviders/SnuggleGoalProvider.ts`) — listens on
five `jibo.system.events`: `hatchOpen`, `hatchClose`, `pluggedIn`, `unplugged`,
`axisFaultOn` (20-24). Emits `SnuggleGoal(type)` unless skill is
`@be/tutorial` or `@be/first-contact` (55-63).

**`HeadTouchGoalProvider`** (`goalproviders/HeadTouchGoalProvider.ts`) —
listens on `jibo.globalEvents.touchStop` (20). Always emits
`HeadTouchGoal(parent, data)` (28-30). Idle/listening decision resolved later
in BasicPolicy.

**`ProactiveGreetingGoalProvider`** (`goalproviders/ProactiveGreetingGoalProvider.ts`)
**Only registered when `pegasusProactiveTrigger === false`.** Listens on
`lps.identity.events.visibleFaceStarted`, `jetstream.events.hjHeard`,
`lps.identity.events.idAcquired` (52-56). On visible face, starts a 5 s timer;
on `idAcquired` cancels and `triggerIfAllowed()`; on timer expiry, evaluates
iff someone still present.

`triggerConditionsMet()` (152-173) requires: `@be/idle`; `>60 s` in skill;
`>60 s` since HJ; `>10 s` since last greeting; `circadian ∈ {ALERT, RELAXED}`;
`ungreetedPersonVisible()` (uses `jibo.im.getTimeSinceLast` against
`@be/greetings`, SOCIAL-drive-modulated 1–3 h threshold, 178-216). On
success, issues an `SSWGoal('@be/greetings', skillOptions:{nlu:{skill:
'@be/greetings', intent:'proactiveGreeting'}}, criteria:{currentSkill:
'@be/idle'})` downgraded to `GoalPriority.Proactive` (4) +
`SINGLETON_KEEP_FIRST` (222-240).

## 8. OpportunityDetector

`proactive/OpportunityDetector.ts:46-295`. The M54 stub of
`jibo.action._runtime.proactive` is this class. Extends `GoalProvider` though
only `triggerGreeting()` uses `provideGoal`.

**Signals owned** (52-92):
- **Firing** (push into `evaluate()`): `SignalIDAcquired` (face ID via LPS),
  `SignalFacePersisted`, `SignalSurprise` (`@be/surprises → @be/idle` switch
  fires `ProactiveTriggerSource.SURPRISE`), `ArrivalTracker`.
- **Inhibiting** (all must `evaluate()===true`): `SignalJiboStatus`
  (`circadian ∈ {ALERT, RELAXED}`), `SignalSkillStatus` (skill is `@be/idle`),
  `SignalHJStatus` (no HJ in progress, 27 s window), `SignalNoMatchStatus` (no
  global no-match in last 5 min), `SignalRateLimiterStatus` (rate +
  part-of-day budget), `SignalVADStatus` (VAD long+short below thresholds),
  `SignalLoudEnvironmentStatus` (audio dB long+short below thresholds).

**`init()`** (98-103) — calls `init()` on every podSignal and subscribes to
`jibo.globalEvents.skillRelaunch` to time skill-switch latency.

**`update()`** (118-124) — 10 Hz. Only `arrivalTracker.update()`; VAD/Loud are
event-driven; their explicit `update()` lines are commented out ("should
remain commented out while the OpportunityDetector is being tuned").

**`evaluate(proactiveRequest)`** (156-169) — `checkInhibitors()` (all-AND of
seven inhibitors, 182-189). If pass and `disableProactiveTrigger === false`,
`sendTrigger` + `signalRateLimiterStatus.addTriggerEvent()`.

**`sendTrigger`** (194-237) — sets `MAX_JETSTREAM_RESPONSE_TIMEOUT_MS = 2500`
timer, awaits `jibo.jetstream.triggerProactive(req).promise`. If
`triggerSource === NEW_ARRIVAL` with a `looperID`, pushes that ID to
`lps.identity.setActiveSpeaker(...)` (218-226).

**`checkEnvironmentInhibitors()`** — **public API** (174-177):
```ts
public checkEnvironmentInhibitors(): boolean {
    return this.signalVADStatus.evaluate() &&
           this.signalLoudEnvironmentStatus.evaluate();
}
```
VAD: `AmbientStats` 5 s baseline / 0.1 s recent, thresholds `-0.3 / 0.35`,
`RECENTLY_INHIBITED_DURATION_MS=2000` (`SignalVADStatus.ts:26-33`). Loud:
60 s / 10 s dB averages, `BASELINE_CEILING_DB=-40`, `RECENT_CEILING_DB=-30`,
`RECENTLY_INHIBITED_DURATION_MS=7500` (`SignalLoudEnvironmentStatus.ts:20-27`).

**This is the function that crashes when `_runtime.proactive === null`** —
`api.checkEnvironmentContext` dereferences `_runtime.proactive` blindly
(`api.ts:232-234`).

**Other external proactive surface**:
- `proactive.resetArrivalTrackerSM()` (279-281) — only `TunableDebug.ts:108`.
- `proactive.signalRateLimiterStatus.{reset,dispose,createNextPartOfDayTimeout}`
  — only `TunableDebug.ts:113-115`.
- `proactive.signalHJStatus.getState()` — internal, used by
  `SignalVADStatus.shouldSkipVADProcessing` (`SignalVADStatus.ts:75-80`).

**Static config** — `OpportunityDetector.Configure(...)` (287-294) +
per-signal `Configure` (322-327) load from
`packages/jibo-action-system/config/ProactiveConfiguration.json` at import
time. Missing file logs an error; baked-in defaults remain.

## 9. `checkEnvironmentContext` — public proactive surface

```ts
// api.ts:228-234
export function checkEnvironmentContext(): boolean {
    return _runtime.proactive.checkEnvironmentInhibitors();
}
```

**Callers (exhaustive grep across `/tmp/sdk`)**:
- `/tmp/sdk/packages/jibo-action-system/src/api.ts:232` — the export itself.
- `/tmp/sdk/skills/surprises/src/SurpriseSkill.ts:123`:
  ```ts
  if (!jibo.action.checkEnvironmentContext()) {
      this.log.info(`No EoS because environment context is loud or detected people talking.`);
      return [null, null];
  }
  ```
  Called inside `SurpriseSkill._open()` after `OPEN_WAIT_TIME_MS` of
  VAD sampling. If loud/noisy, the skill bails before picking an EoS category.
  **This is the exact crash site** the sim was hitting before M54 stubbed
  `proactive`.

External `_runtime.proactive.*` outside this package is otherwise limited to
`TunableDebug.ts:108-115` (debug-only buttons).

## 10. API exports — exact surface (`src/api.ts`)

```ts
export namespace goal { Goal; GoalEvents; }       // 14-17
export namespace action { Action; }               // 23-25
export { types };                                  // 31-33

export let _runtime: ActionRuntime;               // 45
export let events: PublicActionEvents;            // 57

export function init(options): Promise<void>;                      // 70-74
export function getState(): ExternalState;                         // 82-89  {partOfDay, circadianState, time}
export function setCurrentSkill(skillName): void;                  // 97-99
export function setCurrentCircadianState(state): void;             // 107-109
export function setSkillSwitchHandler(handler): void;              // 118-120
export function getActiveGoalActions(): Array<[Goal, Action]>;     // 128-132
export function addSkillSwitchGoal(data): Goal;                    // 141-146
export function addBeSkillSwitchGoal(data): Goal;                  // 155-160
export function addPlayAnimationGoal(data, priorityType?): Goal;   // 170-175
export function addFindPersonGoal(): Goal;                         // 183-188
export function getMotivationalDriveValue(drive): number;          // 197-199
export function applyMotivationalEffect(drive, effect): void;      // 211-213
export function configure(configOptions): void;                    // 221-223
export function checkEnvironmentContext(): boolean;                // 232-234
export function setHoldHeadToQuitDuration(ms): void;               // 242-249
export function resetHoldToQuitTime(): void;                       // 255-257
```

**There is no `proactive` export on the api namespace.** Skills that need
proactive state reach through `jibo.action._runtime.proactive.*` (only
`TunableDebug` does this in the SDK). The `proactive` namespace from
`src/index.ts:5,25` is a *type* namespace for tests + Pegasus internals.

`PublicActionEvents` (`common/ActionEvents.ts:49-62`) — events skills can
listen to: `headPat: boolean[]`, `circadianChange: CircadianState`,
`secondHandTouchStop: boolean[]`.

Internal `ActionEvents` (25-37) additionally carries `oriented`, `goalAdded`,
`skillChange` — used in-package (`SignalHJStatus` + `SignalSurprise` subscribe
to `events.skillChange`).

---

**File index** — runtime/API: `common/ActionRuntime.ts`, `api.ts`, `index.ts`.
State/utils: `common/{Updater,State,Types,ActionEvents,Memory,Utils,TunableDebug}.ts`.
Goals: `goal/{Goal,GoalSet,GoalPriority,GoalParallelism,GoalProvider}.ts`,
`goal/goals/*.ts`. Goal providers: `goal/goalproviders/{HJ,HJNoMatch,HJOnly,
Snuggle,HeadTouch,ProactiveGreeting}GoalProvider.ts`. Actions:
`action/{Action,ActionSystem,GoalDrivenAction}.ts`,
`action/policies/{ActionPolicy,BasicPolicy}.ts`, `action/actions/*.ts`.
Motivation: `motivation/{MotivationSystem,Drive}.ts`,
`motivation/drives/WakingDrive.ts`. Proactive:
`proactive/OpportunityDetector.ts`, `proactive/signals/**`. External callers
found: `/tmp/sdk/skills/surprises/src/SurpriseSkill.ts:123`.
