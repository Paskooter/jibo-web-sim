# 13 — `jibo-loader`, `jibo-kb`, `jibo-cai-utils`

Source-of-truth reference for the legacy asset-loading pipeline (`jibo.loader.*`),
the knowledge-base HTTP client (`jibo.kb.*`), and the cross-cutting promise/file/cache
helpers (`jibo-cai-utils`). Citations point at `/tmp/sdk/packages/...`.

---

## 1. Loader architecture

`LoaderPlugin` → `AssetManager` → `AssetLoad` → `Task[]`. One `AssetManager` owns the
registered `Task` definitions, a shared `AssetCache`, and two backend loaders:
`RemoteLoader` (XHR) and `LocalLoader` (`fs.readFile`).

`LoaderPlugin` (`jibo-loader/src/LoaderPlugin.ts`) constructs the `AssetManager`, seeds
the `'load-default'` named cache (`DEFAULT_CACHE`, lines 241-258), and pre-registers the
three generic tasks:

```ts
// LoaderPlugin.ts:261-263
this.register(LoadTask, 0)
    .register(ListTask, 5)
    .register(FunctionTask, 10);
```

`basePath`/`baseUrl` forward to `localLoader.basePath` / `remoteLoader.baseUrl`
(lines 403-424). `AssetManager.register` (lines 125-148) pushes onto `taskDefs` and
sorts **higher priority first** — `b.priority - a.priority`.

`AssetLoad.getTaskByAsset` (`AssetLoad.ts:547-563`) walks `taskDefs` and picks the first
`TaskClass.test(asset) === true`. **Higher priority = more specific.**

Effective priority table (after `RenderingPlugin.ts:11-19` and `SoundPlugin.ts:79`
register):

| Task                  | Pri | Task                | Pri |
| --------------------- | --: | ------------------- | --: |
| `SpritesheetTask`     |  90 | `ColorAlphaTask`    |  40 |
| `KeysDataTask`        |  81 | `TextureTask`       |  30 |
| `KeysTask`            |  80 | `CompressedImageTask` | 25 |
| `ShapesTask`          |  70 | `FunctionTask`      |  10 |
| `TimelineTask`        |  60 | `ListTask`          |   5 |
| `SoundTask`           |  50 | `LoadTask` (catch)  |   0 |

`loader.load({id, type, src, …}, cb)` flow: `LoaderPlugin.load` (lines 364-396)
normalizes string source to `{src, …}` and calls `AssetManager.load` (165-213) which
pools an `AssetLoad` and calls `load.setup(assets, options)`. `setup → addTasks →
addTask → getTaskByAsset` constructs `new TaskClass(manager, asset)`
(AssetLoad.ts:501-537). Three result shapes: `SINGLE_MODE=0`, `MAP_MODE=1`,
`LIST_MODE=2`. Throttle: `maxLoads` (default 4 from `AssetManager.maxDefaultLoads`).
`nextTask()` (570-647) marks one task `RUNNING`, either hits cache (`process.nextTick →
taskDone`) or calls `task.start(taskDone)`, then recurses while `numLoading < maxLoads`.

---

## 2. Built-in Task types

Every concrete task subclasses `abstract class Task` (`jibo-loader/src/tasks/Task.ts:45`).
Constructor: `constructor(manager, asset, fallbackId?)`. Required:
`static test(asset)` and `start(callback)`. Status constants `WAITING=0/RUNNING=1/FINISHED=2`.
`Task` records `cache/id/remote/timeout/format/original`, derives `cacheKey` via
`getCacheKeyFromAsset` (uses `asset.src` else `asset.id`, `AssetManager.ts:24-30`), and
defaults `needsCache=false`. Subclasses that *must* be cached (textures, timelines,
sheets, keys) set `needsCache = true`, and `AssetLoad.addTask` will
`console.error('Trying to load %o but it needs to be cached!')` if `cache:` is missing
(AssetLoad.ts:523-526). `Task.load(source, options)` (238-250) is the sub-loader
entrypoint tasks call inside `start`; pushes `load.tokens` into `this.subAssets` when
caching.

