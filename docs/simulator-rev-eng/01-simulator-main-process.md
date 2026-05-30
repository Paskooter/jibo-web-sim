# Simulator Main Process (Electron) — Reverse Engineering Reference

Source tree: `/tmp/sdk/packages/jibo-cli/` (the `jibo-cli` package shipped via the SDK monorepo).
All `file:line` citations are from that tree. **All claims in this doc are sourced; absences are called out.**

The "main process" here is the Electron main script `src/simulator/index.ts` plus its sibling modules
(`windowing.ts`, `dev-tools.ts`, `settings.ts`) and the host HTML files in `simulator/`. There is no
separate launcher process — the parent that spawns Electron is `src/launcher/launcher.ts` (a Node
class, not Electron), invoked from CLI commands.

---

## 1. Entry & CLI parsing

The Electron main script is `src/simulator/index.ts`. It runs **inside** Electron — `app`, `BrowserWindow`,
`ipcMain` are imported at line 1:

```
1: import {app, BrowserWindow, ipcMain as ipc, Menu} from 'electron';
3: import {globalShortcut} from 'electron';   // @if RELEASE only
6: import program = require('commander');
```

Commander flags (`src/simulator/index.ts:23-27`):

```
23: program
24:     .option('-p, --path <path>', 'The path to the skill')
25:     .option('-r, --registry <port>', 'Provide a port for the registry service')
26:     .option('-f, --frameless', 'Run with frameless window (no menu bar)')
27:     .parse(process.argv);
```

- `--path / -p`: absolute path to the skill's `index.html`. **Required**; if missing, the process exits with code 1 at `index.ts:78-81`.
- `--registry / -r`: optional pre-chosen registry port, forwarded to the renderer via the `get-registry-port` IPC (`index.ts:74-76`).
- `--frameless / -f`: declared but **never read** anywhere in `src/simulator/`. Treat as a no-op stub.

**Single-instance enforcement** (`index.ts:31-33`):

```
31: let shouldQuit = app.makeSingleInstance(() => {
32:     return true;
33: });
```

If another instance is already running, `shouldQuit` is `true` and the process opens a **400x200
resizable=false** dialog window loading `single-instance-dialog.html` (`index.ts:54-62`) explaining
the simulator is already running. That dialog has no JS; it's a static "please close the other
instance" message (`simulator/single-instance-dialog.html:22`). The original instance's callback just
returns `true` and does nothing else (no focus/raise of the existing window).

**Launcher (parent of Electron).** The CLI command `jibo sim` ultimately calls
`tools.launcher.play(indexPath, registryPort)` in `src/cli/commands/sim.ts:35`. That `play` is
`src/launcher/launcher.ts:108-163`, which `spawn()`s the Electron binary:

```
113: let args = [
114:     path.resolve(cwd, 'app.js'),
115:     '--path',
116:     indexPath
117: ];
118: if( registryPort && registryPort.length > 0 ) {
119:     args.push('--registry', registryPort);
120: }
122: const envOverrides = {
123:     "ELECTRON_INTERNAL_RUN_AS_NODE": "0",
124:     "RUNMODE": "SIMULATOR",
125:     "NODE_PATH": ""
126: };
141: this.child = spawn(getElectronPath(), args, {cwd, env});
```

`cwd` is `getToolsPath('simulator')` (the simulator HTML folder); `app.js` is the built/transpiled
`src/simulator/index.ts`. `NODE_PATH_SIM` is honored as a fallback for `NODE_PATH` (lines 134-140).
`RUNMODE=SIMULATOR` is the env var the skill's main process uses to detect sim mode.

---

## 2. Process model

Three relevant processes exist while a skill runs:

1. **Electron main process** — `src/simulator/index.ts`. Single instance enforced. Owns the
   `mainWindow` (the visualizer host) and, if the lock is held, the single-instance dialog window.
2. **Electron renderer process (visualizer host)** — loads `simulator/index.html`. That HTML uses
   `<webview id="skill" partition="persist:jibo-skill" nodeintegration ...>` (`index.html:21-33`) to embed
   the skill itself in a **separate web frame**, not a separate OS process unless Electron's
   site-isolation kicks in for `<webview>` (default for `webview` tags).
