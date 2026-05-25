// Entry point. Boots the 3D viewport and the sidebar tabs.
// Vanilla ESM, no framework, no bundler.

import { createViewport } from './viewport/scene.js';
import { installTabs } from './ui/tabs.js';

const viewportEl = document.getElementById('viewport');
const statusEl = document.getElementById('status');
const resetBtn = document.getElementById('btn-reset-view');

const viewport = createViewport(viewportEl);

resetBtn.addEventListener('click', () => viewport.resetView());

installTabs(document.getElementById('tabs'), document.getElementById('tab-panels'));

statusEl.textContent = `M0 · three.js r${viewport.threeRevision} · ready`;