**LoadTask** (pri 0, `tasks/LoadTask.ts`) — catch-all. `test: !!asset.src` (40-43).
`start` → `manager.simpleLoad(src, cb, {remote, timeout, format})`. Result = whatever
`AbstractLoader.internalDone` post-processes to (§3 table).
**ListTask** (pri 5, `tasks/ListTask.ts`) — `test: !!asset.assets && (Array.isArray ||
isPlain)` (46-48). `start` recurses `this.load(this.assets, {complete, progress,
cacheAll, remoteAll})`.
**FunctionTask** (pri 10, `tasks/FunctionTask.ts`) — `test: !!asset.async` (37-40).
`start` calls `this.async(callback)`. Folds an async function into the loader's
progress/cache model.

### TextureTask (pri 30) — `jibo/src/rendering/tasks/TextureTask.ts`
`test: type === "texture" && !!src` (36-39). `needsCache=true`, forces `format='image'`.
`start` nested-loads `{_color, _alpha?}`, optionally calls `ColorAlphaTask.mergeAlpha`,
builds `new PIXI.BaseTexture(image)` and `new PIXI.Texture(base)`. If `asset.upload`,
calls `Runtime.instance.face.textureManager.updateTexture(texture)` (77-128).

### ColorAlphaTask (pri 40) — `jibo/src/rendering/tasks/ColorAlphaTask.ts`
`test: src && alpha && /\.(jpg|png|jpeg|gif)$/.test(src) && /\.(png|gif)$/.test(alpha)`
(32-35). `mergeAlpha(rgb, alpha, canvas?)` (53-68) draws RGB, sets
`globalCompositeOperation='destination-in'`, draws alpha → returns canvas.

### SoundTask (pri 50) — `jibo/src/sound/tasks/SoundTask.ts`
`test: !!src && /\.(mp3|m4a|wav|ogg|oga|aif)$/i.test(src)` (41-44). `useXHR =
asset.remote === true || PathUtils.isURL(this.src)` (97). Dedups by alias: same alias +
same src → returns existing; same alias + different src → warns + overwrites (110-125).
Then `soundPlugin.add(alias, {src, preload:true, block, loop, volume, panning,
autoPlay, useXHR, loaded: callback})` (127-137), and patches `sound.destroy` to also
call `soundPlugin.remove(alias)` (142-152).

### TimelineTask (pri 60) — `jibo/src/rendering/tasks/TimelineTask.ts`
`test: type === "timeline" && /\.js$/i.test(src)` (37-40). `needsCache=true`. Loads the
PixiAnimate JS **as text** and evals via `vm.runInNewContext` (79-108). Local override
during eval: `PIXI.Texture.fromFrame = timeline.getTexture.bind(timeline)` so the
library hits *this* timeline's frame map, then restored. `getAssets(timeline)` (161-209)
iterates `timeline.library.stage.assets`: `.shapes.(txt|json)` → `type:'shapes'` →
`addShapes`; `.png|.jpg|.gif|.dds|.crn` → `type:'texture'` → `addTexture(result, id)`;
`.json` → `type:'spritesheet'` → `addSpritesheet`. If `upload && Runtime.instance.face`,
calls `timeline.upload(face, cb)` before returning.

### ShapesTask (pri 70) — `jibo/src/rendering/tasks/ShapesTask.ts`
`test: type === "shapes" && /\.shapes\.(json|txt)$/i.test(src)` (30-32). Trivial:
`simpleLoad → new Shapes(this.id, results)` (51-61).

### KeysTask (pri 80) — `jibo/src/rendering/tasks/KeysTask.ts` ⭐ the .keys+assets chain
`test: type === "keys" && !!root && ((!!src && /\.keys$/i) || !!data)` (47-50).
`needsCache=true`. `start` runs an `async.waterfall`:

1. **Resolve & load.** Compute `keys.assetPack` by comparing
   `PathUtils.getProjectName(PathUtils.findRoot(path.resolve(this.src)))` to the current
   project name (non-empty only when they differ). Then
   `jiboKeyframes.getAnimFilePath(src, cb)` + `getAssetsFilePath(src, cb)`. If both
   exist, `fs.readFileSync(assetSrc)` synchronously; else `new KeysLoader(src, root,
   id).load(done)` (103-142).
2. **Convert to sub-asset list and recurse `this.load(assets)`.** `.assets` path →
   `convertAssetPaths(data, keys)` (232-254) rewrites each entry's `src` through
   `getAudioUri / getTimelineUri / getAssetUri` and stamps `cache`. `.keys` path →
   `getAssetsFromKeys(keys)` (194-230) walks every layer's keyframes, detects
   `AudioEvent` / `Pixi` (sub-timeline) / `Texture` and synthesizes `{id, type:
   'sound'|'timeline'|'texture', src, cache}` entries. These re-enter the manager and
   naturally pick `SoundTask` / `TimelineTask` / `TextureTask` by priority.
3. **Wire results back onto the KeysData** (166-181): `for (let id in results)` →
   `addTimeline` / `addSound` / `addTexture` based on `instanceof`. Returns populated
   `KeysData`.

### KeysDataTask (pri 81) — `jibo/src/rendering/tasks/KeysDataTask.ts`
`test: type === "keys-data" && !!root && /\.keys$/i.test(src)` (24-28). Skips the
sub-asset graph; only resolves the raw `KeysLoader.load(callback)` (37-44).

### SpritesheetTask (pri 90) — `jibo/src/rendering/tasks/SpritesheetTask.ts`
`test: type === "spritesheet" && /\.(json)$/i.test(src)` (35-38). `needsCache=true`.
`simpleLoad` the JSON, then nested-load `path.join(path.dirname(src), data.meta.image)`
(image may be compressed, so it routes through the manager), build
`new PIXI.BaseTexture(image)`, return `new Spritesheet(baseTexture, data.frames,
data.meta.scale || 1)` (66-103). `upload` calls
`Runtime.instance.face.textureManager.updateTexture(baseTexture)`.

### CompressedImageTask (pri 25) — `jibo/src/rendering/tasks/CompressedImageTask.ts`
`test: asset.src && /(\.dds|\.crn)$/.test(src)` (33-36). `.crn` (Crunch) spins up a
`Worker(Runtime.instance.utils.PathUtils.getAssetUri('jibo://resources/workerJS/
webgl-texture-util.js'))` and decodes off-thread (83). `.dds` does raw `XHR` with
`responseType='arraybuffer'` then `PIXI.compressedTextures.CompressedImage.loadFromArrayBuffer(
xhr.response, src)` (67-79).

---

## 3. LocalLoader — `fs.readFile` path

`LocalLoader` (`jibo-loader/src/loaders/LocalLoader.ts`) plugs `fs.readFile` into
`AbstractLoader`.

`prepare(uri)` (39-50): if not absolute and not `http(s)`/`file://`, route through
`PathUtils.getAssetUri(uri, undefined, this.basePath)` then `path.resolve`.

`internalLoad(type, uri, callback)` (60-97): `fs.readFile(uri, encoding, …)`. On error
`callback(createError(err, uri, 'Unable to read ${type} file at ${uri}'))`. On success:
`IMAGE` → builds `new Image()` with `src = data:${mimeType};base64,${data}`;
`JAVASCRIPT` → `require(uri)` (wrapped in try/catch); everything else falls through to
`internalDone`. Encoding: `IMAGE→'base64'`, else `'utf8'` (107-118). MIME map (7-14):
`jpg/jpeg→image/jpeg`, `gif`, `png`, `bmp`, `webp`.

File-type/result table (`AbstractLoader.getFileType` 184-218 + `internalDone` 94-116):

