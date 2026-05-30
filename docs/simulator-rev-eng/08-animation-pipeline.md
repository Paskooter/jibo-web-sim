# Animation + Expression Pipeline

End-to-end reference for the Jibo animation pipeline as it exists in the original SDK
(`/tmp/sdk/packages/`). Covers the path from on-disk `.keys` file to DOFs being streamed
into the FaceRenderer + body axis controllers, including AnimDB indexing, Playback,
keyframe runtime evaluation, expression service handles, and DOF arbitration.

All citations are `file:line` against the SDK checkout at `/tmp/sdk/packages/`.

---

## 1. AnimDB structure

An `animdb.json` is an `AnimMetadataMap`: a flat object whose keys are the
lower-cased animation name and whose values are `AnimMetadata` records produced
from the `.keys` file at build time.

`AnimMetadata` fields (`Classes.ts:74-89`):
`name, path, scale[2], speed[2], durationRange[2], duration, startsNeutral,
endsNeutral, hasAudio, holdSafeKF, orientation, categories[], layers
(LayerPresence), metaTerms[]`.

`AnimDBParser.parseAnimationFromAnim` (`AnimDBParser.ts:294-381`) derives those
properties from the loaded `.keys`:

- The `.keys` `animdb` block supplies `name`, `scaleMin/Max`, `speedMin/Max`,
  `categories`, `meta` (comma-strings; lowercased and split).
- `holdSafeKF` is the time of an `Event` layer whose name equals `HOLD_SAFE`
  (`AnimUtils.ts:230-245`). If present, `durationRange[1] = INFINITE_DURATION`
  (`AnimDBParser.ts:339-347`).
- `layers` (LayerPresence) is built by `AnimUtils.checkLayers`
  (`AnimUtils.ts:173-183`) — booleans for `Body, Eye, EyeTexture, Overlay,
  OverlayTexture, AudioEvent, Event, Pixi, BackgroundTexture, LED`.
- If `metaTerms` contains `audio-only` (`AnimUtils.ts:22`), every layer except
  `AudioEvent` is zeroed (`AnimDBParser.ts:355-361`) — the lie that lets the
  BEAT layer treat the keys as audio-only in Embodied Speech.

`AnimCollection` (`AnimCollection.ts`) is an indexed bag of `Animation`s plus a
`Category` table: `addAnimation`/`addCategory` insert by lowercased name (36-55);
`getAnimByName`/`getCategoryByName`/`getAnimationNames`/`getAnimationCategories`
(63-93); `query(AnimQuery)` either filters by `categories` (intersection) or
scans the full set via `Utils.getAnimationsByQuery` (157-170).

`AnimDB` (`AnimDB.ts`) is a stack of collections; `getAnimByName` returns the
first match (`AnimDB.ts:57-68`).

---

## 2. AnimDB API

Module-level exports in `jibo-anim-db/src/api.ts` keep a singleton `_animDB`:

```
init(jibo: any, animDBPath?: string, ...moreAnimDBPaths: string[]): Promise<void>
    api.ts:54-60
resolveAnimDB(jibo: any, dir?: string): string
    api.ts:78-106  (reads package.json "jibo.animdb" or falls back to "animdb.json")
getAnimByName(animName: string): Animation       api.ts:114
getAnimationNames(): string[]                    api.ts:123
getAnimationCategories(): string[]               api.ts:132
search(searchTerm: string): SearchResults        api.ts:142
query(query: AnimQuery): AnimResults             api.ts:152
push(animCollection: AnimCollection): void       api.ts:161
pop(): AnimCollection                            api.ts:170
```

`AnimDBParser.readAnimDB` (the engine behind `init`) reads each path with
`FileUtils.readFile`, parses as JSON, and `addAnimCollection` for each.
The result becomes `_animDB` (`AnimDBParser.ts:55-66`, `api.ts:58`).

`AnimQuery` signature (`Classes.ts:119-131`):

