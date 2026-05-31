# jibo-web-sim

A browser-only simulator for Jibo skill bundles. Loads a production skill
bundle into a sandboxed iframe, talks to in-browser stand-ins for the
on-device services, and (optionally) bridges out to a real cloud backend
for cloud-routed turns.

The sim works two ways:

- **Offline** — voice/typed input is parsed by an in-browser implementation
  of the launch-rule DSL against whatever rule files the loaded bundle ships
  with. Anything the bundle can handle locally (scripted responses,
  on-device skills) runs to completion: speech, body animation, music,
  screen content. No backend required.
- **With a cloud backend** — typed/voice input is forwarded to the
  configured hub; the cloud's intent router routes the turn back to the
  bundle the same way the on-device runtime does.

## Running it

```sh
npm install     # express only
node server.js  # http://localhost:8080/
```

Then point `EXTERNAL_SKILLS` at the directory containing your unpacked
skill bundle (defaults to `/tmp`), open the page, click **Start Jibo**.
The click is what unlocks the page's audio context.

To connect to a cloud backend, enter its host:port in the host UI field
before starting.

## What you supply

The simulator ships **no skill content of its own**. You bring:

- A skill bundle (typically a `jibo-be` build) unpacked at some path
  under `EXTERNAL_SKILLS`.
- The bundle's own `launch.rule` files, anywhere under
  `<bundle>/node_modules/**/launch.rule` — they're auto-discovered on
  boot. Same for `.grm` factory grammars.

If the bundle ships rules, they're picked up. If it doesn't, only the
regex-backed quick-match table fires and offline NLU coverage is thin.

## Architecture

```
┌────────────────────── browser tab ───────────────────────────────────┐
│                                                                      │
│  ┌──── host ─────────────────────┐  ┌── sandboxed iframe ─────────┐  │
│  │ Three.js viewport (body rig)  │  │  user-supplied skill bundle │  │
│  │ face-overlay homography       │←→│  loaded in place:           │  │
│  │ TTS via Web Speech            │  │   - real jibo runtime       │  │
│  │ audio playback                │  │   - PixiJS face renderer    │  │
│  │ touch/tap forwarding          │  │   - require() shim          │  │
│  └──────────────┬────────────────┘  │   - in-memory service bus   │  │
│                 │ postMessage       └────────┬────────────────────┘  │
│                 ▼                            │ /__cloud-ws (optional) │
│             host bridge                      │                        │
└──────────────────────────────────────────────│────────────────────────┘
                                               ▼
                                     express dev server
                                  (forwards to a cloud hub
                                  with injected auth headers)
```

## Layout

```
index.html                      page shell, "Start Jibo" gate
server.js                       express; cloud WS proxy + cross-origin image proxy
src/
  main.js                       boot: viewport + skill iframe + bridge
  viewport/                     three.js scene + body rig
  ui/                           sidebar panels (chat / rig / etc.)
  bridge/                       host bridge + face overlay homography
  skill-runtime/                in-iframe machinery
    boot.js                       shim mode (own demo skills) | real-runtime mode (user bundle)
    cjs-require.js                browser require() + cloud WS bridge
    live-eye.js                   DOF playback, audio routing
    nlu/                          rule-DSL lexer/parser/matcher
    services/                     in-memory service bus + stand-ins
skills/                           a couple of hand-written demo bundles
assets/jibo-legacy/               body geom/skel/kin + texture for the rig
```

## What works

- Bundle boots clean; the on-device runtime loads, plugins init, face renders.
- Local NLU with the full launch-rule DSL: alternation precedence,
  group-tag scope, tag append (`+=`), char-class grammar, factory refs.
  Rule files are discovered from the loaded bundle.
- Scripted-response lookups against whatever MIM set the bundle ships.
- Animation engine: DOF arbiter priority preemption, eased start poses,
  PIXI timeline overlays, real animation durations, eye lookAt, blink, LED.
- Cloud path (when a backend is configured): typed chat → cloud hub →
  intent router → skill switch → speech + music + screen content.

## What you'll hit

Limits, not bugs:

- **Offline NLU coverage depends on what rules the bundle ships.** A
  stock bundle typically ships rules for a handful of skills. Skills
  without on-device rules need either the cloud or local rule files
  added to the bundle.
- **Cloud-only flows** (general question answering, news, weather, music
  streaming, etc.) need a configured backend.
- **Live mic input** isn't wired — the chat field is the input path.
- **Hardware-backed services** (real wifi, scheduler, OTA) are
  no-op stand-ins by design.

## License

Code in `src/`, `server.js`, `index.html`: this repo's license.
Vendored libraries (`vendor/three.module.js`, etc.): MIT, per their
upstream headers.
