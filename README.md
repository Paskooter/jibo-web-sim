# jibo-web-sim

A modern, browser-only re-implementation of the Jibo SDK simulator (`jibo sim`).

The legacy simulator (`sdk-archive/jibo-cli` on the local Gitea) is an Electron
app: it hosts the skill UI in a `<webview>`, projects an HTML face plane over
a Three.js body, and wires renderer-side React 0.13 to skill code through
Electron IPC. This project replaces all of that with a static, browser-only
build.

## Stack

- Vanilla JavaScript, ES modules
- No bundler, no framework, no TypeScript
- Three.js for the 3D viewport (vendored under `vendor/`)
- Plain `import map` in `index.html`
- Skill isolation via a sandboxed `<iframe>` + `postMessage`

## Running it

```sh
cd jibo-web-sim
npm install     # one-time; pulls in Express (the dev server's only dep)
npm start       # listens on http://localhost:8080/
```

`server.js` is a ~15-line Express static-file server. Disables caching so
edits are picked up on refresh. No build step.

## Layout

```
index.html                # entry; declares the import map
assets/css/main.css       # all styles
src/
  main.js                 # boot
  viewport/scene.js       # Three.js scene + camera + (placeholder) body
  ui/tabs.js              # sidebar tab strip
  ipc/                    # host <-> skill postMessage envelope (TBD)
  services/               # host-side BodyService, AsrService, ... (TBD)
  shim/                   # in-iframe `jibo` global, proxies to host (TBD)
  skill-host/             # iframe bootstrap loader (TBD)
vendor/                   # three.module.js, OrbitControls.js (vendored, MIT)
demo/hello-world/         # canonical bring-up skill (TBD)
docs/                     # design notes
```

## Milestones

- **M0** — scaffold, Three.js viewport renders, sidebar tabs switch.  *(current)*
- **M1** — articulated Jibo body (3 joints) + LED ring, kinematic test harness.
- **M2** — iframe skill loader + `jibo` shim covering `init`, `face`, `tts`, `nlu`.
- **M3** — Chat tab routes fake-ASR utterances into the skill; TTS subtitle bar.
- **M4** — `jibo.animate` keyframe playback + LED API.
- **M5** — Hello World skill loads end-to-end.

## Why a rewrite (vs. reviving the Electron sim)

- Browser-only: no Electron build, no per-OS packaging, hostable from
  `data.jibo`'s nginx.
- No `<webview>`/`nodeintegration`: skills run in a real sandboxed iframe,
  isolated by the platform, talking over `postMessage`.
- Modern Three.js (r166) instead of the patched `animation-utilities` blob
  Worker pipeline that the legacy renderer used.
- Distinct code: the legacy source is consulted as reference (IO surface,
  IPC envelopes, the face-on-body perspective trick) but nothing is copied.
