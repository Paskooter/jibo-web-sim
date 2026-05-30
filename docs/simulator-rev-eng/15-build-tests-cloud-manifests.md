# 15 — Build, Tests & Cloud Skill Manifests

Citations: `/tmp/sdk` = Jibo SDK monorepo; `/tmp/pegasus-phoenix` = active phoenix hub.

---

## 1. Repo bootstrap

### 1.1 `setup.sh` (`/tmp/sdk/setup.sh:1-23`)

```sh
export VIRTUALIZE_NODE_VERSION=6.5.0
git submodule init && git submodule update
virtualize/setup.sh
if [[ ! -d ~/Library/Caches/jibo-nlu-js-nodejs ]]; then
    tar -zxvf ./Library/Caches/jibo-nlu-js-nodejs -C ~
fi
echo "don't forget to source ./activate"; echo "then yarn install"
```

- Pins Node 6.5.0 (`:3`), hydrates `virtualize`/`virtualize-node` submodules (`:6-8`),
  extracts the prebuilt NLU native binaries from the in-tree 18 MB tarball
  `/tmp/sdk/LibraryCachesjibo-nlu-js-nodejs.tar.gz` into `~/Library/Caches/` (`:10-13`).
- Does NOT run `yarn install` — separate step after sourcing `./activate`.

### 1.2 `activate`

`/tmp/sdk/activate` is a symlink → `virtualize/activate`. The `virtualize` submodule
is empty on this restoration checkout (`ls /tmp/sdk/virtualize/` shows 0 files), so
sourcing is a no-op locally; on a fresh clone after `setup.sh`, it prepends
`virtualize-node/bin` (pinned Node 6.5.0) + `.bin/` to `PATH` so every `yarn ...`
that follows uses the pinned toolchain (electron-prebuilt@1.4.3).

### 1.3 `switch_jsc_cloud.sh` (`/tmp/sdk/switch_jsc_cloud.sh:1-43`)

Toggles `node_modules/@jibo/jibo-server-client/lib/region_config.json` in place:

- forward: `s/jibo[.]com/data.jibo/` (`:16`)
- reverse: `s/jibo[.]media[.]mit[.]edu/jibo.com/` (`:28`)

The reverse asymmetry reveals the file originally held `jibo.media.mit.edu`. This is
what `jsc cloud` flips — which JSC region the `@jibo/jibo-server-client` module
(account/auth/health) talks to.

### 1.4 Yarn workspaces (`/tmp/sdk/package.json:8-22`)

```json
"workspaces": {
  "packages": ["packages/*", "tests/*", "skills/*"],
  "nohoist": [
    "**/@types/electron", "**/@types/electron/**",
    "**/@types/react-dom", "**/@types/react-dom/**",
    "**/@types/react", "**/@types/react/**"
  ]
}
```

- `packages/*` — 47 dirs (jibo, jibo-cli, skills-service-manager, jibo-action-system,
  jibo-attention-manager, jibo-flow-core, jibo-embodied-dialog, jibo-anim-db, …).
- `tests/*` — 7 dirs: integration-{cli, gui, jibo, platform, sdk, skill}, ui-sdk.
- `skills/*` — 33 dirs incl. `be`, `be-framework`, `chitchat-mims`, `circuit-saver`,
  `clock`, `create`, `exercise`, `first-contact`, `friendly-tips`, `gallery`, `greetings`,
  `hue-control`, `idle`, `ifttt`, `introductions`, `main-menu`, `nimbus`, `radio`,
  `remote`, `restore`, `rosbridge`, `settings`, `surprises*`, `tutorial`.
- Ignore-sets (`package.json:3-7`):
  `ignore_sdk = {@tests/*,@be/*,skills-test-utils,@jibo/chitchat-mims,animation-preview}`,
  `ignore_skills = @tests/*` — feed `yarn build`/`test`'s `--ignore` filter.

---

## 2. Launcher — `jibo sim`

### 2.1 CLI entry (`/tmp/sdk/packages/jibo-cli/src/cli/commands/sim.ts:10-39`)

```ts
export default class Sim extends Command {
    parse() {
        this.program.option('-r, --registry <n>', 'Port of registry service').parse(process.argv);
    }
    exec() {
        this.tools.validateSkillPath(this.program.args[0], (err, skillPath, skillName) => {
            if (err) return this.error(err);
            this.sim(skillPath, skillName);
        });
    }
    sim(skillPath, skillName) {
        exec("cd " + skillPath, (err) => {
            if (err) return this.error(err.toString());
            let indexPath = skillPath + "/index.html";
            this.tools.launcher.play(indexPath, this.program.registry);
        });
    }
}
```

