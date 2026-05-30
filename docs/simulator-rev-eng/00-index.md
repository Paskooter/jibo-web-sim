# Jibo Simulator — Reverse-Engineering Reference

Branch: `sdk/sdk @ restoration/2026-05`. Clone path: `/tmp/sdk`. All 15 sibling
files in this directory cover one subsystem each; every claim in them is
cited `file:line` against `/tmp/sdk/packages/<pkg>/src/...` or `/tmp/sdk/skills/
<skill>/src/...`. Read this index first — it tells you which subdoc to open
for which question, and flags the cross-cutting findings that the per-doc
agents discovered and that meaningfully change the design of a faithful port.

## Doc map

| # | File                                  | Topic                                                    |
|---|---------------------------------------|----------------------------------------------------------|
| 01| 01-simulator-main-process.md          | Electron main: CLI, IPC, BrowserWindow, settings, dev-tools |
| 02| 02-simulator-renderer.md              | Renderer: face-on-body homography, three.js scene, webview |
| 03| 03-ssm-factory.md                     | SSM Factory / orchestrator / process model / init phases |
| 04| 04-ssm-sim-services.md                | All 14 simulator-side stub services (TTS/Body/LPS/…)    |
| 05| 05-ssm-real-services.md               | All 13 hardware-backed services (for reference)         |
| 06| 06-jetstream-client-and-hub.md        | jetstream-client + pegasus hub wire protocol            |
| 07| 07-jibo-runtime.md                    | jibo runtime + plugin chain + DOF firehose contract     |
| 08| 08-animation-pipeline.md              | AnimDB → KeysAnimation → expression → DOFArbiter        |
| 09| 09-embodied-dialog.md                 | TTS pipeline, listen pipeline, MimManager, AutoRules    |
| 10| 10-action-system.md                   | Goals/Actions/Motivations/GoalProviders/OpportunityDet  |
| 11| 11-be-framework.md                    | be/be + be-framework + SkillSwitchScheduler             |
| 12| 12-be-skills-audit.md                 | Every individual skill + Nimbus deep-dive + skill×API matrix |
| 13| 13-loader-kb-assets.md                | jibo-loader / jibo-kb / jibo-cai-utils                  |
| 14| 14-face-touch-render.md               | FaceRenderer (PIXI), eye layers, TouchManager, GestureManager |
| 15| 15-build-tests-cloud-manifests.md     | Build flow, integration tests, all cloud skill manifests, DecisionMediator |

## Architectural deltas (original sim → our jibo-web-sim port)

These are the design choices that **the original sim makes that our port
doesn't** — each one is a faithful-recreation gap or an explicit choice we
made differently because the browser doesn't permit the same thing. Discovered
across docs 01–15.

### 1. Process / window model

- **Original (doc 01, 03):** Electron main process + a single BrowserWindow
  renderer. The SSM runs *inside the renderer process*, not as a subprocess
  (the renderer has `nodeIntegration: true`, so it `require()`s SSM directly).
  Other "processes" (`mms`, `scs`, `expression`, `skills-renderer`) are split
  by `process` field in dependencies but all hosted in-renderer.
- **Ours:** No Electron. Browser tab + sandboxed iframe. ServiceBus lives in
  the iframe. **Decision**: in-iframe SSM-equivalent is the only choice in a
  browser; document this explicitly so future ports know not to look for an
  out-of-process SSM.

### 2. Skill→host comms

- **Original (doc 02):** skill runs inside an Electron `<webview>` with
  `nodeintegration=true`, `partition="persist:jibo-skill"`, locked 1280×720.
  **There is ZERO renderer↔skill `postMessage` IPC.** The skill uses
  `RegistryClient.getRecords()` (which the in-renderer SSM serves) and HTTP/WS
  on `127.0.0.1:<port>` to reach services — the host renderer is co-resident.
- **Ours:** Sandboxed iframe with `allow-scripts allow-same-origin`. Skill
  cannot `require()` Node. We replaced the SSM transport with an in-iframe
  `ServiceBus` + a host↔iframe `postMessage` bridge for the things that *must*
  cross (audio playback, TTS, face touch, body DOFs).
- **Implication**: every host↔iframe message kind we send is a thing the
  original didn't need to send. We're maintaining a parallel protocol the
  original never had. Document that protocol (we have, in
  `reference_agent_handoff.md`) as a porting artifact, not as "spec".

### 3. Body rendering

- **Original (doc 02):** body is a `THREE.js` scene populated by
  `visualize.createRobotRenderer` (from `animation-utilities`). Scene path is
  index-based: `children[4].children[0]...` (brittle).