```
{ category?, categories?, includeCat?, includeSomeCat?, excludeCat?,
  duration?, durationError?, hasAudio?,
  includeMeta?, includeSomeMeta?, excludeMeta? }
```

`AnimUtils.insertDefaultAnimQueryParams` lowercases every category/meta filter and
defaults `hasAudio` to `DONT_CARE` (`AnimUtils.ts:308-349`).

`AnimResults` contains `matching: Animation[]` and `nonMatching: Animation[]`
(`Classes.ts:137-150`). `nonMatching` is animations whose categories/meta match but
whose duration doesn't fit the requested duration ± `durationError`.

---

## 3. Loading a .keys — the full pipeline

Runtime entrypoint:

```
const anim = jibo.animDB.getAnimByName('positive');
const { playback, result } = anim.play(config, options);    // Animation.ts:58-66
```

`Animation.play` constructs a `Playback(transform, cache, this)` and calls
`playback.initAndPlay(config, options)`. Inside Playback:

1. `_init(config)` (`Playback.ts:208-270`): resolves `filePath = path.join(resourceRoot, meta.path)`,
   applies AnimConfig transforms (flip-left/right, exaggerate via per-DOF scale
   on `topSection_r/middleSection_r/bottomSection_r/eyeSubRootBn_t`, speed,
   hold-safe frames → `holdSafeDuration` in ms).
2. `resolvePlaybackOptions` merges `defaultOptions` `{disableSetFaceAnim:false,
   screenCenterOverride:true, ownerInformation:'AnimDB'}` with the caller's
   (`Playback.ts:20-24, 280-284`).
3. `loadAnimation(true)` (`Playback.ts:394-429`): calls `jibo.loader.load({…type:'keys'})`.
   Loader uses `KeysLoader` to read and composite reference layers
   (`KeysLoader.ts:120-163`), resolves to a `KeysData`. With `andPlay=true`,
   Playback then calls `keysData.getAndPlayAnim({src, ...config}, ownerInformation)`
   (`Playback.ts:420-424`).
4. `KeysData.getAndPlayAnim(options, requestor)` (`KeysData.ts:174-196`):
     - Pins the cached `.keys` blob via a second `loader.load` (`_loadToken`).
     - `createAnimOptions(options)`: if no precomputed `.anim`, runs
       `jiboKeyframes.computeAnimObject(this.data, this.src)` (`KeysData.ts:230-233`)
       and packs `{path: this.root, src, data, cacheName}` as the AnimationOptions.
     - Invokes `Runtime.instance.expression.createAndPlayAnimation(animOptions, requestor)`
       (`KeysData.ts:193`).
5. `Expression.createAndPlayAnimation` (`Expression.ts:147-157`) serializes
   `arg.dofs = arg.dofs.getDOFs()` if present, RPCs the server, and constructs
   `AnimationInstance(client, instanceId, id, dofs, didPlay=true)`.
6. `Playback.registerEventsAndHandlers` (`Playback.ts:293-333`) wires
   `stopped/cancelled/rejected/holdSafe` on `instance.events`. If the keys touches
   screen DOFs and `disableSetFaceAnim` is false, it also calls
   `jibo.face.eye.addAnimation(this.keysAnimation)` so the FaceRenderer ticks it.

`KeysData.getAnim` (no andPlay) is the "init only" variant (`KeysData.ts:141-163`); a
later `Playback.play` invokes `keysAnimation.instance.play(this.options.ownerInformation)`
(`Playback.ts:169`).

---

## 4. computeAnimObject — shape of the played data

`KeysUtils.computeAnimObject(keysData, filename)`
(`jibo-keyframes/src/utils/KeysUtils.js:180-248`) is the keyframe→DOF cooker. Output:

```
{
  header: { fileType:'Animation', version, animdb: <hash of animdb tag> },
  content: {
    name,                     // basename of source
    channels: Channel[],
    events:   AnimEvent[]
  }
}
```

