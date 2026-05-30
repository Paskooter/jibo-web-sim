# Simulator Renderer (BrowserWindow) — Reverse Engineering Reference

Source tree: `/tmp/sdk/packages/jibo-cli/`. All `file:line` cites are from there. Absences are called
out explicitly. The renderer is the Electron `BrowserWindow` that loads `simulator/index.html`. Inside
that page, `<script>global.realThree = true; require('./client');</script>`
(`simulator/index.html:38-41`) boots `src/simulator/client/index.tsx`. The renderer hosts the SSM
Factory **in process** (`index.tsx:269`), mounts React, drives the 3D body + iframe homography, and
forwards a small set of channels to the Electron main. Companion doc 01 covers the main process; this
doc is only the DOM/React/three stack.

---

## 1. Renderer entry — `index.tsx`

Static DOM tree from `simulator/index.html:9-37`: `#toolbar`, `#container > {#visualizer, #face >
#faceContent > {#loader, #notifications, <webview id="skill" partition="persist:jibo-skill"
nodeintegration width=1280 height=720 min/max=1280×720 style="position:absolute;
display:inline-flex">}}`, `#sidebar`. `#notifications` lives **inside the face quad** so it rides the
homography (`client.less:458-490`).

Boot in `index.tsx`:

1. `let registryPort = ipc.sendSync('get-registry-port');` (`:45`).
2. `async.series` (`:258-313`):
   - **Step 1** (`:259-276`): resolves `skills-service-manager` + `jibo-cli`, reads
     `configs/ssm.json`, overrides `RegistryService.port` (`:266`) and
     `SkillsServiceSim.skillsBaseDir = dirname(skillPath)` (`:267-268`), `new Factory(config,
     rootDir).init(...)`. On init: `ipc.send('registry-init',
     'http://127.0.0.1:${RegistryClient.instance.port}/registry')` (`:271-272`).
   - **Step 2** (`:277-286`): `new KnowledgeBase()` at `KBService.instance.port`, `kb.initLoop() +
     kb.initMedia()`.
   - **Step 3** (`:287-308`): `kb.loop.loadLoop` → `RobotInfo.createInfo(new JiboConfig(), ...)` →
     `React.render(<View robotInfo loop/>, #sidebar)` + `React.render(<Notifications/>,
     #notifications)`. `window.chatView` stashed for DevShell (`:296`).

**React mounts only into `#sidebar` and `#notifications`** at boot; toolbar gets its own
`React.render(<Toolbar/>, #toolbar)` inside face-on-body (`face-on-body.tsx:322-328`). No single
root.

Root `<View>` (`index.tsx:53-119`): state `{currentView:'chat'}`; `componentWillMount` makes
`this.reloadWatcher = new EventEmitter()` and `ipc.sendSync('get-simulator-settings')` (`:60-64`).
`render()` emits `<TabBar/> <ChatView/> <LpsView/> <AdvancedView/>` (`:103-119`); the AdvancedView is
wrapped in literal `// @if DEBUG ... // @endif` JSX comments stripped by a bundler step in non-debug
builds. Tab labels/icons: `Chat`/`fa-comment`, `LPS`/`fa-compass`, `Advanced`/`fa-cog` (`:67-95`).

`componentDidMount` (`:130-250`):

- `LPSService.instance.on('update', () => this.forceUpdate())` (`:131-136`).
- Grabs `#container`, `#face`, `#visualizer`, `#skill` (`:153-159`) and calls
  `faceOnBody.init(robotInfo, createRobotRenderer, container, face, visualizer, onSettingsChanged,
  cb)` (`:161`). `const createRobotRenderer = visualize.createRobotRenderer;` is captured at module
  top (`:33`) before any skill loads — otherwise `jibo.wrapVisualize` rewires the signature and
  drops `robotInfo` (`:29-33`, real bug they hit).