Flags: positional `<path>` (skill dir; `package.json:name` becomes skill name);
`-r, --registry <n>`. No `--remote` (deprecated). `jibo-sim.js:1-2` is a one-liner:
`new (require('../')).cli.sim();`.

### 2.2 `Launcher.play` (`/tmp/sdk/packages/jibo-cli/src/launcher/launcher.ts:108-163`)

```ts
play(indexPath, registryPort?) {
    let cwd = getToolsPath('simulator');
    let args = [path.resolve(cwd, 'app.js'), '--path', indexPath];
    if (registryPort?.length > 0) args.push('--registry', registryPort);
    const envOverrides = {
        "ELECTRON_INTERNAL_RUN_AS_NODE": "0",
        "RUNMODE": "SIMULATOR",
        "NODE_PATH": ""
    };
    // NODE_PATH_SIM bridge for atom-shell parent env
    this.child = spawn(getElectronPath(), args,
        { cwd, env: _.assign({}, process.env, envOverrides) });
}
```

Final command:

```
<electron> <jibo-cli>/simulator/app.js --path <skill>/index.html [--registry <port>]
```

Env: `RUNMODE=SIMULATOR`, `ELECTRON_INTERNAL_RUN_AS_NODE=0` (GUI mode). `simulator/app.js`
is built by the gulp `simulator` task (§3.2).

### 2.3 Electron binary (`/tmp/sdk/packages/jibo-cli/src/get-electron-path.ts:18-30`)

Re-synthesizes the prebuilt-electron platform exec path manually because Atom's
`apm install` moves modules out of a temp dir and breaks `electron-prebuilt`'s
postinstall `path.txt`. Version pinned to `electron-prebuilt: 1.4.3` per
`tests/integration-gui/package.json:49`, `integration-jibo/package.json:39`.

---

## 3. Build pipeline

### 3.1 Jenkinsfile (`/tmp/sdk/Jenkinsfile`)

Env (`:25-30`): `Node-6.5.0` tool, `MONORAIL_VERBOSE=1`, `JIBO_JSCMODE=SIMULATOR`,
`HOME=${WORKSPACE}/Jenkinshome`, `DISPLAY=:0`.

Stages (`:36-106`):

1. **Checkout** — shallow GitSCM, depth 1, `CleanBeforeCheckout` (`:36-51`).
2. **Bootstrap** — `yarn install` (10-min) (`:54-56`).
3. **Lint** — `yarn lint` = `jshint scripts` per `package.json:59` (`:57-59`).
4. **Build** — `yarn build:all --verbose` = `node scripts/monorail/run build -tv`
   (topological traversal) (`:64-66`, `package.json:41`), 20-min.
5. **Test** — `JIBO_JSCMODE=SIMULATOR yarn test:all:report` (50-min, `:98-101`).
6. **Docs** — `yarn docs --verbose` (`:102-104`).
7. **Notes/Bumps/Publish** (`:70-96`, only when `ReleaseNotes=true`): publishes
   to npm with `--tag=latest`, re-tags via `get-release.js | tags.js`, rebuilds
   buildroot images for `skills/be` and `packages/skills-service-manager` (`:93-94`).

Reports (`:114-138`): coverage HTML, JUnit XML (`packages/*/report.xml`,
`skills/*/report.xml`), archive `summary.html` + `coverage.json`. Failure email →
culprits + developers + requesters + `rm@jibo.com` (`:185-189`).

### 3.2 Gulp tasks in `jibo-cli/tasks/`

`/tmp/sdk/packages/jibo-cli/gulpfile.js:1-58`. Driven by `jibo-gulp`:

| Task | File | Output |
|---|---|---|
| `on-build` | `tasks/on-build.js:1-8` | composite: `simulator`, `simulator-client`, `styles`, `font-awesome` |
| `simulator` | `tasks/simulator.js:1-4` | browserify `src/simulator/` → `simulator/app.js` (electron main) |
| `simulator-client` | `tasks/simulator-client.js:1-8` | browserify `src/simulator/client/` → `simulator/client.js` (renderer) |
| `styles` | `tasks/styles.js:1-9` | LESS+minify `src/styles/client.less` → `simulator/assets/css/client.css` |
| `font-awesome` | `tasks/font-awesome.js:1-7` | copy `node_modules/font-awesome/{css/*.min.css,fonts/*}` → `simulator/assets/` |

