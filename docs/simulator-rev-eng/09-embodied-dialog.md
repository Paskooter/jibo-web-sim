# 09 — Embodied Dialog (speech + listen + MIMs)

Source-of-truth tree at `/tmp/sdk/packages/`. Quotes are `file:line`.
Key files: `jibo-service-clients/src/services/TTSService.ts`,
`jibo-embodied-dialog/src/{EmbodiedDialog,speech/,listen/,auto_rules/}`,
`jibo/src/bt/behaviors/{TextToSpeech,Mim}.ts`, `jibo/src/bt/mim/*`,
`jibo/src/bt/mim/delegates/GlobalListenDelegate.ts`.

---

## 1. TTS client surface (jibo-service-clients)

The TTS client speaks to a backend over HTTP (paths) + WS (sockets), defined in
`TTSService.ts:72-82`:

```
const APIPath = {
    TOKENS:      '/tts_tokens',     // WS
    PHONES:      '/tts_phones',     // WS
    STOP:        '/tts_stop',       // HTTP GET
    SPEAK:       '/tts_speak',      // HTTP POST, returns 204
    TIMING:      '/tts_token_times',// HTTP POST -> WordTimings JSON
    EFFECTS:     '/tts_effects',    // WS (effects pedals)
    ANALYSIS:    '/tts_analysis',   // WS
    POS_TOKENS:  '/tts_lex',        // HTTP POST -> POSTokens JSON
    POS_TAGGING: '/tts_pos_tagging' // HTTP POST -> POSTags JSON
};
```

`init()` (l.210) builds `httpInterface = "http://"+host+":"+port` and
`socketUrl = "ws:"+host+":"+port`, then opens four WS sockets in parallel
(`createSocket`, l.242): TOKENS→`word`, PHONES→`phone`, ANALYSIS→`analysis`,
EFFECTS→`effect`. Public events (l.176-200): `word`, `phone`, `effect`,
`analysis`, `stopped` (emitted locally on `stop()`). Module state (l.202-204):
`isInitialized`, `isTalking`, `isStopping`.

Default request bodies:

```ts
const defaultTTSReqBody = { prompt:'', locale:TTSLocale.EN_US, voice:TTSVoice.GRIFFIN, mode:TTSMode.TEXT };   // l.154
const defaultPOSReqBody = { text:'',   locale:TTSLocale.EN_US, tokens:[] };                                    // l.165
```

### HTTP

| Path | Method | Payload | Response | Used by |
|------|--------|---------|----------|---------|
| `/tts_speak` | POST | `defaultTTSReqBody` + `duration_stretch`/`pitch`/`pitchBandwidth`/`volume`/`whisper`/`cached`/`earlyStopTime`/`mode` (l.693-722) | **204 No Content** when speak done (l.729) | `_sendTTSRequest` ← `speak()` |
| `/tts_token_times` | POST | same body | `WordTimings { tokentimes:{ tokens:[{name,start,end},…] } }` | `getWordTimings()` (l.395) |
| `/tts_stop` | GET | — | 200 OK | `stop()` (l.349), 2s XHR timeout |
| `/tts_lex` | POST | `defaultPOSReqBody` + `text` | `POSTokens { tokens:string[] }` | `getPOSTokens()` (l.524) |
| `/tts_pos_tagging` | POST | `defaultPOSReqBody` + `tokens` | `POSTags { tokentags:string[][] }` | `getPOSTags()` (l.578) |

### WS

| Socket | Inbound → emitter | Outbound | Payload |
|--------|-------------------|----------|---------|
| `/tts_tokens` | `word` event `{token,timestamp,status:'PLAY',moreinfo:[]}` (real shape produced by `_dispatchWordSchedule` l.651-656; backend pushes raw token frames) | — | consumer: BT `TextToSpeech.onWord` |
| `/tts_phones` | `phone` event (raw) | — | debug only |
| `/tts_analysis` | `analysis` event (raw) | — | analysis log only |
| `/tts_effects` | `effect` event (raw inbound) | `{name, action:START\|STOP\|UPDATE, param}` via `startEffect`/`stopEffect`/`updateEffect` (l.468/485/503) | sound effects pedal |

---

## 2. `speak(text, opts)` flow inside the client

`speak()` (l.277-341): reject if `!isInitialized`; if `isStopping`, wait for `stopped` event then `doSpeak()`; if `isTalking`, call `stop(doSpeak)` first.

`doSpeak()`:
- `options.skipWordEvents` → only `_sendTTSRequest(text, options, ...)`.
- otherwise → `getWordTimings(text, options, ...)` then `_dispatchWordSchedule(timings)` (fire and forget) **and** `_sendTTSRequest(text, options, ...)` in parallel.

