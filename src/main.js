// Entry point. Boots the 3D viewport, the sidebar tabs, and (M2) the skill
// runtime: a sandboxed iframe whose `jibo.*` calls are bridged to host-side
// services, with its face projected onto Jibo's 3D screen.
// Vanilla ESM, no framework, no bundler.

import { createViewport } from './viewport/scene.js';
import { installTabs } from './ui/tabs.js';
import { installRigPanel } from './ui/rig-panel.js';
import { installChatPanel } from './ui/chat-panel.js';
import { installTtsPanel } from './ui/tts-panel.js';
import { createHostBridge } from './bridge/host-bridge.js';
import { createFaceOverlay } from './bridge/face-overlay.js';
import { createSessionService } from './bridge/services/session-service.js';
import { createTtsService } from './bridge/services/tts-service.js';
import { createNluService } from './bridge/services/nlu-service.js';
import { createAsrService } from './bridge/services/asr-service.js';
import { createAnimationService } from './bridge/services/animation-service.js';
import { loadSkillManifest } from './skill-runtime/skill-loader.js';

const SKILL_DIR = '/skills/hello-world';

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

// Subtitle bar over the viewport (TTS output).
const subtitleEl = document.createElement('div');
subtitleEl.id = 'subtitle';
subtitleEl.hidden = true;
viewportEl.appendChild(subtitleEl);
function setSubtitle(text) {
  if (text) { subtitleEl.textContent = text; subtitleEl.hidden = false; }
  else { subtitleEl.hidden = true; }
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

  // The Chat tab's input is delivered to the skill as recognized speech.
  // (Real wake-word/speech-to-text is shelved; Chat is the text stand-in.)
  const asr = createAsrService({ emit: (event, data) => bridge.emit('asr', event, data) });
  bridge.register('asr', asr.service);
  chat.setSendHandler((text) => asr.recognize(text));

  // jibo.animate: keyframed gestures driving the rig (body + LED) and eye.
  bridge.register('animate', createAnimationService({
    rig: viewport.rig,
    emitFace: (event, data) => bridge.emit('face', event, data),
    loadAnim: (uri) => fetch(`/assets/jibo-legacy/${uri}`).then((r) => r.json()),
  }));

  const overlay = createFaceOverlay({
    viewportEl,
    element: iframe,
    mesh: screenMesh,
    camera: viewport.camera,
  });
  viewport.onFrame(overlay.update);

  // Discover + load the skill from its manifest, then point the iframe at the
  // bundle's entry (its own index.html).
  try {
    const skill = await loadSkillManifest(SKILL_DIR);
    statusEl.textContent =
      `M5 · ${skill.name} v${skill.version} · three.js r${viewport.threeRevision}`;
    if (skill.prompt) chat.setPlaceholder(`${skill.prompt}…`);
    iframe.src = skill.entry;
  } catch (err) {
    console.error('skill load failed:', err);
    statusEl.textContent = `M5 · three.js r${viewport.threeRevision} · skill load FAILED — see console`;
  }
}