Debug variants: `on-build-debug.js`, `simulator-debug.js`, `simulator-client-debug.js`.

### 3.3 Patched-SSM commit `d8c30682e3`

```
Force-add patched lib/skills-service-manager.js + document sim setup
 README.md                                          |    26 +
 .../lib/skills-service-manager.js                  | 18212 +++++++++++++++++++
```

Author pasketti, Fri May 15 2026. The file is a single UMD-bundled SSM
(18,212 lines, starts `(function(f){if(typeof exports==="object" ...})(function(){...})`);
top contains `ClientInitializer` for in-process clients (jetstream, expression, body,
audio, media, media-manager, wifi — the exact list the browser sim emulates per doc 04).

README diff (`README.md:295-323`) documents:

> `packages/skills-service-manager/lib/skills-service-manager.js` has two
> hard-coded checks that hit URLs that no longer exist in the restoration
> environment (`stg-entrypoint.<domain>` HTTPS and a JSC Account#get call). Be
> treats a failure on either as "lost connection to jibo servers" and parks in
> an error screen. Both have been patched to no-op `return`s, the original
> bodies are left in place after them for reference.

Plus a `@be/be` launch recipe: `yarn first:local:disable .` (bypass First Contact,
once per checkout) → `yarn sim` (defaults `JetstreamSim_hubHost=pegasus.jibo`) /
`yarn sim:localhost`.

---

## 4. Tests

All five `tests/integration-*` use **Mocha** via `@jibo/floss@^3.0.0` (Electron-
embedded mocha) + `should.js`. `ui-sdk` uses Nightwatch + selenium.

### 4.1 integration-cli (`tests/integration-cli/`)

Scope: `jibo` CLI binary smoke (help/robot-management/negative) without a bot.
Three files in `lib/tests/`: `cli-help-no-bot-tests.js`,
`cli-bot-management-no-bot-tests.js`, `cli-bot-management-no-bot-negative-test.js`.
Driver: `jibo-autobot@^8.0.0` (`package.json:22`).

Representative — `cli-help-no-bot-tests.js:14, :33-42` — `child_process.exec`s
`node packages/jibo-cli/bin/jibo.js help` and string-asserts on the help blob.
Fixture: `lib/cli.json` = `{"robots":[{"name":"gel","ip":"gel-interior-asher-wool.local"}], "defaultRobot":"gel"}`.

`yarn test` is `echo "Skipping integration-cli tests"` (`package.json:8`) — CI
runs subtargets `test:cli-help`, `test:cli-bot-management`, etc.

### 4.2 integration-gui (`tests/integration-gui/`)

Scope: `jibo.rendering.gui.*` (Button, Clip, ContactButton, ContentButton, Label,
List, ListProgress, MenuButton, ContactsView, EyeView, MenuView, FaceRenderer —
`tests/basic.js:1-15`).

Packaged as an `asset-pack` skill (`package.json:6-12`). Build: `tsify --target=es6`
+ browserify + mapstraction + preprocessify (`:33`); `behaviorify` + `rulify` for
flows/rules. Runner: `floss --path tests/index.js`.

Bootstrap (`tests/index.js:16-103`): `ssm.Factory({...port:0 for all sim services...},
rootDir)`, full sim-service list — `AudioServiceSim`, `BodyService`, `DevShell`,
`ErrorService`, `ExpressionService`, `GlobalManagerService`, `KBService`,
`JetstreamServiceSim`, `LPSService`, `MediaManagerService`, `MediaService`,
`PerformanceService`, `SecureTransferServiceSim`, `ServerService`, `SkillsServiceSim`,
`SystemManagerService`, `SystemMonitoringServiceSim`, `TTSService`, `WifiService` —
then `jibo.init({display:"face", registryHost}, done)`. `nock`-stubs `/context` →
200 empty context.

### 4.3 integration-jibo (`tests/integration-jibo/`)

Scope: full `jibo` runtime + SSM. 16 sub-suites under `tests/`: `action`, `animdb`,
`backuprestore`, `bt`, `context`, `dofArbiter`, `embodied`, `emotion`, `expression`,
`gl`, `id`, `kb`, `keys-reference`, `media`, `nlu`, `tts` (`tests/index.js:94-110`).

Bootstrap (`tests/index.js:14-82`): same `Factory({...sim services...})` as
integration-gui but `JetstreamServiceSim:{port:0, hubHost:"dev-hub.jibo.com",
hubPort:443, secure:true}` (`:26-30`). `HTTPService.getPort(0)` for context port,
`nock` stubs `POST /context → 200 {character,perception,location,loop,dialog: {}}`,
then `jibo.init({registryHost}, done)` + `jibo.loader.addCache(jibo.face.eye.CACHE_ID)`.

Runner: `JIBO_JSCMODE=SIMULATOR floss --path index.js` (`package.json:19`). This is
the canonical "boot SSM in Electron with no robot" sequence — the same bootstrap
shape doc 04 emulates in our browser sim.

### 4.4 integration-platform (`tests/integration-platform/`)

Scope: on-robot smoke. Assumes platform Electron + X
(`DISPLAY=:0 XAUTHORITY=/tmp/.Xauthority floss --path index.js --electron /usr/local/electron-x/electron`,
`package.json:19`). Test stub: `expect().is.true(true)` (`tests/index.js:1-11`).
Scaffolding only.

### 4.5 integration-sdk (`tests/integration-sdk/`)

Skill-shaped test target: `animdb-manifest.json`, `launch.rule`, `index.html`,
`schemas/`, `src/`. Build via `jibo-dev` (`package.json:14-19`). No test runner —
serves as a fixture skill for other suites.

### 4.6 integration-skill (`tests/integration-skill/`)

Scope: skill build pipeline. `tests/subtrees.js` verifies BT subtree
compilation/bundling. Same browserify-tsify chain as integration-gui
(`package.json:36-40`). `tests/index.js:1-8` sets `process.env.runMode = 'UNIT_TESTS'`.
Runner: `gulp test`.

### 4.7 ui-sdk (`tests/ui-sdk/`)

E2E driver tests for the SDK's Atom editors (animation-editor, behavior-editor,
flow-editor, mim-editor, rules-editor — `lib/tests/*-editor-tests/`).
Nightwatch + electron-chromedriver (`package.json:9-13`); bundles
`bin/selenium-server-standalone-2.53.0.jar`. `run-tests.sh:1-48` does
`apm link .` of jibo-sdk → `nightwatch -c nightwatch{Windows,}.json` per OS →
HTML report via `nightwatch-html-reporter`.