204 contract (l.729): `request.status === 204` → `isTalking=false; callback()`. Other statuses → failure with `'TTS Service is unavailable'` default message.

### `_dispatchWordSchedule` (l.639-668)

Local fallback emitter — does **not** use the WS. Filters non-words `'/pau/'`, `'<break>'`, `'<audioBreak>'`, `'<say-as>'`, `'[lpau]'`, then schedules each remaining token via `setTimeout` against `Date.now() - start`, emitting `word { token:wordObj.name, timestamp:wordObj.start, status:'PLAY', moreinfo:[] }`.

Net: in `skipWordEvents` mode the WS supplies words; in normal mode the **client** schedules its own word events from `/tts_token_times` and the server audio plays in parallel.

---

## 3. `TextToSpeech` behavior (`jibo/bt/behaviors/TextToSpeech.ts`)

Simple BT leaf. `start()` (l.23): sets `Status.IN_PROGRESS`, calls `Runtime.instance.tts.speak(this.options.words, err=>{ this.status=Status.SUCCEEDED; })` (errors still report SUCCEEDED), then subscribes `tts.word.on(this.options.onWord)` and `tts.stopped.on(this.onSpeakingStopped)`. `update()` returns `this.status`; once it leaves IN_PROGRESS, `cleanup()` (l.72) detaches both handlers. `onSpeakingStopped` (l.68) flips status to SUCCEEDED. So normal completion, error, or external stop all surface as success.

`TextToSpeechJs` (`TextToSpeechJs.ts:13-49`) wraps `TextToSpeech`, pulls `words` via `options.getWords(callback)`, delegates `_start/_stop/_update/destroy`.

---

## 4. `jibo.embodied.speech.speak` — entry used by MIMs

Public namespace fn (`jibo-embodied-dialog/src/api.ts:155`):

```ts
export function speak(textToSpeak, speakOptions?, autoRuleConfig?)
    : Promise<RequestStatus> {
    return _embodied.speech.speak(textToSpeak, speakOptions, autoRuleConfig);
}
```

The MIM speak delegate is set to `Runtime.instance.embodied.speech` (`MimManager.ts:208`). `EmbodiedSpeech.speak` (l.209-244) wraps each request in a `Session { id, resolve, reject, wasStopped }` and runs it through a `PromiseQueue`. `_speak` (l.246) builds the `Dataflow` and calls `this.sm.start(data)`.

`this.sm` chain (l.104-107): `CreateTimelineState → BuildDispatchableState → DispatchState → CompleteState`.

- **CreateTimelineState** (`states/CreateTimeline.ts`) — preInputTree → NL parse tree → auto-tag trees → `timelineManager.generateTimeline(inputTree, opts, autoTagTrees)`.
- **BuildDispatchableState** (`states/BuildDispatchable.ts`) — see §5.
- **DispatchState** — see §5.
- **CompleteState** (`states/Complete.ts`) — `sm.stop()`.

`EmbodiedSpeech.init` (l.119) also primes the global cache with blink/beat/comma/question queries (l.130-148) and computes defaults:

```ts
const defaultAutoRuleConfig = {
    interSentenceTiming:false, intraSentenceTiming:false,
    hotWords:allowAutoRule, punctuation:allowAutoRule,
    structure:false, voice:allowAutoRule, beat:allowAutoRule, themeRheme:false
};
```

---

## 5. DispatchState / failsafe timeout + ActionTimeline

`speech/states/Dispatch.ts`, constants `TIMEOUT=3000`, `STOP_FAILED='STOP_FAILED'` (l.8-9).

`onEntry` (l.26) sequence:

1. Cache dataflow, build a new `ActionTimeline`, reset `playingKeys`.
2. Resolve dispatch promise: `resolvedType = ttsRoot.data.dispatchOverride || speakOptions.dispatchComplete`. If TTS → wait only on `ttsDonePr`; else `Promise.all([ttsDonePr, animDonePr])` (l.34-36).
3. Push `AttentionMode.SPEAKING` (wrapped in `timeout(...,3000, {timeoutValue: AttentionMode.OFF})`).
4. `await this.es.ed.listen.waitForIdle()` (wrapped in same 3s `timeout`). Speak won't start until EL is in Idle (or 3 s have elapsed).
5. Dispatch:

```ts
actionTimeline.dispatchTimeline(dataflowCache.dispatchableTimeline);
dispatched = true;
if (dataflowCache.timeline.anim.length > 0) {
    const FAILSAFE_TIMEOUT_MS = (3 * Math.max(
        dataflowCache.timeline.tts.stop,
        dataflowCache.timeline.anim.stop)) * 1000;
    failsafeTimeoutHandle = this.es.jibo.timer.setTimeout(() => {
        if (this.es.active?.id === dataflowCache.session) {
            failsafeTriggered = true; this.es._stop();
        }
    }, FAILSAFE_TIMEOUT_MS);
}
```

