# jibo-web-sim

A browser-only port of the original Electron Jibo simulator (`jibo sim`),
running the production **`jibo-be` skill bundle unmodified** against a
self-hosted pegasus cloud hub.

The legacy simulator (`sdk-archive/jibo-cli`) is an Electron app: the
skill runs in a `<webview>` with `nodeIntegration:true`, `require()`s
the SSM (skills-service-manager) directly, and reaches local services
on `127.0.0.1:<port>`. This project replaces all of that with a static,
sandboxed-iframe build that talks to in-browser service stand-ins —
faithful enough that the production `@be/be` bundle (clock, chitchat,
nimbus, report-skill, …) boots and runs end-to-end.

## What works end-to-end

- Typed chat → pegasus cloud → IntentRouter → skill switch → speech +
  body animation + music + screen images.
- `@be/clock` — tells the time, plays opening animation.
- `@be/chitchat` "dance" — full ~22s body+eye DOF playback with synced
  music track.
- `@be/nimbus` + report-skill — reads each headline aloud with thumbnail
  imagery.
- PixiJS `FaceRenderer` (the bundle's own eye) rendering live, with
  idle bob + per-frame channel mixing from skill-driven animations.
- Face-on-body homography across DPR=1 and high-DPR (4K) screens.

## Running it

```sh
npm install     # express, ws — that's it
node server.js  # http://localhost:8080/
```

Open the page, click **Start Jibo** (the click is also what unlocks
the page's audio context). Type into the chat to talk to the robot.

The page connects to a pegasus hub configured per host UI. Default is
`pegasus.jibo:9000` (the `phoenix` branch is what's been verified end-to-end
against this port — see `docs/simulator-rev-eng/15-build-tests-cloud-manifests.md`
for the DecisionMediator rewrite table that motivated patch M55).

## Architecture in one slide

```
┌─────────────────────────── browser tab ──────────────────────────────┐
│                                                                      │
│  ┌──── host ────────────────────────┐  ┌── sandboxed iframe ──────┐  │
│  │ Three.js viewport (body rig)     │  │  /tmp/jibo-be loaded     │  │
│  │ face-overlay homography          │←→│  unmodified:             │  │
│  │ TTS via SpeechSynthesis          │  │   - real jibo runtime    │  │
│  │ audio playback (Sound.play)      │  │     (UNIT_TESTS mode)    │  │
│  │ touch/tap forwarding             │  │   - PixiJS FaceRenderer  │  │
│  └──────────────┬──────────────────┘  │   - @be/be + 25 skills   │  │
│                 │ postMessage         │   - cjs-require shim     │  │
│                 │                     │   - in-memory ServiceBus │  │
│                 ▼                     │     (13 SSM services)    │  │
│             host bridge               └────────┬─────────────────┘  │
│                                                │ /__cloud-ws + WS    │
└────────────────────────────────────────────────│─────────────────────┘
                                                 ▼
                                    Express server.js
                                  (adds X-JIBO-transID header)
                                                 │
                                                 ▼
                                    pegasus hub (phoenix branch)
                                            :9000
```

## Layout

```
index.html                      page shell, "Start Jibo" gate
server.js                       express; /__cloud-ws WS proxy + /__img cross-origin proxy
src/
  main.js                       boot: viewport + skill iframe + bridge
  viewport/                     three.js scene, jibo rig (legacy geom loader)
  ui/                           sidebar panels (chat / rig / settings)
  bridge/                       host bridge + face overlay homography
  skill-runtime/                in-iframe machinery
    boot.js                       SHIM mode (demo skills) | REAL-RUNTIME mode (jibo-be)
    cjs-require.js                browser require() + cloud WS bridge
    live-eye.js                   DOF playback, audio routing, monkey patches
    services/                     in-memory ServiceBus + 13 SSM service stand-ins
docs/
  simulator-rev-eng/            16-doc source-of-truth deep-dive (~400KB)
skills/
  hello-world, fortune-teller   legacy hand-written demo bundles (SHIM mode)
assets/jibo-legacy/             body geom/skel/kin + texture
```

For deep technical detail on every subsystem (Electron sim main/renderer,
SSM Factory, sim-services, real-services, jetstream/hub, jibo runtime,
animation pipeline, embodied dialog, action system, be-framework, every
`@be/*` skill, loader/KB, FaceRenderer/Touch, build/tests/cloud manifests),
read `docs/simulator-rev-eng/00-index.md` first — it maps the
remaining 15 subdocs.

## Status

### Working
- Cloud bridge end-to-end (auth + LISTEN + CONTEXT + CLIENT_ASR/NLU + WS)
- Be skill loading (all 25 skills load; `_validateSkill` passes)
- Cloud-skill routing via Nimbus (M47: in-memory `cloudSkillResponse` preserved)
- Body DOFs → rig sections + LED ring (animation channels sampled locally)
- Eye DOFs → PixiJS FaceRenderer (`face.eye.display` driven per frame)
- Audio playback routed through host (`Sound.play` → `postMessage` → `new Audio()`)
- TTS via Web Speech with real-duration timeline blocking (M52/M53)
- Cross-origin image loading (server-side `/__img` proxy, M57)
- High-DPR face alignment (M59)

### Partial / stubbed
- **Live mic ASR** — typed chat path is wired; audio-mode LISTEN (no
  `mode` field, audio frames) isn't. Needs Web Speech Recognition glue.
- **Screen-touch → MainMenu nav** — taps are forwarded via `spoofGesture`,
  but the full subskill navigation flow isn't strictly verified.
- **Media/photo operations** — `media-manager` HTTP stubs return 200;
  `Media.takePhoto` etc. resolve with no actual photo (no skill in the
  verified path uses these).
- **`@be/remote`** — `sessionDiscarded` event fires correctly; no Loop
  peer ever pairs (no real ROM stack).
- **`@be/surprises-ota`** — schedules an OTA check; the `scheduler` stub
  returns canned-OK and never fires the job (no OTA endpoint).

### Documented gaps (no equivalent in port)
- **DevShell / autobot tunables** — no `/execute` WS, no remote debug panel.
- **EventPlayback orchestrator** — SSM-side scripted-event replay; used
  only by integration tests.
- **Two-pass plugin orchestration** (`docs/.../07-jibo-runtime.md` §4) —
  we do a single manual `initOfflineServices` pass.
- **Hardware-backed services** (`docs/.../05-ssm-real-services.md`) — by
  design, we use sim-equivalents (no real wifi/wpa_cli/scheduler/etc.).

### Known-benign noise
All non-fatal at boot:
- `Unable to load home location from KB` — falls back to Boston defaults
  (`jibo.js:21755`; source does the same when KB has no edges).
- `Not connected to WiFi at Be startup` — no wifi-service installed.
- `error during skill @be/chitchat postinit call: No credentials set` —
  chitchat's older direct-cloud path; the cloud-routed flow is unaffected.
- `Skills config load error: null` — Be falls back to launch idle.
- `Deprecation Warning: ViewManager.IN/UP` — internal deprecation.
- `MODEL_LOADING: callback X called but not currently pending` —
  jibo-anim-db kinematics double-load; harmless.
- `SurprisesOta error: Scheduler Service not initialized` — silently skips.

## Applied patches (M35–M61)

The path from "skill bundle boots" to "end-to-end loop" required ~25
small surgical patches across `src/skill-runtime/`. They're indexed in
`/home/shell/.claude/projects/-home-shell-jibo-web-sim/memory/reference_agent_handoff.md`
(auto-loaded by agents) with one-line summaries each. Highlights:

- **M40 / M47** — GlobalManagerService + cloud-match bypass of the
  `/globals` JSON round-trip to preserve `cloudSkillResponse` Promise.
- **M52 / M53** — audio playback via host postMessage; per-keyframe
  audio events from `computeAnimObject.content.events`.
- **M55** — stamp `release: '1.9.0'` in outbound CONTEXT to bypass the
  phoenix-branch `DecisionMediator` rewrite of `requestNews` → dead
  `news` skill.
- **M57 / M58** — `/__img` cross-origin image proxy; `server.js` ESM imports.
- **M59** — `renderer.setSize(w, h)` pins canvas CSS size on high-DPR.
- **M60** — 16-doc reverse-engineering reference (`docs/simulator-rev-eng/`).
- **M61** — source-aligned service registry (added `media-manager`,
  `remote`, `scheduler`); GlobalEvents envelope padded with `id`+`moreinfo`.

## Source-of-truth references

This project is the result of comparing a port-in-progress against the
original SDK and the production be bundle. The source trees consulted:

- `/tmp/sdk` — `sdk/sdk @ restoration/2026-05` (the original Electron
  simulator + SSM + all sim/real services + every `@be/*` skill).
- `/tmp/jibo-be` — production `@be/be@12.0.0` bundle (same artifact
  shipped to the real robot).
- `/tmp/pegasus-phoenix` — the `phoenix` branch of pegasus that this
  port has been verified against.

Every file:line citation in `docs/simulator-rev-eng/` is relative to one
of these trees.

## Why a port (vs. running the Electron sim)

- Browser-only — no Electron, no per-OS packaging; static hosting.
- Real sandboxed iframe + `postMessage` instead of `<webview>` +
  `nodeIntegration: true` + co-resident `require()`.
- Works on any device with a modern browser, including phones (DPR=2
  handled in M59).
- The skill bundle is **literally the production bundle** — porting is
  done at the runtime/service boundary, not in the skill code, so the
  port stays in lock-step with whatever the real robot is running.

## License

Code in `src/`, `server.js`, `index.html`: this repo's license.
Vendored libraries (`vendor/three.module.js`, etc.): MIT, per their
upstream headers. Legacy assets under `assets/jibo-legacy/` are Jibo
Inc. proprietary and consulted only as I/O references.