---

## 5. Cloud skill manifests

Wire shape: `{id, basePath?, baseURL?, intents[], proactives?, IHQueries?, settings?, onRobot?}`.

### 5.1 external-skills (both removed from active config per `_comment_2026`)

**`external-skills/answer_manifest.json:1-168`** —
`id:"answer"`, `basePath:"/answer_skill"`. 27 intents, each with
`memo:{type:<generic|how|what|when|where|who|why>}`. Names: `doesJiboKnowPersonThing`,
`gqa`, `general{How,What,When,Where,Who,Why,Questions}`, `requestTellAboutThing`,
`requestWeather`, `howDescriptorIs{Unknown,Person}`, `isUnknownDescriptor`,
`whyIsUnknownDescriptor`, `whenIsBirthday`, `whoIsPerson` (×3: bare, `given-name=*`,
`last-name=*`), `whereIsPerson` (×3: bare, `given-name=*`, `last-name=*`),
`whereIsThing`. Entity-filter shape `"entities":[{"name":"given-name","value":"*"}]`
(`:103-107` prototype).

**`external-skills/news_manifest.json:1-6`**:
```json
{ "id": "news", "basePath": "/news_skill", "intents": [] }
```
Empty intents — `news` only exists as a `DecisionMediator` rewrite target (§7).

### 5.2 pegasus-skills

**`pegasus-skills/answer_skill_manifest.json:1-19`** —
`id:"answer-skill"`, 13 intents (the external-answer set minus the entity-filter
variants, plus `answerQuestion`). No proactives/settings.

**`pegasus-skills/chitchat_skill_manifest.json`** — 60,090 lines, ~1.6 MB.
`id:"chitchat-skill"`. ~9,260 intent records, each
`memo:{mim:"<MIM_ID>", type:"ScriptedResponse"}` with an intent name + entity filters
(e.g. `name:"canJiboAction", entities:[{name:"Action", value:"AccessThing"}]`,
`memo.mim:"KU_CanYouAccessThing"`). MIM id families: `JBO_*`, `KU_*`, `RI_JBO_*`,
`RA_JBO_*`, `JF_*`. Last record `name:"willJiboReceiveHolidayGift"` with
`Holiday=ValentinesDay` → `mim:"RI_JBO_ReceivesGiftValentinesDay"`.

