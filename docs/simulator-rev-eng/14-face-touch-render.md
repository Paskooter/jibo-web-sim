# 14 — FaceRenderer, Eye, Touch/Gesture, ViewManager

Source-of-truth: `/tmp/sdk/packages/jibo/src/rendering/`. All citations `file:line`.

---

## 1. `FaceRenderer` — `FaceRenderer.ts`

`class FaceRenderer extends PIXI.WebGLRenderer` (`FaceRenderer.ts:21`). Owned by Runtime; exposes `face.eye`, `face.views`, `face.gestures`, `face.tween`, `face.stage`.

Hard-coded face dimensions (`:30`, `:39`):

```ts
public static WIDTH:number  = 1280;
public static HEIGHT:number = 720;
```

Constructor (`:105-240`) calls `super(WIDTH, HEIGHT, {view: createView(), antialias:true})`, then instruments `textureManager.updateTexture/destroyTexture` (the "PIXI.TextureManager - uploaded BaseTexture..." log spam), enables `WEBGL_compressed_texture_s3tc`, then creates `stage = new PIXI.Container()`, `_eye = new EyeContainer()`, `_views = new ViewManager(this)`, `_gestures = GestureManager.init(this)`; adds views.stage to stage; binds `_timer.on('update', this.update)`; installs `plugins.prepare.limiter = new PIXI.prepare.TimeLimiter(10)`.

Canvas `width:100% height:100%` (`createView`, `:97-103`). WebGL context-loss handler (`:143-173`) resets views, destroys eye, deletes `ViewManager.GLOBAL_CACHE` and `this.eye.CACHE_ID`, then `Runtime.instance.lifecycle.finished()`. Restore (`:177-190`) rebuilds `EyeContainer` and re-`init`'s.

`init(element, prepWorkers=true)` (`:249-259`): append canvas → `_views.init(null, prepWorkers)` → `_eye.init()` → `paused = false`.

Update loop `update(elapsed)` (`:303-326`), per Timer 'update' tick: `TweenManager.update(elapsed); this._views.update(elapsed); this.render(this.stage)` — wrapped in `try`/`catch` that on error calls `_views.reset()`, destroys + re-creates the `EyeContainer`, and bails to `Runtime.instance.lifecycle.finished()`.

`reset()` (`:348-355`) → `_eye.reset()` → `_views.reset()` → `super.reset()`.

---

## 2. Eye rendering — layer composition

`EyeContainer extends PIXI.Container implements IAuxOutput` (`eye/EyeContainer.ts:33`). Constructor (`:101-129`) builds: `backgroundBorder = new PIXI.Graphics()`, `eye = new Eye(this)`, `eyeOverlay = new EyeOverlay(this)`, `background = new Background(this)`, `glow = new GlowFilter()`, `lighting = new LightFilter()`; `glow.target = lighting.target = this.eye`; `lighting.lightPosition.set(WIDTH/2, HEIGHT/2)`; `this.eye.filters = [this.lighting, this.glow]`.

Layer z-order — `reset()` (`EyeContainer.ts:339-359`):

```ts
this.removeChildren();
this.addChild(this.background);        // bottom
this.addChild(this.backgroundBorder);  // editor debug rect
this.addChild(this.eye);               // mesh + [lighting, glow] filters
this.addChild(this.eyeOverlay);        // top
```

Then `onAnimationReorder` (`:397-408`) appends every non-`EyeLayer` from the active `KeysAnimation` *above* the eye:

```ts
this._animation.layers.forEach((layer:Layer) => {
    if (!(layer instanceof EyeLayer)) {
        this.addChild((<TimelineLayer>layer).instance);
    }
});
```

Final z: **background → backgroundBorder → eye (filtered) → eyeOverlay → anim timeline layers**.

Layer classes: `Background extends AbstractLayer` wraps `PIXI.Sprite(texture)` (`Background.ts:12, :27`). `Eye` / `EyeOverlay` both `extends AbstractEye`, build an `EyeMesh(texture)` child in `AbstractEye.init` (`AbstractEye.ts:26-30`).

Default textures (`EyeContainer.ts:18-22`, loaded in `_getDefaultTextures` `:366-389` from the resolved `animation-utilities` dir, cache `'global-eye'`):

```ts
EYE:         "res/geometry-config/P1.0/textures/Default_Eye.png",
EYE_OVERLAY: "res/geometry-config/P1.0/textures/JiBO_eye_customizer_44.png",
BACKGROUND:  "res/geometry-config/P1.0/textures/JiBO_BG_00.png"
```