- In cb: `ipc.on('reload-skill', () => webview.reloadIgnoringCache())` (`:168-170`); webview
  `did-start-loading` → set `face.className='loading'`, `reloadWatcher.emit('reload')`,
  `webviewWhiteScreenWorkaround(webview)` (`:172-180`); `ipc.on('toggle-dev-tools', (s, show) =>
  show ? webview.openDevTools() : webview.closeDevTools())` (`:187-195`); `dom-ready` →
  `webview.insertCSS('html{min-width:1280px;min-height:720px;} body{min-width:1280px;
  min-height:720px;margin:0;overflow:hidden;}')` (`:216`); `BodyService.instance.on('update', dofs
  => robotRenderer.display(dofs))` (`:241-246`); finally `webview.src = ipc.sendSync('get-
  skill-path');` (`:247`).
- Once per Jetstream instance: `JetstreamServiceSim.instance.events.hjHeard.on(() =>
  LPSService.instance.triggerSimulatedHJEvent())` (`:229-235`); `lastJetstreamInstance` guard
  reattaches on skill reload.

`onWords(wordOptions)` (`:252-254`) forwards to `JetstreamServiceSim.instance.onWordsReceived(...)`
— the path from chat input into the runtime.

`webviewWhiteScreenWorkaround(webview)` (`:321-329`) zeroes the webview's width/height during load,
restores 1280×720 on `did-finish-load`. Comment at `:316-320` admits they don't know why this fixes
the white-screen-on-first-load bug.

---

## 2. Visual layout

`<body>` is `margin:0; overflow:hidden; background:#151517; color:#fff; font-size:12px`
(`client.less:5-12`). Four absolute-positioned root regions:

- **`#toolbar`** (`width:40px; height:100%; z-index:1` — `client.less:18-22`): left 40 px strip
  owned by Toolbar.
- **`#tabBar`** (`left:-40px; top:0; z-index:2` — `client.less:24-28`): three tab buttons rendered
  into `#sidebar` but visually offset 40 px left into the toolbar column.
- **`#container`** (`position:absolute; height:100%; right:400px` — `client.less:120-152`): the
  body+face area; 400 px reserved on the right. Class toggles:
  - `.view2d` → `left:0; overflow:auto`, hides `#visualizer`, applies
    `translate(-50%,-50%); top:50%; left:50%; margin:auto` so face centers (`:124-139`).
  - `.view3d` → `overflow:hidden; left:40px`, both `#visualizer`/`#face` are absolute (`:140-146`).
  - `.loading` → both hidden (`:147-151`).
- **`#visualizer`**: the THREE.js body; sized in JS per viewMode (`face-on-body.tsx:61-64, 278-279`).
- **`#face`**: 1280×720+ε projection target with the webview. `.loading` shows `#loader` overlay
  (`client.less:153-167`, `background-image: url('../images/loader.gif')`).
- **`#faceContent`** (`width:1280; height:720; position:absolute; overflow:hidden` —
  `client.less:168-173`): zoom container; `transform:scale(zoomFactor)` in 2D mode
  (`face-on-body.tsx:253`).
- **`#sidebar`** (`position:absolute; right:0; height:100%; width:400px` — `client.less:191-213`):
  right pane with TabBar+ChatView+LpsView+AdvancedView. In `.view2d`, hides `.tools` and
  `.lps-pane`, forces `.chat-pane` visible — 2D is implicitly chat-only.

**No body image/SVG/PNG.** The body is the three.js mesh from `visualize.createRobotRenderer` only.
The renderer sets background `(0.25, 0.25, 0.25, 1.0)` and grid `(0.05, 6, rgb(128,128,128))`
(`face-on-body.tsx:234-235`). Notifications use PNGs `assets/images/{message,battery,alarm,
twitter}.png` (`notifications-view.tsx:45`). Palette: `darkBackground:#1d1e21; bodyBackground:#151517;
buttonColor:#383A3F; selectColor:#5261ed; selectTextColor:#d5d5d5; dividerColor:#3b3c3e`
(`styles/colors.less:1-6`).

---

## 3. face-on-body math — the homography

Runs as a `_postRenderCallbacks` hook every body-render frame (`face-on-body.tsx:142-174`); skipped
when `settings.viewMode !== '3d'` (`:144-146`).

