# 12 — Be-skills audit (every skill, what it does, what it touches)

Source root: `/tmp/sdk/skills/*`. Every claim anchored at `file:line`.
Every Skill below is an asset-pack package exporting a class that extends
`BeSkill` (or `SurpriseElement`, which itself extends `BeSkill`). Registered
in the top-level `be` bundle (`/tmp/sdk/skills/be/package.json`) and loaded
by the Be runtime.

Skill lifecycle (`/tmp/sdk/skills/be-framework/src/BeSkill.ts`):

- `preload(done)` — once per instance before first `open()`.
- `postInit(done)` — after framework init; opens KBs, registers crons.
- `open(result, refresh, prevSkillName, prevOpts)` — launch entry. `result`
  is typically a `jibo.jetstream.types.ListenResult` (NLU + cloud response).
- `close(done)` — internal `'exit'` event → close handler (`:298`).
- `redirect(skill, opts)` (`:452`), `exit(opts)` (`:438`).

Static `BeSkill.plugins` (`:94`) — `.analytics`, `.context`. Every per-skill
`Analytics` class dispatches through
`BeSkill.plugins.analytics.currentSkill` (see Nimbus deep dive).

Per-skill `jibo.*` API usage is summarized in the **cross-skill matrix** at
the bottom; the per-skill sections call out only the **load-bearing** APIs
(the one or two each skill is unique for).

---

## @be/clock — ClockSkill

- **Package**: `@be/clock` v12.0.1, main `index.js`.
- **Entry**: `src/index.js:18` `class ClockSkill extends BeSkill`.
- **What it does**: Time/date/birthday/holiday queries + alarms + timers.
  `open()` (`src/index.js:92`) picks a sub-skill by domain+intent
  (`timer`/`alarm`/`clock` × menu/askForTime/askForDate/whenIsBirthday/…).
- **Skill shape**: sub-skills extend `SubSkill` (`src/JiboClock.js:35`).
  `postInit()` (`:64`) loads KB `/jibo/clock/alarm_timer` and runs
  `CronJobManager.restoreJobs(model)` to resurrect timers across boot.
- **Load-bearing APIs**: `jibo.kb.onInit`,
  `jibo.kb.createModel('/jibo/clock/alarm_timer')`,
  `jibo.timer.setInterval`. Plus the usual flow/face/sound.
- **Mims** (`mims/`, flat): `TodaysDate.mim`, `BirthdayToday.mim`,
  `HolidayJustPassed.mim`, `AlarmTimer_Change.mim`,
  `AlarmTimer_TurningOff.mim`, plus Birthday/Holiday-N-To-M variants.
- **Flows**: `src/flows/alarmTimer{Cancel,Finished,Main,Query,Set}.flow`.
- **Assets**: `audio/` (alarm/timer chimes).
- **Cloud**: none.

## @jibo/chitchat-mims — chitchat mim library

- **Package**: `@jibo/chitchat-mims` v4.0.1
  (`/tmp/sdk/skills/chitchat-mims/package.json:2`).
- **Entry**: empty placeholder (`src/index.ts:1`
  `// Empty placeholder file for build purposes`).
- **What it does**: Not a skill — asset-only mim library consumed by the
  cloud chitchat container (and by nimbus error fallbacks). 3,889 `.mim`
  files (`find … -name *.mim | wc -l = 3889`):
  - `mims/core-responses/` — Jibo's voice
    (`JBO_AreYouGod.mim`, `JBO_DoYouHaveSuperPowers.mim`, …).
  - `mims/core-responses/deflector/` — deflection when chitchat punts.
  - `mims/gqa-responses/` — GQA fallbacks (`CC_GQA_Answer.mim`,
    `CC_GQA_Failure_{what,who,why,when,where,how,which}.mim`).
  - `mims/scripted-responses/`, `mims/emotion-responses/`.
- **jibo.* APIs**: none (no runtime code).
- **Cloud**: cloud `chitchat-skill` (renamed `chitchat` by Nimbus's
  `SkillRename`) selects from this pool and ships the chosen mim down
  inside a SLIM action.

## @be/circuit-saver — CircuitSaver

- **Package**: `@be/circuit-saver` v7.0.1.
- **Entry**: `src/CircuitSaver.ts:10` `extends BeSkill`; `open(:44)`,
  `close(:77)`. Game state in `GameView.ts`, attention/face in
  `FaceWatcher.ts` + `BetterCenter.ts`.
- **What it does**: "Jibo's overheating circuits" head-tilt minigame —
  player leans left/right to steer Jibo's circuits.
- **Load-bearing APIs**: `jibo.lps.events`, `jibo.lps.motionData`,
  `jibo.media.getViewfinder`, `jibo.expression.acquireTarget`,
  `jibo.tts.speak` directly (rare among skills),
  `jibo.mim.silentMenus = true`, `jibo.mim.end`.
- **Mims** (`mims/en-us/`): `CS_Intro*.mim`, `CS_Countdown.mim`,
  `CS_{Zero,Low,High}Score.mim`, `CS_YouFinished.mim`,
  `CS_{Face,Lean}Error.mim`, `CS_SinglePlayerOnly.mim`.
- **Flows**: `main.flow`, `faceYou.flow`.
- **Assets**: `animations/`, `assets/audio/`.
- **Cloud**: none.

## @be/create — Create (photo)

- **Package**: `@be/create` v9.0.1.
- **Entry**: `src/index.ts:11` `class Create extends BeSkill`. `open(:55)`,
  `close(:119)`. `preload()` (`:46`) loads `audio/Shutter_01.m4a` into
  `jibo.loader.activeCache`.
- **What it does**: Take-a-photo. Find faces (`FaceFinder`, `FaceSearcher`,
  `FaceScore`), frame them (`FrameHelper`), shutter, save.