| Extension                            | FILETYPE     | Result                              |
| ------------------------------------ | ------------ | ----------------------------------- |
| `.jpeg/.jpg/.gif/.png/.webp/.bmp`    | `IMAGE`      | `HTMLImageElement` (base64 data URI)|
| `.json/.keys/.bt/.assets/.anim`      | `JSON`       | parsed object                       |
| `.xml/.svg/.html/.htm/.xhtml`        | `XML`/`SVG`/`HTML` | `Document` from `DOMParser`   |
| `.css`                               | `CSS`        | `HTMLStyleElement`                  |
| `.js`                                | `JAVASCRIPT` | `require(uri)` return               |
| anything else                        | `TEXT`       | raw string                          |

**Error format.** `AbstractLoader.createError` (80-83) wraps in `LoaderError`
(`errors/LoaderError.ts:23-46`):

```
LoaderError: Unable to read image file at /abs/path/foo.png: ENOENT: no such file or directory, open '/abs/path/foo.png'
```

`err.originalError = <fs.ENOENT>`, `err.request = '/abs/path/foo.png'`,
`err.name = 'LoaderError'`.

---

## 4. RemoteLoader — XHR path

`RemoteLoader` (`jibo-loader/src/loaders/RemoteLoader.ts`) is selected when
`PathUtils.isURL(uri)` or `options.remote=true` (`AssetManager.simpleLoad`/`prepare`
224-253). `prepare` (31-41) prepends `baseUrl` with a slash if neither side already has
one. `internalLoad` (51-93) picks a `Resource` subclass — `IMAGE → ImageResource`,
`BINARY → BinaryResource`, else `TextResource`. `onComplete` routes: `JAVASCRIPT` →
build `<script>` element (`innerHTML = result`, `dataset.url = url`); `IMAGE` →
callback raw `HTMLImageElement`; otherwise `this.internalDone(type, url, result, cb)`
for JSON/XML/CSS/SVG/HTML parsing. Used by SDK / skill-upload flows; in the simulator
it's the path for HTTP audio proxy and remote asset packs.

---

## 5. Asset path resolution (`jibo-plugins/PathUtils`)

Single source of truth for `asset-pack://foo/bar` syntax. Token is `'://'`
(`PathUtils.ts:19`). Both `findRoot` and `_getAssetUri` memoize (`findRootCache`,
`getAssetUriCache`; key is `fileName + '###' + assetPack + '###' + resourceRoot`).

Signatures:

```ts
// PathUtils.ts:113-119
static getAssetUri(fileName:string, assetPack:string = '', resourceRoot?:string):string
// PathUtils.ts:161-164
static getAudioUri(fileName:string, currentAssetPack:string = '', resourceRoot?:string):string
// PathUtils.ts:174-177
static getTimelineUri(fileName:string, currentAssetPack:string = '', resourceRoot?:string):string
// PathUtils.ts:190-193
static getAnimationUri(fileName:string, currentAssetPack:string = '', resourceRoot?:string):string
```

`_getAssetUri` policy (121-151) — try in order: (1) absolute paths, (2) specific asset
pack via `resolveAssetPack(assetPack)`, (3) provided `resourceRoot`, (4) non-specific
pack via `resolveAssetPack`, (5) fallback `findRoot()` of cwd. Returns
`path.join(resourceRoot, fileName)`. The `://`-split also strips the pack prefix from
`fileName` first when present.

`getAudioUri` / `getTimelineUri` / `getAnimationUri` inject `'audio'` / `'timelines'` /
`'animations'` via `setDefaultPath` (85-92) and forward to `getAssetUri`.
`setDefaultPath` is pack-aware: `pack://x.wav` becomes `pack://audio/x.wav`, not
`audio/pack://x.wav`.

`resolveAssetPack` (226-248): `'project'` → `getPackagePath()` (project root);
`'core'`/`'jibo'` → dirname of `PathUtils.resolve('jibo/package.json')`; else dirname of
`PathUtils.resolve(name + '/package.json')` (Node `Module._resolveFilename`, 203-218).