**A. Locate the screen mesh** — hardcoded child-index chain (`face-on-body.tsx:149`):

```
149: let screenObject = this.robotRenderer.scene._scene.children[4]
150:   .children[0].children[1].children[1].children[0].children[2].children[0],
```

Brittle (no name lookup). A web port should use `scene.getObjectByName(...)`.

**B. Project bbox → viewport pixels** — `getScreenPositions(THREE, obj, camera)` (`:394-430`):

```
395: let widthHalf = 0.5 * (window.innerWidth - dims.CHAT_WIDTH);
396: let heightHalf = 0.5 * (window.innerHeight);
402: corners3d = [
403:   // TL (max.x, max.y, max.z), TR (min.x, max.y, max.z),
405:   // BL (max.x, min.y, min.z), BR (min.x, min.y, min.z)
410: ];
412: vector = corners3d[i].applyMatrix4(obj.matrixWorld); vector.project(camera);
414: vector.x = vector.x * widthHalf + widthHalf;
415: vector.y = -vector.y * heightHalf + heightHalf;
416: corners2d.push({x: Math.floor(vector.x), y: Math.floor(vector.y)});
```

Corner pattern: TL/TR off `max.z`, BL/BR off `min.z`; X is "inverted" so `max.x` is on the left
(model-specific authoring). Viewport width subtracts `CHAT_WIDTH = 400` (`dimensions.ts:9`).

**C. Homography → `matrix3d`** — `transform2d(elt, x1,y1,...,x4,y4)` (`:497-510`):

```
497: function transform2d(elt, x1, y1, x2, y2, x3, y3, x4, y4) {
498:   let w = elt.offsetWidth-dims.SCREEN_EPSILON, h = elt.offsetHeight-dims.SCREEN_EPSILON;
499:   let t = general2DProjection(0,0,x1,y1, w,0,x2,y2, 0,h,x3,y3, w,h,x4,y4);
500:   for(let i = 0; i != 9; ++i) t[i] = t[i]/t[8];
501:   t = [t[0], t[3], 0, t[6],
502:        t[1], t[4], 0, t[7],
503:        0,    0,    1, 0,
504:        t[2], t[5], 0, t[8]];
505:   t = "matrix3d(" + t.join(", ") + ")";
506:   elt.style.transform = t; // also -webkit-/-moz-/-o-
510: }
```

**Source square**: `(0,0)→(w,0)→(0,h)→(w,h)` with `w = offsetWidth − 2`, `h = offsetHeight − 2`
(`SCREEN_EPSILON = 2` — `dimensions.ts:8`). **Destination quad**: the four projected pixel corners
in TL, TR, BL, BR order. The 3×3 projective matrix is normalized by `t[8]` and rewritten as a 4×4
column-major CSS `matrix3d`.

**D. Projective math** (`:439-492`):
- `adj(m)` — 3×3 adjugate (`:439-445`).
- `multmm(a,b)` / `multmv(m,v)` — 3×3 mat·mat and mat·vec (`:446-465`).
- `basisToPoints(x1,y1,...,x4,y4)` (`:470-482`): `v = adj(m)·[x4,y4,1]; return m·diag(v)`.
- `general2DProjection(...src..., ...dst...)` (`:483-492`): returns `multmm(d, adj(s))` — composes
  src→dst.

Source: math.stackexchange answer cited in file header (`:1-7`).

**E. Backface culling** — `shouldBackFaceCull(corners2d)` (`:365-392`) swaps entries 2,3 (clockwise
TL,TR,BR,BL), shoelace signed area, returns `signedArea < 0`. Effect: `face.style.zIndex =
shouldBackFaceCull(...) ? "-1" : "0"` (`:173`) — sinks the iframe but does **not** `display:none`
it.

**Camera presets** (`:16-32, 340-348`): `viewFront` and `viewReset` identical (pos `(0.5,0,0.35)`,
lookat `(0,0,0.15)`, fov 45); `viewTop` (pos `(0,0,1)`, same lookat/fov).