Each `Channel` (`KeysUtils.js:205-211`):

```
{
  dofName: string,           // e.g. 'topSection_r', 'eyeSubRootBn_t'
  length:  number,           // keysData.duration / framerate  (seconds; the whole
                             //   timeline length, NOT this channel's length)
  times:   number[],         // seconds, monotonically increasing
  values:  any[]             // numeric DOF value or per-DOF struct
}
```

Channels are built by iterating every frame `0..duration-1`, computing
`timeInSeconds = framesToSeconds(frame, framerate)`, calling
`Runtime.evaluateAllDOFLayers(keysData, JiboKeyframeInfo, timeInSeconds)`
(`Runtime.js:105-133`), and pushing into `animChannels[dofName]`
(`KeysUtils.js:198-236`).

The **DOF Kompressor** (`KeysUtils.js:219-235`): when the last two frames in a channel
have the same value as the new one, it pops the previous frame and updates the
last frame's time — effectively run-length-encoding constant runs into a
two-frame `[startTime, endTime]` segment. Downstream playback samples by
nearest/linear interpolation between adjacent (time, value) pairs.

Each `AnimEvent` (`KeysUtils.js:238-244`):

```
{
  time: number,              // seconds
  eventName: string,         // see below
  payload: any
}
```

Events come from `Runtime.evaluateAllEventLayers` (`Runtime.js:466-494`), which scans
every event-layer and asks `layerClass.generateEvent(props, layerIdx)`.

`eventName` values (from `jibo-keyframes/src/layers/`):

- `play-audio` — `AudioLayer.js:31`, payload `{ file }`.
- `play-pixi` — `PixiLayer.js:39`, payload `{ file, layerNum, attach, offset, effect:false }`.
- `HOLD_SAFE` — `EventLayer.js` generic event with that name.
- Any other — free-form `{ name, payload }` from `EventLayer.js:30`.

`STOPPED/STARTED/CANCELLED/REJECTED` are not embedded as `AnimEvent`s on the
channel; they are state transitions emitted by the expression service to the
client `AnimationInstance` via the `'EVENT'` RPC (see §5).

---

## 5. AnimationInstance.onEvent — dispatcher

`AnimationInstance` (`AnimationInstance.ts:68-202`) subscribes to the `'EVENT'` RPC
channel and `onEvent(eventName, payload)` (`AnimationInstance.ts:168-201`) routes:

- `'play-audio'` → `events.audio.emit(payload)`
- `'play-pixi'` → `events.pixi.emit(payload)`
- `'HOLD_SAFE'` → `events.holdSafe.emit()`
- `STOPPED|STARTED|CANCELLED|REJECTED` → `setState(…); events.<state>.emit(); emit(…)`
- anything else → `events.general.emit({name, payload})`

`AnimationEvents` (`AnimationInstance.ts:52-62`) emitters:
`general, audio, pixi, holdSafe, stopped, cancelled, rejected, started, stateChange`.

`AnimationState` (`AnimationInstance.ts:22-32`):
`INVALID, PLAYING, STOPPED, STOPPING, CANCELLED, PAUSED, RESUMED, STARTED, REJECTED`.
`play/stop/pause/resume` RPC the server and toggle `state` (`AnimationInstance.ts:110-148`).

---

## 6. KeysAnimation — onPlayAudio / onPlayTimeline

`KeysAnimation` (`KeysAnimation.ts:137-580`) is the client-side render object for a
single playing keys file. Its `instance` setter hooks
`general → onEvent`, `audio → onPlayAudio`, `pixi → onPlayTimeline`
(`KeysAnimation.ts:324-336`).

`onPlayAudio(payload)` (`KeysAnimation.ts:518-520`) is one line:
`this.sounds[payload.file].play()`. `this.sounds` is a getter for `KeysData.sounds`
(`KeysAnimation.ts:297-299`), populated when the loader pre-loaded each audio
referenced in the .keys into the eye cache (`KeysData.addSound`, `KeysData.ts:109-111`).
The `Sound` object lives at `jibo/src/sound/Sound.ts`.