3. **Skills-Service-Manager (SSM)** — **runs in-process inside the renderer**. There is no child
   process spawn for SSM in the main process. The renderer's bootstrap
   (`src/simulator/client/index.tsx:258-275`) constructs `new Factory(config, rootDir)` from the
   `skills-service-manager` module and calls `factory.init(...)`. All SSM services live in the
   renderer's Node-integrated JS context. See §4.

Notably **no background-service BrowserWindow is created by the main process**. `index.ts:98-115`
exposes a `get-background-service-path` IPC that reads `jibo.backgroundMain` from the skill's
`package.json` and returns the resolved path — but `grep` of `src/simulator/` shows no code in the
main process that ever sends `backgroundMain` or creates a window for `background-service.html`.
The `background-service.html` file (`simulator/background-service.html:12-15`) is a stub that listens
for `ipcRenderer.on('backgroundMain', src => require(src))`, so something elsewhere (renderer-side or
SSM) is expected to host it as a `<webview>` or hidden window. **Not visible in the main-process source.**

IPC channel names registered on the main process (`ipcMain`):

| Channel | File:line | Direction | Payload |
|---|---|---|---|
| `get-registry-port` | `index.ts:74` | renderer→main (sendSync) | returns `program.registry \|\| 0` |
| `get-skill-path` | `index.ts:90` | renderer→main (sendSync) | returns `program.path` (string) |
| `get-background-service-path` | `index.ts:98` | renderer→main (sendSync) | returns absolute path to `jibo.backgroundMain` or `""` |
| `registry-init` | `index.ts:212` | renderer→main (send) | `(event, registryHost: string)` — saved into closure-local `registryHost` |
| `get-context` | `index.ts:274` | renderer→main (send) | replies via `event.sender.send('set-context', {registryHost, token:""})` |
| `get-simulator-settings` | `settings.ts:65` | renderer→main (sendSync) | returns `JSON.stringify(this._settings)`; flips `simulatorReady=true` |
| `close-dev-tools` | `settings.ts:76` | renderer→main (send) | toggles `isDevToolsOpened=false` |
| `close-background-service-dev-tools` | `settings.ts:81` | renderer→main (send) | toggles `isBackgroundServiceDevToolsOpened=false` |
| `set-tts-mode` | `settings.ts:87` | renderer→main (send) | `(event, mode)` persisted as `ttsMode` |
| `set-speaker-id` | `settings.ts:94` | renderer→main (send) | `(event, id)` persisted as `speakerId` |

Main→renderer broadcasts (via `mainWindow.webContents.send`):

| Channel | File:line | Trigger | Payload |
|---|---|---|---|
| `reload-skill` | `index.ts:150` | View→Reload menu (Cmd/Ctrl+R) | none |
| `toggle-dev-tools` | `settings.ts:115` | `toggleSkillDevTools()` called by Developer menu | `boolean` (new visibility) |
| `simulator-settings-changed` | `settings.ts:129` | every `settings.update(...)` after `simulatorReady` | `JSON.stringify(this._settings)` |
| `set-context` | `index.ts:275` | reply to `get-context` | `{registryHost, token:""}` |

The renderer-side counterparts of these channels are visible in
`src/simulator/client/index.tsx:45,168,187,247` (sendSync `get-registry-port`, `on reload-skill`,
`on toggle-dev-tools`, sendSync `get-skill-path`).

---

## 3. Window topology

**Main visualizer window** (`index.ts:240-257`):

```
240: const options:any = {
242:     partition: "persist:jibo-simulator"
243: };
245: if (settings.get('fullscreen')) {
246:     options.fullscreen = true;
247: } else {
250:     options.useContentSize = true;
251:     options.x = settings.get('windowX');
252:     options.y = settings.get('windowY');
253:     options.width  = settings.get('contentWidth')  / display.scaleFactor;
254:     options.height = settings.get('contentHeight') / display.scaleFactor;
255: }
257: mainWindow = new BrowserWindow(options);
```

Notes on the options object:
- `partition: "persist:jibo-simulator"` is **not a standard `BrowserWindow` option** — `partition`
  belongs on `<webview>`. It is present in the source as-is; Electron likely ignores it on the
  window itself. The actual persistent partition used by the skill is the `<webview>`'s
  `partition="persist:jibo-skill"` (`simulator/index.html:22`).