- **Ours:** Independent THREE.js scene + rig (`src/viewport/jibo.js`) built on
  the same `animation-utilities` geom/skel/kin loaders. **Already matches the
  same library inputs**; the rig is a parallel implementation.

### 4. Face-on-body math

- **Original (doc 02):** computes screen-quad destination corners from a
  THREE-camera projection of the body's screen-mesh corners; same homography
  matrix3d approach as we use. Source-square = `(0,0)→(0,W)→(W,H)→(W,0)`.
- **Ours:** Same algorithm. Confirm `src/bridge/face-overlay.js` is a faithful
  port of `face-on-body.tsx`. The M59 fix (renderer.setSize updateStyle=true)
  is browser-only — Electron's `<webview>` doesn't have the high-DPR canvas
  display-size gotcha because webview content size and host CSS size are
  independently controlled.

### 5. Cloud connection

- **Original (doc 06, 15):** `jetstream-client.api.init({hostname, port: 8090
  or 9000})` opens a long-lived `/events` WS + per-turn POSTs that the
  jetstream-service relays to the hub. The sim-services
  `JetstreamServiceSim` proxies these to the actual hub via `@jibo/hub-client`.
- **Ours:** We bridge directly to the hub (skipping the jetstream-service
  relay) via `cjs-require.js`'s `bridgeViaHub` + `server.js /__cloud-ws`. We
  inject the `X-JIBO-transID` header server-side because browsers can't set
  WS upgrade headers. The fake `/events` WS in `__hubSockets` is a registry
  for translated event delivery. **This is a faithful re-implementation of
  the wire protocol but skips an entire layer (jetstream-service) — which is
  fine because that layer's only job was protocol translation in-process**.

### 6. Hub release-version sensitivity

- **Original (doc 06, 15):** the hub on the phoenix branch has
  `DecisionMediator.mediateDecision` that rewrites `report-skill` +
  `requestNews` → `{skillID: 'news'}` for robots reporting `release < '1.9.0'`.
  `MessagePreProcessor` defaults release to `'1.8.0'` when omitted.
- **Ours:** M55 stamps `release: '1.9.0'` in outbound CONTEXT. **Faithful to
  what a real be v12 robot would send** (be v12 ≥ hashbrown era).

### 7. DOF firehose contract

- **Original (doc 07):** `ExpressionPlugin.ts:34-36` registers
  `events.dofs.on((data) => face.eye.display(data.timestamp, data.dofValues,
  data.metadata))`. The expression *service* streams DOFs from its
  arbitration loop at 33Hz over an SRO channel (not WS).
- **Ours:** We sample animation channels locally in
  `startDofPlayback`/`makeAnimInstance` and write into
  `window.__activeAnimDofs`, which `driveEye` mixes into `face.eye.display`
  per frame. **The end contract (call signature of `face.eye.display`) is
  identical**; the upstream source of values is local instead of streamed.

### 8. AnimDB initialization

- **Original (doc 08):** `jibo-anim-db.api.init(jibo, animDBPath)`. The path
  is resolved via `find-root('jibo-anim-db-animations')` which walks
  `process.cwd()` upward. The animDBPlugin runs in plugin init.
- **Ours:** `find-root` returns nothing in browser. M51 monkey-patches
  `jibo.animDB.init` so the no-arg form (the plugin's call) auto-fills the
  HTTP-relative animdb.json path. **Indexed: 1761 animations** confirmed.

### 9. Sound playback

- **Original (doc 07):** `Sound` uses the renderer's `AudioContext` (which
  has user activation from the renderer itself). `SoundTask` integrates with
  the loader.
- **Ours:** iframe's `AudioContext` is permanently suspended (sandbox
  prevents user activation). M52 patches `Sound.prototype.play` to
  postMessage `play-sound` to the host, which plays via `new Audio()`.
  **Audible output goes through the host's audio stack**; the iframe still
  decodes for `isPlaying`/state consistency.

### 10. Lifecycle / per-turn cleanup

- **Original (doc 07):** `Lifecycle` opens a WS to skills-service; `finished()`
  sends `{command:'finished'}` over that WS. UNIT_TESTS mode skips init →
  no WS. The lifecycle's IPC fallback EventEmitter is the only thing that
  stays functional in UNIT_TESTS.
- **Ours:** M56 no-ops `Lifecycle.finished` when `_client` is undefined.

### 11. Action system / proactive

- **Original (doc 10):** `ActionRuntime.init({jibo})` only instantiates
  `OpportunityDetector` when `pegasusProactiveTrigger` (in
  `jibo-action-system/package.json options`) is `true`. **In the source we
  cloned, that flag is `false`** — so the original sim runs without
  `_runtime.proactive` too. Surprises was always going to need a stub or
  `pegasusProactiveTrigger:true`.
