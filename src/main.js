// Entry point. Boots the 3D viewport, the sidebar tabs, and (M2) the skill
// runtime: a sandboxed iframe whose `jibo.*` calls are bridged to host-side
// services, with its face projected onto Jibo's 3D screen.
// Vanilla ESM, no framework, no bundler.

import * as THREE from 'three';
import { createViewport } from './viewport/scene.js';
import { createLookAtController } from './viewport/lookat.js';
import { installTabs } from './ui/tabs.js';
import { installRigPanel } from './ui/rig-panel.js';
import { installChatPanel } from './ui/chat-panel.js';
import { installTtsPanel } from './ui/tts-panel.js';
import { installLpsPanel } from './ui/lps-panel.js';
import { installAudioPanel } from './ui/audio-panel.js';
import { installNotificationsPanel } from './ui/notifications-panel.js';
import { createNotificationBanner } from './ui/notification-banner.js';
import { createAudioEvent } from './viewport/audio-event.js';
import { createHostBridge } from './bridge/host-bridge.js';
import { createFaceOverlay } from './bridge/face-overlay.js';
import { createSessionService } from './bridge/services/session-service.js';
import { createTtsService } from './bridge/services/tts-service.js';
import { createNluService } from './bridge/services/nlu-service.js';
import { createAsrService } from './bridge/services/asr-service.js';
import { createAnimationService } from './bridge/services/animation-service.js';
import { createLpsService } from './bridge/services/lps-service.js';
import { createNotificationsService } from './bridge/services/notifications-service.js';
import { createMediaService } from './bridge/services/media-service.js';
import { loadSkillManifest } from './skill-runtime/skill-loader.js';

const SKILLS = ['/skills/hello-world', '/skills/fortune-teller', '/external-skills/jibo-be'];
let switchSkill = () => {};   // assigned once the runtime is up

const viewportEl = document.getElementById('viewport');
const statusEl = document.getElementById('status');
const resetBtn = document.getElementById('btn-reset-view');
const panelsEl = document.getElementById('tab-panels');

const viewport = createViewport(viewportEl);

resetBtn.addEventListener('click', () => viewport.resetView());

installTabs(document.getElementById('tabs'), panelsEl);
installRigPanel(panelsEl.querySelector('[data-panel="rig"]'), viewport.rig);
const chat = installChatPanel(panelsEl.querySelector('[data-panel="chat"]'));
const ttsPanel = installTtsPanel(panelsEl.querySelector('[data-panel="tts"]'));

// LPS target + audio events are wired once the runtime is up; the panels
// delegate through these.
let setActiveTarget = () => {};
let fireAudioEvent = () => {};
const lpsPanel = installLpsPanel(panelsEl.querySelector('[data-panel="lps"]'), {
  onSetTarget: (t) => setActiveTarget(t),
  onPlacementMode: (on) => viewport.setPlacement(on ? (pt) => setActiveTarget(pt) : null),
});
installAudioPanel(panelsEl.querySelector('[data-panel="audio"]'), {
  onFire: (t) => fireAudioEvent(t),
  onPlacementMode: (on) => viewport.setPlacement(on ? (pt) => fireAudioEvent(pt) : null),
});

let pushNotification = () => {};
const notificationBanner = createNotificationBanner(viewportEl);
installNotificationsPanel(panelsEl.querySelector('[data-panel="notes"]'), {
  onPush: (n) => pushNotification(n),
});

// Backend server address (e.g. a Pegasus cloud at `pegasus.jibo`). Persisted and
// passed to the skill iframe so the runtime can route cloud requests there.
// Changing it reloads the current skill so the new address takes effect.
const serverInput = document.getElementById('server-addr');
const getServer = () => (localStorage.getItem('jibo-server') || '').trim();
serverInput.value = getServer();
serverInput.addEventListener('change', () => {
  localStorage.setItem('jibo-server', serverInput.value.trim());
  if (switchSkill && skillPicker.value) switchSkill(skillPicker.value);
});

// Skill picker — populated from each bundle's manifest (display-name).
const skillPicker = document.getElementById('skill-picker');
(async () => {
  for (const dir of SKILLS) {
    try {
      const m = await loadSkillManifest(dir);
      const opt = document.createElement('option');
      opt.value = dir;
      opt.textContent = m.name;
      skillPicker.appendChild(opt);
    } catch (err) { console.error('skill manifest load failed:', dir, err); }
  }
})();
skillPicker.addEventListener('change', () => switchSkill(skillPicker.value));

// Subtitle bar over the viewport (TTS output).
const subtitleEl = document.createElement('div');
subtitleEl.id = 'subtitle';
subtitleEl.hidden = true;
viewportEl.appendChild(subtitleEl);
function setSubtitle(text) {
  if (text) { subtitleEl.textContent = text; subtitleEl.hidden = false; }
  else { subtitleEl.hidden = true; }
}