- **No `webPreferences` is set.** That means Electron defaults apply: in the Electron version this
  SDK targets (pre-5, given the `app.makeSingleInstance` API at `index.ts:31`), defaults were
  `nodeIntegration: true`, `contextIsolation: false`, no sandbox. The renderer can `require()` Node
  modules — confirmed by `simulator/index.html:38-41`:
  ```
  38: <script>
  39:     global.realThree = true;
  40:     require('./client');
  41: </script>
  ```
- `useContentSize: true` makes width/height refer to the web content area, not window frame.
- Window size is divided by `display.scaleFactor` because settings are stored in device pixels (see
  the `windowing.ts:67-89` capture loop that multiplies content size by `scaleFactor`).

Defaults from `src/simulator/settings.ts:11-42`:
- `contentWidth: 1280`, `contentHeight: 720`
- `windowX: 50`, `windowY: 50`
- `fullscreen: false`, `zoomFactorIndex: 4` (=100%), `viewMode: '3d'`

**Single-instance dialog window** (`index.ts:54-59`):

```
54: let dialogWindow = new BrowserWindow({
55:     useContentSize: true,
56:     width: 400,
57:     height: 200,
58:     resizable: false
59: });
```

Loads `single-instance-dialog.html` (line 62). No webPreferences specified.

**Skill webview (inside the renderer, not a main-process BrowserWindow)** —
`simulator/index.html:21-33`:

```
21: <webview id="skill"
22:     partition="persist:jibo-skill"
23:     style="position: absolute; display: inline-flex; width: 1280px; height: 720px;"
24:     autoresize="on"
25:     nodeintegration
26:     width="1280" height="720"
27:     minwidth="1280" maxwidth="1280"
28:     minheight="720" maxheight="720">
29: </webview>
```

`nodeintegration` is enabled on the webview so the skill itself can `require()` Node modules. Size
is locked to 1280x720 via `minwidth/maxwidth/minheight/maxheight`. The skill's `src` is set from JS
at `client/index.tsx:247` via `ipc.sendSync('get-skill-path')`.

**Background service window: not constructed in the main-process source.** See §2.

---

## 4. SSM startup

SSM is **embedded in the renderer**, not spawned by main. See `src/simulator/client/index.tsx:258-275`:

```
258: async.series([
259:     (next) => {
261:         const rootDir = path.join(resolve.sync('skills-service-manager', { basedir: __dirname }), '..');
262:         const configFile = path.resolve(path.join(resolve.sync('jibo-cli', { basedir: __dirname }), '../../configs/ssm.json'));
264:         const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
266:         config.RegistryService.port = registryPort === '' ? 0 : registryPort;
267:         config.services.SkillsServiceSim.skillsBaseDir =
268:             path.join(ipc.sendSync('get-skill-path'), '..');
269:         const factory = new Factory(config, rootDir);
270:         factory.init(() => {
271:             const registryServiceURL = `http://127.0.0.1:${RegistryClient.instance.port}/registry`;
272:             ipc.send('registry-init', registryServiceURL);
273:             next();
274:         });
275:     },
```

- Config source: `configs/ssm.json` (this same package, `configs/ssm.json`).
- Default ports declared in `configs/ssm.json`:
  - `RegistryService` 127.0.0.1, port 0 (auto-assigned at runtime).
  - Fixed: `AudioServiceSim: 8383`, `BodyService: 8282`, `LPSService: 8484`, `DevShell.syncPort: 8989`.
  - All other services declared with `"port": 0` (dynamic).
- `RegistryService.port` is overridden from the CLI `--registry` arg (passed through
  `get-registry-port` IPC).
- `SkillsServiceSim.skillsBaseDir` is set to the **parent dir** of the skill `index.html`.
- After `factory.init(...)` completes, the renderer constructs the registry URL
  `http://127.0.0.1:${RegistryClient.instance.port}/registry` and sends it back to main via
  `registry-init` (line 272). The main process stashes it for any future `get-context` request
  (`index.ts:212-215, 274-279`).

**Therefore the main process passes no ports/env-vars to SSM** — the renderer reads the JSON config
directly. The only env vars affecting the simulator are set by the Node launcher (§1):
`RUNMODE=SIMULATOR`, `ELECTRON_INTERNAL_RUN_AS_NODE=0`, `NODE_PATH` (possibly composed from
`NODE_PATH_SIM`).

---

## 5. Renderer↔main IPC (consolidated)

See table in §2. A few payload shape clarifications grounded in source:

- `get-context` returns `{registryHost: string, token: ""}` (`index.ts:275-278`). `token` is hard-coded empty.
- `simulator-settings-changed` payload is `JSON.stringify(this._settings)` — the **entire** merged
  settings object (`settings.ts:129`). Renderer receives the full snapshot, not a diff.
- `get-simulator-settings` returns the **stringified** settings object via `event.returnValue`
  (sync IPC, `settings.ts:67`). The first such call flips `simulatorReady=true` and proactively pushes
  a `zoomFactor` update derived from `windowing.getZoom()` (line 69-71).
- No `ipcMain.handle` / `ipcRenderer.invoke` usage — this is the older `ipc.on` + `event.returnValue`
  pattern only. (Consistent with the Electron version that still had `app.makeSingleInstance`.)

---

## 6. Settings storage

File: `src/simulator/settings.ts`.

**Path** (`settings.ts:7-11`):

```
7: function getUserHome() {
8:   return process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'];
9: }
11: let settingsPath = path.join(getUserHome(), "./jibo/simulator/settings.json"),
```

So the resolved path is `$HOME/jibo/simulator/settings.json` (Unix) or
`%USERPROFILE%\jibo\simulator\settings.json` (Windows). Note this is **not** under
`~/.jibo/...` — there's no leading dot.

**Format**: pretty-printed JSON, 4-space indent (`settings.ts:125`):

```
125: fs.writeFileSync(settingsPath, JSON.stringify(this._settings, null, '    '), 'utf8');
```

**Schema** — every field present in `defaults` (`settings.ts:12-42`):

```
contentWidth:                       1280
contentHeight:                      720
windowX:                            50
windowY:                            50
fullscreen:                         false
zoomFactorIndex:                    4     // index into windowing.ts zoomFactors[]
zoomFactor:                         1     // multiplier actually used by renderer
viewMode:                           '3d'  // '2d' | '3d'
devToolsWindowX:                    0
devToolsWindowY:                    0
devToolsContentWidth:               1200
devToolsContentHeight:              800
isSimulatorDevToolsOpened:          false
isDevToolsOpened:                   false // skill's webview dev tools
isBackgroundServiceDevToolsOpened:  false
ttsMode:                            "Instant"
```

Additionally `speakerId` is written on `set-speaker-id` (`settings.ts:97`) but is **not** in
`defaults` — it is added lazily on first set.

**Read path** (`settings.ts:46-58`):
- On `init()` it tries `fs.readFileSync(settingsPath)`. If present, parses and merges over `defaults`
  with `_.extend({}, defaults, parsed)`. If parse fails or file missing, uses `defaults`.
- The merge direction means user file overrides defaults but new defaults added in code are picked up
  automatically.

**Write path**:
- Sole writer is `update(changes)` (`settings.ts:119-131`). It merges into `_settings`, ensures the
  parent directory exists (`fs.ensureDirSync`), writes the file, and (if `simulatorReady`) broadcasts
  `simulator-settings-changed` to the renderer.
- `windowing.ts:67-91` runs a `setInterval(..., 200)` that polls window bounds and pushes
  `windowX/Y, contentWidth/Height, devicePixelRatio` to `settings.update(...)` whenever they change.

**Renderer-side reading**: only on mount via `ipc.sendSync('get-simulator-settings')`
(`client/index.tsx:63`) and via the `simulator-settings-changed` push thereafter. There is no
direct renderer read of the file.

---

## 7. Dev tools

Two distinct dev-tools targets are tracked:

1. **The main visualizer renderer's** dev tools — managed by `src/simulator/dev-tools.ts`.
2. **The embedded `<webview id="skill">`'s** dev tools — managed by `settings.toggleSkillDevTools()`
   (`settings.ts:107-117`) and the renderer-side `toggle-dev-tools` listener
   (`client/index.tsx:187-204`).

**`dev-tools.ts`** wires up:
- On `init(mainWindow)`: if `settings.get('isSimulatorDevToolsOpened')` is true, opens the visualizer
  devtools (lines 13-16).
- Listens for `webContents 'devtools-opened'` / `'devtools-closed'` to persist
  `isSimulatorDevToolsOpened` (lines 20-38). On open, it also restores the devTools window's
  saved position (lines 26-32).

**Keyboard shortcuts** (`src/simulator/index.ts:18-21, 184-201`):
- Stem: `Alt+Command+` on macOS, otherwise `Shift+Control+`.
- `Shift+Ctrl+I` (or `Alt+Cmd+I`): toggle **skill** webview devtools — calls
  `settings.toggleSkillDevTools()`.
