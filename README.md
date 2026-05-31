# jibo-web-sim

![Jibo twerks on command](assets/screenshots/jibo-twerk.gif)

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

Drop unpacked skill bundles into `./skills/` (two demo bundles already
live there); they show up in the picker. Open the page, click
**Start Jibo** — the click also unlocks the page's audio context.

To connect to a cloud backend, enter its host:port in the host UI field
before starting.

### Unpacking a jibo-be tarball

For a downloaded `jibo-be-12.0.0.tar.gz` (or any other version), unpack
it under `./skills/jibo-be/`:

```sh
mkdir -p skills/jibo-be && tar xzf jibo-be-12.0.0.tar.gz -C skills/jibo-be
```

The bundle shows up in the picker on the next reload.

### Importing the rule pack

The [companion rule pack][rule-pack] is fetched automatically as part of
`npm install` (postinstall hook → `scripts/fetch-rules.js`). It lands in
`./rules/`. If the directory already has content the script skips, so
manual or custom rule packs stay put.

Re-fetch any time:

```sh
npm run fetch-rules
```

Or skip the automatic fetch — set `SKIP_RULE_FETCH=1` before `npm
install`, or pull manually with:

```sh
curl -sSL https://github.com/Paskooter/jibo-web-sim-rules/archive/refs/heads/main.tar.gz \
  | tar xz -C rules --strip-components=1
```

Same shape works for any other rule pack — just drop the tree into
`./rules/`.

[rule-pack]: https://github.com/Paskooter/jibo-web-sim-rules

### Pointing elsewhere

The defaults `./skills` and `./rules` are overridable per process:

```sh
EXTERNAL_SKILLS=/path/to/bundles \
EXTERNAL_RULES=/path/to/rule-pack \
node server.js
```

Either tree is walked the same way as a bundle — any `launch.rule` files
under `<root>/node_modules/<scope>/<name>/` register as that skill, and any
`*.grm` files register as factory grammars.

## What you supply

The simulator ships **no skill content of its own**. You bring:

- A skill bundle (typically a `jibo-be` build) dropped into `./skills/`
  (or a custom dir via `EXTERNAL_SKILLS`).
- The bundle's own `launch.rule` files, anywhere under
  `<bundle>/node_modules/**/launch.rule` — they're auto-discovered on
  boot. Same for `.grm` factory grammars.
- Optionally, a companion rule pack in `./rules/` (gitignored) or a
  custom dir via `EXTERNAL_RULES`, for skills whose `launch.rule` isn't
  shipped on-device.

If neither source has rules for a given input, the regex-backed
quick-match table is the fallback.

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
skills/                           drop unpacked bundles here (demos pre-installed)
rules/                            drop a launch-rule pack here (empty by default)
assets/jibo-legacy/               body geom/skel/kin + texture for the rig
```

## What works

![Asking for the time runs the clock skill end-to-end](assets/screenshots/jibo-time.gif)

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