`onPlayTimeline(payload)` (`KeysAnimation.ts:545-562`) looks up
`this.timelines[payload.file]`, constructs a `TimelineLayer(layerNum, file,
timeline, currentTime, attach, offset)`, and inserts/replaces it via
`replaceOrAddTimelineLayer` + `reorder()`.

`TimelineLayer` (`KeysAnimation.ts:56-100`) instantiates a pixi-animate
`MovieClip` via `new timeline.library.stage()` and locks framerate to
`KeysAnimation.FRAMERATE` (30). On each `update(time, dofValues)` it does
`gotoAndStop(offset + Math.round((time-startTime)*30))`. If `attach`, it tracks
`eyeSubRootBn_t/_t_2/_r` (`KeysAnimation.ts:107-116`).

`KeysAnimation.update(time, dofValues)` (`KeysAnimation.ts:347-356`) is driven by
the face render tick and emits `'update'` which `playSync` callers consume.

---

## 7. Expression class

`jibo-expression-client/src/Expression.ts` is the client-side proxy to the expression
service. Two creation paths exist:

```ts
createAnimation(options: AnimationOptions<DOFSet>): Promise<AnimationInstance>
    // Expression.ts:125-135
createAndPlayAnimation(options, requestor='Behavior'): Promise<AnimationInstance>
    // Expression.ts:147-157
```

Both serialize `options.dofs` via `getDOFs()` before sending. `createAndPlayAnimation`
RPCs `'createAndPlayAnimation'` with `[arg, requestor]`; the resulting
`AnimationInstance` is constructed with `didPlay=true` so its initial state is
`PLAYING` (`Expression.ts:152-156`, `AnimationInstance.ts:98-102`).

Other public surface (`Expression.ts`):

- `acquireTarget(opts)` → `AcquireHandle` (175-181) — look-at target.
- `setAttentionMode(mode)` (190-192) and `pushAttentionMode(mode)` → `AttentionHandle`
  (209-213); `getAttentionMode()` (220-222). Stack semantics: push wins, release pops.
- `setLEDColor([r,g,b])` (230-232) — direct LED, values 0..1.
- `awaitFace({timeout})` → `AwaitFaceHandle` (254-260).
- `centerRobot({requestor, dofs, centerGlobally})` (268-280) — drive listed DOFs to
  neutral; `cleanup({requestor, dofs})` (288-300) — center + release ownership.
- `indexRobot()` (307-309); `setSkillRoot(root)` (311-316); `blink()` (323-325);
  `destroyCaches(name|name[])` (165-167).

`Expression.events` (`Expression.ts:56-59,86-91`) is a pair of `Event` emitters:

- `dofs`: `{ timestamp:[s,ns], dofValues, metadata }` — high-frequency per-frame DOF
  stream the server pushes to the client.
- `kinematics`: `KinematicFeatures` (head/eye/base position+direction).

`AnimationOptions<DOFSet>` is the message body. Notable extra fields baked by
`KeysData.createAnimOptions`: `{ path, src, data, cacheName }`
(`KeysData.ts:235-240`). When `data` is present the server evaluates locally; when
`src` is set the server consumes a pre-cooked `.anim` file.

---

## 8. Handle types

All handles inherit from `ClientRemoteObject`. Two flavors:

`ReleaseHandle<T>` (`jibo-expression-client/src/base/ReleaseHandle.ts:6-36`):
- `release()` sends `'release'` to the server, then `destroy()`s the proxy.
- Double-release is logged and silently returns `valToReturnWhenAlreadyReleased`.

