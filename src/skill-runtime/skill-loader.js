// Host-side skill loader. Discovers a skill from its package.json manifest
// (the same "jibo" block jibo-cli's package generator emits) and resolves the
// entry the iframe should load plus the metadata to surface in the UI.
//
// Mirrors how the original simulator resolved a skill via `get-skill-path`
// (jibo-cli/src/simulator/index.ts) + the package.json jibo config.

export async function loadSkillManifest(baseDir) {
  const dir = baseDir.replace(/\/$/, '');
  const res = await fetch(`${dir}/package.json`);
  if (!res.ok) throw new Error(`skill manifest not found: ${dir}/package.json (${res.status})`);
  const pkg = await res.json();
  const j = pkg.jibo || {};
  const main = j.main || pkg.main || 'index.html';
  return {
    dir,
    main,                                                      // entry filename
    entry: `${dir}/${main}`,
    name: j['display-name'] || pkg.name || 'skill',
    version: pkg.version || '0.0.0',
    prompt: j.prompt || '',
    type: j.type || 'behavior',
    launchRule: j.launchRule ? `${dir}/${j.launchRule}` : null,
    pkg,
  };
}
