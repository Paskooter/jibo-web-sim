// Projects the skill's face (an HTML <iframe>) onto Jibo's screen quad.
//
// Jibo's screen is the 4-vertex `screenMeshBillboardMesh`. We take its 4
// corners, transform them to world space, project them to viewport pixels with
// the camera, then solve the 2D homography that maps the iframe's rectangle
// onto those 4 projected points and apply it as a CSS `matrix3d` transform.
// Recomputed every frame so the face tracks the body as it articulates/orbits.
//
// This is the technique from the original simulator's face-on-body.tsx, which
// credits http://math.stackexchange.com/questions/296794 (and jsfiddle dFrHS).

import * as THREE from 'three';

// Logical face resolution, matching the real Jibo face (also handed to the
// skill via the session service so the eye canvas sizes itself the same).
export const FACE_WIDTH = 1280;
export const FACE_HEIGHT = 720;

// --- 3x3 projective matrix helpers (verbatim approach from the reference) ---

function adj(m) {
  return [
    m[4] * m[8] - m[5] * m[7], m[2] * m[7] - m[1] * m[8], m[1] * m[5] - m[2] * m[4],
    m[5] * m[6] - m[3] * m[8], m[0] * m[8] - m[2] * m[6], m[2] * m[3] - m[0] * m[5],
    m[3] * m[7] - m[4] * m[6], m[1] * m[6] - m[0] * m[7], m[0] * m[4] - m[1] * m[3],
  ];
}

function multmm(a, b) {
  const c = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let cij = 0;
      for (let k = 0; k < 3; k++) cij += a[3 * i + k] * b[3 * k + j];
      c[3 * i + j] = cij;
    }
  }
  return c;
}

function multmv(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

function basisToPoints(x1, y1, x2, y2, x3, y3, x4, y4) {
  const m = [x1, x2, x3, y1, y2, y3, 1, 1, 1];
  const v = multmv(adj(m), [x4, y4, 1]);
  return multmm(m, [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]]);
}

function general2DProjection(s1x, s1y, d1x, d1y, s2x, s2y, d2x, d2y,
                             s3x, s3y, d3x, d3y, s4x, s4y, d4x, d4y) {
  const s = basisToPoints(s1x, s1y, s2x, s2y, s3x, s3y, s4x, s4y);
  const d = basisToPoints(d1x, d1y, d2x, d2y, d3x, d3y, d4x, d4y);
  return multmm(d, adj(s));
}

// Identify the quad's 4 corners by UV: TL=(0,1) TR=(1,1) BL=(0,0) BR=(1,0).
function extractCorners(geometry) {
  const pos = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  const want = { TL: [0, 1], TR: [1, 1], BL: [0, 0], BR: [1, 0] };
  const out = {};
  for (const [key, [wu, wv]] of Object.entries(want)) {
    let bestI = 0, bestD = Infinity;
    for (let i = 0; i < uv.count; i++) {
      const d = Math.hypot(uv.getX(i) - wu, uv.getY(i) - wv);
      if (d < bestD) { bestD = d; bestI = i; }
    }
    out[key] = new THREE.Vector3(pos.getX(bestI), pos.getY(bestI), pos.getZ(bestI));
  }
  return out;
}

export function createFaceOverlay({ viewportEl, element, mesh, camera }) {
  element.style.position = 'absolute';
  element.style.top = '0';
  element.style.left = '0';
  element.style.width = `${FACE_WIDTH}px`;
  element.style.height = `${FACE_HEIGHT}px`;
  element.style.transformOrigin = '0 0';
  element.style.willChange = 'transform';
  element.style.visibility = 'hidden';   // until the first frame positions it

  const local = extractCorners(mesh.geometry);
  // Scratch vectors reused each frame.
  const w = { TL: new THREE.Vector3(), TR: new THREE.Vector3(),
              BL: new THREE.Vector3(), BR: new THREE.Vector3() };
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  const normal = new THREE.Vector3(), toCam = new THREE.Vector3();
  const center = new THREE.Vector3();

  function project(local3, world3, W, H) {
    world3.copy(local3).applyMatrix4(mesh.matrixWorld);
    const ndc = world3.clone().project(camera);
    return { x: (ndc.x * 0.5 + 0.5) * W, y: (-ndc.y * 0.5 + 0.5) * H };
  }

  function update() {
    const W = viewportEl.clientWidth;
    const H = viewportEl.clientHeight;
    mesh.updateWorldMatrix(true, false);

    const TL = project(local.TL, w.TL, W, H);
    const TR = project(local.TR, w.TR, W, H);
    const BL = project(local.BL, w.BL, W, H);
    const BR = project(local.BR, w.BR, W, H);

    // Back-face cull using the world-space quad normal vs. the camera.
    // The world corner positions were filled by project() above. With this
    // corner winding (TL,TR,BL) the cross product points INTO the head, so the
    // screen is front-facing when normal·toCam is negative (verified against
    // the rest pose). Hide it once that flips positive (we're behind Jibo).
    e1.copy(w.TR).sub(w.TL);
    e2.copy(w.BL).sub(w.TL);
    normal.copy(e1).cross(e2);
    center.copy(w.TL).add(w.TR).add(w.BL).add(w.BR).multiplyScalar(0.25);
    toCam.copy(camera.position).sub(center);
    if (normal.dot(toCam) >= 0) {
      element.style.visibility = 'hidden';
      return;
    }
    element.style.visibility = 'visible';

    const t = general2DProjection(
      0, 0, TL.x, TL.y,
      FACE_WIDTH, 0, TR.x, TR.y,
      0, FACE_HEIGHT, BL.x, BL.y,
      FACE_WIDTH, FACE_HEIGHT, BR.x, BR.y,
    );
    for (let i = 0; i < 9; i++) t[i] = t[i] / t[8];
    const m3d = [
      t[0], t[3], 0, t[6],
      t[1], t[4], 0, t[7],
      0, 0, 1, 0,
      t[2], t[5], 0, t[8],
    ];
    element.style.transform = `matrix3d(${m3d.join(',')})`;
  }

  return { update };
}