`ResolveHandle<T>` (`jibo-expression-client/src/base/ResolveHandle.ts:6-43`):
- Exposes `promise: Promise<T>` and `result: T`.
- `cancel()` sends `'cancel'` to the server (no-op if already resolved/cancelled).
- `onPromise(result)` is the server-pushed resolution hook — it fulfills the
  promise and destroys the proxy.

Concrete handles:

- `AttentionHandle extends ReleaseHandle<boolean>` (`handles/AttentionHandle.ts:9-18`)
  — returned by `pushAttentionMode(mode)`. `release()` pops this mode; the highest
  remaining un-released mode becomes active. Double-release returns `false`.
- `AcquireHandle extends ResolveHandle<ResultStatus>` (`handles/AcquireHandle.ts:8`)
  — returned by `acquireTarget(opts)`. `promise` resolves when acquired; `cancel()` aborts.
- `AwaitFaceHandle extends ResolveHandle<AwaitFaceResult>` (`handles/AwaitFaceHandle.ts:8`)
  — returned by `awaitFace({timeout})`. `promise` resolves with the face result; resolves
  immediately if a face is already present. `cancel()` aborts.

`LEDHandle` exists as a placeholder but `pushLEDMode/getLEDMode` are commented out
(`Expression.ts:236-244`).

---

## 9. DOFSet — algebra and standard sets

`DOFSet` (`animation-utilities/src/geometry-info/DOFSet.js:26-129`) is a tiny
set-of-strings type:

```js
plus(otherSet | name)   // union           DOFSet.js:49-72
minus(otherSet | name)  // setdiff         DOFSet.js:81-105
getDOFs()               // string[]        DOFSet.js:111-113
hasDOF(dof)             // bool            DOFSet.js:122-124
createFromDofs(dofs)    // factory         DOFSet.js:126-128
```

A `dofSetGroup` map is captured in the constructor closure so string names can be
resolved to the named DOFSet (`DOFSet.js:54-58, 86-90`).

The standard `DOFSets` are loaded from `jibo.dofgroups` (`DOFSets` JSON with
`content.DOFSets` and optional `content.CompoundSets`) via `DOFSet.load`
(`DOFSet.js:145-158, 165-206`). `createDOFs()` (`DOFs.ts:41-85`) exposes the public
namespace: `ALL, BASE, BODY, EYE, LED, OVERLAY, SCREEN`, plus per-subsystem
`{EYE,OVERLAY,SCREEN_BG}_{ROOT,DEFORM,RENDER,TRANSLATE,ROTATE,COLOR,TEXTURE,VISIBILITY}`.
`createDOFs` calls `RobotInfo.createInfo`, which loads `jibo.dofgroups` and exposes
each set via `robotInfo.getDOFSet(name)` (`RobotInfo.js:173-176`).

### How embodied-dialog uses set algebra

`jibo-embodied-dialog/src/listen/Utils.ts:25-27`:

```ts
if (!ALL_MINUS_BASE) {
    ALL_MINUS_BASE = jibo.expression.dofs.ALL.minus(jibo.expression.dofs.BASE);
}
```

Defaulting animation `config.dofs = ALL_MINUS_BASE` means listen-state animations
never touch the base (wheel) DOFs — those are reserved so a separate "drive"
behavior can run concurrently without conflict.

In `EmbodiedListen` constructor (`EmbodiedListen.ts:101-103`):

```ts
this.DOFS_ALL_MINUS_EYE_TRANSLATE = dofs.ALL.minus(dofs.EYE_TRANSLATE);
this.DOFS_EYE_AND_OVERLAY_MINUS_EYE_TRANSLATE = (dofs.EYE.plus(dofs.OVERLAY))
                                                  .minus(dofs.EYE_TRANSLATE);
this.DOFS_TO_CENTER = dofs.ALL.minus(dofs.LED).minus(dofs.BODY).minus(dofs.EYE_TRANSLATE);
```

These three are passed as `config.dofs` to `playAnimation` / `cleanup` so each
listen sub-mode is scoped to a coherent slice of the face.

