# Notes on the legacy CLI simulator

Source of truth for the original simulator on the local Gitea:

- `sdk-archive/jibo-cli` (master) — the `jibo sim` Electron app
  - `bin/jibo-sim.js` — binary entrypoint: `require('../').cli.sim()`
  - `simulator/index.html` — Electron renderer layout (`#toolbar`,
    `#visualizer`, `#face` w/ `<webview id="skill" partition="persist:jibo-skill">`,
    hidden `#background-service` webview)
  - `src/simulator/index.ts` — Electron main: IPC handlers
    `get-skill-path`, `get-background-service-path`, `get-simulator-settings`,
    `is-remote-mode`, `reload-skill`, application menus
  - `src/simulator/client/` — React 0.13 renderer
    - `index.tsx` — mounts tab UI, hooks up `skills-service-manager`
      service classes (ASRService, BodyService, LPSService, KBService,
      RegistryClient, Factory)
    - `face-on-body.tsx` — perspective-projects an HTML face plane onto
      the THREE.js body using a 4-point homography
      (math.stackexchange.com/questions/296794)
    - `views/{chat,lps,target,audio-event,tts,asr,notifications}.tsx`
    - `services/nlu-service.ts`
- `sdk-archive/jibo` (master) — the runtime that skills consume
  - `dts/index.d.ts` lists the public namespace shape:
    `jibo.utils`, `jibo.animate`, `jibo.gl`, `jibo.bt`, `jibo.flow`,
    `jibo.kb`, `jibo.animUtils`, `jibo.nlu`, `jibo.lps`, `jibo.media`,
    `jibo.notifications`, `jibo.tts`, `jibo.system`, `jibo.systemManager`,
    `jibo.face` (FaceRenderer), `jibo.timer`, `jibo.sound`,
    `jibo.loader`, `jibo.mim`, `jibo.lifecycle`, `jibo.rendering`,
    plus `jibo.init`, `jibo.RunMode`, `jibo.runMode`
  - The `dts/` directory is the authoritative source for the API surface
    this project must implement.
- `sdk-archive/animation-utilities` — the THREE.js-based body renderer
  (`visualize.createRobotRenderer`), blob Worker pipeline
- `sdk-archive/jibo-client-framework` — the skills-side shim package

## Confluence pages worth re-reading

(Reachable at `http://192.168.1.135/confluence/...`)

- SDK — Simulator
- SDK — CLI and Robot Use
- SDK — Basic Skill Structure
- About PixiJS
- SDK — About the Animation System
- SDK — About Behavior Trees
- How to Get KB Creds in Simulator
- Commander Simulation (TKT)

## What the simulator simulates

Per "SDK - Simulator":

- Jibo's body and motor services (3 motor axes)
- LED light ring
- Screen output (HD 1280x720)
- Screen touch input
- Audio file output
- Listening (NLU & ASR)
- Text-to-speech
- Photo taking
- Target tracking (LPS)
- Audio event tracking