**`pegasus-skills/report_skill_manifest.json:1-507`** — `id:"report-skill"`.

Intents (`:3-29`, all `memo` is literal string `"Reactive..."`):
`launchPersonalReport`, `requestWeatherPR`, `requestCommute`, `requestCalendar`,
`requestNews`.

Proactive (`:30-92`): `topics:[]`, `memo:"Proactive"`.
- contextRules: `PART_OF_DAY ∈ MORNING/{EARLY,MID,LATE}`; `DAY_OF_WEEK ∈ {0..6}`;
  `TRIGGER_SOURCE EXACT SURPRISE`; `FOCUSED_PERSON NOT UNKNOWN`.
- IHRules: `PersonalReportLaunchCount7LastHours LESS_THAN 1`.
- settingsRules: `report-skill.offerProactively EXACT {"value":true}`.

IHQuery `PersonalReportLaunchCount7LastHours` (`:94-104`): `type:"Count"`,
`skillID EXACT "report-skill"`, window `[-7h, 0h]`.

Settings (`:106-505`) — full nested settings tree, type `skill`, title
"Personal report". Top-level children:
1. switch "Offer report proactively" → `person.offerProactively=true`.
2. switch "Weather" → `person.weatherEnabled`; child choice `person.weather`
   = `[{0:Fahrenheit},{1:Celsius}]`; footer linking placeholder `JIBO_SETTINGS`.
3. switch "Commute" → home/work `locationTextField`s, `commuteType` choice
   (Drive/Public transport/Bike/Walk), `commuteTime` time picker.
4. switch "Calendars" → personal/work `connectable`s; each with Google OAuth
   (`iosClientId:830717411721-cve42qbj1n333d85g94cunacq04b578v...`,
   `serverClientId:830717411721-5nqkekk2bkvail90qkr8kuhe8v1lu58t...`,
   scope `calendar.readonly`) and Outlook OAuth
   (`iosClientId:398130f2-af6f-42df-8935-18b351383656`, scopes
   `offline_access`, `Calendars.Read`); valueDefinitions on `lasso.google:*` /
   `lasso.outlook:*` keys.
5. switch "News" → `person.newsEnabled`; toggles International, National,
   Business, Entertainment, Sports, Health, Politics, Science, Technology, Strange.
6. footer tutorial copy.

**`pegasus-skills/example_skill_manifest.json:1-17`** —
`id:"example-skill"`, intent `doesJiboLikeThing memo:"SomeThing"`, one proactive
`topics:["fake topic 1"], contextRules:[]`. Reference template.

**`pegasus-skills/template_skill_manifest.json:1-12`** —
`id:"template-skill"`, intent `template_skill memo:{entry:"SomeThing"}`.

### 5.3 be-skills — all have `"onRobot": true`

Common intent shape:
```json
{
  "name": "<intent>",
  "entities": [{"name":"skill","value":"@be/<skill>","matchRule":"EXACT"}],
  "memo": "Launch intent"
}
```

The `skill EXACT @be/<name>` entity filter is the disambiguator: NLU must surface
this slot for the be-skill to win against chitchat/answer.