---

## 3. `face.eye.display(timestamp, dofs, meta)` — expression-service entry

Signature (`EyeContainer.ts:248`): `public display(timestamp:Array<number>, dofValues:DOFValues, meta?):void`. Body (`:248-277`):

1. If `_destroyed`, return.
2. If `_pendingAnim && meta.sourceTimes && meta.sourceTimes[_pendingAnim.name]` → `swapLastAnimForPending()`.
3. If `meta.sourceTimes && _animation` → `_animation.update(meta.sourceTimes[_animation.name], dofValues)`.
4. If `connected`, shift `_previousDofValues = _currentDofValues; _currentDofValues = dofValues`.
5. `glow.animate()`.
6. If `!isNotDirty(prev, curr)` → call `glow.update`, `lighting.update`, `eye.display`, `eyeOverlay.display`, `background.display` (all with `timestamp, dofValues`).

DOF → layer mapping:

- **`Eye.display`** (`Eye.ts:21-69`): `eyeTextureInfixBn_r` → `texturePath`; nine `vertexJoint{1..9}_t / _t_2` → `eyeMesh.points[0..8]` via `conversion.toPixelsX/Y`; `eyeSubRootBn_t / _t_2` → `(x, y)` from screen center; `eyeVisibilityBn_r` → `visible`; `eye_alphaChannelBn_r` → `alpha`; `eye_{red,green,blue}ChannelBn_r` → `eyeMesh.tint` via `rgb2hex`; `eyeSubRootBn_r` → `rotation = -that`.
- **`EyeOverlay.display`** (`EyeOverlay.ts:21-72`): mirror with `overlay_*` DOF names and `overlayTextureInfixBn_r`.
- **`Background.display`** (`Background.ts:38-50`): `screenBGTextureInfixBn_r` → `texturePath`; `screenBG_{red,green,blue}ChannelBn_r` → `sprite.tint`.

### Texture-infix DOFs (path-as-DOF)

The `*TextureInfixBn_r` "DOFs" are **string file paths smuggled through the DOF stream**. `AbstractLayer.set texturePath` (`AbstractLayer.ts:151-176`): if value changed and is an image path, try `eyeContainer.getTexture(value)` (looks up in `_animation.textures`, `EyeContainer.ts:216-226`); else if path matches the default, `reset()`; else `_loadTexture(value)` which issues `{id:value, src:value, type:'texture', cache: eyeContainer.CACHE_ID}` against `Runtime.instance.loader` (`:272-286`).

---

## 4. Animation slots — `addAnimation` / `removeAnimation`

State (`EyeContainer.ts:97-99`):

```ts
private _animation:KeysAnimation      = null;
private _animRemovalTimer:DelayedCall = null;
private _pendingAnim:KeysAnimation    = null;
```

`addAnimation(anim)` (`:151-177`): if `_pendingAnim` exists and differs, `destroyWhenComplete()` it; if `anim === _animation`, just `onAnimationReorder()` and return; else if `anim` is truthy, `emit('addAnimation')`, park in `_pendingAnim`, call `holdCurrentAnim()`; if `anim` is null, `removeLastAnim()` and `reset()`.

The new anim is **parked** until `display()` sees the first `meta.sourceTimes[anim.name]` — then `swapLastAnimForPending()` (`:437-451`) destroys the old, promotes the pending, wires `STOPPED`/`REORDER` listeners and calls `onAnimationReorder()`.

`removeAnimation(anim)` (`:185-196`): if `anim === _animation` and no `_pendingAnim`, `emit('removeAnimation')` and `queueAnimRemoval()` — `setTimeout(removeLastAnimAndReset, ANIM_REMOVAL_DELAY)` where `ANIM_REMOVAL_DELAY = 100` ms (`:25`).

`holdCurrentAnim()` (`:203-208`): cancels `_animRemovalTimer`, keeping current anim alive past the 100 ms anti-flicker window until the next `addAnimation` resolves.

---

## 5. `ViewManager` — `gui/ViewManager.ts`

Namespace `jibo.face.views`. The class itself is `@deprecated Since 7.4.1` (`:132-138`) — *"Everything in this class is now accessible as part of `jibo.face.views`"*.

### Views

`View extends ComponentGroup` (`views/View.ts:96`). Owns a `stage`, component tree, `assetManifest`, category, transitions.