**Debug overlay** — `debugMode = false` (`:40`); when flipped, four colored corner dots
(red/green/purple/blue) track the projected corners (`:118-140, 158-162`).

---

## 4. Iframe mounting

The "skill iframe" is an Electron `<webview>` (`simulator/index.html:21-33`), not a plain `<iframe>`.
Attributes: `id="skill"`, `partition="persist:jibo-skill"` (persistent storage/devtools),
`width/height/min/max = 1280×720` (locks size; `autoresize=on` is a no-op), `nodeintegration` (skill
can `require` SSM clients directly), no `sandbox`/`preload`/`webpreferences`. `src` set
imperatively: `webview.src = ipc.sendSync('get-skill-path');` (`index.tsx:247`), where main returns
the skill's `index.html` absolute path (doc 01).

**Positioning.** 3D mode: webview inside `#faceContent` inside `#face`; `#face` carries the
matrix3d. 2D mode: `#faceContent` carries `transform:scale(zoomFactor)` (`face-on-body.tsx:253`) and
the face is plain `1282×722` centered via margin math (`:202-218, 260-272`).

**Z-ordering.** `#visualizer` and `#face` are absolute siblings inside `#container`
(`client.less:140-146`); `#face.zIndex` flips 0↔-1 via the backface-cull check (`:173`).
`#notifications` (`z-index:10` — `client.less:464`) and `#loader` (`z-index:10` —
`client.less:155`) are siblings of the webview inside `#faceContent` and overlay it.

**Visibility.** `.loading` class on `#container`/`#face` set on boot (`:57`, `index.tsx:174`) and
every `did-start-loading` (`:172-174`); cleared on `dom-ready` via `face.className = ""` (`:227`).
The white-screen workaround zeroes width/height during load (`index.tsx:321-329`).

**Renderer↔skill IPC.** **No `postMessage` and no `'message'` listener anywhere** in
`src/simulator/client/`. Skill comms flow through SSM Registry HTTP + per-service WS (docs 03-04);
`nodeintegration` lets the skill `require` SSM clients in-process.

---

## 5. Host-side services (`client/services/`)

Just one file. Excluded from `tsconfig.json:18`.

- **`nlu-service.ts`** — wraps a native NLU parser addon at `parser/build/Release/jsjibonlu.node`
  (renamed from `.jibo` on first run — `:6-11`). HTTP server on ephemeral port responding to POSTs
  at `/nlu_interface` with `REQ_TYPE ∈ {COMPILE, PARSE_FROM_URI, PARSE_FROM_TEXT, PARSE_FROM_FILE}`
  (`:52-80`). Drives `nlu.compile_fst_from_text / build_sentence_parser / read_fst_from_uri`.
  **Not imported anywhere**; dead/legacy. Live NLU is SSM's `NLUService` (doc 04). No Registry
  record from the renderer side.

The renderer's actual "service stack" is the SSM Factory itself, constructed in process at
`index.tsx:269`. `TTSService`, `BodyService`, `LPSService`, `JetstreamServiceSim`,
`NotificationsService`, `RegistryClient`, `KBService` are imported from `'skills-service-manager'`
and used directly by views (`index.tsx:7-15`, `chat-view.tsx:2`, `asr-view.tsx:5`,
`lps-view.tsx:4`, `notifications-view.tsx:2`, `advanced-view.tsx:3`).

---

## 6. Views, elements, react-components

**Views (`client/views/`):**

- **`toolbar.tsx`** — mounted in `#toolbar` (`face-on-body.tsx:322-328`). Top buttons `id="audio"`
  (FA `fa-microphone`) and `id="target"` (FA `fa-dot-circle-o`); click → `props.setMode(target.id)`
  (`:35-38`) sets `face-on-body.mode`. Bottom: `fa-video-camera` opens popup with **Top / Front /
  Reset**; click → `props.setCamera(target.id)`. Outside-click dismissal walks DOM up looking for
  `id == 'viewTrigger'` (`:11-22`).
- **`react-components/tab-bar.tsx`** — three tab buttons; tracks `state.activeTab`, applies
  `.selected`; calls `tab.callback(i)` switching the root View's `currentView` (`:11-26`).
