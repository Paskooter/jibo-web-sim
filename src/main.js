// Entry point. Boots the 3D viewport and the sidebar tabs.
// Vanilla ESM, no framework, no bundler.

import { createViewport } from './viewport/scene.js';
import { installTabs } from './ui/tabs.js';
import { installRigPanel } from './ui/rig-panel.js';

const viewportEl = document.getElementById('viewport');
const statusEl = document.getElementById('status');
const resetBtn = document.getElementById('btn-reset-view');
const panelsEl = document.getElementById('tab-panels');

const viewport = createViewport(viewportEl);

resetBtn.addEventListener('click', () => viewport.resetView());

installTabs(document.getElementById('tabs'), panelsEl);
installRigPanel(panelsEl.querySelector('[data-panel="rig"]'), viewport.rig);

statusEl.textContent = `M1 · three.js r${viewport.threeRevision} · ready`;