// Photo thumbnail overlay — feedback when jibo.lps.takePhoto fires.
const photoEl = document.createElement('img');
photoEl.id = 'photo-thumb';
photoEl.hidden = true;
viewportEl.appendChild(photoEl);
let photoTimer = 0;
function showPhoto(dataUrl) {
  photoEl.src = dataUrl;
  photoEl.hidden = false;
  clearTimeout(photoTimer);
  photoTimer = setTimeout(() => { photoEl.hidden = true; }, 3500);
}

statusEl.textContent = `M5 · three.js r${viewport.threeRevision} · loading model…`;

viewport.rig.ready
  .then(() => {
    statusEl.textContent = `M5 · three.js r${viewport.threeRevision} · click Start`;
    showStartGate();
  })
  .catch((err) => {
    console.error('Jibo model load failed:', err);
    statusEl.textContent = `M5 · three.js r${viewport.threeRevision} · model load FAILED — see console`;
  });

// A "power-on" gate: browsers block audio until the user interacts with the
// page, so an autoplayed greeting would be silent. The click both unlocks
// audio for the session and boots the skill, so its greeting speaks aloud.
function showStartGate() {
  const gate = document.createElement('button');
  gate.id = 'start-gate';
  gate.type = 'button';
  gate.innerHTML = '<span class="start-eye"></span>Start Jibo';
  gate.addEventListener('click', () => {
    gate.remove();
    startSkillRuntime();
  }, { once: true });
  viewportEl.appendChild(gate);
}