- **Ours:** M54 installs a noop proactive stub.

### 12. The chitchat-skill cloud container

- **Original (doc 15):** `chitchat_skill_manifest.json` has **~9260 intents**
  in the file. The container responds with mim graphs that reference local
  `@jibo/chitchat-mims/mims/*.mim` files (e.g. `RA_JBO_Dance.mim` listing 14
  speak prompts each carrying `<anim cat='dance' filter='&(music)'/>`). The
  client-side `@jibo/chitchat-mims` package must be present in the be bundle
  for the SLIM to load.
- **Ours:** We use the same `/tmp/jibo-be/node_modules/@jibo/chitchat-mims`
  the production be v12 ships. **Source matches** — no port-side
  translation required.

### 13. Nimbus pipeline

- **Original (doc 12):** Nimbus is the cloud-skill executor. Outer/Core
  state machines, `ProcessCloudState` (thinking anim + JCP→SLIM mim
  translation + analytics shepherding), `DoCloudActionState` (SLIM execution
  via `MimRunner`), `nextActionTransID` listening for the next user turn,
  `WaitForAdditionalState` self-redirect loop, `CloudSkillError.mim`,
  SkillRename table.
- **Ours:** Nimbus runs unmodified. Our M47 fix routes cloud match → nimbus
  by rewriting `match.skillID = '@be/nimbus'` while preserving the original
  `cloudSkill` and the `cloudSkillResponse` Promise. **Faithful invocation of
  the same nimbus code path the real robot uses.**

## Critical findings flagged by agents (in their own words)

- **02:** *"Renderer↔skill IPC is zero: no postMessage, no 'message' listener.
  Skill comms flow through SSM Registry (HTTP+WS) via nodeintegration
  require()."* Mouse-routing typo: `"movedown"` instead of `"mousedown"` at
  `face-on-body.tsx:88`. Three.js scene path is index-based (brittle).
- **03:** *5-process model (ssm/mms/scs/expression/skills-renderer); 7
  LATE_CLIENTS in ClientInitializer; only `performance` + `skills` services
  have BOTH a sim and a real impl.*
- **04:** `EventPlayback` is a pure in-process orchestrator (no port);
  `PerformanceServiceSim.init` never calls `super.init` (so no port opens);
  `ServerService` is the only sim-service that talks to live Jibo cloud (when
  `~/.jibo/credentials.json` + `identity.json` exist).
- **05:** GMS WS envelope is `{status, message:<tag>, id, result, moreinfo}`
  with 4 tags (`skill-relaunch`/`skill-launch`/`global`/
  `non-interrupting-global`). `expression` emits `'dofs'`+`'kinematics'` at
  33 Hz over an SRO channel (not WS). `media-manager` registers under two
  names (`media-manager` + `media-proxy` alias).
- **06:** `CloudResponseRegistry.add(transID)` returns the existing promise
  *and deletes the entry*, so a double-add leaves a future `resolve()`
  call creating a new orphan entry — this is the exact bug M47 fixes.
- **07:** `GlobalEvents.init` hard-overrides `service.host = '127.0.0.1'`
  (`GlobalEvents.ts:160`). `Lifecycle.ts:20` has an EventEmitter IPC shim for
  non-Electron, but `RegistryPlugin.ts:41` does not — `set-context` must be
  synthesized in ports. `DevShellPlugin.ts:35` forces itself on in SIMULATOR
  mode. `Runtime.ts:682` registers the loader plugin from the runtime file
  itself (loader is always first). No circular plugin deps.
- **08:** DOF arbiter default config is `{Direct:5, unknown:2, Attention:1}`;
  BEAT layer bypasses the arbiter. Texture-infix DOFs (`*TextureInfixBn_r`)
  are file-paths-as-DOFs.
- **09:** `EmbodiedListen` enums are `AmbientListenMode={NORMAL,NO_BODY}` and
  `ActiveListenMode={OPTIONAL_RESPONSE,UI}` — the `NORMAL_HJ`/`ONLY_HJ`/
  `IGNORE_HJ` names commonly seen elsewhere don't exist in this build.
- **10:** Only SOCIAL + PLAYFUL motivations are registered (HELPFUL commented
  out at `MotivationSystem.ts:52`). `BeSSWGoal` can self-bump above
  `HeyJibo` priority (12→13) when `data.beSkillPreferences.cancelOrientOnStart`
  is set.
