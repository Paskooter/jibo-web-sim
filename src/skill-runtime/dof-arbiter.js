// DOFArbiter — faithful in-browser port of the
// `jibo-dof-arbiter` package that the real expression service runs
// inside the SSM (skills-service-manager). Source:
//   /tmp/sdk/packages/jibo-dof-arbiter/src/main/{DOFArbiter,
//     DOFArbiterPriorityPolicy, DOFEventDispatcher, OwnerInfo,
//     DOFOptions, DOFOwnershipListener, index}.ts
//
// In jibo v12 the runtime-level `jibo.dofArbiter` was REMOVED (the
// bundle throws on access: "jibo.dofArbiter has been removed, please
// use jibo.expression"). Arbitration now lives inside the expression
// service, behind expression.createAndPlayAnimation/playAnimation,
// which forwards a requestor string ('Behavior'/'EmbodiedSpeech'/
// 'BargeIn'/etc.) to dofArbiter.playAnimation. Because we don't run
// the expression service offline, we drive the same arbitration
// locally in the iframe and wire it into our createAndPlayAnimation
// stub (installExpressionStubs).
//
// Priority config below mirrors ExpressionService.initDOFArbiter
// (ExpressionService.ts:135-149) verbatim.

// OwnershipStatusFlag — matches OwnerInfo.ts:14-23.
export const OwnershipStatusFlag = Object.freeze({
  AVAILABLE: 0,
  ACTIVE_AUTO: 1,
  ACTIVE_LOCKED: 2,
  TIMED_RELEASE: 3,
});

// One per DOF; tracks the current/most-recent owner, instance, status.
// Mirrors OwnerInfo.ts OwnershipInformation.
export class OwnershipInformation {
  constructor(dof) {
    this.dof = dof;
    this.owner = null;
    this.mostRecentOwner = null;
    this.ownerInstance = null;
    this.ownershipStatus = OwnershipStatusFlag.AVAILABLE;
    this.releasedAt = null;     // ms timestamp (we use performance.now() instead of jibo's Clock.currentTime)
  }
}

// Default priority config from ExpressionService.ts:135-149. Higher
// number wins. 'Direct' (priorityForDirectUsers) is the bucket for
// animation requests that go directly through animation-utilities
// without being mediated by playAnimation — those can't be denied,
// only their priority affects whether others can interrupt them.
export const DEFAULT_PRIORITY_CONFIG = Object.freeze({
  priorityForUnknownLabels: 5,
  priorityForDirectUsers: 10,
  priorityEntries: [
    { owner: 'LowTest', priority: 1 },
    { owner: 'Cleanup', priority: 2 },
    { owner: 'Attention', priority: 3 },
    { owner: 'Behavior', priority: 5 },
    { owner: 'EmbodiedSpeech', priority: 5 },
    { owner: 'EmbodiedListen', priority: 7 },
    { owner: 'AttentionCommand', priority: 7 },
    { owner: 'BargeIn', priority: 8 },
    { owner: 'Test', priority: 9 },
  ],
});

// DOFArbiterPriorityPolicy — port of DOFArbiterPriorityPolicy.ts.
// acquire(requester, dofs, dofOwners, options): which subset of the
// requested DOFs this requester is allowed to take. Denials happen
// when the current owner has >= priority. With options.allOrNothing
// true, ANY denial returns []. Otherwise the allowed subset is
// returned and the requester takes what it can.
export class DOFArbiterPriorityPolicy {
  constructor(config, directCommandsLabel) {
    this.unknownRequesterIDPriority = config.priorityForUnknownLabels;
    this.priorityMap = new Map();
    for (const entry of config.priorityEntries) this.priorityMap.set(entry.owner, entry.priority);
    this.priorityMap.set(directCommandsLabel, config.priorityForDirectUsers);
  }
  _priorityOf(requester) {
    const p = this.priorityMap.get(requester);
    return p === undefined ? this.unknownRequesterIDPriority : p;
  }
  acquire(requester, dofs, dofOwners, options) {
    const allowed = [];
    const denied = [];
    const newPriority = this._priorityOf(requester);
    for (const dof of dofs) {
      const info = dofOwners.get(dof);
      if (!info) { denied.push(dof); continue; }   // unknown DOF — be conservative
      const curOwner = info.owner;
      if (curOwner === requester || curOwner === null) { allowed.push(dof); continue; }
      const curPriority = this._priorityOf(curOwner);
      if (curPriority < newPriority) allowed.push(dof);
      else denied.push(dof);
    }
    if (denied.length > 0 && options && options.allOrNothing) return [];
    return allowed;
  }
  // Sort owners low→high priority (for listener-notification order).
  ownerPriorityOrder(owners) {
    return owners.slice().sort((a, b) => this._priorityOf(a) - this._priorityOf(b));
  }
}

