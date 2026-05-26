// Skill iframe bootstrap. Installs the `jibo` shim as a global, then loads the
// skill bundle's entry as a classic <script> so the skill sees `jibo` globally
// (as it would on a real robot / in the original simulator webview).
//
// The skill bundle's index.html includes this module; by default it loads the
// bundle's `index.js` (resolved relative to that index.html). ?skill=<url>
// overrides the entry.

import { installJiboShim } from './jibo-shim.js';

const jibo = installJiboShim();
window.jibo = jibo;

const params = new URLSearchParams(location.search);
const skillUrl = params.get('skill') || 'index.js';

const script = document.createElement('script');
script.src = skillUrl;
script.onerror = () => console.error('[skill-runtime] failed to load skill:', skillUrl);
document.body.appendChild(script);