- **`chat-view.tsx`** — wraps `<MessagesList/>` + `<AsrView/>` (`:67-77`). Subscribes to TTSService
  events `speech`, `token`, `sending-tokens`, `stop` (`:16-34`) and pipes them into MessagesList.
- **`messages-list.tsx`** — `.chat-messages` scroller of `<ChatMessage/>` (`:66-83`). Auto-scrolls
  when `scrollTop + offsetHeight + 15 >= scrollHeight` (`:54-57`). Listens
  `reloadWatcher.emit('reload')` and inserts a session break (`:13-16`). `appendMessage` filters TTS
  markup `/pau/`, `<break>`, `<audioBreak>`, `<say-as>`, `[lpau]` (`:36-38`).
- **`chat-message.tsx`** — bubble + author label; `author === 'jibo'` adds `.jibo`
  (left-align styling at `client.less:244-254`).
- **`asr-view.tsx`** — bottom-pinned `.asr-input`, speaker `<select>` from `props.loop`
  (`:108-119`), Instant/Incremental TTS radios (`:139-162`). On Enter: strips
  `[|&;$%@"#<>()+,?.]` (`:31`), `props.onWords({words, final:true, speaker, speakerId})` (`:39`) →
  `JetstreamServiceSim.instance.onWordsReceived`. On Space: `incremental:true` partial (`:42-45`).
  Up/Down step through input history (`:48-60`). Speaker change → `ipc.send('set-speaker-id', id)`
  (`:76`). Radios: `TTSService.instance.setMode(mode) + ipc.send('set-tts-mode', mode)` (`:83-89`).
- **`lps-view.tsx`** — Add Target → `LPSService.instance.updateTarget({id, x:0.2, y:0, z:0.2})`
  (`:78-86`). Lazy-builds `MouseTargetPositioner` from `animation-utilities` (`:21-53`); filters:
  match=`altKey && !metaKey && !ctrlKey`, ground=`shiftKey`, camera=`!shiftKey` (`:31-44`); position
  changes → `LPSService.instance.updateTarget(target)` (`:45-51`). Subscribes `audio-event-start/end`
  on LPSService and creates/dims/scales-down AudioEvent spheres (`:55-76`). Inline markdown
  instructions (`:128-132`).
- **`audio-event.ts`** — wraps `THREE.SphereGeometry(0.1, 32, 32)` + red MeshBasicMaterial added to
  the visualizer scene at click coords (`:27-36`). `startScaling(cb)` ticks 100 ms shrinking by 0.05
  until zero, removes (`:43-66`). `setColor/setOpacity/updateType/Confidence/Ts/setName` mutators
  (`:71-108`). On new audio-event-start, all existing spheres dim to white 0.5 opacity
  (`lps-view.tsx:62-66`).
- **`target-view.tsx`** — `.lpsTarget` row. Reads `target.parts[0].value.rays[0].dir`
  (`.toFixed(5)`) for x/y/z (`:36-40`). Remove btn (FA `fa-times`) → `props.removeTarget`; row
  click → `props.onClick(id)` selects.
- **`advanced-view.tsx`** — Backup/Restore/Wipe. Each → `backupOrRestore(opType)` (`:20-48`):
  `RegistryClient.instance.getRecordByName('system-manager', ...)` then POSTs
  `http://{host}:{port}/system/{opType}` with `{ directory: ~/.jibo/backup/<service-name> }`. Behind
  `// @if DEBUG` (`index.tsx:116-118`).
- **`notifications-view.tsx`** — `NotificationsService.instance.on('notification-created', ...)`
  (`:15`) and `$.append`s a `.notification-item` to `#notifications` with one of four presets keyed
  by `notification.type ∈ {message, battery, alarm, twitter}` (`:24-40`); `alarm` adds
  `shake-horizontal shake-constant`. jQuery-animates `marginTop: -89 → 1 → -89` with delays
  (`:44-60`). `render()` returns an empty div; all DOM is jQuery imperative.