- **Load-bearing APIs**: `jibo.action.addFindPersonGoal`,
  `jibo.media.{setViewfinder,takePhoto,storePhoto}`,
  `jibo.lps.{demandDetect,getFaces}`,
  `jibo.rendering.{eye,FaceRenderer,gui}` directly,
  `jibo.face.{eye,MenuView,width,height}`,
  `jibo.mim.shouldShowGUI`.
- **Mims** (`mims/en-us/`): `LookingForYou.mim`, `FoundYou.mim`,
  `IsItAKeeper.mim`, `TakeAnotherPhoto.mim`, `LookGood*.mim`,
  `SaveMedia.mim`, `PhotoRollup.mim`.
- **Flows**: `create-main.flow` + `subs/`.
- **Cloud**: none.

## @be/exercise — Exercise

- **Package**: `@be/exercise` v3.0.1.
- **Entry**: `src/Exercise.ts:16` `extends BeSkill`. `open(:95)`,
  `close(:292)`. `Rounds.ts` schedules rounds; `Routines.ts` holds the
  workout library; `Audio.ts` does the music.
- **What it does**: Guided workout — warmup → rounds → cooldown with
  music and pose images.
- **Load-bearing APIs**: `jibo.expression.{centerRobot,setLEDColor}`,
  `jibo.jetstream.{HotwordModeToken,setHotwordMode}`,
  `jibo.rendering.{eye,gui,tween}`, `jibo.sound.SoundInstance`.
- **Mims** (`mims/en-us/`): `ExerciseDailyIntentionIntro.mim`,
  `ExerciseRoundPart.mim`, `ExercisePause{Hold,Quit}.mim`,
  `ExerciseLoveIt.mim`, `ExerciseRoutine{Liked,DidntLike}.mim`,
  `ExerciseBailed.mim`, `ExerciseNotReady.mim`.
- **Flows**: `main.flow`, `executeRoutine.flow`.
- **Assets**: `resources/music/`, `resources/images/poses/`,
  `resources/icons/`.
- **Cloud**: none.

## @be/first-contact — FirstContactSkill (OOBE)

- **Package**: `@be/first-contact` v11.0.1.
- **Entry**: `src/index.ts:13` `class FirstContactSkill extends BeSkill`.
- **What it does**: First-boot meet-Jibo flow → hands off to
  `@be/introductions` for enrollment.
- **Skill shape**: `open()` (`:36`) sets `_isInterruptible = false`, calls
  `jibo.action.configure({orientToHJ: false})` (`:38`),
  `jibo.globalEvents.touchStop.on(handleHeadTouch)` (`:40`), and pushes
  `AttentionMode.OFF` for the awakening segment (`:44`).
- **Load-bearing APIs**: `jibo.action.configure`, `jibo.globalEvents.touchStop`,
  `jibo.jetstream.setHotwordMode`,
  `jibo.kb.createModel`+`kb.loop`, `jibo.lps.motionData`.
- **Mims** (`mims/en-us/oobe/`): `FC_IAmReallyHere.mim`,
  `FC_IAmYourRobot.mim`, `FC_IAmVeryNew.mim`, `FC_SayLoopNames.mim`.
- **Flows**: `awakening/`, `introduction.flow`, `main.flow`.
- **Cloud**: none.

## @be/friendly-tips — FriendlyTips

- **Package**: `@be/friendly-tips` v10.0.1.
- **Entry**: `src/FriendlyTips.ts:11` `extends BeSkill`. `open(:48)`,
  `close(:98)`.
- **What it does**: Card-based "did you know" tips. `CardSelector.ts`
  weighted-picks from `CardData.ts` by `Category.ts`; `CardDisplay.ts`
  renders.
- **Mims** (`mims/en-us/`): `CuriousIntro.mim`, `FrustratedIntro.mim`,
  `SayHeyJibo.mim`, `WantMoreTTD.mim`.
- **Flows**: `main.flow`.
- **Cloud**: none.

## @be/gallery — Gallery

- **Package**: `@be/gallery` v8.0.1.
- **Entry**: `src/index.ts:14` `class Gallery extends BeSkill`.
  `open(:44)` closes-and-reopens on `refresh`. `close(:102)`.
- **What it does**: Browse Jibo's photos/videos; tap to view, swipe,
  delete (confirmation flow).
- **Load-bearing APIs**: `jibo.kb.media`,
  `jibo.media.{deletePhoto,getUrl}`, `jibo.face.{TouchManager,tween}`.
- **Mims** (`mims/en-us/`): `{Open,Reopen,Empty}Gallery.mim`,
  `ConfirmDeleteItem.mim`, `DeleteFromGallery.mim`, `NoDelete*.mim`,
  `NoMoreItems.mim`, `GalleryUnavailable.mim`, `EmptyCancel.mim`.
- **Flows**: `main.flow`, `itemView.flow`, `deleteItem.flow`,
  `actualDelete.flow`.
- **Cloud**: none.

## @be/greetings — GreetingsSkill

- **Package**: `@be/greetings` v12.0.1.
- **Entry**: `src/index.ts:5` exports `{ Skill: GreetingsSkill, Utils }`.
  `src/GreetingsSkill.ts:19` `extends BeSkill`. `open(:118)`, `close(:130)`.
- **What it does**: Hi/hello/good-morning + holiday + sleep/day-empathy.
  Drives a state machine (`GreetingsSM.ts`) with ~30 states under
  `src/states/` (HelloState, HeyJiboIntentState, ProactiveGreetingState,
  ShouldDoBirthdayState, SleepEmpathyResponseState, …).
- **Load-bearing APIs**: `jibo.action.applyMotivationalEffect`,
  `jibo.action.getMotivationalDriveValue`, `jibo.lps.identity`,
  `jibo.kb.{createModel,loop,Model,Node,UserNode}`.
- **Mims** (`mims/`): `GreetingAfternoon.mim`, `GoodMorningEcho.mim`,
  `WhatsUpResp.mim`, `ProactiveVerbalGreetingPlayful.mim`,
  `BedtimeReminder.mim`, `{Day,Sleep}QualityBetter.mim`,
  `NotHoliday.mim`.