The **3×-max failsafe** = 3 × max(ttsStop, animStop), in seconds, ×1000 → ms. Fires only when there's actual anim content. If the dispatch never resolves within that window, the state machine self-stops.

6. `await Promise.race([dispatchedPr, dispatchInterruptPr.promise])`.

`onStop` (l.92) — `actionTimeline.fastForward()`, stop every playingKey (3s `timeout` each → reset on STOP_FAILED), `jibo.tts.stop()`, optionally `expression.centerRobot(...)`, then await `dispatchedPr` (3s timeout). Any failure flips `reset=true`.

`onExit` (l.194) — release attention-mode handle, fast-forward leftovers, optionally center robot.

### `dispatchableTimeline` vs `actionTimeline`

Two different objects:

- `dispatchableTimeline: TimelineElement[]` — flat `{timeMs, action}` list, built by `BuildDispatchableState.onEntry` (`states/BuildDispatchable.ts:33-115`) by walking the two-layer `Timeline` linked-lists (`tts._root`, `anim._root`).
- `actionTimeline: ActionTimeline` (from `jibo-cai-utils`) — consumes the list, schedules every `action` callback. `actionTimeline.fastForward()` flushes everything immediately.

The TTS action (`BuildDispatchable.ts:118`) chains each speak through a single
serial promise: `ttsDispatchChainPr = ttsDispatchChainPr.then(() => jibo.tts.speak(ssml, params).catch(...es.stop()))`. The "final TTS action" (l.140) waits on `audioDone` before resolving `ttsDone`. Anim mirrors this: `_generateFinalAnimAction` awaits `Promise.all(animDispatchPrs)` + the screen-anim PromiseQueue.

---

## 6. AutoRuleManager and the rules list

`AutoRuleNames` enum (`AutoRuleManager.ts:43-60`): Exclamation, Question, Blink, DoubleBlink, BeatBlink, Comma, Or, But, List, Noun, BeatFirstWordPart, BeatNewWord, Initiate, Settle, HotWords, ThemeRhemeGaze. Also `TimelineModifyingRuleNames` (l.63-69): InterSentenceTiming, IntraSentenceTiming, Ellipsis, ExclamationVoice, EmotionalVoice.

Actually-instantiated rules (`AutoRuleManager.ts:78-90`, priority-ordered):

```ts
new QuestionRule(2), new CommaRule(jibo, 5),
new BlinkRule(3), new DoubleBlinkRule(3), new BeatBlinkRule(4),
new ListRule(jibo, 10), new OrRule(jibo, 10),
new ButRule(jibo, 10), new NounRule(10),
new HotWordsRule(0, 1, hotWordMap, rejectWordMap, descendingPhraseLengths),
new InitiateRule(jibo, 1),
```

Plus timeline-modifying (l.92-97): InterSentenceTiming, IntraSentenceTiming, Ellipsis, EmotionalVoice.

`applyRules(nlpTreeRoot, config)` (l.172-210) → `Node[]` of auto-tag trees. Routing: `punctuation` → Question+Comma; `structure` → Or/But/List/Noun; `beat` → Initiate/Blink/DoubleBlink/BeatBlink; `hotWords` → HotWordsRule.

`AutoRule.applyRule` template (`AutoRule.ts:56-79`): each rule's `_applyInternal` returns a `Node[][]` of word sequences; for each sequence, with `Math.random() < probability`, build `_createNode(sequence)`, attach the words as children, hang under a ROOT carrying `autoRule=ruleName, priority=priority`.

### Per-rule pattern + produced AssetNode (each rule's `_createNode` body lives
at the cited line range)