In `Playback.handlePlaybackCompletion` (`Playback.ts:350-358`):

```ts
Playback.DOFS_TO_CENTER = dofs.ALL.minus(dofs.BASE).minus(dofs.EYE_TRANSLATE);
```

— the "centerRobot at end" call deliberately leaves BASE and EYE_TRANSLATE alone so
the attention system retains gaze control.

---

## 10. RobotInfo / JiboConfig — geometry files

`JiboConfig` (`animation-utilities/src/geometry-info/JiboConfig.js:12-107`) computes
URLs relative to a base path. The default base is
`<find-root>/res/geometry-config/<robotVersion>/` with `robotVersion = "P1.0"`
(`JiboConfig.js:17-22`).

Files loaded (URL accessors on `JiboConfig`, all rooted at the robot version dir):

- `jibo_body.{geom,skel,kin}`, `jibo_joined.{geom,skel,kin}`, `jibo_eye.{geom,skel,kin}`
  via `SkeletonLoader` / `KinematicsLoader` (geom is loaded by the viewer, not runtime).
- `jibo.jscene` → `SceneInfo.load` → `EyeScreenInfo`.
- `jibo.dofgroups` → `DOFSet.load` (`DOFSet.js:145-158`).
- `jibo.lim` → `LimitsLoader`.
- `jibo_default.anim` → `AnimationLoader` (sampled at duration/2 to capture neutral
  pose).
- `defaultNormalMap.png` for the eye texture.

`RobotInfo.createInfo(config, cb)` (`RobotInfo.js:53-66`) instantiates a
`JiboKinematicInfo(config)` and calls `.load(cb)`. The load fans out parallel
requests using `getCallback("…")` registration; only when every named callback
fires does it finalize (`JiboKinematicInfo.js:75-176`).

Loaded fields surface via `RobotInfo` accessors (`RobotInfo.js:89-176`):

```
getBodyDOFNames(), getEyeDOFNames(), getDOFNames(),
getEyeScreenInfo(), getDOFInfo(dof), getDefaultDOFValues(),
getDOFSetNames(), getDOFSet(name)
```

`getDefaultDOFValues` samples the default `.anim` at `duration/2` to capture the
neutral pose (`JiboKinematicInfo.js:141-152`).

`FileTools.loadText(url, cb)` (`animation-utilities/src/ifr-core/FileTools.js:27`) is
the cross-platform loader. It prefers `XMLHttpRequest` (`FileTools.js:39-66`);
falls back to `http.request` for `http://` URLs in node
(`FileTools.js:66-95`); falls back to `fs.readFile(uri.path(), 'utf8', cb)` for
`file://` URLs (`FileTools.js:114`). `FileTools.loadJSON` wraps it with `JSON.parse`
(`FileTools.js:131-133`).

---

## 11. DOF Arbiter — who wins when animations overlap

`jibo-dof-arbiter/src/main/DOFArbiter.ts` runs server-side. Every
animation/lookat that goes through `animation-utilities` triggers a global
`ADDED` event the arbiter hooks (`DOFArbiter.ts:175-176, 722-784`):

1. **Identify owner.** If queued via the arbiter's own `playAnimation/startLookat`,
   the builder is found in `builderToOwner`. Otherwise owner is `"Direct"`
   (`DOFArbiter.ts:764-774`).
2. **Mark DOFs in use by instance.** `markInUseByInstance` (`DOFArbiter.ts:651-674`)
   records the previous owner in a `dofLosses` map and reassigns ownership with
   status `ACTIVE_AUTO`.
3. **Notify listeners** of lost/gained DOFs (`DOFArbiter.ts:587-615`).
4. **On `STOPPED`/`CANCELLED`** the arbiter flips DOFs to `TIMED_RELEASE` with
   `releasedAt = Clock.currentTime()`. The 100 ms `update()` tick
   (`DOFArbiter.ts:188-220`) checks `curTime - releasedAt > graceExpiryPeriodS`
   (currently `-0.001` — release immediately) and flips them to `AVAILABLE`.