- **Flows**: `Greeting.flow`.
- **Cloud**: none.

## @be/hue-control — HueControl

- **Package**: `@be/hue-control` v3.0.1.
- **Entry**: `src/HueControl.ts:18` `extends BeSkill`. `open(:67)`,
  `close(:177)`. Bridge REST client at `src/api/`; orchestration in
  `HueControler.ts`.
- **What it does**: Philips Hue bridge pairing + light control.
- **Load-bearing APIs**: `jibo.expression.pushAttentionMode`,
  `jibo.expression.AttentionHandle`.
- **Mims** (`mims/en-us/`): `LightsControl{FirstTime,WantToSetup}.mim`,
  `LightsSetup{PressLink,FoundBridge,NoBridges,TooLong,Failure1}.mim`,
  `Lights{Command,UpCompletely}Failure*.mim`, `LightsDownAreOff.mim`.
- **Flows**: `Main.flow`, `Setup.flow`, `SetupDefaultGroup.flow`,
  `HueTutorial.flow`, `Command.flow`, `ControlCheck.flow`,
  `PostControl.flow`, `DeleteHueData.flow`.
- **Cloud**: none (LAN only).

## @be/idle — Idle (default skill)

- **Package**: `@be/idle` v13.0.1.
- **Entry**: `src/index.ts:10` → `src/main/Idle.ts:32` `extends BeSkill`.
- **What it does**: The ambient skill — runs whenever nothing else is.
  Owns circadian state (ALERT/RELAXED/SLEEPY/SLEEP via
  `CircadianStateMachine`), look-around behaviors, hotword/touch
  routing, the screen-touch → main-menu hook.
- **Skill shape (rich)**:
  - `postInit()` (`:95`): `screenDofs = jibo.expression.dofs.ALL.minus(BODY)
    .minus(EYE_TRANSLATE).minus(LED)` (`:101`); init `kbModel`.
  - `preload()` (`:111`): `jibo.timer.on('update', updateBinding)`;
    `jibo.expression.setAttentionMode(AttentionMode.IDLE)` (`:116`).
  - `open(result, refresh)` (`:125`): forces
    `jibo.mim.shouldShowGUI = false`, `jibo.mim.silentMenus = false`;
    subscribes circadian event handlers; opens or replaces session.
  - `forceEyeView()` (`:167`): temp `'Test'` arbiter cleanup,
    `jibo.face.views.forceEyeView(resolve, onTouchBind, IN, UP, reject)`.
  - `onTouch()` (`:191`): if state ∈ {ALERT, RELAXED} →
    `redirect('@be/main-menu', { intent: 'tap' })`; else wake circadian.
  - `close()` (`:205`): clears actions on `currentView`, drops timer
    listener, unsubscribes events, clears anim queue, releases attention
    mode.
- **Launch rule**:
  `TopRule = ($* ($GO_TO | $STOP | $SHUT_UP | $SLEEP | $NOT_YOU) $* {domain='idle'}{skill='\@be/idle'});`
  (`/tmp/sdk/skills/idle/launch.rule:1`).
- **Load-bearing APIs**: `jibo.action.setCurrentCircadianState`,
  `jibo.expression.cleanup`, `jibo.expression.dofs.ALL.minus(...)`,
  `jibo.face.views.forceEyeView`, `jibo.jetstream.resetHotwordMode`,
  `jibo.lps.detector`, `jibo.globalEvents.sleep`.
- **Mims** (`mims/`): `TurnBackQuestion.mim`,
  `TurnBackAnnouncement.mim`, `IdleNMExplanation.mim`.
- **Flows**: `turnAway.flow`, `global/`, `nomatch/`.
- **Cloud**: none.

## @be/ifttt — IFTTT

- **Package**: `@be/ifttt` v7.0.1.
- **Entry**: `src/index.ts:9` `class IFTTT extends BeSkill`. `open(:38)`,
  `close(:68)`. Declares `allowedInterrupts = ['@be/idle']` (`:19`).
- **What it does**: Triggers IFTTT recipes via `ServerController.ts` HTTP.
- **Load-bearing APIs**: `jibo.systemManager.getCredentials`.
- **Mims** (`mims/`): `NoTrigger.mim`, `Success.mim`, `Delegate.mim`,
  `Failure.mim`, `Working.mim`.
- **Flows**: `main.flow`, `delegate.flow`, `send.flow`.
- **Assets**: `animations/`, `audio/`.
- **Cloud**: IFTTT HTTP — not JCP.

## @be/introductions — Introductions (enrollment)

- **Package**: `@be/introductions` v6.0.1.
- **Entry**: `src/index.ts:8` `class Introductions extends BeSkill`.
  `postInit` (`:42`) loads `/introductions` KB root.
  `open(result, refresh, previousSkillName)` (`:48`) closes+reopens on
  refresh. `close()` (`:141`).
- **What it does**: Voice + face + name enrollment. Delegates to
  `VoiceEnroller`, `FaceEnroller`, `NameEnroller` (`src/enrollment/`).
- **Load-bearing APIs**: `jibo.jetstream.createSpeakerModel`,
  `jibo.jetstream.initNameLearning`,
  `jibo.jetstream.startEnrollmentTurn`,
  `jibo.jetstream.startNameLearningTurn`,
  `jibo.jetstream.removePendingSamples`, `jibo.jetstream.request`,
  `jibo.action.addFindPersonGoal`.
- **Mims** (`mims/en-us/`): `CaptureHJ_{Prompt,Success,SuccessJoke,Error1}.mim`,
  `FaceCapture_{Status,Failure,WasteTime}.mim`,
  `IntroToVoiceAndFaceTraining.mim`, `AnyMoreIntros.mim`,
  `TellMeYourFirstNameAgain.mim`.
- **Flows**: `CaptureFace.flow`, `CaptureFirstName.flow`,
  `CaptureHeyJibo.flow`, `VoiceFaceTraining.flow`.
- **Assets**: `animations/`, `audio/`, `RadialMask.js` GUI helper.
- **Cloud**: none.