States (`View.ts:64-73`): `INITIALIZED | DATA_LOADED | ASSETS_LOADED | LOADED | OPENED | CLOSED | DESTROYED | LOAD_ERROR`.
Categories (`View.ts:82-86`): `GUI | DISPLAY | EYE`.
View-level constants: `View.BACK = 'back'` (`:120-122`), `View.EMPTY = 'empty'` (`:131-133`), `View.PAUSED = 'paused'` (`:142-144`).

### `currentView` (`ViewManager.ts:305-307`)

```ts
public get currentView():View { return this._viewProcess.currentView; }
```

### `TRANSITION` enum (`ViewManager.ts:121-130`)

```ts
export enum TRANSITION {
    UP='trans_up', DOWN='trans_down', LEFT='trans_left', RIGHT='trans_right',
    IN='trans_in', OUT='trans_out', EYE='trans_eye', NONE='trans_none',
}
```

Plus `STACK_DIRECTION { ADD=1, REMOVE=2, SWAP=3 }` (`:103-107`). `DEFAULT_TRANS_TIME = 550` ms (`:36`), exposed as `ViewManager.TRANS_TIME` and `face.views.TRANSITION_TIME`.

Re-exposed on `face.views` (`:165-189`): `ActionData, Component, ComponentGroup, Button, Clip, ContactButton, ContentButton, Element, Label, List, MenuButton, ContactsView, EyeView, MenuView, ImageView, View, TextView, TRANSITION, STATE, CATEGORY, STACK_DIRECTION, GESTURE`.

Deprecation aliases (in `actionHandler`, `:763-907`):
- `CLOSE_ALL_OPEN` → warn, no-op (`:776-778`).
- `SWIPE_DOWN` → warn + `changeView({remove:true, ...DOWN})` (`:824-827`).
- `CLOSE_VIEW_EMPTY` / `CLOSE_ALL` / `CLOSE_ALL_EMPTY` — all warn `"Deprecation :: ActionData.CLOSE_ALL_OPEN is deprecated, please use ..."` (`:844-865`).

`init(callback, prepWorkers=true)` (`:579-674`): inits `TouchManager`, opens root `EyeView`, adds cache `GLOBAL_CACHE = 'global-gui'` (`:297`), loads `core://resources/audio/guiMap.json` then border textures from `core://resources/border/` into the cache. If `prepWorkers`, double-loads 3 `.crn` button atlases to warm Worker pool.

`changeView(options, onComplete?, onFailure?, onLoaded?)` (`:972-1100`) is the single entry point. `ChangeOptions` (`:66-76`): `{ remove?, removeAll?, removeTo?, removeToInclude?, leaveEmpty?, addView?: string|View|any, pause?:PauseOptions, transitionClose?:string, transitionOpen?:string }`. Promise pipeline interruptable via `ViewProcess.interrupt`.

---

## 6. `TouchManager` — `gui/TouchManager.ts`

Singleton (`:46-56`), created by `ViewManager` constructor (`ViewManager.ts:462`). Wraps `GestureManager` and dispatches gestures to the current `View` via PixiJS hit testing.

### `GESTURE` enum (`:22-28`)

```ts
export enum GESTURE {
    TAP = 'tap',
    SWIPE_DOWN = 'swipeDown',
    SWIPE      = 'swipeDown',   // alias
    SWIPE_UP   = 'swipeUp',
    PAN        = 'pan',
}
```

`THRESHOLD = 30` px (`:65`).

Tap registration (`createTapGesture`, `:503-519`) calls `gestureManager.addStageGesture(hammer.Tap, {event:TAP, time:5000, interval:0, threshold:30, touchAction:'manipulation'}, tapHandler)`.

### `tapHandler(gestureEvent)` (`:527-563`)