| Manifest | id | Intents (n) | Proactives | Lines |
|---|---|---|---|---|
| `circuit_saver_manifest.json` | `@be/circuit-saver` | `launchGame` (1) | – | `:1-14` |
| `clock_manifest.json` | `@be/clock` | `menu`, `askForDate`, `askForTime`, `whenIsHoliday`, `whenIsBirthday` (×3: bare, +`loopMemberReferent=*`, +`loopmember=speaker`), `start`, `stop`, `query`, `set`, `delete`, `restart`, `edit` (13) | – | `:1-135` |
| `create_manifest.json` | `@be/create` | `createOnePhoto`, `createSomePhotos` (2) | – | `:1-23` |
| `exercise_manifest.json` | `@be/exercise` | `exerciseDoYoga`, `exerciseYogaTutorial`, `exerciseWantTo`, `exerciseLike` (4) | – | `:1-41` |
| `friendly_tips_manifest.json` | `@be/friendly-tips` | `frustrated`, `whatCanIDo` (2) | – | `:1-23` |
| `gallery_manifest.json` | `@be/gallery` | `galleryOpen` (1) | – | `:1-14` |
| `greetings_manifest.json` | `@be/greetings` | `happyHoliday`, `imHome`, `imBack`, `heyJibo`, `hello`, `whatsUp`, `goodMorning`, `goodAfternoon` (×2 dup), `goodEvening`, `goodNight`, `goodBye`, `notifications`, `selfID` (14) | yes (see below) | `:1-163` |
| `hue_control_manifest.json` | `@be/hue-control` | `lights{DeleteData, Setup, SetupDefaultGroup, On, GroupOn, Off, GroupOff, Up, GroupUp, Down, GroupDown, UpCompletely, GroupUpCompletely, Warm, GroupWarm, Cool, GroupCool, Color, ColorGroup, HowTo}` (20) | – | `:1-186` |
| `ifttt_manifest.json` | `@be/ifttt` | `ifttt` (1) | – | `:1-14` |
| `introductions_manifest.json` | `@be/introductions` | `enrollment` (×2: bare, +`style=RequestToMeet`+`loopMemberReferent=*`) | – | `:1-34` |
| `main_menu_manifest.json` | `@be/main-menu` | `launchMainMenu` (1) | – | `:1-14` |
| `radio_manifest.json` | `@be/radio` | `play`, `showStations`, `unsupportedGenre` (3) | – | `:1-33` |
| `settings_manifest.json` | `@be/settings` | `menu`, `battery`, `volumeQuery`, `storageStatus`, `wifiStatus`, `updates` (6) | – | `:1-59` |
| `surprises_ota_manifest.json` | `@be/surprises-ota` | `releaseNotes` (1) | – | `:1-14` |
| `tutorial_manifest.json` | `@be/tutorial` | `tutorialOpen` (1) | – | `:1-14` |
| `who_am_i_manifest.json` | `@be/who-am-i` | `launchWhoAmI` (1) | – | `:1-14` |
| `word_of_the_day_manifest.json` | `@be/word-of-the-day` | `play`, `like`, `tutorial` (3) | – | `:1-32` |

Greetings proactive (`greetings_manifest.json:131-162`): `topics:[]`, `memo:"Proactive Launch"`;
`contextRules:[{TRIGGER_SOURCE NOT SURPRISE}]`;
`IHRules:[{GreetingsLaunchLast2Hours LESS_THAN 1}]`;
`IHQueries.GreetingsLaunchLast2Hours: Count, skillID EXACT "@be/greetings", [-2h..0h]`.

---

## 6. skills-local.json (full, verbatim)

`/tmp/pegasus-phoenix/packages/hub/resources/skills/skills-local.json:1-73`:

```json
{
    "skills": [
        { "baseURL": "http://answer-skill:8080",   "configPath": "pegasus-skills/answer_skill_manifest.json" },
        { "baseURL": "http://report-skill:8080",   "configPath": "pegasus-skills/report_skill_manifest.json" },
        { "baseURL": "http://chitchat-skill:8080", "configPath": "pegasus-skills/chitchat_skill_manifest.json" },
        { "configPath": "be-skills/circuit_saver_manifest.json" },
        { "configPath": "be-skills/clock_manifest.json" },
        { "configPath": "be-skills/create_manifest.json" },
        { "configPath": "be-skills/exercise_manifest.json" },
        { "configPath": "be-skills/friendly_tips_manifest.json" },
        { "configPath": "be-skills/gallery_manifest.json" },
        { "configPath": "be-skills/greetings_manifest.json" },
        { "configPath": "be-skills/hue_control_manifest.json" },
        { "configPath": "be-skills/ifttt_manifest.json" },
        { "configPath": "be-skills/introductions_manifest.json" },
        { "configPath": "be-skills/main_menu_manifest.json" },
        { "configPath": "be-skills/radio_manifest.json" },
        { "configPath": "be-skills/settings_manifest.json" },
        { "configPath": "be-skills/surprises_ota_manifest.json" },
        { "configPath": "be-skills/tutorial_manifest.json" },
        { "configPath": "be-skills/who_am_i_manifest.json" },
        { "configPath": "be-skills/word_of_the_day_manifest.json" }
    ],
    "notes for humans": {
        "hub": "is on port 9000",
        "history_service": "is on port 9006",
        "lasso": "is on port 9007"
    },
    "_comment_2026": "Removed external GQA answer + AP-news skill entries (originally docker.for.mac.localhost:9002, hosted services not in this monorepo)."
}
```