async function startSkillRuntime() {
  const screenMesh = viewport.rig.parts.screen;
  if (!screenMesh) {
    console.error('skill runtime: no screen mesh on the rig; cannot mount face');
    return;
  }

  // The skill's face surface: a sandboxed iframe, projected onto the screen.
  const iframe = document.createElement('iframe');
  iframe.id = 'skill-iframe';
  // allow-same-origin lets the iframe load its ES modules from our dev server;
  // the shim only ever talks to the host via postMessage, so the isolation
  // contract still holds and a true cross-origin host is a drop-in later.
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  iframe.style.pointerEvents = 'none';   // let OrbitControls own the viewport
  viewportEl.appendChild(iframe);

  // Real-runtime skills (jibo-be) speak via SpeechSynthesis in THIS window — the
  // skill iframe is sandboxed so speech there is silent. The skill posts
  // {kind:'speak', id, text}; we utter it and post {kind:'speak-done', id} back
  // when it ends so the skill paces to real speech. Keep utterance refs alive to
  // dodge the Chromium GC-cancels-speech bug.
  const synth = window.speechSynthesis;
  const liveUtters = new Set();
  let speechChecked = false;
  if (synth && synth.getVoices().length === 0 && typeof synth.addEventListener === 'function') {
    synth.addEventListener('voiceschanged', () => {}); // nudge async voice load
  }
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || m.__jibo !== true) return;
    if (m.kind === 'speak') {
      const reply = () => { try { iframe.contentWindow.postMessage({ __jibo: true, kind: 'speak-done', id: m.id }, '*'); } catch (_) { /* gone */ } };
      if (m.text) chat.addJiboMessage(m.text);   // every spoken line shows up in Chat
      if (!synth || typeof window.SpeechSynthesisUtterance !== 'function' || !m.text) { reply(); return; }
      try {
        // Diagnose the most common silent-TTS cause once: no installed voices
        // (typical on Linux Chrome without speech-dispatcher/espeak).
        if (!speechChecked) {
          speechChecked = true;
          const vs = synth.getVoices();
          if (!vs.length) console.warn('[tts] No SpeechSynthesis voices available — Jibo will be silent. Install a system TTS voice (e.g. speech-dispatcher + espeak-ng on Linux), or use a browser/OS with built-in voices.');
          else console.log(`[tts] ${vs.length} SpeechSynthesis voice(s) available`);
        }
        const u = new SpeechSynthesisUtterance(m.text);
        u.rate = 1.0;
        u.pitch = 1.15; // a touch higher — closer to Jibo's voice character
        const en = synth.getVoices().find((v) => /^en/i.test(v.lang));
        if (en) u.voice = en;
        liveUtters.add(u);
        const done = () => { liveUtters.delete(u); reply(); };
        u.onend = done;
        u.onerror = done;
        try { synth.resume(); } catch (_) { /* Chrome 'paused' quirk */ }
        synth.speak(u);
      } catch (_) { reply(); }
    } else if (m.kind === 'speak-stop' && synth) {
      try { synth.cancel(); } catch (_) { /* nothing speaking */ }
    } else if (m.kind === 'dofs' && m.dofs && viewport.rig) {
      // jibo-be animation playback (expression.createAndPlayAnimation) — the
      // skill-runtime samples the animation's channels per frame and posts the
      // resulting DOF map here so the body rig actually moves. Only the body
      // sections + LED ring channels apply to the host viewport; eye DOFs are
      // driven separately inside the iframe via jibo.face.eye.display.
      const d = m.dofs;
      try {
        if ('bottomSection_r' in d) viewport.rig.setDof('bottomSection_r', d.bottomSection_r);
        if ('middleSection_r' in d) viewport.rig.setDof('middleSection_r', d.middleSection_r);
        if ('topSection_r' in d) viewport.rig.setDof('topSection_r', d.topSection_r);
        if (('led_r' in d || 'led_g' in d || 'led_b' in d) && viewport.rig.setLEDColor) {
          viewport.rig.setLEDColor(d.led_r ?? 0.31, d.led_g ?? 0.79, d.led_b ?? 1.0);
        }
      } catch (_) { /* rig not ready */ }
    }
  });

  // Host bridge + services. Create the bridge (starts listening) before
  // pointing the iframe at the skill host, so we catch its 'hello'.
  const bridge = createHostBridge(iframe);
  bridge.register('session', createSessionService());
  bridge.register('tts', createTtsService({
    emit: (event, data) => bridge.emit('tts', event, data),
    onSubtitle: (text) => {
      setSubtitle(text);
      if (text) chat.addJiboMessage(text);   // log Jibo's replies in Chat
      ttsPanel.setSpeaking(text);             // TTS tab readout
    },
  }));
  bridge.register('nlu', createNluService());

  const notifications = createNotificationsService({
    emit: (event, data) => bridge.emit('notifications', event, data),
    onShow: (n) => notificationBanner.show(n),
  });
  bridge.register('notifications', notifications.service);
  pushNotification = notifications.push;

  // The Chat tab's input is delivered to the skill as recognized speech.
  // (Real wake-word/speech-to-text is shelved; Chat is the text stand-in.)
  const asr = createAsrService({ emit: (event, data) => bridge.emit('asr', event, data) });
  bridge.register('asr', asr.service);
  // Typed chat input goes to the skill as recognized speech: ASR.recognize for
  // shim skills, and also into the iframe so real-runtime jibo-be can inject it
  // via MimManager.handleSpeech — the same path the original simulator used to
  // turn typed lines into user utterances.
  chat.setSendHandler((text) => {
    asr.recognize(text);
    try { iframe.contentWindow.postMessage({ __jibo: true, kind: 'utterance', text }, '*'); } catch (_) { /* iframe gone */ }
  });

  // jibo.animate: keyframed gestures driving the rig (body + LED) and eye.
  const animation = createAnimationService({
    rig: viewport.rig,
    emitFace: (event, data) => bridge.emit('face', event, data),
    loadAnim: (uri) => fetch(`/assets/jibo-legacy/${uri}`).then((r) => r.json()),
    setLookTarget: (point) => setActiveTarget(point),   // jibo.animate.lookAt
  });
  bridge.register('animate', animation);

  // jibo.lps + look-at: Jibo turns to track a target placed in the world.
  const lps = createLpsService({ emit: (event, data) => bridge.emit('lps', event, data) });

  // jibo.media + jibo.lps.takePhoto: capture the viewport as a photo.
  const media = createMediaService();
  bridge.register('media', media.service);
  lps.service.takePhoto = () => {
    const dataUrl = viewport.renderer.domElement.toDataURL('image/png');
    const photo = media.store(dataUrl);
    showPhoto(dataUrl);
    return { url: photo.url, id: photo.id };
  };
  bridge.register('lps', lps.service);

  // Screen interaction: a click-drag on the face quad drives Jibo's screen — a
  // quick click is a tap, a drag is a pan (so menus scroll, etc.) — both in face
  // pixel coords. Orbit-rotate is gated behind Ctrl (see scene.js), so while Ctrl
  // is held we leave the gesture to OrbitControls and don't forward anything.
  const tapRay = new THREE.Raycaster();
  const dom = viewport.renderer.domElement;
  const faceAt = (e) => {
    const r = dom.getBoundingClientRect();
    tapRay.setFromCamera(new THREE.Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1,
    ), viewport.camera);
    const hit = tapRay.intersectObject(screenMesh, false)[0];
    return (hit && hit.uv) ? { x: hit.uv.x * 1280, y: (1 - hit.uv.y) * 720 } : null;
  };
  let downX = 0, downY = 0, downT = 0, dragging = false, panned = false, pfx = 0, pfy = 0;
  dom.addEventListener('pointerdown', (e) => {
    downX = e.clientX; downY = e.clientY; downT = performance.now(); dragging = false; panned = false;
    if (viewport.isOrbitModifier()) return;        // Ctrl held → let the camera orbit
    const f = faceAt(e);
    if (f) { dragging = true; pfx = f.x; pfy = f.y; }
  });
  dom.addEventListener('pointermove', (e) => {
    if (!dragging || viewport.isOrbitModifier()) return;
    if (!panned && Math.hypot(e.clientX - downX, e.clientY - downY) <= 6) return; // ignore tap jitter
    const f = faceAt(e);
    if (!f) return;
    panned = true;
    bridge.emit('face', 'pan', { x: f.x, y: f.y, movementX: f.x - pfx, movementY: f.y - pfy, isFinal: false });
    pfx = f.x; pfy = f.y;
  });
  dom.addEventListener('pointerup', (e) => {
    if (dragging && panned) {
      bridge.emit('face', 'pan', { x: pfx, y: pfy, movementX: 0, movementY: 0, isFinal: true });
    } else if (!viewport.isOrbitModifier() && Math.hypot(e.clientX - downX, e.clientY - downY) <= 6 && performance.now() - downT <= 350) {
      const f = faceAt(e);
      if (f) bridge.emit('face', 'touch', f);
    }
    dragging = false; panned = false;
  });

  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(0.018, 20, 16),
    new THREE.MeshBasicMaterial({ color: 0xffb454 }),
  );
  marker.visible = false;
  viewport.scene.add(marker);

  const lookat = createLookAtController({
    rig: viewport.rig,
    screenMesh,
    emitFace: (event, data) => bridge.emit('face', event, data),
    isBusy: () => animation.isActive(),
    dofMax: viewport.rig.dofMax,
  });
  lookat.calibrate();
  viewport.onFrame(lookat.update);

  // Attention = a transient audio glance, else the persistent LPS target.
  let lpsTarget = null;
  let audioAttention = null;
  const applyAttention = () => lookat.setTarget(audioAttention || lpsTarget);

  setActiveTarget = (pt) => {
    lpsTarget = pt ? { x: pt.x, y: pt.y, z: pt.z } : null;
    lps.setTarget(lpsTarget);
    marker.visible = !!lpsTarget;
    if (lpsTarget) marker.position.set(lpsTarget.x, lpsTarget.y, lpsTarget.z);
    lpsPanel.showTarget(lpsTarget);
    applyAttention();
  };

  // Audio events: spawn a ping, glance toward it, notify the skill, then revert.
  const audioViz = [];
  let audioTimer = 0;
  fireAudioEvent = (pt) => {
    const entity = {
      id: 'a' + Math.floor(performance.now()), name: 'sound', type: 'audio',
      position: { x: pt.x, y: pt.y, z: pt.z }, confidence: 100,
    };
    lps.fireAudioEvent(entity);
    audioViz.push(createAudioEvent(viewport.scene, pt));
    audioAttention = { x: pt.x, y: pt.y, z: pt.z };
    applyAttention();
    clearTimeout(audioTimer);
    audioTimer = setTimeout(() => {
      audioAttention = null;
      lps.clearAudioEvent(entity);
      applyAttention();
    }, 1600);
  };
  viewport.onFrame(() => {
    if (!audioViz.length) return;
    const now = performance.now();
    for (let i = audioViz.length - 1; i >= 0; i--) {
      if (!audioViz[i].update(now)) { audioViz[i].dispose(); audioViz.splice(i, 1); }
    }
  });

  const overlay = createFaceOverlay({
    viewportEl,
    element: iframe,
    mesh: screenMesh,
    camera: viewport.camera,
  });
  viewport.onFrame(overlay.update);

  // Load a skill from its manifest and point the iframe at the bundle entry.
  // Used at boot and when the picker switches skills.
  async function applySkill(dir) {
    try {
      const skill = await loadSkillManifest(dir);
      statusEl.textContent = `${skill.name} v${skill.version} · three.js r${viewport.threeRevision}`;
      chat.setPlaceholder(skill.prompt ? `${skill.prompt}…` : 'Say something to Jibo…');
      setActiveTarget(null);              // drop any look-at when switching skills
      // The in-place loader (skill-host.html) sets up jibo + require, then runs
      // the bundle's own index.html unmodified.
      const server = getServer();
      iframe.src = `/skill-host.html?dir=${encodeURIComponent(skill.dir)}&entry=${encodeURIComponent(skill.main)}${server ? `&server=${encodeURIComponent(server)}` : ''}`;
      if (skillPicker.value !== dir) skillPicker.value = dir;
    } catch (err) {
      console.error('skill load failed:', err);
      statusEl.textContent = `M11 · three.js r${viewport.threeRevision} · skill load FAILED — see console`;
    }
  }
  switchSkill = applySkill;
  applySkill(SKILLS[0]);
}