1. **y=358 touch-driver hack** (`:529-532`): if `pointers[0].clientY === 358`, `log.warn("Ignoring tap event for y coord = 358!")` and bail.
2. `Runtime.instance.globalEvents.shared.screenGesture.emit(GESTURE.TAP)`.
3. `log.info("received tap event", gestureEvent.eventType, pointers[0].clientX, pointers[0].clientY)` — this is the "received tap event undefined X Y" log; **`undefined` is `gestureEvent.eventType`**, because Hammer doesn't populate `eventType` on synthetic taps from `GestureManager.spoofGesture`.
4. `const currentView = this._viewManager.currentView; if (currentView && !currentView.inputLocked)` — **view-input-locked guard**: any in-flight transition will have called `currentView.lockInput(true)` (`ViewManager.ts:993`), dropping taps mid-transition.
5. **View-level dispatch**: if `currentView.isTouchInteractive && currentView.hasActions(GESTURE.TAP)` → `currentView.triggerActions(GESTURE.TAP)`.
6. **Otherwise PIXI hit-test dispatch**: `resetInput(clientX, clientY)` writes the tap coords into `this._interactionEvent.data.global`; `findTappedDisplay(currentView)` runs PIXI hit testing; if a component was hit, `_elementHit.triggerActions(GESTURE.TAP)`; then `resetInput(0,0)`.
7. If anything was `handled`, `Runtime.instance.face.views.disableMovement = true`.

`findTappedDisplay(currentView)` (`:571-582`) calls `_interactionManager['processInteractive'](_interactionEvent, currentView.stage, checkElementHit, true, true)`. `checkElementHit` (`:592-597`) sets `_elementHit = displayObject.parentElement` if the hit object has a `parentElement` property. `_interactionEvent` is a fake stand-in (`:222-226`): `{ data: { global: new PIXI.Point() } }`.

`createRequiredGestures(view)` (`:316-350`) walks the view's component tree; auto-registers `TAP` / `SWIPE_DOWN` if any component has actions on those gestures. `PAN` is never auto-added.

`onCoreTouchEvent` (`:440-477`) — real-Jibo only: for pans that *start outside* the touch surface, listens to raw mouse events on the canvas and re-emits through `gestureManager.spoofGestureWithOptions('pan', {...})`. Not used in sim mode.

---

## 7. `GestureManager` — `input/GestureManager.ts`

Thin wrapper around `HammerJS.Manager` bound to the renderer canvas. Top-of-file (`:5-8`):

```ts
let HammerJS;
if (electron) { HammerJS = require('hammerjs'); }
```

So in a pure-browser port, the import is skipped and `_hammerManager` will throw — must shim global `Hammer` or stub `electron` truthy.

Construction (`:140-153`): `GestureManager.init(renderer)` returns `new GestureManager(renderer)`; ctor does `this._hammerManager = new HammerJS.Manager(renderer.view)`.

Pan/Swipe constants (`:23-122`, all `static readonly string`): `PAN, PANSTART, PANMOVE, PANEND, PANCANCEL, PANLEFT, PANRIGHT, PANUP, PANDOWN, SWIPE, SWIPELEFT, SWIPERIGHT, SWIPEUP, SWIPEDOWN, TAP` (lowercase string values match Hammer event names).

`addStageGesture(hammerType, options, callback)` (`:195-217`): if event already registered, appends `callback` to `_hammerManager.handlers[event]`; else `new hammerType(options)`, `add(...)`, `.on(event, callback)`.

`removeStageGesture(g)` (`:224-229`): `_hammerManager.off(g.options.event); _hammerManager.remove(g)`.

### `spoofGesture(name='tap', x=0, y=0)` (`:238-241`)

```ts
public spoofGesture(gestureEvent:string = 'tap', xPos:number = 0, yPos:number = 0):void {
    this._log.info("spoofing gesture", gestureEvent.toLowerCase(), xPos, yPos);
    this._hammerManager.emit(gestureEvent.toLowerCase(),
        { pointers:[{clientX:xPos, clientY:yPos}]});
}
```

`spoofGestureWithOptions(name='tap', options={})` (`:249-251`): just `this._hammerManager.emit(gestureEvent, options)`.

### `spoofFullPanGesture(panLeft=true)` (`:258-274`)

Synthesizes a 3-step horizontal pan at y=310. With `pointers=[WIDTH*0.75, WIDTH*0.5, WIDTH*0.25]` and `movements=[-31,-198,-31]` (signs flipped if `!panLeft`), emits 3 `PAN` events with `{isFinal:false, srcEvent:{movementX:movements[i]}, pointers:[{x:val, clientY:310}]}`, plus a final `{isFinal:true, ...}` PAN after the last step.

`stop()` (`:170-172`) → `this._hammerManager.stop()`.

---

## 8. GUI gesture types + `ActionData` constants

`GESTURE` enum: see §6 (`TouchManager.ts:22-28`). `ActionData` (`gui/actions/ActionData.ts`) — every constant is a `static get`. String values + `ViewManager.actionHandler` effects:

- `CHANGE_VIEW` = `"changeView"` → `changeView(data.options, onComplete)` (`:767-775`).
- `OPEN_VIEW` = `"openView"` → build View from `data.viewType` or `data.configPath`, `changeView({addView, transitionOpen, transitionClose})` (`:779-823`).
- `CLOSE_VIEW` = `"closeView"` → `changeView({remove:true, transitionClose:DOWN, transitionOpen:DOWN})` (`:829-843`).
- `CLOSE_VIEW_EMPTY` = `"closeViewEmpty"` — deprecated; `{remove:true, leaveEmpty:true}` (`:844-855`).
- `CLOSE_ALL` = `"closeAll"` — deprecated; `{removeAll:true}` (`:856-860`).
- `CLOSE_ALL_EMPTY` = `"closeAllEmpty"` — deprecated; `{removeAll:true, leaveEmpty:true}` (`:861-865`).
- `CLOSE_ALL_OPEN` = `"closeAllOpen"` — deprecated; warns only (`:776-778`).
- `SWIPE_DOWN` = `"swipeDown"` — deprecated; `{remove:true, ...DOWN}` (`:824-828`). `SWIPE_UP` = `"swipeUp"` handled at View level. `SWIPE_RIGHT`/`SWIPE_LEFT` → `currentView.actionEnactor(action)` (`:866-872`).
- `GO_TO_BEGINNING` / `GO_TO_END` — List-component scoped.
- `EVENT` = `"event"` → View emits `data.event`. `SOUND` = `"sound"` plays by `id` or `src`.
- `UTTERANCE` → `MimManager.instance.handleSpeech.emit(data.utterance)` (`:873-882`). `VERBAL_COMMAND` → `actionEnactor(action)` (`:883-893`). `MIM_END` → `MimManager.instance.end.emit(data)` (`:894-897`). `MIM_SHOW_GUI` → `MimManager.instance.openGUI.emit()` (`:898-901`).
- `CALLBACK` = `"callback"` — code-only callback (`:414`).

`ActionData.createFromConfig({type, data})` (`:431-435`) builds an instance from JSON — how View JSON declares button actions.

---

## 9. Rendering tasks — `tasks/`

Exported from `tasks/index.ts:10-19`:

```ts
export default { ColorAlphaTask, TimelineTask, ShapesTask, TextureTask,
                 KeysTask, KeysDataTask, SpritesheetTask, CompressedImageTask };
```

Each extends `jibo-loader.Task` with a `static test(asset)` predicate and instance `start(callback)`.

**`KeysTask`** (`KeysTask.ts`). `test`: `type==="keys" && root && ((src && /\.keys$/i.test(src)) || data)` (`:47-50`). Loads `.keys` manifest (supplied as `data` or fetched by `KeysLoader.load`), parses asset declarations via `getAssetsFromKeys` (`:194-230`): `AudioEvent.file` → `{type:'sound', src:getAudioUri(...)}`; `Pixi` → `{type:'timeline', src:getTimelineUri(...)}`; `Texture` (if `PathUtils.isImage`) → `{type:'texture', src:getAssetUri(...)}`. Sub-loads, then `keys.addTimeline / addSound / addTexture` (`:165-181`). **Output**: `KeysData` (`{data, textures, sounds, timelines, assetPack}`).

**`KeysDataTask`** (`KeysDataTask.ts`). `test`: `type==="keys-data" && root && src && /\.keys$/i.test(src)` (`:24-27`). Calls `new KeysLoader(src, root, id).load(callback)` only — does NOT load referenced sub-assets. **Output**: raw KeysLoader JSON.

**`TimelineTask`** (`TimelineTask.ts`). `test`: `type==="timeline" && src && /\.js$/i.test(src)` (`:37-40`). Loads PixiAnimate `.js` library as **text**, evaluates via `vm.runInNewContext(result, {module:{exports:{}}, PIXI:PIXI})` after replacing `PIXI.Texture.fromFrame` with `timeline.getTexture.bind(timeline)` (`:94-117`) so the library captures a timeline-local frame fetcher. Walks `library.stage.assets` (`:162-209`): `.shapes.(txt|json)` → `{type:'shapes'}` → `timeline.addShapes`; `.png|.jpg|.gif|.dds|.crn` → `{type:'texture'}` → `timeline.addTexture`; `.json` → `{type:'spritesheet'}` → `timeline.addSpritesheet`. If `upload`, `timeline.upload(face, cb)`. **Output**: `Timeline` (with `library, textures, spritesheets, shapes`).