## @be/main-menu — MainMenu

- **Package**: `@be/main-menu` v10.0.1.
- **Entry**: `src/index.ts:7` `class MainMenu extends BeSkill`.
- **What it does**: Top-level skill picker (voice or tap). `open()`
  detects modality: tap sets `jibo.mim.silentMenus = true` (`:34`);
  voice or skill-return tracked differently. `skillChosen` (`:21`)
  blocks stale launches once a sub-skill is picked.
- **Load-bearing APIs**: `jibo.jetstream.mimicGlobalTurn`,
  `jibo.globalEvents.shared`, `jibo.mim.silentMenus`.
- **Mims** (`mims/en-us/`): `ChooseSkill.mim`, `AlreadyOnMenu.mim`.
- **Flows**: `main.flow`.
- **Assets**: `animations/`.
- **Cloud**: none.

## @be/nimbus — Nimbus (cloud-skill executor)

- **Package**: `@be/nimbus` v3.0.1. `src/index.ts:1` exports
  `{ Skill: Nimbus, MimRunner, ProcessCloudState }`.
- **What it does**: On-robot executor for every cloud skill — chitchat,
  GQA `answer`, news, personal-report, music, weather, …. The launch
  rule sends everything tagged with a cloud-skill ID here:
  `TopRule = $* do nimbus $* {skill='\@be/nimbus'}{cloudSkill='NA'};`
  (`launch.rule:1`). See the **Nimbus deep dive** below.
- **Skill shape**: `Nimbus extends BeSkill` (`src/Nimbus.ts:16`); drives
  an **outer SM** (start ↔ tech-error fallback) and a **core SM**
  (init → processCloud → doCloudAction → waitForAdditional → done).
- **Mims**: single error mim `mims/CloudSkillError.mim`.
- **Cloud**: this *is* the cloud-skill interaction layer.

## @be/radio — Radio (iHeart)

- **Package**: `@be/radio` v4.0.1.
- **Entry**: `src/Radio.ts:40` `extends BeSkill`. `open(:184)` and a
  900-line `close(:854)`. `DanceController.ts` schedules anims to the
  beat; per-locale genre menus under `assets/genreMenus/{us,ca}/`.
- **Load-bearing APIs**: `jibo.systemManager.getIdentity`,
  `jibo.expression.cleanup`, `jibo.expression.dofs`.
- **Mims** (`mims/en-us/`): `RadioGetGenre{,CA}.mim`,
  `RadioFirstTimeStation.mim`, `Current{Station,Track}.mim`,
  `Radio{Recovery,Crashed,Down,Failure}.mim`, `PresentingIHeart.mim`.
- **Flows**: `Main.flow`.
- **Assets**: `assets/player/`, `assets/genreMenus/{us,ca}/`,
  `assets/icons/`, `assets/volume/`.
- **Cloud**: iHeartRadio API only, not JCP.

## @be/remote — Remote

- **Package**: `@be/remote` v4.0.1.
- **Entry**: `src/index.ts:16` `class Remote extends BeSkill`.
  `open(:36)` / `close(:84)`. Tracks `ANIM_STATE` (OPENING/CLOSING/
  OPENED/CLOSED/SKIPPED) (`:9`). `silentRemote` intent skips the
  transition anim (`:51`).
- **What it does**: When a Be-Remote / dev tools client connects via
  jibo-command-protocol, this skill takes the face and freezes mim
  selection until disconnect.
- **Mims** (`mims/`): `TransitionEntry.mim`, `TransitionExit.mim`.
- **Assets**: `resources/audio/`.
- **Cloud**: no JCP — local socket via jibo-command-protocol.

## @be/restore — Restore

- **Package**: `@be/restore` v6.0.1.
- **Entry**: `src/index.ts:22` `class Restore extends BeSkill`.
- **What it does**: Factory-restore / re-pair flow. Polls for a UGC key,
  shows waiting/success/error GUI views, reboots via systemManager.
  Status enum `UGC_KEY_TIMEOUT/RESTORE_SUCCESS/RESTORE_FAILED/REFRESH_FAILED/CANCELED`
  (`:15`).
- **Load-bearing APIs**: `jibo.systemManager.reboot`,
  `jibo.systemManager.restore`.
- **Mims**: none.
- **Flows**: none — raw GUI views from `resources/views/waiting.json`,
  `success.json`, `errors.json` (`src/index.ts:8-11`).
- **Cloud**: none.

## @be/rosbridge — JiboRosbridgeReceiver

- **Package**: `@be/rosbridge` v4.0.0.
- **Entry**: `src/index.ts:37`
  `class JiboRosbridgeReceiver extends BeSkill`. One huge class
  (`close` at `:1290`).
- **What it does**: Researcher/Wizard-of-Oz bridge. Connects to a
  rosbridge WebSocket; forwards `/jibo` (commands),
  `/jibo_asr_command`, `/jibo_remote`; publishes `/jibo_state` (every
  100 ms) and `/jibo_asr_result`. Mirrors MIT Media Lab `jibo_msgs`
  (`:18`). Deployment profiles HOME/SCHOOL/DEVELOPMENT (`:30`).
- **Launch rule**: `TopRule = ($* ross {skill='\@be/rosbridge'} $*);`.
- **Load-bearing APIs**: `jibo.tts.speak` direct,
  `jibo.jetstream.startLocalTurn`,
  `jibo.media.mediaManagerService`, `jibo.expression.blink`,
  `jibo.systemManager.getIdentity`.
- **Mims**: none.
- **Flows**: `main.flow` plus `behaviors/`, `menu/`, `msg/`, `rules/`.
- **Assets**: `animations/`, `audio/`.
- **Cloud**: rosbridge over LAN, not JCP.

## @be/settings — Settings

- **Package**: `@be/settings` v11.0.1.
- **Entry**: `src/Settings.ts:39` `extends BeSkill`. The largest local
  skill — wraps `src/subskills/{About,Battery,Error,Menu,Shutdown,
  ShutdownAnimation,Updates,Volume,WiFi,Wipe}Skill.ts`.