- **BlinkRule** (`BlinkRule.ts:21-53`) — last word of every REGULAR/EXCLAMATION sentence. `_createNode` calls `TimelineModUtils.blinkNodeBuilder(BlinkNodeType.SINGLE)`, sets `nonBlocking='true'`, `position='after'`, `rule='Blink'`, `timeSyncNode=children[0]`.
- **DoubleBlinkRule** (`DoubleBlinkRule.ts:21-53`) — same shape but only on QUESTION sentences, `BlinkNodeType.DOUBLE`.
- **CommaRule** (`CommaRule.ts:28-65`) — splits by commas; fires only if `wordSegments.length < 3`. Node: ANIM with `cat='comma'`, `layers='body'`, alternating `orientation`, `endNeutral='false'`; short segments get `nonBlocking='true'` + `timeSyncNode=children[0]`. → QUERY.
- **NounRule** (`NounRule.ts:27-61`) — every NOUN word minus contraction-expansions and `AR_EXEMPT_NOUNS = Set(['i','you','we','me'])`. Node: ANIM with `cat='glances'`, `filter='!down'`, `nonBlocking='true'`, `timeSyncNode=children[0]`. → QUERY.
- **HotWordsRule** (`HotWordsRule.ts:34-66`) — see §6.5. `_createNode` copies the matched `WeightedRandomData` entry's attrs (whatever it has — typically `name` or `cat`/`filter`) onto a new ANIM AssetNode, sets `rule='HotWords'`, falls back to `nonBlocking+timeSyncNode=children[0]` if not `bounded`. → NAME or QUERY (depends on JSON entry).
- **QuestionRule** (`QuestionRule.ts:21-55`) — QUESTION sentences, last N words. Node: ANIM with `cat='question'`, `layers='body'`, `filter='!eye-only'`, `endNeutral='false'`; if `children.length <= 3` adds `nonBlocking='true'` + `timeSyncNode=children[0]`. → QUERY.
- **ListRule** (`ListRule.ts:44-122`) — split by `[',','and']`; needs ≥3 subsections. Picks `SUB_RULE_1='list-rule-sr1'` or `SUB_RULE_2='list-rule-sr2'` via `_.sample`. Node: ANIM with `cat=<sub-rule>`, `filter='a'|'b'` for SUB_RULE_2, `orientation`, `endNeutral`. → QUERY.
- **OrRule** (`OrRule.ts:50-67`) — sentence segments around `or`, 5-word windows on each side, picks anim name from `OR_KEYS=['Or_01','Or_02','Or_03']` per OR-group. Node: ANIM with `name=<chosen>`, `orientation`, `endNeutral`. → **NAME**.
- **ButRule** (`ButRule.ts:49-66`) — symmetric to OrRule. `BUT_KEYS=['But_01','But_02']`. → **NAME**.
- **InitiateRule** (`InitiateRule.ts:27-37`) — first 3 words of every sentence. Node: ANIM with `cat='poses'`, `filter='initiation'`, `layers='body'`, `orientation`. → QUERY.

### Summary table

| Rule | _applyInternal pattern | RequestType | cat / filter / name |
|------|------------------------|-------------|---------------------|
| Question | last words of QUESTION sentence | QUERY | cat=question, filter=!eye-only |
| Comma | <3 comma segments, each pre-comma | QUERY | cat=comma, layers=body |
| Blink | last word of REGULAR/EXCLAMATION | (built by `TimelineModUtils.blinkNodeBuilder` — single) | nonBlocking position=after |
| DoubleBlink | last word of QUESTION | (double via blinkNodeBuilder) | nonBlocking position=after |
| Noun | every NOUN word minus AR_EXEMPT_NOUNS | QUERY | cat=glances, filter=!down |
| List | ≥3 segments split by `,`/`and` | QUERY | cat=list-rule-sr1 or sr2, filter=a/b |
| Or | 5-word windows around `or` | NAME | name ∈ {Or_01,Or_02,Or_03} |
| But | 5-word windows around `but` | NAME | name ∈ {But_01,But_02} |
| Initiate | first 3 words of each sentence | QUERY | cat=poses, filter=initiation |
| HotWords | longest-first phrase match in `hotWordMap` | NAME or QUERY (from JSON) | whatever the matched entry says |

---

## 6.5. HotWords loading — `retreiveHotWordsDir`