How `resourceRoot` + `assetPack` combine in practice: `KeysTask` stores `keys.root`
(passed in via the asset spec) and `keys.assetPack` (computed by comparing the keys
file's own project root to the current project — non-empty only when they differ).
Sub-asset specs are then `PathUtils.getAudioUri(file, keys.assetPack, keys.root)` etc.,
so in-project assets resolve via `keys.root` and cross-package ones route via the named
pack.

---

## 6. KnowledgeBase WebClient

`WebClient` (`jibo-kb/src/WebClient.ts`) is the HTTP-driven subclass of
`KnowledgeDatabase`, replacing `load/loadList/loadRoot/save/remove/getDirectory`.
Constructor (53-56) strips trailing slash from `httpUrl`. `_makeUrl` (227-230):
`${httpUrl}/v1/kb/${querystring.escape(kbName)}${addPath}`.

Endpoints:

| Method                 | HTTP                                        | Notes                                  |
| ---------------------- | ------------------------------------------- | -------------------------------------- |
| `load(id, cb)`         | `GET  /v1/kb/<kb>/node/load/<id>`           | → `createNodeFromObject(res.data)`     |
| `loadList(ids, cb)`    | `POST /v1/kb/<kb>/node/load` body=ids[]     | 400 fallback: `async.map(ids, this.load.bind(this), cb)` for legacy SSM |
| `loadRoot(cb)`         | `GET  /v1/kb/<kb>/node/loadRoot`            |                                        |
| `save(node, cb)`       | `POST /v1/kb/<kb>/node/save` body=node JSON |                                        |
| `remove(idOrNode, cb)` | `DELETE /v1/kb/<kb>/node/remove/<id>`       |                                        |
| `getDirectory()`       | returns `_makeUrl()`                        | used as root for `createAsset`         |

Error wrap `_processError` (38-50): `Error('HTTP Error Code ${status}${responseData}')`
or `'No response received'` / `'Unknown error'`.

**Node shape** (`jibo-kb/src/Node.ts:33-110`):

```ts
public _id:string;          // v4 uuid (defaulted)
public type:string;         // defaulted 'node'
public data:any;            // arbitrary skill data
public created:number;      // ms since epoch
public updated:number;
public edges:{[layer:string]: string[]};   // edges grouped by layer name
public assets:{[subtype:string]: string[]};// assets grouped by subtype
public getKb:() => KnowledgeDatabase;      // bound via setKb()
```

Edges grouped by **layer name** (string). `addEdges(idsOrNodes, layer?)` infers
`layer = node.type` when passed `Node` objects (`_resolveIdAndLayer` 418-433).
`getEdges(layers)` returns deduped IDs across the layer set (214-226).

**KnowledgeBase singleton (`jibo.kb`)** constructor (`KnowledgeBase.ts:103-120`)
registers `('jibo/loop', LoopModel)`, `('user', UserNode, 'jibo/loop')`, `('jibo/robot',
RobotModel)`, `('root', RobotRootNode, 'jibo/robot')`. `init(service, cb)` sets
`httpUrl = 'http://' + host + ':' + port` and creates `this.robot =
createModel('/jibo/robot')` (130-139). Slice CRUD over HTTP:
`POST /v1/kb/<name>/create`, `GET /v1/kb/<name>/exists`,
`DELETE /v1/kb/<name>/remove/yesiamsure`, `DELETE /v1/removeall/yesiamsure`.

---

## 7. KB slices / models

### `kb.loop` — `LoopModel` (`jibo-kb/src/LoopModel.ts`)

Subclass of `Model`. Opens `WSClient(httpUrl)`, listens for `'LoopUpdated'`, emits
`events.loopUpdated` (547-567). All methods `@promisify`-decorated.

| Method                                | What it does                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `loadLoop(cb)`                        | `loadLoopAll` then filter out `status === 'declined'\|'removed'` (110-119)                |
| `loadLoopAll(cb)`                     | `loadRoot` → `root.getEdges('user')` → `this.load(userIds)` (174-188)                     |
| `getUserNodeById(id, cb)`             | `loadLoop` + `find(node => node.id === id)`                                                |
| `getWrittenNameById` / `getSpokenNameById` | call `getUserNodeById` then `user.getWrittenName()` / `user.toString()` (phonetic)    |
| `setPhoneticName(idOrNode, name, cb)` | `POST ${httpUrl}/v1/loop/updatePhoneticName` body `{loopId, id, phoneticName}`            |
| `setEnrollment(params, cb)`           | `POST ${httpUrl}/v1/loop/enrollment` body `{loopId, id, face?, voice?}`                   |
| `suspend(cb)`                         | `POST ${httpUrl}/v1/loop/suspend` body `{loopId}`                                          |
| `hasKeyBackup(cb)`                    | `GET  ${httpUrl}/v1/loop/hasKeyBackup/${loopId}` → `res.data.hasKeyBackup`                 |
| `fetchLoop()` / `fetchLoopAll()`      | Synchronous cache reads (`fetchRoot().getEdges('user')` → `fetch(...)`)                    |

`root.data.id` of `/jibo/loop` is the **loop id** cloud calls require.

### `kb.media` — `MediaModel` (`jibo/src/services/media/MediaModel.ts`)

Attached as `jibo.kb.media` by the media service (registration in `KnowledgeBase.ts` is
commented out — service installs its own). Subclass of `Model`. Opens `WSClient`,
listens for `'MediaListChanged'`, emits `events.mediaListChanged`. `storePhoto`
(255-270): `POST ${httpUrl}/v1/media/storePhoto` body=data, returns `{id, thumbnails}`.
Server-side is `skills-service-manager/src/services/kb/MediaListManager.ts:134-…`
(emits `'_storePhoto'` at 459). `MediaNode` (`jibo/src/services/media/MediaNode.ts`)
extends `Node` with `id`, `loopId`, `url`, `getThumbnailId(type)`.

### `kb.identity` / "looker" info

**No separate slice/model exists.** Looker info is exposed via `kb.loop`'s
`getUserNodeById` / `getWrittenNameById` / `getSpokenNameById` and `UserNode` methods.
Runtime systems (perception, autobot, dialog) source the "current looker id" from
runtime state and resolve against `kb.loop`.

### Other slices registered

`/jibo/loop` → `LoopModel`, `user`-typed nodes → `UserNode`.
`/jibo/robot` → `RobotModel`, `root`-typed nodes → `RobotRootNode`.
`/jibo/media` reserved; consumed by service-attached `MediaModel`.

---

## 8. `FileUtils.readFile` — open/fstat/read-chunks/close

```ts
// jibo-cai-utils/src/main/FileUtils.ts:47-87
/** fs.readFile doesn't ensure closing file descriptors and can run
 *  out of allowed maximum number of open files */
static async readFile(filePath: string, encoding='utf8', chunkSize=512): Promise<string> {
    let fd = await prify<number>( h => fs.open(filePath, 'r', h) );
    let buffer: any; let bufferSize: number;
    try {
        const stats = await prify<fs.Stats>(h => fs.fstat(fd, h) );
        bufferSize = stats.size;
        buffer = new Buffer(bufferSize);
        let bytesRead = 0;
        while (bytesRead < bufferSize) {
            let chunkSizeToUse = chunkSize;
            if ((bytesRead + chunkSize) > bufferSize)
                chunkSizeToUse = (bufferSize - bytesRead);
            await prify( h => fs.read(fd, buffer, bytesRead, chunkSizeToUse, bytesRead, h) );
            bytesRead += chunkSizeToUse;
        }
    } catch (error) { throw error; }
    finally { await prify( h => fs.close(fd, h) ); }
    if (buffer) return buffer.toString(encoding, 0, bufferSize);
}
```

**Why:** Node's `fs.readFile` doesn't deterministically close fds before yielding.
Under heavy parallel load (animation cache warm-up) the process hit `EMFILE: too many
open files`. Explicit `open → fstat → loop(read) → close-in-finally` guarantees fd
return when the promise resolves; 512-byte chunked read also keeps per-call heap
bounded. `FileUtils.findAllFiles` (114-161) extends the same pattern with
`async-parallel.invoke(generators, maxConcurrent=50)` for recursive walks.
`FileUtils.onRobot()` (166-168) returns the cached
`fs.existsSync('/var/jibo/identity.json')` flag.

---

## 9. `PromiseUtils.timeout` — exact algorithm

```ts
// jibo-cai-utils/src/main/PromiseUtils.ts:142-152
static timeout<T>(promise, timeoutMs, errorMessage?): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timeoutHandle = setTimeout(() => {
            reject(new Error(errorMessage || `Timeout of ${timeoutMs}ms`));
        }, timeoutMs);
        promise
            .then(data  => resolve(data))
            .catch(error => reject(error))
            .then(() => clearTimeout(timeoutHandle));
    });
}
```

**Semantics:** This version always **rejects** on timeout. There is **no `timeoutValue`
option** — the function unconditionally rejects with `Error('Timeout of ${timeoutMs}ms')`
or the caller-supplied `errorMessage`. The `resolve(timeoutValue) vs reject` choice
doesn't exist in this build; callers wanting "resolve a default on timeout" wrap with
`.catch(() => defaultValue)`. Inner promise rejection passes through unchanged. The
trailing `.then(() => clearTimeout(timeoutHandle))` runs on **both** branches, so the
timer is always cleaned up.

Other helpers same file: `promisify(func, firstParamError=true)` wraps `(err,data)` or
single-arg callbacks as Promise (74-105); `to(promise)` returns `[err, data]` (114-118);
`promisifyTo = to(promisify(...))` (128-130); `firstToSucceed(promises)` resolves with
first success, rejects with errors[] if none (50-65).

---

## 10. `ExtPromiseWrapper` — externalized resolve/reject

```ts
// jibo-cai-utils/src/main/ExtPromiseWrapper.ts:1-24
export class ExtPromiseWrapper<T> {
    public resolve: (data: T) => void;
    public reject:  (error: Error | string) => void;
    public promise: Promise<T>;
    constructor() {
        this.promise = new Promise<T>((resolve, reject) => {
            this.resolve = resolve;
            this.reject  = reject;
        });
    }
}
```

Used throughout the action system / behavior tree to bridge event-driven "some future
callback will settle this" code into Promise consumers. Await `wrapper.promise`; whoever
owns the wrapper later calls `wrapper.resolve(x)` or `wrapper.reject(e)`.

---

## 11. `CacheUtils.GlobalCacheName` — global vs per-skill cache

```ts
// jibo-cai-utils/src/main/CacheUtils.ts:1-23
export class CacheUtils {
    static GlobalCacheName = 'global';
    static initialized = false;
    static initGlobalCache(jibo: any): void {
        jibo.loader.addCache(CacheUtils.GlobalCacheName);
        CacheUtils.initialized = true;
    }
}
```

`AssetCache` supports multiple **named caches** (`addCache`, `emptyCache`, …) plus a
single `activeCache` (default `'load-default'`, `LoaderPlugin.ts:241-242`). Skills load
into their own named cache so `unloadAll(skillName)` cleans only that skill's assets.

`'global'` is the shared bucket, initialized in
`jibo-embodied-dialog/src/EmbodiedDialog.ts:64` via `CacheUtils.initGlobalCache(jibo)`.
Used for assets that outlive any single skill — backchannel animations, head-touch
reactions, expression-system pre-warmed timelines. Call sites:
`jibo-embodied-dialog/src/speech/EmbodiedSpeech.ts:152` (load),
`speech/timelines/TimelineManager.ts:834`,
`listen/EmbodiedListen.ts:121-125, 613`,
`jibo-action-system/src/action/actions/HeadTouch.ts:134` (`jibo.loader.cached(path,
CacheUtils.GlobalCacheName)`), `jibo-emotion-system/src/expression/ExpressionSystem.ts:154`.

Pattern: at boot, push canonical/shared assets into `'global'` once; at runtime, read
back with `jibo.loader.cached(id, CacheUtils.GlobalCacheName)` instead of re-loading.

---

All file:line citations are inline above; no separate index needed.