- **What it does**: Settings menu + sub-flows for WiFi, battery,
  OTA-trigger, shutdown, factory-wipe, error reporting, OOBE recovery.
- **Load-bearing APIs**: every category (see matrix). Unique:
  `jibo.expression.doCenterRobotOnDisconnect`, `jibo.face.gestures`,
  `jibo.lps.readBarcode` (for WiFi setup),
  `jibo.globalEvents.voiceStop`.
- **Mims** (`mims/en-us/`): `CollectPasscode-{NP,Skill}.mim`,
  `MyBatterysLow.mim`, `SettingsMenuNav.mim`, `ShutDownConfirmation.mim`,
  `IWantPowerUser.mim`, `ILikeWiFi.mim`, `WouldLikeAPlugin.mim`.
- **Flows**: `Updates.flow` + flows inside each subskill.
- **Assets**: `animations/`, `audio/`, `views/`, `WiFi.ts` runtime.
- **Cloud**: only the OTA check (see surprises-ota).

## @be/surprises — SurpriseSkill (EoS dispatcher)

- **Package**: `@be/surprises` v11.0.1, main `lib/surprises.js`.
- **Entry**: `src/index.ts` exports
  `{ Skill: SurpriseSkill, kb, policies, BeFramework }`.
  `src/SurpriseSkill.ts:28` `extends BeSkill`.
- **What it does**: The Elements-of-Surprise dispatcher. Sees what
  `SurpriseElement` categories are registered (`supplyCategories`,
  `:54`), runs the `SelectionPolicy` (default
  `HighestPriorityPolicy`, `:32`), then `redirect`s to the winning
  category. Owns global EoS gating via `EoSControl`.
- **Skill shape**: `open(result)` (`:74`) `process.nextTick`s →
  `_open(result)` → `redirect(categoryName, context)` or `exit()`.
  `close(done)` (`:98`) sets `isActive = false`.
- **Load-bearing APIs**: `jibo.lps.identity` (set on `eosControl`,
  `:46`), `jibo.action.checkEnvironmentContext`.
- **Mims**: none directly — each category brings its own.
- **Cloud**: indirect (EoSControl consults `jibo.lps.identity` and
  cloud-skill state).

## @be/surprises-date — SurprisesDate

- **Package**: `@be/surprises-date` v11.0.1.
- **Entry**: `src/SurprisesDate.ts:30`
  `class SurprisesDate extends SurpriseElement`. `open(:122)`,
  `close(:227)`. `DateInfoDb.ts`/`DateInfo.ts` hold facts.
- **What it does**: "On this day in history" surprise.
- **Mims** (`mims/en-us/date-commentary/`):
  `DateCommentary{,Intro,YearsAgo,Template}.mim`, `OfferDateFact.mim`,
  `DateFact-Declined.mim`; plus a `new/M-D.mim` per-day matrix.
- **Flows**: `main.flow`.
- **Cloud**: none.

## @be/surprises-empathic-stories-reminder

- **Package**: `@be/surprises-empathic-stories-reminder` v11.0.1.
- **Entry**: `src/SurprisesEmpathicStoriesReminder.ts:24`
  `extends SurpriseElement`. `open(:116)`, `close(:221)`.
- **What it does**: Periodic reminder to record an "empathic story"
  with Jibo (engagement-loop EoS).
- **Mims/Flows**: mirror `surprises-date` structure.
- **Cloud**: none.

## @be/surprises-ota — OTASurprise

- **Package**: `@be/surprises-ota` v10.0.1.
- **Entry**: `src/index.ts:27`
  `class OTASurprise extends SurpriseElement`. `open(:225)`,
  `close(:381)`. KB root `/ota`.
- **What it does**: OTA-update surprise — checks for new firmware,
  offers release notes, schedules the install. Speaks to
  `@jibo/jibo-server-client` (or `jibo-server-client` for partner,
  `:10-15`). Constants `MIN_TIME_BETWEEN_CHECKS = 6h`, `A_WHILE = 18h`,
  `A_LITTLE_WHILE = 1h` (`:18-21`).
- **Load-bearing APIs**: `jibo.systemManager.getCredentials`,
  `jibo.systemManager.getIdentity`.
- **Mims** (`mims/en-us/`): `OfferOTAReleaseNotes.mim`,
  `ShareOTAReleaseNotes.mim`, `RejectedOTAReleaseNotes{,Error}Resp.mim`,
  `{Downloading,BackingUp,OTAError}Announcement.mim`,
  `OkayInstall{Now,Later}.mim`, `OkayButInstallLater.mim`.
- **Flows**: `BackupNotification.flow`,
  `DownloadingNotification.flow`, `ErrorNotification.flow`,
  `ReleaseNotes.flow`, `UpdateAvailableNotification.flow`.
- **Cloud**: OTA server via jibo-server-client.

## @be/surprises-user-research — SurprisesUserResearch

- **Package**: `@be/surprises-user-research` v3.0.1.
- **Entry**: `src/SurprisesUserResearch.ts:13`
  `extends SurpriseElement`. `open(:167)`, `close(:222)`.
- **What it does**: Polls Jibo's owner with research questions
  ("what feature would you like next?").
- **Mims** (`mims/en-us/`): `SurpriseFutureFeature{Accessories,
  Meditation,FamilyRecipes,LearningGame,Thanks}.mim`,
  `SurpriseNoMatch.mim`.
- **Flows**: `Main.flow`.
- **Cloud**: none.

## @be/tutorial — Tutorial

- **Package**: `@be/tutorial` v7.0.1.
- **Entry**: `src/index.ts:17` `class Tutorial extends BeSkill`. Hard-
  coded rules `DANCE_RULE = 'tutorial/dance'`,
  `PHOTO_RULE = 'tutorial/take_photo'` (`:14`).
- **What it does**: Post-OOBE tutorial covering Hey Jibo, listen vs.
  command, GUI taps/pans/swipes, head-touch, photo-taking. Each topic
  is a sub-flow.