- Only `answer-skill`, `report-skill`, `chitchat-skill` carry `baseURL` (HTTP-served
  pegasus monorepo services). `@be/*` are `configPath`-only — manifest on hub, runtime
  on robot.
- `_comment_2026`: the two `external-skills/*` entries (pointing at
  `docker.for.mac.localhost:9002`) were removed during 2026 restoration. The
  DecisionMediator still rewrites to `news` — see §7 / sim M55.

---

## 7. DecisionMediator overrides

`/tmp/pegasus-phoenix/packages/hub/src/intent/DecisionMediator.ts:1-78` (full):

```ts
import * as semver from 'semver';
import { nlu, asr } from '@jibo/interfaces';
import { Decision } from './interfaces';

const RELEASE_NOT_FOUND = "RELEASE_NOT_FOUND";
const HASHBROWN_RELEASE = '1.9.0';

export function mediateDecision(
    decision: Decision, asr: asr.ASRResult,
    nlu: nlu.NLUResult, release: string
): Decision {
    let alteredDecision: Decision;

    if (release === RELEASE_NOT_FOUND) {
        release = HASHBROWN_RELEASE;  // jibo-tbd missing → assume hashbrown
    }

    const version = semver.valid(semver.coerce(release));
    if (semver.lt(version, HASHBROWN_RELEASE)) {  // fajita-and-earlier
        if (decision.skillID === 'report-skill') {
            switch (nlu.intent) {
                case 'launchPersonalReport':
                    alteredDecision = { skillID: 'chitchat-skill',
                        memo: { mim: "KU_GiveMeA", type: "ScriptedResponse" } };
                    break;
                case 'requestWeatherPR':
                    alteredDecision = { skillID: 'answer' };
                    break;
                case 'requestCommute':
                    alteredDecision = { skillID: 'chitchat-skill',
                        memo: { mim: "RA_JBO_Traffic", type: "ScriptedResponse" } };
                    break;
                case 'requestCalendar':
                    alteredDecision = { skillID: 'chitchat-skill',
                        memo: { mim: "RA_JBO_Calendar", type: "ScriptedResponse" } };
                    break;
                case 'requestNews':
                    alteredDecision = { skillID: 'news' };
                    break;
                default:
                    alteredDecision = { skillID: 'chitchat-skill',
                        memo: { mim: "KU_AreYouAbleTo", type: "ScriptedResponse" } };
                    break;
            }
        }
    }
    return alteredDecision;
}
```

### Rewrite table (release < `1.9.0` AND IR pick = `report-skill`)

| `nlu.intent` | rewritten skillID | rewritten memo |
|---|---|---|
| `launchPersonalReport` | `chitchat-skill` | `{mim:"KU_GiveMeA", type:"ScriptedResponse"}` |
| `requestWeatherPR`     | `answer`         | – |
| `requestCommute`       | `chitchat-skill` | `{mim:"RA_JBO_Traffic", type:"ScriptedResponse"}` |
| `requestCalendar`      | `chitchat-skill` | `{mim:"RA_JBO_Calendar", type:"ScriptedResponse"}` |
| `requestNews`          | `news`           | – |
| (default)              | `chitchat-skill` | `{mim:"KU_AreYouAbleTo", type:"ScriptedResponse"}` |

### Why sim M55 stamps `release='1.9.0'`

`HASHBROWN_RELEASE = '1.9.0'` (`DecisionMediator.ts:7`). If `release === RELEASE_NOT_FOUND`
the mediator coerces to hashbrown (`:21`). But the sim was sending an
*invalid/empty* release that `semver.coerce` resolved to `0.0.0` — fajita per
`semver.lt('0.0.0','1.9.0')`. So every `report-skill` decision was rewritten to
`chitchat-skill` or `news`, and `news` doesn't exist in active skills-local.json
(§6 `_comment_2026`), so news died silently. Fix: stamp
`CONTEXT.data.general.release='1.9.0'` (sim commit `0011993` M55) to clear the gate.

On a real hashbrown robot news works because the rewrites only activate for
fajita-and-earlier — hashbrown+ keeps the original `report-skill` decision and
`report-skill` handles `requestNews` itself by talking to lasso for AP-News.

---

## 8. Cross-reference — container/host addresses

From `/tmp/pegasus-phoenix/docker-compose.yml:25-153` +
`docker-compose.override.yml:1-32`:

| Skill id | `baseURL` (in-network) | Container | Host port | Notes |
|---|---|---|---|---|
| `answer-skill` | `http://answer-skill:8080` | `answer-skill` (override `:2-19`) | `9009:8080` | `node /skill/server.js`, image `node:20-slim`, vol `./packages/answer-skill:/skill:ro`, env `ETCO_answer_llmUrl=http://192.168.1.252:1234/v1`, `ETCO_answer_llmModel=google/gemma-4-e4b` (LLM-backed) |
| `report-skill` | `http://report-skill:8080` | `report-skill` (compose `:97-111`) | `9003:8080` | env `NET_lasso=lasso:8080`, `NET_settings=settings.jibo.aws`, `prefsFromConfig=true` |
| `chitchat-skill` | `http://chitchat-skill:8080` | `chitchat-skill` (compose `:85-95`) | `9004:8080` | `/pegasus/packages/chitchat-skill` |
| `answer` (external, **disabled**) | was `http://docker.for.mac.localhost:9002` | – | – | external GQA — removed per `_comment_2026` |
| `news` (external, **disabled**) | was `http://docker.for.mac.localhost:9002` | – | – | external AP-News — removed per `_comment_2026` |
| `hub` | – | `hub` (compose `:27-53`) | `9000:8080` | env `ETCO_hub_skillsConfig=skills-local.json` (`:32`), `NET_parser=parser:8080`, `NET_history=history:8080` |
| `parser` (NLU) | – | `parser` (compose `:54-65`) | `9005:8080` | env `ETCO_parser_dialogflow_key=...` (`:62`); override adds `ETCO_parser_llmEnabled=true`, `llmUrl=http://192.168.1.252:1234/v1` |
| `history` | – | `history` (compose `:67-83`) | `9006:8080` | mongo `history_mongos:27017` |
| `lasso` | – | `lasso` (compose `:113-137`) | `9007:8080` | DarkSky + Google Maps + AP News keys; redis + mongo_lasso |

Override-only changes (`docker-compose.override.yml`):
- `answer-skill` is an LLM-backed standalone server on `9009`, vol-mounted from
  `./packages/answer-skill` (`:2-19`).
- `hub` adds `ETCO_server_asrProvider=parakeet`, `parakeetUrl=http://192.168.1.252:6972`,
  `ETCO_hub_disableAuth=true` (`:20-24`).
- `parser` adds `ETCO_parser_llmEnabled=true` + LLM URL (`:28-32`).
- `lasso` swaps `ETCO_lasso_googleMapsKey` to a new OpenRouteService-style token
  (`:25-27`).

Inside the docker network all baseURLs resolve via container DNS. From outside —
e.g. a browser sim wanting to ping the hub directly — host ports are: `9000` (hub),
`9003` (report), `9004` (chitchat), `9005` (parser), `9006` (history), `9007`
(lasso), `9009` (answer-skill).

---

## 9. File:line index

- `/tmp/sdk/setup.sh:1-23`, `/tmp/sdk/switch_jsc_cloud.sh:1-43`,
  `/tmp/sdk/package.json:3-22`.
- `/tmp/sdk/packages/jibo-cli/src/cli/commands/sim.ts:10-39`,
  `.../src/launcher/launcher.ts:108-163`,
  `.../src/get-electron-path.ts:18-30`,
  `.../bin/jibo-sim.js:1-2`.
- `/tmp/sdk/Jenkinsfile:25-30`, `:36-106`, `:114-138`, `:185-189`.
- `/tmp/sdk/packages/jibo-cli/gulpfile.js:1-58`;
  `tasks/{on-build,simulator,simulator-client,styles,font-awesome}.js`.
- Patched-SSM commit `d8c30682e3`:
  `packages/skills-service-manager/lib/skills-service-manager.js` (18,212 lines),
  `README.md:295-323`.
- Test bootstraps: `/tmp/sdk/tests/integration-jibo/tests/index.js:14-82`,
  `/tmp/sdk/tests/integration-gui/tests/index.js:16-103`.
- Hub config: `/tmp/pegasus-phoenix/packages/hub/resources/skills/skills-local.json:1-73`.
- DecisionMediator: `/tmp/pegasus-phoenix/packages/hub/src/intent/DecisionMediator.ts:1-78`.
- Manifests: `/tmp/pegasus-phoenix/packages/hub/{external-skills, pegasus-skills, be-skills}/*.json`.
- Compose: `/tmp/pegasus-phoenix/docker-compose.yml`, `docker-compose.override.yml`.