**`TextureTask`** (`TextureTask.ts`). `test`: `type==="texture" && src` (`:36-39`). Loads color (+ optional `asset.alpha` via `ColorAlphaTask.mergeAlpha`); wraps into `new PIXI.BaseTexture(image)` (sets `baseTexture.imageUrl = src`) then `new PIXI.Texture(baseTexture)`. If `upload`, `Runtime.instance.face.textureManager.updateTexture(texture)` (`:118-127`). **Output**: `PIXI.Texture`.

**`CompressedImageTask`** (`CompressedImageTask.ts`). `test`: `src && /(\.dds|\.crn)$/.test(src)` (`:33-36`). `.crn` → pooled `Worker(jibo://resources/workerJS/webgl-texture-util.js)` to uncrunch into `CompressedImage` (`:82-110`). `.dds` → XHR arraybuffer → `PIXI.compressedTextures.CompressedImage.loadFromArrayBuffer` (`:68-79`). **Output**: `PIXI.compressedTextures.CompressedImage` (consumed by `TextureTask` upstream).

**`SpritesheetTask`** (`SpritesheetTask.ts`). `test`: `type==="spritesheet" && src && /\.(json)$/i.test(src)` (`:35-38`). Loads the JSON (`meta.image`, `frames`), then loads `path.join(dirname(src), meta.image)` (so a `.crn` atlas image works). Wraps into `PIXI.BaseTexture`, optionally uploads. **Output**: `new Spritesheet(baseTexture, frames, meta.scale || 1)` (`:100`).

**`ShapesTask`** (`ShapesTask.ts`). `test`: `type==="shapes" && src && /\.shapes\.(json|txt)$/i.test(src)` (`:29-32`). `simpleLoad`, wraps into `new Shapes(id, results)` (`:51-61`). **Output**: `Shapes` (PixiAnimate vector geometry).

**`ColorAlphaTask`** (`ColorAlphaTask.ts`). `test`: `src && alpha && /\.(jpg|png|jpeg|gif)$/i.test(src) && /\.(png|gif)$/i.test(alpha)` (`:32-35`). `mergeAlpha` via canvas `destination-in` (`:53-68`): `ctx.drawImage(rgbImage, 0, 0); ctx.globalCompositeOperation = "destination-in"; ctx.drawImage(alphaImage, 0, 0)`. **Output**: `HTMLCanvasElement` usable as texture source.

---

## 10. `face.eye.CACHE_ID`

```ts
public readonly CACHE_ID:string = 'global-eye';
```
(`EyeContainer.ts:38-41`).

The loader cache key for **everything the eye loads**:

- `EyeContainer.init()` (`:131-144`): `loader.addCache(this.CACHE_ID)`, then loads default textures with `cache: this.CACHE_ID`.
- `AbstractLayer._loadTexture` (`AbstractLayer.ts:272-286`): `cache: this.eyeContainer.CACHE_ID` on every infix-DOF-triggered texture load.
- WebGL context-loss handler `FaceRenderer.ts:168` wipes it in one shot: `Runtime.instance.loader.deleteCache(this.eye.CACHE_ID)`.

Companion: `ViewManager.GLOBAL_CACHE = 'global-gui'` (`ViewManager.ts:297`) for GUI assets (button textures, border, sfx).

---

## Web-sim port notes

- PixiJS v4 required (`PIXI.WebGLRenderer`, `Container.processInteractive`, `compressedTextures` plugin, `prepare.TimeLimiter`, `Texture.fromFrame`).
- `HammerJS` import is gated on `electron`; port must shim global `Hammer` or stub `electron` truthy.
- `Runtime.instance.loader` must support `.addCache(id)` and `.load([{id, src, type, cache}], {complete:(err, results)=>...})` (`EyeContainer.init`, `:137-143`).
- `Runtime.instance.face.textureManager` must exist — `TextureTask` / `SpritesheetTask` upload calls `updateTexture` on it.
- DOF stream must include texture-infix string DOFs (`eyeTextureInfixBn_r`, `overlayTextureInfixBn_r`, `screenBGTextureInfixBn_r`) alongside numeric DOFs.
- `.crn` decompression spawns `Worker(jibo://resources/workerJS/webgl-texture-util.js)`; skip support and the worker is unused.
- `tapHandler`'s "received tap event undefined X Y" is `gestureEvent.eventType` printing `undefined` because `spoofGesture` doesn't set it — harmless.