- **Load-bearing APIs**: very broad — see matrix. Unique to tutorial:
  `jibo.globalEvents.skillRelaunch`, `jibo.loader.{load,unload,activeCache}`.
- **Mims** (`mims/en-us/`): `Tut_{All,Touch}Intro.mim`,
  `Tut_Touch{TapNow,SwipeDown,PanProceed}.mim`,
  `Tut_QuestionYes.mim`, `Tut_HJ{Oops,Fail_1,Fail_2}.mim`,
  `Tut_HeadTalk.mim`.
- **Flows**: `main.flow` + 16 sub-flows under `sub-flows/` (01-listen,
  02-command, 03-question, 04-gui, 04A-tap, 04B-pan, 04C-swipe,
  05-stop, 05A-head-touch, 06-photo, 06A-command, 06B-take-photo,
  06B1-find-face, 06B2-frame-faces, 06C-save-photo, 07-outro).
- **Assets**: `audio/`.
- **Cloud**: none.

## @be/who-am-i — WhoAmI

- **Package**: `@be/who-am-i` v10.0.1.
- **Entry**: `src/index.ts:11` `class WhoAmI extends BeSkill`.
  `open(:36)`, `close(:120)`.
- **What it does**: Identifies the active loop/user by speaker/face;
  collects a name if unknown.
- **Mims** (`mims/en-us/`):
  `WhoAmI_{DontKnow,Fail,Learned,NameIsRight,Incomplete}.mim`,
  `WhoAmI_CollectName_GUI.mim`,
  `WhoAmI_{WantToEnroll,YesEnroll,NoEnroll}.mim`, `collectNames.mim`.
- **Flows**: `fix.flow`, `hypothesis.flow`.
- **Cloud**: none.

## @be/word-of-the-day — WordOfTheDay

- **Package**: `@be/word-of-the-day` v3.0.1.
- **Entry**: `src/WordOfTheDay.ts:19`
  `class WordOfTheDay extends SurpriseElement`. `open(:114)`,
  `close(:179)`.
- **What it does**: Word-of-the-day announcement + guessing-game variant.
- **Mims** (`mims/en-us/`):
  `WotD{Definition,Comment,LikeOffer,HowOffer,HowToPlay,FunFact,
  Surprise,Response,RightWord,Puzzle}.mim`.
- **Flows**: `Main.flow`, `Gameplay.flow`, `HowWotD.flow`,
  `LikeWotD.flow`, `Surprise.flow`.
- **Cloud**: none.

---

## Nimbus deep dive

The on-robot half of every cloud-skill conversation. Cloud ships a JCP
behavior tree; Nimbus translates it into local mims, plays them through
a `jibo.bt.behaviors.Mim` runner, and either resumes with another cloud
turn or exits.

### Launch path — `open(listenResult)`

`Nimbus.open(listenResult, refresh, lastSkill)` (`src/Nimbus.ts:131`):

- Requires `listenResult.cloudSkillResponse` — otherwise throws
  `Error('Nimbus launched without complete ListenResult; …')` (`:165`).
- `BeSkill.plugins.analytics.currentSkill =
  this.analytics.renameSkill(listenResult.match.cloudSkill)` (`:140`).
- `jibo.context.updateSkillContext({ id: currentSkill })` (`:145`).
- Forces back to the eye: `jibo.face.views.forceEyeView(() => { … })`
  (`:152`) — regardless of what GUI was up.
- On refresh → `session.replaceSession(data)`; else subscribes
  `jibo.timer.on('update', updateBinding)` and `session.open(data)`
  (`:155-161`).

### Two state machines

(`src/Nimbus.ts:23-52`)

- **outer SM** — `OuterInitState` starts the **core**; on any failure
  transitions to `DoTechErrorMiMState` (a `DoCloudActionState` with
  hard-coded `mims/CloudSkillError.mim`,
  `src/states/DoTechErrorMiM.ts:11`). Both funnel to `DoneState`.
- **core SM** — `initialize → processCloud → doCloudAction →
  (self | waitForAdditional | done)`. `DoCloudActionState` has 3
  outgoing transitions (`installTransitions(execute, wait, done)`,
  `src/states/DoCloudAction.ts:114`).

`OuterInitState.onEntry` (`src/states/OuterInit.ts:36`) runs
`coreSM.start(data)`. Any thrown error in core ⇒
`handleError → transitionTo(_errorState)`, logging the SM trace (`:50`).

### `ProcessCloudState` — thinking anim + cloud parsing

(`src/states/ProcessCloud.ts:39`)

- `isGQA = (cloudSkill === 'answer' || cloudSkill === 'news')` (`:64`).
  If GQA: `loopingAsset = jibo.animDB.getAnimByName(
  'Thinking_Eye_Loop_01')` (`:67`), then `doThinkingAnim()`.
- Awaits cloud reply with 8 s timeout:
  `data.cloudResponse = await timeout(data.listenResult.cloudSkillResponse,
  CLOUD_SKILL_TIMEOUT=8000, 'Cloud Skill Response Timeout')` (`:24, :77`).
  Timeout → `stopThinkingAnim()` + throw.
- On success: rename via `SkillRename`, push
  `jibo.context.updateSkillContext(cloudResponse.skill)` (`:86`),
  `processCloudResponse(data)` (`:89`).
- Thinking anim plumbing:
  - `doThinkingAnim`: push `AttentionMode.OFF` (`:294`),
    play with `config={loops:0, cache:GlobalCacheName}`,
    `options={disableSetFaceAnim:false, screenCenterOverride:true,
    ownerInformation:'Behavior'}` (`:305`).
  - `stopThinkingAnim`: race-safe 500 ms wait if no playback yet
    (`:339`), stop, then `centerRobot({requestor:'Behavior',
    centerGlobally:false, dofs:jibo.expression.dofs.EYE})` (`:357`),
    then `timeout(attnModeHandle.release(), 2000)` (`:23, :361`).
