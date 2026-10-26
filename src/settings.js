// Persistent user settings. The server owns the file (settings.json in the
// sim root, override with SETTINGS_FILE) and exposes it at /__settings; this
// module is shared by both sides so the defaults and the validation rules
// live in one place. No DOM / Node imports here.

export const DEFAULTS = {
  version: 1,
  wakeWord: false,   // arm the "Hey Jibo" detector on page load
  server: '',        // cloud hub host (blank = offline)
  skill: '',         // last-picked skill dir (blank/unknown = first available)
  viewport: {
    background: '#0b0e12',   // 3D scene backdrop
    floorColor: '#141a22',   // the faint disc under Jibo
  },
};

// Extra per-setting format rules, keyed by dotted path (type is already checked
// against DEFAULTS).
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const FORMATS = {
  'viewport.background': [HEX_COLOR, 'a #rrggbb colour'],
  'viewport.floorColor': [HEX_COLOR, 'a #rrggbb colour'],
};
const badFormat = (path, v) => { const f = FORMATS[path]; return f && !f[0].test(v) ? f[1] : null; };

// Check `patch` against the shape of `defaults`: every key must exist there and
// carry the same JS type; nested objects recurse. Returns an array of problems
// (empty = valid).
export function validate(patch, defaults = DEFAULTS, path = '') {
  const errors = [];
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return [`${path || 'settings'}: expected an object`];
  }
  for (const [k, v] of Object.entries(patch)) {
    const here = path + k;
    if (!(k in defaults)) { errors.push(`${here}: unknown setting`); continue; }
    const want = defaults[k];
    if (want !== null && typeof want === 'object') errors.push(...validate(v, want, here + '.'));
    else if (typeof v !== typeof want) errors.push(`${here}: expected ${typeof want}, got ${typeof v}`);
    else if (badFormat(here, v)) errors.push(`${here}: expected ${badFormat(here, v)}`);
  }
  return errors;
}

// Drop every entry of `raw` that validate() would reject, keeping the rest —
// used on the hand-editable file so one typo doesn't discard the whole thing.
export function sanitize(raw, defaults = DEFAULTS, path = '') {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).flatMap(([k, v]) => {
    const want = defaults[k];
    if (!(k in defaults)) return [];
    if (want !== null && typeof want === 'object') return [[k, sanitize(v, want, `${path}${k}.`)]];
    return typeof v === typeof want && !badFormat(path + k, v) ? [[k, v]] : [];
  }));
}

// Deep-merge `patch` over `base` (both plain, already-valid objects).
export function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v !== null && typeof v === 'object' ? merge(base[k] || {}, v) : v;
  }
  return out;
}

// Client side -------------------------------------------------------------

// Fetch the effective settings. Any failure (server down, route missing) falls
// back to the defaults so the sim still boots.
export async function loadSettings() {
  try {
    const r = await fetch('/__settings');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return merge(DEFAULTS, await r.json());
  } catch (e) {
    console.warn('[settings] using defaults:', e.message);
    return structuredClone(DEFAULTS);
  }
}

// Persist a partial update (e.g. { wakeWord: true }). Fire-and-forget; writes
// are applied by the server in arrival order.
export function saveSettings(patch) {
  return fetch('/__settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }).then((r) => {
    if (!r.ok) return r.json().then((b) => { throw new Error((b.errors || [r.status]).join('; ')); });
  }).catch((e) => console.warn('[settings] save failed:', e.message));
}