- `Shift+Ctrl+J` (or `Alt+Cmd+J`): toggle **visualizer/SSM-host** devtools —
  `mainWindow.webContents.toggleDevTools()`. The menu item is guarded by `// @if DEBUG ... @endif`
  (lines 192-202), and **additionally** in `// @if RELEASE` builds the same `*+J` shortcut is registered
  as a hidden global shortcut (lines 261-267) so it still works without a menu entry.
- `Cmd/Ctrl+R`: View→Reload → sends `reload-skill` (line 147-152) → renderer calls
  `skillWebview.reloadIgnoringCache()` (`client/index.tsx:168-170`).
- `Ctrl+Cmd+F`: toggle full screen (`windowing.ts:133-142`) and persist `fullscreen` setting.
- `Cmd/Ctrl+0`: actual size (resets zoom to `PIXELPERFECT=4`) — registered both as a menu accelerator
  (`windowing.ts:146`) and a globalShortcut (`windowing.ts:54-56`).
- `Cmd/Ctrl+=` / `Cmd/Ctrl+-`: zoom in/out by walking the `zoomFactors` array
  (`windowing.ts:152-172`).
- `Cmd/Ctrl+4`: "Physical Sized" — switches to `LIFESIZED=-2` zoom, which calculates a multiplier
  from `lifesized.ppi(display)` / `300dpi` × `display.scaleFactor` (`windowing.ts:174-180, 234-247`).
- `Cmd/Ctrl+2` / `Cmd/Ctrl+3`: set `viewMode` to `'2d'` / `'3d'` (`windowing.ts:184-201`).

The application menu is rebuilt once on `app.ready` via
`Menu.buildFromTemplate(template); Menu.setApplicationMenu(menu);` (`index.ts:171-172`). The
template has 3 top-level submenus: `Electron` (Quit), `Edit` (Undo/Redo/Cut/Copy/Paste/Select All, all
using macOS `selector:` style — these only work on macOS), and `View` (Reload + the items from
`windowing.getMenuItems()` + `Developer` from `addDebugging()`).

---

## 8. App lifecycle

- `app.commandLine.appendSwitch('enable-speech-dispatcher')` — set **before** any `app.on('ready')`
  (`index.ts:15`). See §9.
- `app.makeSingleInstance(cb)` — guards entire init (`index.ts:31-33`). If the lock is held
  elsewhere, this process takes the "dialog" branch; otherwise the "skill" branch.
- `app.on('ready')` — registered twice, one per branch:
  - Dialog branch (`index.ts:36-69`): builds a minimal "Electron→Quit" menu, opens the
    400x200 single-instance dialog, exits on close (`dialogWindow.on('closed', ...)` nulls the
    reference but does not call `app.quit()` — so the process lingers until the user manually
    quits or another window closes).
  - Skill branch (`index.ts:169-175`): sets the full application menu and calls `loadSkill()`.
- `app.on('window-all-closed', () => app.quit())` (`index.ts:165-167`) — even on macOS, the app
  fully quits when all windows close.
- `mainWindow.on('closed', () => shutdown(mainWindow))` (`index.ts:289-291`).
- `shutdown(windowThatClosed)` (`index.ts:294-305`):
  - Closes `mainWindow` if it's a different window than the one that triggered shutdown.
  - Nulls `mainWindow`.
  - Calls `windowing.shutdown()` which clears the dimension-change polling `setInterval`
    (`windowing.ts:94-98`).
  - Calls `devTools.shutdown()` — currently a no-op that only guards a never-set
    `devToolsWindowDimensionChangesInterval` (`dev-tools.ts:41-46`).
- No `before-quit` / `will-quit` / `quit` handlers. No explicit teardown of SSM (SSM lives in the
  renderer, which dies with the window).

---

## 9. Platform quirks

- **Linux TTS via speech-dispatcher**: applied **unconditionally** in this source, not gated to Linux
  (`index.ts:15`):
  ```
  15: app.commandLine.appendSwitch('enable-speech-dispatcher');
  ```
  The flag is meaningful only on Linux where Chromium gates TTS behind speech-dispatcher. On
  macOS/Windows it is harmless.