// Queue events emitted from within arbiter stack-frames, dispatch
// them all at the end so listener callbacks see a stable arbiter
// state. Singleton mirrors DOFEventDispatcher.ts:23-78.
export class DOFEventDispatcher {
  constructor() { this._queue = []; }
  static getInstance() {
    if (!DOFEventDispatcher._instance) DOFEventDispatcher._instance = new DOFEventDispatcher();
    return DOFEventDispatcher._instance;
  }
  queueEvent(fn, thisArg, args) {
    if (!fn) return;
    this._queue.push({ f: fn, o: thisArg, a: args });
  }
  dispatchQueuedEvents() {
    const q = this._queue;
    this._queue = [];
    for (const e of q) { try { e.f.apply(e.o, e.a); } catch (_) { /* listener threw */ } }
  }
}

// Main arbiter. Tracks per-DOF ownership across a known DOF universe
// (set via init(robotInfo) or init(dofNamesArray)). Skills call
// playAnimation(builderLike, requester) which:
//   1. Asks the policy which DOFs we can take.
//   2. Marks them ACTIVE_AUTO and owned by us; emits dofsLost on
//      previous owners (queued through DOFEventDispatcher).
//   3. Returns instance (or null if all-or-nothing rejected).
// When the caller signals the instance stopped/cancelled it transitions
// owned DOFs to TIMED_RELEASE. update() (called every 100ms) walks
// the table and demotes TIMED_RELEASE → AVAILABLE after the grace
// period (graceExpiryPeriodS, default -0.001 = release immediately,
// matching DOFArbiter.ts:119).
export class DOFArbiter {
  constructor() {
    this._policy = null;
    this._dofOwners = new Map();
    this._instanceToDOF = new Map();
    this._builderToOwner = new Map();
    this._ownershipListeners = new Map();
    this._ownershipListenersInOrder = [];
    this._eventDispatcher = DOFEventDispatcher.getInstance();
    this._directRequester = 'Direct';
    this._mainAnimationLayer = 'default';
    this._graceExpiryMs = -1;
    this._updateTimer = 0;
    this._defaultOptions = { allOrNothing: true };
  }
  // robotInfoOrNames: either an animation-utilities RobotInfo (we'll
  // call getDOFNames()) or an array of DOF name strings.
  init(robotInfoOrNames, priorityConfig) {
    if (this._policy) return;  // idempotent — matches "Initialized multiple times!" guard
    const cfg = priorityConfig || DEFAULT_PRIORITY_CONFIG;
    this._policy = new DOFArbiterPriorityPolicy(cfg, this._directRequester);
    const names = Array.isArray(robotInfoOrNames)
      ? robotInfoOrNames
      : (robotInfoOrNames && typeof robotInfoOrNames.getDOFNames === 'function'
          ? robotInfoOrNames.getDOFNames()
          : []);
    for (const name of names) this._dofOwners.set(name, new OwnershipInformation(name));
    // 100ms tick — DOFArbiter.ts:173 setInterval(update, 100). Skipped
    // when no DOFs are registered (nothing to track).
    if (names.length > 0 && typeof setInterval !== 'undefined') {
      this._updateTimer = setInterval(this.update.bind(this), 100);
    }
  }
  // Periodic — TIMED_RELEASE → AVAILABLE after grace period. Notifies
  // ownership listeners (low → high priority) of freed DOFs.
  update() {
    if (!this._policy) return;
    const now = performance.now();
    const freed = [];
    for (const info of this._dofOwners.values()) {
      if (info.ownershipStatus !== OwnershipStatusFlag.TIMED_RELEASE) continue;
      const ageMs = now - (info.releasedAt || now);
      if (ageMs >= this._graceExpiryMs) {
        info.ownershipStatus = OwnershipStatusFlag.AVAILABLE;
        info.owner = null;
        info.ownerInstance = null;
        info.releasedAt = null;
        freed.push(info.dof);
      }
    }
    if (freed.length) {
      // Notify high-priority owners last so they react to the freed
      // DOFs after lower-priority listeners have had a chance to
      // (matches DOFArbiter.ts:209 — reverse iteration).
      for (let i = this._ownershipListenersInOrder.length - 1; i >= 0; i--) {
        const owner = this._ownershipListenersInOrder[i];
        const ls = this._ownershipListeners.get(owner);
        if (!ls) continue;
        for (const l of ls) { try { l.dofsAvailable(freed); } catch (_) { /* listener threw */ } }
      }
    }
    this._eventDispatcher.dispatchQueuedEvents();
  }
  // Stop the periodic update loop and clear all state. Used when the
  // arbiter is being re-initialized (test scenarios only).
  dispose() {
    if (this._updateTimer) { clearInterval(this._updateTimer); this._updateTimer = 0; }
    this._dofOwners.clear();
    this._instanceToDOF.clear();
    this._builderToOwner.clear();
    this._ownershipListeners.clear();
    this._ownershipListenersInOrder = [];
    this._policy = null;
  }
  // Try to play the builder under `requester`'s ownership. Returns
  // an instance (whatever builder.play() returns) if any DOFs were
  // acquired, else null. The builder MUST expose getDOFs() and
  // optionally setDOFs() + play(). Mirrors DOFArbiter.ts:232-273.
  playAnimation(builder, requester, options) {
    if (!this._policy) return builder && builder.play ? builder.play() : null;
    if (builder && builder.layer && builder.layer !== this._mainAnimationLayer) {
      // Non-default-layer builders are not arbitrated, just played.
      return builder.play();
    }
    const opts = options || this._defaultOptions;
    const desired = (builder && typeof builder.getDOFs === 'function') ? builder.getDOFs() : [];
    const allowed = this._policy.acquire(requester, desired, this._dofOwners, opts);
    if (typeof builder.setDOFs === 'function') builder.setDOFs(allowed);
    this._builderToOwner.set(builder, requester);
    const instance = builder.play ? builder.play() : null;
    this._builderToOwner.delete(builder);
    if (instance) {
      // If the global ADDED handler didn't fire (no animation-utilities
      // global hook in our port), mark ownership directly so the
      // arbiter's state matches what the bundle would observe.
      if (!this._instanceToDOF.has(instance) && allowed.length > 0) {
        const changes = this._markInUseByInstance(requester, instance, allowed);
        this._notifyLoss(changes.dofLosses);
        this._notifyGain(changes.dofGains.owner, changes.dofGains.dofs);
      }
    }
    if (typeof builder.setDOFs === 'function') builder.setDOFs(desired);
    this._eventDispatcher.dispatchQueuedEvents();
    return allowed.length > 0 ? instance : null;
  }
  // Standalone claim — used when an animation is created and the
  // caller manages the instance lifecycle separately (DOFArbiter.ts:465).
  attemptToClaimForInstance(requester, instance, desiredDOFs, options) {
    if (!this._policy) return desiredDOFs;
    const opts = options || this._defaultOptions;
    const allowed = this._policy.acquire(requester, desiredDOFs, this._dofOwners, opts);
    const changes = this._markInUseByInstance(requester, instance, allowed);
    this._notifyLoss(changes.dofLosses);
    this._notifyGain(changes.dofGains.owner, changes.dofGains.dofs);
    this._eventDispatcher.dispatchQueuedEvents();
    return allowed;
  }
  // Probe-only — same policy check, no state change. DOFArbiter.ts:485.
  getAvailable(requester, desiredDOFs, options) {
    if (!this._policy) return desiredDOFs;
    const opts = options || this._defaultOptions;
    return this._policy.acquire(requester, desiredDOFs, this._dofOwners, opts);
  }
  // List DOFs currently owned by requester. DOFArbiter.ts:499.
  getDofsInUse(requester) {
    const out = [];
    for (const info of this._dofOwners.values()) if (info.owner === requester) out.push(info.dof);
    return out;
  }
  // Listener registration — DOFArbiter.ts:520. listener must implement
  // dofsLost(owner, dofs[]), dofsGained(owner, dofs[]), dofsAvailable(dofs[]).
  addListener(forOwner, listener) {
    let arr = this._ownershipListeners.get(forOwner);
    if (!arr) { arr = []; this._ownershipListeners.set(forOwner, arr); }
    if (arr.indexOf(listener) < 0) {
      arr.push(listener);
      this._ownershipListenersInOrder = this._policy
        ? this._policy.ownerPriorityOrder(Array.from(this._ownershipListeners.keys()))
        : Array.from(this._ownershipListeners.keys());
    }
  }
  removeListener(forOwner, listener) {
    const arr = this._ownershipListeners.get(forOwner);
    if (!arr) return;
    const i = arr.indexOf(listener);
    if (i < 0) return;
    arr.splice(i, 1);
    if (arr.length === 0) this._ownershipListeners.delete(forOwner);
    this._ownershipListenersInOrder = this._policy
      ? this._policy.ownerPriorityOrder(Array.from(this._ownershipListeners.keys()))
      : Array.from(this._ownershipListeners.keys());
  }
  // Subset of provided DOFs whose mostRecentOwner is in onlyForOwners.
  // DOFArbiter.ts:565.
  getDOFsMostRecentlyOwnedBy(desiredDOFs, onlyForOwners) {
    const filtered = [];
    const want = new Set(onlyForOwners);
    for (const dof of desiredDOFs) {
      const info = this._dofOwners.get(dof);
      if (info && want.has(info.mostRecentOwner)) filtered.push(dof);
    }
    return filtered;
  }
  // Caller signals an instance ended naturally (STOPPED) or was
  // preempted/cancelled. Transitions owned DOFs to TIMED_RELEASE so
  // the next update() tick demotes them to AVAILABLE.
  // Mirrors DOFArbiter.ts:785-815 STOPPED/CANCELLED branch.
  releaseInstance(instance) {
    const dofs = this._instanceToDOF.get(instance);
    if (!dofs) return;
    let didAny = false;
    const now = performance.now();
    for (const dof of dofs) {
      const info = this._dofOwners.get(dof);
      if (info && info.ownerInstance === instance && info.ownershipStatus === OwnershipStatusFlag.ACTIVE_AUTO) {
        info.ownershipStatus = OwnershipStatusFlag.TIMED_RELEASE;
        info.releasedAt = now;
        didAny = true;
      }
    }
    this._instanceToDOF.delete(instance);
    if (didAny) this.update();   // immediate release if grace ≤ 0
  }
  // Centering — DOFArbiter.ts:332-399. Restore DOFs to their default
  // (rest) pose. We don't have an animate engine to build a real
  // pose-anim builder, so the caller (installExpressionStubs) hands
  // us a simple {getDOFs, play} object. Faithful semantics: try to
  // acquire the requested DOF set, if anything is allowed run the
  // builder under that requester. completionCallback fires when the
  // builder reports STOPPED/CANCELLED, or immediately if 0 acquired.
  centerRobot(requester, whichDOFs, centerGlobally, completionCallback) {
    if (!this._policy) { if (completionCallback) completionCallback(); return; }
    const desired = (whichDOFs && typeof whichDOFs.getDOFs === 'function') ? whichDOFs.getDOFs() : Array.from(this._dofOwners.keys());
    const allowed = this._policy.acquire(requester, desired, this._dofOwners, { allOrNothing: false });
    if (allowed.length === 0) { if (completionCallback) completionCallback(); return; }
    // Without a real animBuilder we can't actually drive joints to
    // rest from here. The expected effect is observed via the host
    // bridge's _lastBodyDofs ease-in: marking AVAILABLE will let the
    // next animation ease from the rig's current pose, and skills
    // that depend on "rest after centering" follow up with their
    // own neutral-pose play. Mark the DOFs as transient-owned then
    // immediately released so listeners observe the transition.
    const changes = this._markAsUsedByTransient(requester, allowed);
    this._notifyLoss(changes.dofLosses);
    this._notifyGain(changes.dofGains.owner, changes.dofGains.dofs);
    this._eventDispatcher.dispatchQueuedEvents();
    this.update();
    if (completionCallback) completionCallback();
  }
  // DOFArbiter.ts:421-448. Filter DOFs to those most-recently owned
  // by `onlyForOwners`, acquire under `requester`'s priority, then
  // hand off to `trustee` for the ongoing centering.
  centerWithHybridPriority(requester, trustee, desiredDOFSet, onlyForOwners, centerGlobally, completionCallback) {
    if (!this._policy) { if (completionCallback) completionCallback(); return; }
    const allDofs = Array.from(this._dofOwners.keys());
    let useDOFs = (desiredDOFSet && typeof desiredDOFSet.getDOFs === 'function') ? desiredDOFSet.getDOFs() : allDofs;
    if (onlyForOwners && onlyForOwners.length) useDOFs = this.getDOFsMostRecentlyOwnedBy(useDOFs, onlyForOwners);
    useDOFs = this._policy.acquire(requester, useDOFs, this._dofOwners, { allOrNothing: false });
    const changes = this._markAsUsedByTransient(trustee, useDOFs);
    this._eventDispatcher.queueEvent(this._notifyLoss, this, [changes.dofLosses]);
    this._eventDispatcher.queueEvent(this._notifyGain, this, [changes.dofGains.owner, changes.dofGains.dofs]);
    this.centerRobot(trustee, { getDOFs: () => useDOFs }, !!centerGlobally, completionCallback);
  }
  // _markInUseByInstance — DOFArbiter.ts:651. Move DOFs to ACTIVE_AUTO
  // ownership. Returns the diff (losses by old-owner, gains by new-owner).
  _markInUseByInstance(requester, instance, dofsToUse) {
    const dofLosses = {};
    const dofsGained = [];
    this._instanceToDOF.set(instance, dofsToUse);
    for (const dof of dofsToUse) {
      const info = this._dofOwners.get(dof);
      if (!info) continue;
      if (info.owner !== requester) {
        dofsGained.push(dof);
        if (info.owner !== null) {
          if (!dofLosses[info.owner]) dofLosses[info.owner] = [];
          dofLosses[info.owner].push(dof);
        }
      }
      info.owner = requester;
      info.mostRecentOwner = requester;
      info.ownerInstance = instance;
      info.ownershipStatus = OwnershipStatusFlag.ACTIVE_AUTO;
      info.releasedAt = null;
    }
    return { dofLosses, dofGains: { owner: requester, dofs: dofsGained } };
  }
  // _markAsUsedByTransient — DOFArbiter.ts:685. Used for instant
  // (instance-less) DOF usage; immediately goes to TIMED_RELEASE.
  _markAsUsedByTransient(requester, dofsToUse) {
    const dofLosses = {};
    const dofsGained = [];
    const now = performance.now();
    for (const dof of dofsToUse) {
      const info = this._dofOwners.get(dof);
      if (!info) continue;
      if (info.owner !== requester) {
        dofsGained.push(dof);
        if (info.owner !== null) {
          if (!dofLosses[info.owner]) dofLosses[info.owner] = [];
          dofLosses[info.owner].push(dof);
        }
      }
      info.owner = requester;
      info.mostRecentOwner = requester;
      info.ownershipStatus = OwnershipStatusFlag.TIMED_RELEASE;
      info.ownerInstance = null;
      info.releasedAt = now;
    }
    return { dofLosses, dofGains: { owner: requester, dofs: dofsGained } };
  }
  _notifyLoss(dofLosses) {
    for (const owner of Object.keys(dofLosses)) {
      const ls = this._ownershipListeners.get(owner);
      if (!ls) continue;
      const lost = dofLosses[owner];
      for (const l of ls) { try { l.dofsLost(owner, lost); } catch (_) { /* listener threw */ } }
    }
  }
  _notifyGain(owner, dofs) {
    const ls = this._ownershipListeners.get(owner);
    if (!ls) return;
    for (const l of ls) { try { l.dofsGained(owner, dofs); } catch (_) { /* listener threw */ } }
  }
}

export default DOFArbiter;