- **11:** `Be#_validateSkill` enforces override rules. The four-branch
  `requestSkillRedirect` dispatch + close-then-open `_update` algorithm.
  Skill ID convention is `@be/<n>` (the `this.skills` map keys). Three
  Be-instance redirect entries: `redirect`, `exit`, `skillRedirect`.
- **12:** 28 skills audited; `jibo.lps.identity` used by 14 of 28; `jibo.kb`
  used by 21 of 28; `jibo.expression` used by 26 of 28. Nimbus deep-dive
  covers all 7 nimbus states.
- **13:** **No `kb.identity` slice exists** — looker info is via `kb.loop`.
  `PromiseUtils.timeout` in this build has no `timeoutValue` option — it
  unconditionally rejects. Effective task priority: SpritesheetTask(90) >
  KeysDataTask(81) > KeysTask(80) > … > LoadTask(0).
- **14:** `face.eye.CACHE_ID='global-eye'` vs `ViewManager.GLOBAL_CACHE=
  'global-gui'`. TouchManager has a `y=358` ignore hack. The "received tap
  event undefined X Y" log is `gestureEvent.eventType` (spoofGesture doesn't
  set it).
- **15:** The patched `lib/skills-service-manager.js` (18,212-line UMD bundle)
  was force-committed; it contains two patches: stg-entrypoint + JSC
  Account#get no-op. The full mediateDecision rewrite table for `report-skill`:
  `launchPersonalReport` → `chitchat-skill`/`KU_GiveMeA`,
  `requestWeatherPR` → `answer`,
  `requestCommute` → `chitchat-skill`/`RA_JBO_Traffic`,
  `requestCalendar` → `chitchat-skill`/`RA_JBO_Calendar`,
  `requestNews` → `news`,
  default → `chitchat-skill`/`KU_AreYouAbleTo`.

## What "perfectly recreate" means, per these reports

Functional parity with the original sim requires reproducing:

1. **Wire-level parity with the hub** (doc 06) — already done in our port.
2. **Plugin chain init under UNIT_TESTS** (doc 07) — we run manual inits in
   `initOfflineServices`; the gap list (~10 plugins with UNIT_TESTS guards)
   is in doc 07 §3 + §5.
3. **Skill bundle compatibility** (docs 11, 12) — we run the unmodified
   `/tmp/jibo-be` skill bundle; no per-skill patching required.
4. **DOF/animation timing** (doc 08) — our local `startDofPlayback` matches
   what the expression service would stream; AudioEvent firing matches
   `instance.events.audio.emit(payload)`.
5. **TTS pipeline integrity** (doc 09) — `/tts_speak` must block for real
   duration; the embodied-dialog timeline failsafe is 3× expected length.
6. **Asset pathing** (doc 13) — `PathUtils.getAssetUri`/`getAudioUri` must
   resolve relative paths against the right `resourceRoot`+`assetPack`. Our
   cjs-require fs shim maps absolute `/node_modules/...` paths onto the
   HTTP-served skill dir; sound path rewriting in M56+M58 matches this.
7. **Body DOFs to the rig** (doc 14, doc 08) — our `dofs` postMessage to
   host applies `bottomSection_r`/`middleSection_r`/`topSection_r` to
   `viewport.rig.setDof`; faithful to the DOF names the animation channels
   carry.
8. **GlobalEvents routing** (doc 07 §7 + doc 05) — our `GlobalManagerService`
   exposes the same `/globals` WS with the same envelope and `skill-relaunch`
   / `skill-launch` / `global` / `non-interrupting-global` tags. **Faithful
   to the SSM wire** (verified against doc 05).

## What we don't yet reproduce (documented gaps)

- **Live mic ASR** (doc 09 §9) — listen pipeline supports audio-mode LISTEN
  (no `mode` field), accepting audio frames. We only do CLIENT_ASR/CLIENT_NLU.
- **DevShell / autobot tunables** (doc 07, doc 04) — no equivalent in port.
- **EventPlayback orchestrator** (doc 04) — no equivalent. Used by SSM tests
  to replay scripted scenarios.
- **Two-pass plugin orchestration** (doc 07 §4) — we do a single manual
  init pass; documented as a port simplification.
- **Hardware-backed services** (doc 05) — by design, we use sim-services
  equivalents (own LPS stub, no real wifi/scheduler/etc.).

## Cross-references

- Port-side patch index + repo layout: `[[reference_agent_handoff]]`
- Port-side e2e verification status: `[[project_jibo_be_e2e_verified]]`
- Pegasus hub WS protocol detail: `[[reference_pegasus_hub_protocol]]`
- Legacy model loader: `[[reference_jibo_geom_loader]]`
