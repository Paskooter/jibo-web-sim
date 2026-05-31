# Hello World — Jibo web-sim skill

A hand-written Jibo skill bundle, structured the same way a standard
behavior-template package would be. It's loaded end-to-end from its
manifest by the simulator's skill loader.

## Layout

```
hello-world/
├── package.json   # npm manifest + "jibo" block (main, type, launchRule,
│                  #   prompt, display-name) — the simulator reads this
├── index.html     # jibo.main entry: a #face element + the jibo runtime,
│                  #   which then loads index.js
├── index.js       # the skill (package.json "main"): jibo.init + behavior
└── launch.rule    # FST launch grammar (informational in the sim)
```

## What it does

On launch Jibo greets you with a gesture, then listens for input from the
Chat tab. Each message is interpreted with `jibo.nlu` and answered with
`jibo.tts` while a matching `jibo.animate` gesture plays:

| Say… | Jibo… |
|------|-------|
| hello / hi | greets you with a nod |
| what is your name | introduces himself |
| how are you | does a happy wiggle |
| what can you do / look around | scans the room |
| dance | dances |
| goodbye | waves you off |

## Differences from a real robot bundle

- No build step: `index.js` is plain ES (no TypeScript/browserify); the jibo
  runtime is provided by the platform (web sim) instead of bundled in.
- Behavior is written against the public `jibo.*` services directly rather
  than `jibo.flow` / `.bt` / `.flow` files (those subsystems aren't in the
  web sim yet).
- `launch.rule` is authentic FST but not parsed; the sim keeps the skill
  always-running and surfaces the manifest `prompt`.