`AutoRuleManager.ts:151-163`: `resolvedPath = jibo.animDB.resolveAnimDB(jibo)`; `hotWordsDir = path.join(path.dirname(resolvedPath), 'hot')`. If `!fs.existsSync(hotWordsDir)` → `log.warn("Module 'jibo-anim-db-animations' not found. HotWords will not work.")` and returns the path anyway (caller skips loading because dir doesn't exist).

If missing → `hotWordMap` stays empty → `HotWordsRule._applyInternal` (l.78) short-circuits because `descendingPhraseLengths.length === 0`. Every other rule still works.

Loading (ctor l.102-143, synchronous): reads every file in `<hotWordsDir>`, JSON-parses, walks the structure `[[ [{match, reject:[...]}, ...], weightedMatches ], ...]`. For each `match`: `length = match.trim().split(' ').length`; stored at `hotWordMap.get(length).set(match.toLowerCase(), weightedMatches)`. Reject lists → `rejectWordMap`. `descendingPhraseLengths.sort((a,b)=>b-a)`.

Net: `hotWordMap: Map<phraseLength, Map<lowercasePhrase, WeightedRandomData[]>>`, sorted longest-first for greedy matching.

`HotWordsRule._applyInternal` (l.95) sliding-window: each word carries a `phraseLengthMember` attr (l.85); longer phrases claim words and shorter overlaps skip via `slidingWindowMemberCheck` (l.99-105). `REJECT_FUZZY_SIZE=2` (l.13) — reject if any reject-list word appears within ±2 of the match.

**Implication for the web sim:** no `hot/` directory → `hotWordMap` stays
empty → no HotWords ever fire (warn-once at startup). All other auto-rules
continue to work because they don't depend on that data.

---

## 7. TimelineManager.generateTimeline algorithm

`TimelineManager.generateTimeline` (`speech/timelines/TimelineManager.ts:77-98`):

```ts
return this._preProcessPathBasedAssets(inputTree)
    .then(pathAssets => {
        this._pathAssets = pathAssets;
        return this._inputTreeToTimeline(inputTree, options);
    })
    .then(timelineData => {
        const [timeline, wordSchedule] = timelineData;
        if (!autoTagTrees) return Promise.resolve(timeline);
        let pending = this._autoTagTreesToPrioritizedTimelines(autoTagTrees, wordSchedule, timeline);
        return this._mergePendingWithMaster(pending, timeline);
    });
```

### `_inputTreeToTimeline` (l.201-289)

1. Resolve all **blocking** asset nodes first via `_resolveAssetToPlayback` (so their playbackDuration is known).
2. Walk all descendants classifying blocking / unbounded-non-blocking / word-schedule-relevant (l.219-245). Each blocking node injects a synthetic `_buildBreak(playbackDuration / FRAME_RATE)` SSML break so TTS pauses for the asset's duration.
3. Build the TTS params with `mode=SSML`, `skipWordEvents=TRUE`, `cached` flag.
   `skipWordEvents=TRUE` is hard-coded — ES never uses the WS for word events; it uses the schedule from `getWordTimings`.
4. `await jibo.tts.getWordTimings(timingSSMLText, params)`.
5. `_initTimeline(...)` (l.603) seeds one `TTSFrame{start,stop,data}`. If `shouldPrune` (dispatchComplete === TTS without override), `getPrunedStopTime` (l.632) trims trailing breaks but preserves a final `[lpau]`; stop time is stuffed into `params.earlyStopTime` so the backend ends synthesis early.
6. `_generateWordSchedule` (l.660) zips tokens with the wordNodes → `Map<Node,TimeBounds>`.
7. `_populateTimelineLayers` (l.729) inserts assets in the order blocking → unbounded-non-blocking → bounded. Each computes `dynamicStopBoundary = bounds.start + playbackDuration/FRAME_RATE` and calls `timeline.anim.insert(new TimelineFrame(...))`. Emoji-cap: one emoji per utterance, gated by the `emojiCapReached` flag.

### `_autoTagTreesToPrioritizedTimelines` (l.817-895)

For each rule tree, picks the cache (l.825-840): basic Question/Comma/Initiate/Blink/DoubleBlink/BeatBlink → `CacheUtils.GlobalCacheName` (pre-populated by `EmbodiedSpeech.init` blink/beat/comma/question queries); HotWords and default → `this.jibo.face.eye.CACHE_ID`. For each matching subtree it resolves bounds (from wordSchedule via `timeSyncNode` if empty/explicit-non-blocking, else from children) and calls `_resolveAssetToPlayback(subTree, durSec, randomizeOrient=true, cache)`. If bounded resolution fails and `Math.random() < AUTORULE_GATE_RATE` (= 1.0), it retries unbounded. Results land in `priorityMap: Map<priority, AutoRuleMatch[][]>`.

### `_resolveAssetToPlayback` for NAME / QUERY / PATH

- **NAME** branch (l.332-362) — `identifier=node.att.get('name')`; `asset=this.jibo.animDB.getAnimByName(identifier)`. With a duration to fill: `loops===0` → `findOptimalLoop([asset], dur)`; otherwise single-playback duration clamped to `durationRange`.
- **QUERY** branch (l.363-432) — builds an `AnimQuery`:
  `{ categories: someOf.length>0 ? someOf : allOf, includeMeta: allOf, includeSomeMeta: someOf, excludeMeta: noneOf }`,
  runs `this.jibo.animDB.query(query)`. Bounded → optimal-loop or single-playback fit; unbounded → `_.sample(results.matching)`.
- **PATH** branch (l.433-441) — lookup in `this._pathAssets` populated by `_preProcessPathBasedAssets`.

The chosen asset becomes:

```ts
node.playbackData = {
    playbackGenerator: () => asset.createFromConfig(animConfig),
    playbackDuration, playbackName: asset.name, playbackLayers: metaLayerPresence
};
```

The `play()` call itself lives in `BuildDispatchable._generateAnimAction` (`BuildDispatchable.ts:211` — `playback.play(playOptions)`). ES speak path does **not** use `listen/Utils.playAnimation` — that helper is only for EL eye animations.

---

## 8. `<anim cat='...' filter='...'/>` SSML → NLP → AssetNode pipeline

1. `InputProcessor.generatePreInputTree(sentence)` (l.59) — `Parser.parseXML` builds a `TagTreeNode`; types uppercased; `<break/>` swapped for `SSMLNode(SSMLNodeType.BREAK)`. Text nodes lexed via `Lexer.lex` into word tokens; expansion/contraction handling populates `xmlTree.expansions/.contractions`.
2. Timeline-modifying autorules pass (`CreateTimeline.ts:24`).
3. NL parse (`CreateTimeline.ts:29`) — `NLParser.parse` → tree of SENTENCE/WORD/PART nodes.
4. Standard autorules pass (`CreateTimeline.ts:32`) — `AutoRuleManager.applyRules` → `Node[]` of rule trees (see §6).
5. `generateInputTree(preInputTree, nlpTree)` (`InputProcessor.ts:226`) — merges word-level NLP info into the tag tree. The `AssetNode` instances already exist from XML parsing; their constructor (`AssetNode.ts:62-90`) parses the attrs:
   - `cat`/`cats` → `categoryFilter` (via `addCategories`)
   - `filter`/`filters`/`meta`/`metas` → `metaFilter` (via `addMeta`)
   - `layers`/`layer` → `layers` + `layersToAdd`
   - `loop`/`loops` → `loops`
   - And `getRequestInfo` (l.99-119) sets `requestInfo.type = NAME|QUERY|PATH`.

Filter syntax uses `AssetNode.parseTerm` (l.166): operators `&` (allOf), `?` (someOf), `!` (noneOf), `+` (addAll), grouped form `OP(a,b,c)`. So `filter='!down, ?happy'` → `metaFilter.noneOf=['down'], someOf=['happy']`.

6. `TimelineManager.generateTimeline` consumes the tree (§7). Net: literal `<anim cat='comma' filter='!eye-only'/>` → `AssetNode{ categoryFilter:{allOf:['comma']}, metaFilter:{noneOf:['eye-only']}, requestInfo:{type:QUERY} }` → AnimQuery in `_resolveAssetToPlayback`.

---

## 9. Listen pipeline (EmbodiedListen)

`listen/EmbodiedListen.ts` is a `StateMachine` subclass. States (l.38-47): `_idle, _reset, _hjExpression, _nonHjExpression, _offExpression, _engage, _listening, _thinking, _waitForAnimFinish, _active`.

### Modes (`listen/Types.ts:45-59`)

```ts
export enum AmbientListenMode { NORMAL, NO_BODY }
export enum ActiveListenMode  { OPTIONAL_RESPONSE, UI }
```

There are no `NORMAL_HJ`/`ONLY_HJ`/`IGNORE_HJ`/`ASR_Only`/`Normal` enum values in this version of the source — older internal docs reference those, but the public surface is the two ambient + two active modes shown above. HJ handling is always active in ambient; suppressed only by `disableOnce()` (l.453) which sets `_disableOnce=true` for one event.

### Active vs ambient

- **Ambient** (default) — `_idle ↔ _hjExpression ↔ _engage ↔ _listening ↔ _thinking ↔ _waitForAnimFinish ↔ _reset ↔ _idle`. Drives passive behavior on every user utterance.
- **Active** — pushed by `enterActiveMode(mode, options)` (l.493). Pending mode queued via `eventsInternal.enterActiveMode`. `_active.onEntry` (l.201) sets LED + listening-eye: `UI` mode → LED only; `OPTIONAL_RESPONSE` → LED `LISTENING_OR` + listening eye.

### ListenDelegate.create

The MIM-side delegate is `GlobalListenDelegate` (`bt/mim/delegates/GlobalListenDelegate.ts`). `Listener` interface (`MimManager.ts:22-27`): `stop, updateTurn, on, stopped`. Static `create(options)` (l.61):

```ts
const listener = new GlobalListener();
listener.init(options);   // jetstream.startLocalTurn(options) → this.turn
listener.run();           // await turn.promise; emit INTERRUPTED|CLOUD|TIMEOUT then FINISHED
return listener;
```

After a non-active, non-HJ-interrupted turn, `run()` (l.150) calls `Runtime.instance.embodied.listen.waitForIdle(true)` to force EL back to Idle (clears the LED ring).

### `waitForIdle` (EmbodiedListen, l.419-431)

Resolves immediately if `current === _idle`; otherwise subscribes once to `eventsOut.finished`. If `fastForward=true`, also fires `eventsInternal.reset.emit()` to short-circuit the active chain.

Used in two places: `GlobalListener.run` after a turn, and `DispatchState.onEntry` (l.64) before starting a speak — wrapped in a 3 s `timeout`, so ES waits ≤3 s for EL to be idle then proceeds anyway.

### Event wiring (`api.ts:59-107`)

```
jetstream.events.hjHeard         → listen.eventsIn.hjHeard.emit() + oriented.emit()
jetstream.events.localTurnStarted → listen.eventsIn.startListen.emit()
jetstream.events.globalTurnResult → listen.eventsIn.cloudFinished.emit()
globalEvents.shared.hjOnly       → listen.eventsIn.cloudFinished.emit()
jetstream.events.localTurnResult → listen.eventsIn.cloudFinished.emit()
jetstream.events.sos             → listen.eventsIn.sos.emit()
jetstream.events.eos             → listen.eventsIn.eos.emit()
lps.identity.events.visibleFaceStarted/Stopped → listen.eventsIn.personFound/Lost
```

EL is driven entirely by jetstream + LPS-identity events. SOS → `_listening`, EOS → `_thinking`, cloud result → `_offExpression → _waitForAnimFinish → _idle`.

---

## 10. MimManager + Mim FSM

`bt/mim/MimManager.ts` is a singleton (SingletonEnforcer, l.46). Key API:

- `end: Event<any>` (l.76), `openGUI: Event<void>` (l.83)
- **`handleSpeech: Event<string|NLUResult>` (l.90)** — the spoofed-utterance entry point. This is what production-bundle `jibo.js:1581` emits to.
- `heyJibo: Event<void>` (l.99), `heyJiboComplete: Event<HJCompleteReason>` (l.107), `isHeyJiboActive: boolean` (l.115)
- `listenDelegate = GlobalListenDelegate` (l.207), `speakDelegate = Runtime.instance.embodied.speech` (l.208)

`loadMimAssets` (l.300) loads `core://mims/en-us/globals/ThanksResponse.mim`, MimRepeatManager, and the rotation KB node. `attachHJListeners` (l.323) wires hjHeard/hjOnly/noGlobalMatch/nonInterruptingGlobal/globalTurnResult — lazily registered when the first `heyJibo.on` subscriber attaches.

### MIM state machine (`Mim.ts:91-147`)

States (`MimStates` class): `loadConfig, loadRule, choosePrompt, speak, listen, restartListen, analyzeMimGlobal, analyzeMenuGlobal, parseSpoof, analyzeResults, reportResults, handleException, waitForHJEnd`. Transitions all `addInternalTransition` at l.106-145 — major flow: `loadConfig → loadRule → choosePrompt → speak → listen → analyzeResults → reportResults`. Branching: any of {speak,listen,loadConfig,loadRule} can divert to `parseSpoof` or `waitForHJEnd`; `restartListen` re-enters `listen` via 5 ms `TimeoutTransition`; `analyzeMimGlobal` may go to `choosePrompt` for a Repeat global. Each state's `onEntry/onUpdate/onStop/onExit` bound in ctor (l.373-391).

### Spoofed-utterance flow (the `handleSpeech` path)

`Mim.onSpeechEvent` (l.685-745), wired in `start()` at `mm.handleSpeech.on(this.onSpeechEvent)` (l.424). Behavior summary:

1. If utterance is a string, wrap as `{ intent, entities:{}, rules:null }`.
2. Force `utterance.rules = this.mimConfig.ruleNames` (override caller's rules).
3. If current state is `speak`: stop the speak delegate, call `Runtime.instance.embodied.listen.disableOnce()`, fire-and-forget `Runtime.instance.jetstream.startLocalTurn({ nluRules, clientNLU: utterance })`.
4. If current is `listen`: if a live listener exists call `listener.updateTurn(utterance)`; otherwise the same disableOnce+startLocalTurn dance.
5. `current.transitionTo(states.parseSpoof, utterance)`.

The `parseSpoof` state calls `parseSpoofedUtterance` (bound l.385) which NL-parses the payload and transitions to `analyzeResults`.

### MIM speak (Mim.ts:1052-1167)

`private speak()` (l.1052) reads `this.mimState.promptText` + `promptAutoRules`, builds:

```ts
const options = {
    text, disableAutoRules: autoRules === false,
    followedByListen: this.mimConfig.mimType !== MimTypes.ANNOUNCEMENT,
    autoRuleConfig: typeof autoRules !== 'boolean' ? autoRules : undefined
};
```

If the (tag-stripped) prompt matches `/(hey|hay)\s+jibo/i`, the hotword listener is paused via `jetstream.setHotwordMode(HotwordListenMode.Disabled)` and a token saved on `this.pausedHotword` (l.1084) for release on completion. Then:

```ts
MimManager.instance.speakDelegate.speak(options.text, options, options.autoRuleConfig)
    .then(() => {
        this.pausedHotword?.release();
        if (this.mimConfig.mimType === MimTypes.ANNOUNCEMENT) {
            this.states.speak.transitionTo(this.states.reportResults);
        } else {
            this.states.speak.transitionTo(this.states.listen, true);
        }
    })
    .catch(...);
```

`stopSpeaking` (l.1161) just calls `MimManager.instance.speakDelegate.stop()` — which is `EmbodiedSpeech.stop()` → `sm.stop()` → `DispatchState.onStop`.

### MimConfig.ruleNames + globals

`MimConfig.ruleNames` (`MimConfig.ts:54`) — the list of NLU rules to send to the cloud. When the MIM enters `_startListen` (`Mim.ts:1240`), it concatenates:

```ts
const rules = mimConfig.ruleNames.slice();
rules.push(GUI_RULE);  // always
if (this.entryPrompt.text) rules.push(REPEAT_RULE);
if (mimConfig.thanksHandling !== ThanksOptions.IGNORE) rules.push(THANKS_RULE);
```

The three constants (`Mim.ts:210-212`):

```ts
const THANKS_RULE = 'globals/mim_thanks';
const REPEAT_RULE = 'globals/mim_repeat';
const GUI_RULE    = 'globals/gui_nav';
```

So every MIM listen sends its own `ruleNames` + always-on `gui_nav` + optional `mim_repeat` (when there's something to repeat) + optional `mim_thanks` (when MimConfig says OR is allowed to handle thanks).

### MIM types (`MimConfig.ts:36`)

```ts
export enum MimTypes {
    ANNOUNCEMENT     = 'announcement',
    OPTIONAL_RESPONSE = 'optional-response',
    QUESTION         = 'question',
}
```

ANNOUNCEMENT → speak then reportResults (no listen). OR/QUESTION → speak then listen.

### MIM state enum (`MimState.ts:17`)

```ts
ENTRY, MATCH, NO_MATCH, NO_INPUT, REPEAT, THANKS,
HOLD_RETURN, VERBOSE, TRUNCATED, MENU_CLOSED
```

Drives which prompt subcategory `MimConfig.getPromptText` returns
(`MimConfig.ts:177-230`).

---

## 11. Concrete file:line citations

(All citations are inline in §§1–10 above; key landmarks:)

- `TTSService.ts:72-82` APIPath table — `:277-341` speak — `:639-668` _dispatchWordSchedule — `:693-744` _sendTTSRequest (204 at `:729`)
- `EmbodiedSpeech.ts:81-108` sm setup — `:209-244` speak/queue/session — `:163-186` defaults
- `states/CreateTimeline.ts:14-43` — `states/BuildDispatchable.ts:33-115, 130` — `states/Dispatch.ts:8-9, 26-89, 92-191`
- `timelines/TimelineManager.ts:77-98` generateTimeline — `:201-289` _inputTreeToTimeline — `:314-495` _resolveAssetToPlayback — `:729-807` _populateTimelineLayers — `:817-895` _autoTagTreesToPrioritizedTimelines — `:948-986` _mergePendingWithMaster
- `auto_rules/AutoRuleManager.ts:78-97` rules list — `:172-210` applyRules — `:151-163` retreiveHotWordsDir — `:102-143` HotWords loading
- `auto_rules/AutoRule.ts:56-79` template — BlinkRule:21-53, CommaRule:28-65, NounRule:14/27-61, QuestionRule:21-55, DoubleBlinkRule:21-53, ListRule:24-27/44-122, OrRule:23-27/50-67, ButRule:23-26/49-66, InitiateRule:27-63, HotWordsRule:34-66/75-144
- `listen/EmbodiedListen.ts:20, 38-47, 419-431, 493-539` — `listen/Types.ts:45-59` — `api.ts:59-107` — `bt/mim/delegates/GlobalListenDelegate.ts:61-66, 113-162`
- `processing/InputProcessor.ts:296-342` is* helpers — `processing/AssetNode.ts:30-91, 99-119, 139-189` attr/filter parsing
- `bt/mim/MimManager.ts:54, 90, 205-241` — `bt/behaviors/Mim.ts:91-147` SM map — `:210-212` rule consts — `:417-428` event subs — `:685-745` onSpeechEvent (spoofed) — `:1052-1167` speak/stopSpeaking — `:1250-1284` listen rules concat
- `bt/mim/MimConfig.ts:30-40` enums, `:148-257` getPromptText — `bt/mim/MimState.ts:17-28`
- `bt/behaviors/TextToSpeech.ts:23-77` — `bt/behaviors/TextToSpeechJs.ts:13-49`
