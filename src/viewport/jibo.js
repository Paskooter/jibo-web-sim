// Articulated Jibo rig.
//
// Built from the canonical Jibo skeleton + kinematics from
// `sdk-archive/animation-utilities/res/geometry-config/P1.0/`
// (`jibo_body.skel`, `jibo_body.kin`).
//
// Three DOFs, all rotations around the joint's local +Y axis:
//
//   bottomSection_r  — child of rootBn
//   middleSection_r  — child of bottomSection
//   topSection_r     — child of middleSection
//
// The "look anywhere in 3D" capability comes from the *tilted rest-pose
// quaternions* on middleSection (+~13° about X) and topSection (-~22° about X).
// The three local-Y rotations are not parallel in world space, so the three
// motors couple to produce yaw + pitch + (effective) roll of the face.
//
// Mesh parent chain (from the .skel):
//
//   rootBn
//   ├── baseMesh
//   └── bottomSection
//       ├── lightringMesh
//       ├── pelvisMesh
//       └── middleSection
//           ├── torsoMesh
//           └── topSection
//               ├── headMesh
//               ├── maskMesh
//               └── screenMesh
//
// The MIT Media Lab OBJ export bakes the rest-pose transforms into world
// vertex positions, so each loaded mesh's vertices are already in display
// coordinates. We use `Object3D.attach()` to re-parent each mesh into its
// joint group *without changing its world transform*; then rotating the
// joints articulates the chain correctly.

import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';

const MODEL_DIR = 'assets/jibo-model/';
const MTL_FILE  = 'jibomtl.mtl';

// From jibo_body.skel. Quaternions stored as (w, x, y, z); Three.js wants
// (x, y, z, w), so swap order on construction.
const SKELETON = {
  bottomSection: {
    parent: 'root',
    translation: [0, 0, 0],
    restQuatWXYZ: [0, 0, 1, 0],                 // 180° about Y
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

// Mesh → joint mapping (per the .skel children).
const MESH_PARENT = {
  baseMeshMesh:              'root',
  pelvisMeshMesh:            'bottomSection',
  lightringMeshMesh:         'bottomSection',
  torsoMeshMesh:             'middleSection',
  headMeshMesh:              'topSection',
  maskMeshMesh:              'topSection',
  screenMeshBillboardMesh:   'topSection',
};

const PARTS = Object.keys(MESH_PARENT).map((f) => ({
  file: f + '.obj',
  attach: MESH_PARENT[f],
  role: f === 'lightringMeshMesh' ? 'lightring'
      : f === 'screenMeshBillboardMesh' ? 'screen'
      : null,
}));

function quatFromWXYZ([w, x, y, z]) {
  return new THREE.Quaternion(x, y, z, w);
}

export function createJiboRig(scene) {
  const root = new THREE.Group();
  root.name = 'jibo';
  scene.add(root);

  // Joint groups, in rest pose. Initialize each with its rest quaternion;
  // articulation composes the DOF rotation on top.
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

  const parts = { lightring: null, screen: null };

  function setDof(name, rad) {
    const dof = new THREE.Quaternion().setFromAxisAngle(DOF_AXIS, rad);
    joints[name].quaternion.copy(restQuats[name]).multiply(dof);
  }

  function setBottom(rad) { setDof('bottomSection', rad); }
  function setMiddle(rad) { setDof('middleSection', rad); }
  function setTop(rad)    { setDof('topSection', rad); }

  function setLEDColor(r, g, b) {
    if (!parts.lightring) return;
    const hex = (Math.round(r * 255) << 16) |
                (Math.round(g * 255) << 8)  |
                 Math.round(b * 255);
    parts.lightring.traverse((o) => { if (o.isMesh) o.material.color.set(hex); });
  }
  function setLEDHex(hex) {
    if (!parts.lightring) return;
    parts.lightring.traverse((o) => { if (o.isMesh) o.material.color.set(hex); });
  }

  function reset() {
    setBottom(0); setMiddle(0); setTop(0);
    setLEDHex(0x4ec9ff);
  }

  const ready = loadModel(scene, joints, parts).then(() => reset());

  return {
    root,
    ready,
    // Canonical Jibo DOFs (from jibo_body.kin).
    dofs: ['bottomSection_r', 'middleSection_r', 'topSection_r'],
    dofMin: -3.0543, dofMax: 3.0543, dofCyclic: true,
    setBottom, setMiddle, setTop,
    setDof,
    setLEDColor, setLEDHex,
    reset,
  };
}

async function loadModel(scene, joints, parts) {
  const mtlLoader = new MTLLoader().setPath(MODEL_DIR);
  const materials = await new Promise((resolve, reject) => {
    mtlLoader.load(MTL_FILE, resolve, undefined, reject);
  });
  materials.preload();

  await Promise.all(PARTS.map(async (p) => {
    const objLoader = new OBJLoader().setMaterials(materials).setPath(MODEL_DIR);
    const obj = await new Promise((resolve, reject) => {
      objLoader.load(p.file, resolve, undefined, reject);
    });

    // Role-specific material overrides.
    if (p.role === 'lightring') {
      obj.traverse((o) => {
        if (o.isMesh) o.material = new THREE.MeshBasicMaterial({ color: 0x4ec9ff });
      });
      parts.lightring = obj;
    } else if (p.role === 'screen') {
      obj.traverse((o) => {
        if (o.isMesh) {
          o.material = new THREE.MeshBasicMaterial({
            color: 0x1f2630, side: THREE.DoubleSide
          });
        }
      });
      parts.screen = obj;
    }

    // Vertices are in world coords. Add to scene first, then re-parent into
    // the right joint group with attach() so the world transform is
    // preserved at rest. Articulating the joint will then move the mesh
    // correctly because its local transform compensates for the joint's
    // rest transform.
    scene.add(obj);
    joints[p.attach].attach(obj);
  }));
}
