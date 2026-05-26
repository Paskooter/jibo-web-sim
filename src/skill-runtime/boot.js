// Skill iframe bootstrap. Installs the `jibo` shim as a global, then loads the
// skill bundle as a classic <script> so the skill sees `jibo` globally (as it
// would on a real robot / in the original simulator webview).
//
// Which skill to load is controlled by ?skill=<url> on the iframe src; defaults
// to the hand-written Hello World skill.

import { installJiboShim } from './jibo-shim.js';

const jibo = installJiboShim();
window.jibo = jibo;

const params = new URLSearchParams(location.search);
const skillUrl = params.get('skill') || '/skills/hello-world/skill.js';

const script = document.createElement('script');
script.src = skillUrl;
script.onerror = () => console.error('[skill-runtime] failed to load skill:', skillUrl);
document.body.appendChild(script);