- **Dev-tools shortcut stem** — only platform branch in this code (`index.ts:18-21`):
  ```
  18: let toggleDevToolsShortcutStem = 'Alt+Command+';
  19: if (process.platform !== 'darwin'){
  20:     toggleDevToolsShortcutStem = 'Shift+Control+'
  21: }
  ```
  i.e. macOS=`Alt+Cmd+`, all others=`Shift+Ctrl+`.
- **Edit menu uses macOS-only `selector:` actions** (`index.ts:131-141`) — `cut:`, `copy:`, `paste:`,
  `selectAll:`, `undo:`, `redo:`. These rely on Cocoa first-responder semantics and **silently do
  nothing on Linux/Windows**. The simulator was clearly developed primarily for macOS.
- **Settings path** is `~/jibo/simulator/settings.json` on Unix; `%USERPROFILE%\jibo\simulator\settings.json`
  on Windows (`settings.ts:7-11`). The Windows env-var is `USERPROFILE`; everything else uses `HOME`.
- **`require('lifesized')`** is used for physical-size zoom (`windowing.ts:238`). It calls
  `lifesized.ppi(display)` and assumes Jibo's panel is `300 DPI` (`windowing.ts:245`). Cross-platform
  dep, but worth noting since it has display-detection internals.

No other Linux/macOS/Windows branches exist in the four main-process source files.

---

## 10. Things not in this source (explicit non-findings)

- **No `webPreferences` block on any `BrowserWindow`** in `src/simulator/`. The renderer's Node
  integration is the Electron-version default for this codebase.
- **No background-service BrowserWindow construction** in the main process. The `backgroundMain`
  IPC path exists, but no `new BrowserWindow(...)` for it is in `src/simulator/index.ts` (verified
  by `grep BrowserWindow src/simulator/`).
- **No SSM child-process spawn**. SSM runs in-renderer (§4).
- **No code reads the `--frameless` flag** anywhere in `src/simulator/`. Declared but unused.
- **No tray icon, no protocol handlers, no auto-updater wiring** in main-process source.
- `dev-tools.ts:42-45` references `this.devToolsWindowDimensionChangesInterval` which is never
  set anywhere — dead code.

---

## 11. Quick reference: control flow on `jibo sim /path/to/skill`

1. `bin/jibo-sim.js` → `cli.sim()` → `commands/sim.ts` validates path → `launcher.play(indexPath)`.
2. `launcher.play` spawns Electron with `app.js`, args `--path <indexPath> [--registry <port>]`, env
   `{RUNMODE:SIMULATOR, ELECTRON_INTERNAL_RUN_AS_NODE:0, NODE_PATH}` (`launcher.ts:113-148`).
3. Electron starts `src/simulator/index.ts`. Appends `enable-speech-dispatcher` switch.
4. `app.makeSingleInstance` — assume lock acquired (skill branch).
5. Validates `--path` (exit 1 if missing). `settings.init()` reads `~/jibo/simulator/settings.json`.
6. Registers IPC handlers (`get-skill-path`, `get-background-service-path`,
   `get-registry-port`, `get-simulator-settings`, `set-tts-mode`, etc.).
7. `app.on('ready')` → builds menu (incl. `windowing.getMenuItems()` and `addDebugging()`),
   `loadSkill()`.
8. `loadSkill()` reads stored window bounds, picks display, divides by scaleFactor, constructs
   `mainWindow = new BrowserWindow({useContentSize, x, y, width, height, partition:"persist:jibo-simulator"})`.
9. `devTools.init(mainWindow)`, `globalShortcut` for `*+J` (RELEASE only),
   `windowing.setWindow(mainWindow)` (starts 200ms bounds-polling interval),
   `settings.setWindow(mainWindow)`.
10. `mainWindow.loadURL('file://.../index.html')` (`index.ts:287`).
11. Renderer (`simulator/index.html` + `client/index.tsx`) boots:
    - sendSync `get-registry-port` → main returns 0 (or CLI value).
    - sendSync `get-simulator-settings` → main returns full settings JSON, flips `simulatorReady`.
    - Starts SSM `Factory` with `configs/ssm.json` + overrides → sends `registry-init` back to main.
    - Sets `<webview id="skill">.src = ipc.sendSync('get-skill-path')`.
12. From here on, settings changes flow main→renderer via `simulator-settings-changed` pushes; user
    closing the window calls `shutdown()` which clears `windowing`'s polling interval and quits via
    `window-all-closed`.
