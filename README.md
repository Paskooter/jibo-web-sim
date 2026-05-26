# jibo-web-sim

A modern, browser-only re-implementation of the Jibo SDK simulator (`jibo sim`).

The legacy simulator (`sdk-archive/jibo-cli`) is an Electron app: it hosts the
skill in a `<webview>`, projects an HTML face over a Three.js body, and wires
renderer-side React to skill code over Electron IPC. This project replaces all
of that with a static, browser-only build — and re-implements the public
`jibo.*` API so real skills run largely unchanged.

## Stack

- Vanilla JavaScript, ES modules. No bundler, no framework, no TypeScript.
- Three.js r166 for the 3D viewport (vendored under `vendor/`, MIT).
- Plain `<script type="importmap">` in `index.html`.
- Skill isolation via a sandboxed `<iframe>` + a `postMessage` bridge.

## Running it

```sh
npm install     # one-time; only dep is Express (the dev server)
npm start       # http://localhost:8080/
```

`server.js` is a ~15-line Express static server (no caching, no build step).
Open the page and click **Start Jibo** (the click also unlocks audio).

## How it works

- **3D body** (`src/viewport/`) — the legacy `jibo_body.geom/.skel/.kin` loaded
  faithfully (full skeleton, inverted quaternions, frame-local meshes; Z-up
  model parented under a −90°X wrapper). Three DOFs articulate the rig.
- **Skill sandbox** — the skill runs in an `<iframe>` whose `jibo` runtime
  (`src/skill-runtime/`) proxies API calls to **host services**
  (`src/bridge/`) over `postMessage`. Client-side concerns (eye, sound, bt,
  flow, kb) run in the iframe; world/host concerns (body, tts timing, lps,
  notifications, photo) run in the host.
- **Face overlay** — the skill iframe is projected onto the screen quad via a
  4-point homography (`matrix3d`), recomputed each frame with back-face culling.
- **Look-at** — a faithful port of the animation-utilities `Lookat` solver
  (analytical per-joint IK + acceleration-limited motion) drives the rig toward
  LPS targets / audio events.
- **Behavior trees & flows** run client-side in the iframe; their leaves call
  the `jibo.*` services.

## Layout

```
index.html                     import map, viewport, sidebar, skill picker
server.js                      Express static dev server
src/
  main.js                      boot: viewport + tabs + panels + bridge + skill
  viewport/                    scene, jibo rig (geom loader), look-at, audio-event
  ui/                          rig / chat / tts / lps / audio / notifications panels
  bridge/                      host bridge + services (session/tts/nlu/asr/lps/
                               animation/notifications/media) + face overlay
  skill-runtime/               in-iframe jibo shim: eye, sound, bt, flow, kb,
                               runtime-extras (timer/utils/loader/lifecycle),
                               skill-loader, boot
skills/
  hello-world/                 hand-written demo bundle (manifest + flow + mim)
  fortune-teller/              second bundle (demonstrates the skill picker)
vendor/                        three.module.js + OrbitControls (MIT)
assets/jibo-legacy/            jibo_body.geom/.skel/.kin + texture
docs/                          design notes + session handoff
```

## `jibo.*` API coverage

| Namespace | Status |
|-----------|--------|
| `init`, `RunMode`, `runMode`, `versions`, `lifecycle` | ✅ |
| `tts` (speak/stop/events/getWordTimings) | ✅ real audio (Web Speech), queued |
| `face` (lookAt/blink/setColor/gestures/eye) | ✅ canvas eye + screen touch |
| `animate` (play/blink/lookAt/createLookat·AnimationBuilder/LED/dofs) | ✅ |
| `lps` (target/audible entity/takePhoto) | ✅ + look-at + audio events |
| `sound`, `notifications`, `media`, `system`, `kb`, `nlu` | ✅ (kb in-memory; nlu token-matcher) |
| `bt` (lifecycle, composites, ~20 behaviors incl. Listen/Mim/Menu, decorators) | ✅ |
| `flow` (FlowExecutor, GoJS `.flow`, activities incl. Mim/Menu) | ✅ |
| `timer`, `utils`, `loader` | ✅ |
| `mim` (Mim/Menu behaviors + manager surface) | ⚠️ dialog loop only (no GUI/FST) |
| `gl`, `rendering.gui`, `systemManager`, `animUtils` | ❌ not implemented |

Sim stand-ins: ASR is the Chat tab (no wake-word/STT); NLU is a token-overlap
matcher (not the FST engine); `takePhoto` captures the viewport; `kb`/`system`
are in-memory/mock.

## Milestones (all complete)

M0 scaffold · M1 rig + LED · M2 iframe bridge + face overlay · M3 chat +
audible TTS · M4 `jibo.animate` · M5 manifest-loaded skill bundle · M6 look-at
+ LPS · M7 audio events · M8 sound + notifications · M9 touch + photo + system
· M10 behavior trees + flows · M11 kb + skill picker · M12 Mim/Menu.

## Why a rewrite (vs. reviving the Electron sim)

- Browser-only: no Electron, no per-OS packaging; hostable as static files.
- Real sandboxed iframe + `postMessage` instead of `<webview>`/`nodeintegration`.
- Modern Three.js instead of the patched `animation-utilities` worker pipeline.
- Distinct code & naming: the legacy source is consulted as the spec (IO
  formats, the look-at solver, the face-on-body homography) but not copied.