- `processCloudResponse` (`:111`):
  - If `'message' in cloudResponse` → throws the error message (`:112-115`).
  - Else: `processAction(response.action)` walks `action.config.jcp`
    recursively in `processBehavior` (`:145`):
    - `SLIM` → `behaviors.slim`.
    - `SET_PRESENT_PERSON` → `behaviors.setPresentPerson`.
    - `IMPACT_EMOTION` → `behaviors.impactEmotion`.
    - `PARALLEL` → recurse into children.
    - `SEQUENCE` of all-SLIM → `behaviors.slimSequence`; else recurse.
    - Anything else → warn-skip (`:165`).
- `processSlimBehaviors` (`:174`): each `SLIMConfig` becomes a `MIMConfig`
  with `mim_type` from `config.play.meta.mim_type` (or `question` if
  `config.listen.contexts`, else `announcement`),
  `rule_name = contexts.join(',')`, `gui = config.display.view.context`,
  `prompts: [{ prompt_category:'Entry-Core', prompt_sub_category,
  prompt: config.play.esml, media:'TTS', prompt_id, auto_rule_override:
  config.play.autoRuleConfig }]`. The branching at `:208` distinguishes
  `NI`/`NM` prompt-sub-categories from `Q` (rules present) vs `AN`.
- `processSupplementalBehaviors` (`:230`):
  - SetPresentPerson → `jibo.lps.identity.setActiveSpeaker({
    speakers:[{ speaker: looperId, score: confidence, accepted: true,
    high_confidence: true }], snr: 1 }, 'JCP')` (`:233`).
  - ImpactEmotion → `jibo.emotion.triggerImpact({ valence, confidence })`
    (`:249`).
- `processAnalytics` (`:259`): for each cloud-skill key in
  `analytics`, temporarily swap
  `BeSkill.plugins.analytics.currentSkill` to the renamed cloud-skill,
  walk events, set `entry.properties.last_skill = lastSkill` +
  `initial_intent = listenResult.intent` for `'Skill Entry'` (`:266`),
  call `nimbus.track(entry.event, entry.properties)`, restore the
  previous `currentSkill`. This is how cloud-emitted analytics attribute
  to the right cloud skill in the on-robot funnel.

### `DoCloudActionState` — the SLIM execution

(`src/states/DoCloudAction.ts:20`)

- `path` constructor arg is non-null only for the tech-error fallback
  (`DoTechErrorMiMState` passes `'mims/CloudSkillError.mim'`,
  `DoTechErrorMiM.ts:11`).
- `mim = data.mims.shift()` (`:42`). Empty queue → log + go to
  `_completeState` (`:46`).
- Flags:
  - `knownAdditionalMims = (data.mims.length > 0)` (`:48`).
  - `isQuestion = (mim.mim_type === 'question')` (`:49`).
  - A `question` mid-sequence is illegal → log + short-circuit (`:56`).
  - `possibleAdditionalActions = !knownAdditionalMims && isQuestion`
    (`:60`) — a trailing question can spawn a follow-up cloud turn.
- JSON.stringifies object `mim.gui.data` for Mim.ts type 'Javascript'
  (`:53`).
- `mimRunner = new MimRunner(); init({ assetPack, mimConfig:mim,
  mimPath:path })` (`:71`).
- If trailing question → `nimbus.startListeningForNextAction()` (`:73`).
- `await mimRunner.run()` (`:75`).
- After: if mimRunner alive and `!nimbus.hasNextTurn()` →
  `nimbus.stopListeningForNextAction(true)` (rejects nextAction).
  Destroy mimRunner.
- Transitions (`:88-94`):
  - More queued mims → `_executeAdditionalState` (self loop).
  - Trailing question fired off cloud → `_waitForAdditionalState`.
  - Else → `_completeState`.
- `onStop` (`:98`) tears down listener + mimRunner.

### `MimRunner`

(`src/utils/MimRunner.ts:6`)