- **`tts-view.tsx`** — unused, excluded by tsconfig (`tsconfig.json:20`). Imports a non-existent
  `'../services/tts-service'`. Dead.

**Elements** — `custom-elements.ts` registers `atom-workspace/atom-panel/atom-pane-container/
atom-text-editor` (`:43-46`); injects a React DOMProperty config for a `mini` attr (`:2-16`). **The
`index.tsx:12` import is commented out** — dead in shipping build.

**Utils** — `timer.ts` is a singleton 33 ms `setInterval` driving `updater.update()`. Not imported
anywhere; excluded from tsconfig (`:19`). Dead.

---

## 7. Touch / gesture forwarding

**No body-touch-to-Jibo-gesture pipeline exists.** Body clicks go to either the LPS
MouseTargetPositioner (target mode, modifier-keys) or LPS audio-event spawning (audio mode,
toolbar). There's no "click head → Touch gesture" path.

Mouse routing (`face-on-body.tsx:99-116`): listens on `document` for
`["movedown","mousemove","mouseup","mousewheel"]` (`:88-92`); on each, if any of
`shiftKey/ctrlKey/altKey/metaKey` is held → `visualizer.pointerEvents='all'` and
`face.pointerEvents='none'`; else inverse. So **face clicks land inside the skill webview** because
`pointerEvents='all'`. **Note the typo `"movedown"` (`:88`)** — not a real event; mousedown is never
routed, only subsequent move/up/wheel.

Audio-mode handler on `#container` (`face-on-body.tsx:177-191`): on `mousedown`,
`coordinates = getClicked3DPoint(evt)`; if `this.mode === 'audio'`, `evt.stopPropagation();
evt.preventDefault(); LPSService.instance.triggerAudioEvent(coordinates);`. On `mouseup` if audio
mode: `LPSService.instance.triggerAudioEventEnd();`. `getClicked3DPoint` (`:351-356`) calls
`MouseCoordinateWrangler.unprojectEventToPlane(event, visualizer, camera, selectedPlane,
{x:0,y:0,z:1})`.

---

## 8. Audio playback path

**No audio playback in the renderer.** No `new Audio(...)`, no `AudioContext`, no `<audio>`, no
`.wav`/`.mp3` import, no media API call anywhere under `src/simulator/client/` (grepped). Only
audio-related code: LPS sphere placement (`audio-event.ts`); TTSService event handling that updates
the chat bubble in `chat-view.tsx:16-34` (text only); `tts-view.tsx:2` imports a non-existent
`'../services/tts-service'` (dead); `index.tsx:41` TODO comment lists `- wav as audio files` —
planned but not built. Actual TTS synthesis lives in SSM's TTSService (doc 04).

---

## 9. Renderer↔main IPC

Complete channel list with file:line.

| Direction | Channel | Sites | Payload / purpose |
|---|---|---|---|
| sync → main | `get-registry-port` | `index.tsx:45` | returns chosen Registry port |
| sync → main | `get-simulator-settings` | `index.tsx:63`, `face-on-body.tsx:56` | returns settings JSON string |
| sync → main | `get-skill-path` | `index.tsx:247, 268` | returns absolute path to skill's `index.html` |
| async → main | `registry-init` | `index.tsx:272` | sends `registryServiceURL` once SSM is up |
| async → main | `close-dev-tools` | `index.tsx:203, 223` | user manually closed devtools |
| async → main | `set-speaker-id` | `asr-view.tsx:76` | persists selected speaker ID |
| async → main | `set-tts-mode` | `asr-view.tsx:88` | persists `Instant` / `Incremental` |
| main → renderer | `reload-skill` | `index.tsx:168-170` | triggers `webview.reloadIgnoringCache()` |
| main → renderer | `toggle-dev-tools` | `index.tsx:187-195` | open/close webview devtools |
| main → renderer | `simulator-settings-changed` | `face-on-body.tsx:290-302` | new settings JSON; triggers `onViewModeChange()` + `onDimensionChanges()` |

