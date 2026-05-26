// Articulated Jibo rig — uses the legacy .geom + .skel + .kin source data.
//
// We load `jibo_body.geom` directly (the same JSON the original animation-
// utilities Jibo simulator loads via ArticulatedModelLoader/ModelLoader).
// Each mesh in the .geom carries an explicit `skeletonFrameName` pointing
// at a bone in `jibo_body.skel`; we mount the meshes into matching
// THREE.Group "bones" and articulate the chain via the three canonical
// DOFs from `jibo_body.kin`:
//
//   bottomSection_r  — child of rootBn
//   middleSection_r  — child of bottomSection
//   topSection_r     — child of middleSection
//
// All three DOFs rotate about the joint's local +Y axis. The middle and
// top joints have tilted rest-pose quaternions (~+13° and ~-22° about X),
// so the three local-Y rotations aren't parallel in world space — the
// motors couple to swing the head through 3D space.
//
// Legacy renderer uses `defaultMaterial.side = DoubleSide`
// (see sdk-archive/animation-utilities/src/animation-visualize/JiboBody.js).
// The .geom loader mirrors that, which is essential for the head shell
// to read correctly through its face cutout.

import * as THREE from 'three';
import { loadGeom } from './geom-loader.js';

const LEGACY_DIR = 'assets/jibo-legacy/';
const GEOM_FILE  = LEGACY_DIR + 'jibo_body.geom';

// From jibo_body.skel. The full skeleton has nodes for each mesh
// (baseMesh, pelvisMesh, ...) hanging off these joint frames with
// identity transforms — but the .geom vertices are baked in world rest
// coords, so we attach each mesh to its joint via Object3D.attach()
// instead of using the mesh-level skel nodes.
//
// Quaternions stored (w, x, y, z); Three.js wants (x, y, z, w), swap on
// construction.
const SKELETON = {
  bottomSection: {
    parent: 'root',
    translation: [0, 0, 0],
    restQuatWXYZ: [0, 0, 1, 0],                          // 180° about Y
  },
  middleSection: {
    parent: 'bottomSection',
    translation: [0, 0.045563820749521255, -0.0053259097039699554],
    restQuatWXYZ: [0.9935718579377518, 0.11320319392192023, 0, 0],
  },
  topSection: {
    parent: 'middleSection',
    translation: [0, 0.08649425953626633, 0.016203919425606728],
    restQuatWXYZ: [0.9821233481679139, -0.18823848964397946, 0, 0],
  },
};

const DOF_AXIS = new THREE.Vector3(0, 1, 0);

// Map each .geom skeletonFrameName onto one of the four joint groups
// we care about for articulation. (The full skel has per-mesh nodes
// like "baseMesh", "pelvisMesh", etc., but those are identity inside
// their parent joint, so we collapse them.)
const MESH_TO_JOINT = {
  baseMesh:     'root',
  pelvisMesh:   'bottomSection',
  lightringMesh:'bottomSection',
  torsoMesh:    'middleSection',
  headMesh:     'topSection',
  maskMesh:     'topSection',
  screenMesh:   'topSection',
};

function quatFromWXYZ([w, x, y, z]) {
  return new THREE.Quaternion(x, y, z, w);
}

export function createJiboRig(scene) {
  const root = new THREE.Group();
  root.name = 'jibo';
  scene.add(root);

  // Build the joint tree, posed at rest.
  const joints = { root };
  const restQuats = {};
  for (const [name, spec] of Object.entries(SKELETON)) {
    const g = new THREE.Group();
    g.name = name;
    g.position.fromArray(spec.translation);
    restQuats[name] = quatFromWXYZ(spec.restQuatWXYZ);
    g.quaternion.copy(restQuats[name]);
    joints[spec.parent].add(g);
    joints[name] = g;
  }

  // Refs we want after the model load completes.
  const parts = { lightring: null, screen: null, byName: {} };

  function setDof(name, rad) {
    const dof = new THREE.Quaternion().setFromAxisAngle(DOF_AXIS, rad);
    joints[name].quaternion.copy(restQuats[name]).multiply(dof);
  }
  function setBottom(rad) { setDof('bottomSection', rad); }
  function setMiddle(rad) { setDof('middleSection', rad); }
  function setTop(rad)    { setDof('topSection',    rad); }

  function setLEDHex(hex) {
    if (!parts.lightring) return;
    // The lightring's diffuse is black in the source material; the LED
    // color is driven by emissive (and ambient, so we get the color even
    // with low scene lighting).
    parts.lightring.material.emissive.set(hex);
    parts.lightring.material.color.set(hex);
  }
  function setLEDColor(r, g, b) {
    setLEDHex((Math.round(r * 255) << 16) |
              (Math.round(g * 255) << 8)  |
               Math.round(b * 255));
  }

  function setScreenHex(hex) {
    if (!parts.screen) return;
    parts.screen.material.emissive.set(hex);
    parts.screen.material.color.set(hex);
  }

  function reset() {
    setBottom(0); setMiddle(0); setTop(0);
    setLEDHex(0x4ec9ff);
    setScreenHex(0x12161c);
  }

  const ready = loadGeom(GEOM_FILE, LEGACY_DIR).then((meshes) => {
    for (const { name, skeletonFrameName, mesh, material } of meshes) {
      const jointName = MESH_TO_JOINT[skeletonFrameName] ?? 'root';

      // Per-mesh material tweaks.
      if (name === 'lightringMeshMesh') {
        // The .geom's lightringMaterial is all-zero (it's meant to be driven
        // by the three LED color DOFs). Initialize to a visible cyan; the
        // setLEDHex API takes over after that.
        material.emissive.set(0x4ec9ff);
        material.color.set(0x4ec9ff);
        parts.lightring = mesh;
      } else if (name === 'screenMeshBillboardMesh') {
        // Source material has emissive (1,1,1) and no diffuse — meant to
        // display a render-target texture in the legacy sim. Start with a
        // dark panel; M2 will swap in an iframe-driven texture.
        material.map = null;
        material.emissive.set(0x12161c);
        material.color.set(0x12161c);
        parts.screen = mesh;
      }

      parts.byName[name] = mesh;
      // The .geom vertices are baked in world rest coords. Add to scene
      // first, then attach() into the joint group — attach preserves the
      // world transform, computing the local transform automatically so
      // articulation works correctly.
      scene.add(mesh);
      joints[jointName].attach(mesh);
    }
    reset();
  });

  return {
    root,
    ready,
    dofs: ['bottomSection_r', 'middleSection_r', 'topSection_r'],
    dofMin: -3.0543, dofMax: 3.0543, dofCyclic: true,
    setBottom, setMiddle, setTop, setDof,
    setLEDColor, setLEDHex,
    setScreenHex,
    parts,
    reset,
  };
}