- Wraps `jibo.bt.behaviors.Mim`. `init` sets
  `options.onFailure = () => true` ("don't handle Q failure as it will
  be handled by cloud", `:12-13`). Constructs
  `mim = new jibo.bt.behaviors.Mim(options)` (`:14`).
- `run()`: `mim.start()`, `jibo.timer.on('update', this.update)` (`:25`),
  returns `runStatus.promise`.
- `update()` (`:49`): each tick — if `mim.update() !== Status.IN_PROGRESS`
  → unhook + resolve.
- `stop()`: unhook, `mim.stop()` → resolve/reject runStatus.
- `destroy()`: null runStatus and `mim.destroy()`.

### `nextAction` / `nextActionTransID`

(`src/Nimbus.ts:43-46, :219-260`)

- `nextAction: ExtPromiseWrapper<ListenResult>` — resolves with the
  next cloud-skill `ListenResult` after a trailing question.
- `nextActionTransID: string` — transaction ID of the local turn the
  cloud kicked off in response.
- `startListeningForNextAction()` (`:219`): allocates promise wrapper,
  attaches swallow-error `.catch`, subscribes
  `jibo.jetstream.events.localTurnStarted.on(localTurnStartBinding)` and
  `…localTurnResult.on(localTurnResultBinding)`.
- `stopListeningForNextAction(reject?)` (`:232`): removes listeners; if
  `reject` and wrapper exists → reject with
  `'Cloud Skill Turn never started.'`.
- `handleLocalTurnStart(transID)` (`:257`): captures **the first** trans-ID
  only — `if (!nextActionTransID) nextActionTransID = transID`.
- `handleLocalTurnResult(result)` (`:265`): matches `result.transID`
  against `nextActionTransID`, then:
  - `FAILED` → reject `'Local Turn failed.'`.
  - `SUCCEEDED` (via `isSuccessResult` type-guard `'result' in result`,
    `:250`) → resolve with `result.result`.
  - Other → reject `'Local Turn '+status`.
- `getNextAction()` / `hasNextTurn()` (`:208, :218`): used by
  `DoCloudActionState` and `WaitForAdditionalState`.

### `WaitForAdditionalState` — redirect-to-self loop

(`src/states/WaitForAdditional.ts:17`)

- `onEntry` awaits `nimbus.getNextAction()` (`:30`).
- On turnResult (and not stopped):
  - `nimbus.redirect('@be/nimbus', turnResult)` — relaunches Nimbus
    with the new ListenResult (`:33`).
  - 5 s safety timer (`:34-37`); if the redirect doesn't take effect
    within 5 s, log + go to `_completeState`.
- Else → `_completeState`.
- Error → log "Next action could not retrieved" + `_completeState`
  (`:40-42`).
- `onStop` clears the safety timer (`:48`).

### `CloudSkillError.mim`

`/tmp/sdk/skills/nimbus/mims/CloudSkillError.mim` — the only mim Nimbus
ships. `announcement`, `notes: "Thanks-Ignore"`, 3 s timeout. Prompts
include `<ssa cat='oops'/>. Sorry. Something went wrong there. Maybe try
me again in a little while.` (`:21`). Played by `DoTechErrorMiMState`.

### Analytics `renameSkill`

(`src/utils/analytics/Analytics.ts:6`)

```ts
export const SkillRename = {
    'chitchat-skill': 'chitchat',
    'personal-report-skill': 'personal-report'
};
```

Used in three places:

- `Nimbus.open()` — renames `listenResult.match.cloudSkill`
  (`Nimbus.ts:140`).
- `ProcessCloudState.onEntry` — renames
  `data.cloudResponse.skill.id` (`ProcessCloud.ts:85`).
- `processAnalytics` — re-attributes each cloud-skill's analytics
  (`ProcessCloud.ts:264`).

In on-robot funnel data, `chitchat-skill` and `personal-report-skill`
become `chitchat` and `personal-report` before any `BeSkill.track()`.

---

## Cross-skill matrix — `jibo.*` services used

`X` = the skill's `src/` references the column's service. `jibo.flow.run`
and `jibo.face.views` are almost universal but included for completeness.

| Skill | action | expression | face | media | lps | kb | loader | jetstream | mim | rendering | sound | bt | flow | globalEvents | systemManager | tts | context | animDB | emotion |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| @be/clock                                | | | X | | X | X | X | X | | X | X | X | X | X | | | | | |
| @be/circuit-saver                        | X | X | X | X | X | X | | | X | X | X | X | X | | | X | | | |
| @be/create                               | X | X | X | X | X | | X | | X | X | | X | X | | | | | | |
| @be/exercise                             | | X | X | | | X | X | X | X | X | X | X | X | X | | | | | |
| @be/first-contact                        | X | X | X | | X | X | | X | | | | | X | X | | | | | |
| @be/friendly-tips                        | | | X | | | X | X | X | | X | | X | X | | | | | | |
| @be/gallery                              | | | X | X | | X | | X | | X | | X | X | | | | | | |
| @be/greetings                            | X | | X | | X | X | | | | | | | X | | | | | | |
| @be/hue-control                          | | X | X | | | X | X | | X | | | X | X | | | | | | |
| @be/idle                                 | X | X | X | | X | X | | X | X | | | | X | X | | | | | |
| @be/ifttt                                | | | | | | | | | | | | | X | | X | | | | |
| @be/introductions                        | X | X | X | | X | X | X | X | | | | X | X | | | | | | |
| @be/main-menu                            | | | X | | | | X | X | X | | | X | X | X | | | | | |
| @be/nimbus                               | | X | X | | X | X | | X | | | | X | | | | | X | X | X |
| @be/radio                                | | X | X | | | X | X | X | | X | | X | X | X | X | | | | |
| @be/remote                               | | X | X | | | | | | | | | X | | | | | | | |
| @be/restore                              | | | X | | | | | | | X | | | | | X | | | | |
| @be/rosbridge                            | | X | X | X | | X | | X | | | | X | | X | X | X | | | |
| @be/settings                             | | X | X | X | X | X | X | X | | X | X | X | X | X | | | | | |
| @be/surprises                            | X | | | | X | | | | | | | | | | | | | | |
| @be/surprises-date                       | | | X | | | X | | | | | | X | X | | | | | | |
| @be/surprises-empathic-stories-reminder  | | | X | | | X | | | | | | X | X | | | | | | |
| @be/surprises-ota                        | | | X | | | X | X | | | | | X | X | | X | | | | |
| @be/surprises-user-research              | | | X | | X | X | X | | | | | X | X | | | | | | |
| @be/tutorial                             | X | X | X | | X | X | X | X | | | | X | X | X | | | | | |
| @be/who-am-i                             | | | X | | X | X | | | | X | | X | X | | | | | | |
| @be/word-of-the-day                      | | | X | | X | X | X | | X | X | | X | X | | | | | | |

Notes:

- `@be/idle` is the only skill that calls
  `jibo.action.setCurrentCircadianState` and `jibo.expression.cleanup`
  directly.
- `@be/nimbus` is the only skill that touches
  `jibo.animDB.getAnimByName`, `jibo.emotion.triggerImpact`,
  `jibo.context.updateSkillContext`/`resetSkillContext`, and
  `jibo.lps.identity.setActiveSpeaker` with a `'JCP'` requestor.
- `jibo.systemManager.{reboot,restore}` → only `@be/restore`.
  `jibo.systemManager.getCredentials` → only `@be/ifttt` and
  `@be/surprises-ota`. `jibo.systemManager.getIdentity` → `@be/radio`,
  `@be/rosbridge`, `@be/surprises-ota`.
- Direct `jibo.tts.speak` only in `@be/circuit-saver` and
  `@be/rosbridge`; everyone else speaks through mims/flows.
- `jibo.mim.silentMenus` toggled by `@be/main-menu` (true on tap),
  `@be/idle` (false on every open), and `@be/{create, circuit-saver,
  exercise, hue-control, word-of-the-day, tutorial}` for view-only
  screens.