No `ipcRenderer.invoke` anywhere — Electron 1.x era. Everything is `send` / `sendSync` / `on`. No
message bus to the background-service window (`background-service.html` just does
`ipcRenderer.on('backgroundMain', (e, src) => require(src))` — `background-service.html:12-15`);
that window is the SSM's separate process for the skill's background code, and the simulator
renderer doesn't talk to it.

---

## 10. Renderer↔skill IPC

**Nothing direct.** No `iframe.contentWindow.postMessage` and no `window.addEventListener('message',
...)` anywhere in `src/simulator/client/`. The only "data" to the skill is `webview.src =
sendSync('get-skill-path')` (`index.tsx:247`). Skill talks to SSM via the in-process Registry on
`http://127.0.0.1:{registryPort}/registry` (HTTP+WS, docs 03-04), reached through `nodeintegration`.

`reloadWatcher` (`index.tsx:61, 175`, `messages-list.tsx:13-16`) is **intra-renderer only** — tells
MessagesList to insert a "New session" break on each `did-start-loading`.

---

## 11. Resize / DPR handling

- `window.addEventListener('resize', () => onDimensionChanges())` (`face-on-body.tsx:309-311`).
- `onDimensionChanges` (`:242-287`):
  - `effectiveZoom = settings.zoomFactor * settings.devicePixelRatio` (`:243`).
  - **2D**: `faceContent.style.transform = scale(zoomFactor)`; horizontal center via
    `marginLeft = (innerWidth - CHAT_WIDTH - effectiveWidth) / 2` if it fits, vertical similarly
    (`:248-272`); `document.title = "${pageTitle} (${Math.floor(effectiveZoom*100)}%)"` (`:273`).
  - **3D**: `visualizer.style.width = (innerWidth - CHAT_WIDTH) + 'px'`,
    `visualizer.style.height = innerHeight + 'px'`, `robotRenderer.scene.handleResize()`, title
    `"${pageTitle} (3D)"` (`:274-286`).
- DPR is **observed via `settings.devicePixelRatio`**, not `window.devicePixelRatio` — main process
  tracks DPR and broadcasts via `simulator-settings-changed` (doc 01).
- Commented-out `webframe.setZoomFactor(...)` (`:246, 251`) — abandoned Electron webFrame zoom.
- `onViewModeChange` (`:197-240`) fires only when `previous.viewMode !== settings.viewMode`
  (`:297-299`); toggles toolbar visibility (`:218, 238`), face sizing; in 3D sets background, grid,
  `camera.near = 0.001`, `updateProjectionMatrix()` (`:234-237`).
- `window.onDimensionChanges` / `window.onViewModeChange` are stashed for external callers
  (DevShell) (`:304-307`).

---

## 12. Port-time gotchas

- React 0.13/0.14 idioms: `React.createClass`, `React.render`, `getDOMNode()`, string `ref`s.
- **No single React root.** Three parallel `React.render`: sidebar (`index.tsx:296`), notifications
  (`:301`), toolbar (`face-on-body.tsx:323`).
- **`SCREEN_EPSILON = 2`** (`dimensions.ts:8`) — 1 px-on-each-side gutter; `transform2d` subtracts
  (`face-on-body.tsx:498`), face size adds it back (`:226-227`).
- **`global.realThree = true`** (`simulator/index.html:39`) — animation-utilities checks this to use
  real THREE.
- **Three.js scene path** (`face-on-body.tsx:149`) is index-based — port should use
  `getObjectByName('Screen')` or equivalent.
- **`#container` `right:400px`** (`client.less:120`) must equal `dims.CHAT_WIDTH = 400`
  (`dimensions.ts:9`).
- **Mouse event typo** `"movedown"` (`face-on-body.tsx:88`) — replace with `"mousedown"` if pointer
  routing matters.
- **`single-instance-dialog.html`** is just an `<h1>`; irrelevant on the web.
- Dead in shipping build (skip the port): `tts-view.tsx`, `services/nlu-service.ts`,
  `utils/timer.ts`, `elements/custom-elements.ts` — all excluded by tsconfig or with import
  commented out.