Conflict resolution lives in `DOFArbiterPriorityPolicy.acquire`
(`DOFArbiterPriorityPolicy.ts:70-130`). Per DOF: allow if owner is `null`, same as
requester, or has lower priority than requester; otherwise deny. If any DOF is
denied and `options.allOrNothing`, the entire allow-list is cleared.

Default priority config (`DOFArbiter.ts:154-160`): `priorityForDirectUsers: 5`,
`priorityForUnknownLabels: 2`, `priorityEntries: [{owner:"Attention", priority:1}]`.
Direct (5) beats anything; unknown labels (2) beat `Attention` (1); animations
through `createAndPlayAnimation` with default `requestor='Behavior'` get the
unknown-label priority 2.

Special case: when `(builder as any).layer !== 'default'`, arbitration is bypassed
and the builder plays immediately (`DOFArbiter.ts:233-237`) — this is how the BEAT
posture layer can run concurrently with default-layer animations.

`centerRobot` (`DOFArbiter.ts:332-399`) is run with `allOrNothing: false`, so it
takes whatever DOFs it can grab and partially recenters.

`centerWithHybridPriority` (`DOFArbiter.ts:421-448`) lets a high-priority requester
seize DOFs and then re-assign them to a trustee for the actual centering motion.

---

## 12. Embodied dialog — `Utils.playAnimation` walkthrough

`jibo-embodied-dialog/src/listen/Utils.ts:23-43`: lazy-builds
`ALL_MINUS_BASE = dofs.ALL.minus(dofs.BASE)`, looks up `asset = animDB.getAnimByName(animName)`,
fills missing `config.dofs` with `ALL_MINUS_BASE` and missing
`options.ownerInformation` with `EmbodiedListen.NONHJ_OWNER_INFORMATION`, then
calls `asset.play(config, playbackOptions)`.

End-to-end: `EmbodiedListen._addAnimToQueue(name, config, options)`
(`EmbodiedListen.ts:640-655`) queues an async closure on its internal queue, which
calls `Utils.playAnimation({jibo, animName, config, options})`. That dispatches
`asset.play(config, playbackOptions)` → `Animation.play` → `Playback.initAndPlay`
→ the §3 pipeline → `expression.createAndPlayAnimation(animOptions, requestor)`.

Server side: the expression service builds an `AnimationBuilder` from the
animOptions and hands it to `DOFArbiter.playAnimation(builder, requestor, opts)`.
If `policy.acquire` returns zero DOFs and `allOrNothing` is true, the builder is
played anyway but `REJECTED` is dispatched immediately — the client sees
`'EVENT' REJECTED` and `Playback.registerEventsAndHandlers`'s `rejected` handler
resolves the play promise with `AnimationState.REJECTED`. Otherwise
animation-utilities ticks the builder at framerate, evaluating the cooked
channels and emitting `'dofs'` updates and `'EVENT'` audio/pixi events back. On
the client, `AnimationInstance.onEvent` routes those into the typed emitters
(§5), which `KeysAnimation` consumes for `sounds[file].play()` and Pixi timeline
creation (§6). When `STOPPED` arrives, `Playback`'s `stopHandler`
(`Playback.ts:305-310`) resolves with `AnimationState.STOPPED`, and
`handlePlaybackCompletion` (`Playback.ts:342-360`) optionally calls
`expression.centerRobot({dofs: ALL.minus(BASE).minus(EYE_TRANSLATE)})`.

**BEAT-layer override:** in `Playback._init`, if the animation's metaTerms include
`audio-only`, the config is forced to `BuilderLayer.BEAT` (`Playback.ts:224-226`).
That makes the arbiter's `layer !== 'default'` bypass apply
(`DOFArbiter.ts:233-237`), so a "say it" beat animation can run on top of any
posture animation owning the body DOFs.
