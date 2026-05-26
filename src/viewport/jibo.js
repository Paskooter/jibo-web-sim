// Articulated Jibo rig.
//
// Joint hierarchy:
//
//   root
//   ├── base                       (fixed pedestal)
//   └── yaw                        (rotates around Y at the base/pelvis seam)
//       ├── pelvis
//       ├── lightring              (the LED ring; tintable for now)
//       └── pitch                  (rotates around X at the pelvis/torso seam)
//           ├── torso
//           └── roll               (rotates around Z at the torso/head seam)
//               ├── head
//               ├── mask           (face mask, sits on the head)
//               └── screen         (4-vertex billboard plane; iframe in M2)
//
// The joint groups sit at their pivot points; meshes are added with
// `position.y = -pivot` so the OBJ vertices (which are in *world* coords)
// land back at their original world positions when rotations are zero.
//
// `createJiboRig(scene)` returns the rig handle synchronously. The 3D parts
// load asynchronously and attach themselves once ready. Sliders work the
// whole time because they only twist the empty joint groups.
//
// Assets: mitmedialab/Jibo_Models (MIT) cached under assets/jibo-model/.

import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';

const MODEL_DIR = 'assets/jibo-model/';
const MTL_FILE  = 'jibomtl.mtl';

// Pivot Y positions in world space, derived from the OBJ bbox overlaps.
const PIVOT_YAW   = 0.00;
const PIVOT_PITCH = 0.06;
const PIVOT_ROLL  = 0.11;

// Mesh files and which joint group they attach to.
// `pivot` is the cumulative world-Y of that joint, used to compensate so
// world coords are preserved at zero rotation.
const PARTS = [
  { file: 'baseMeshMesh.obj',          attach: 'root',  pivot: 0           },
  { file: 'pelvisMeshMesh.obj',        attach: 'yaw',   pivot: PIVOT_YAW   },
  { file: 'lightringMeshMesh.obj',     attach: 'yaw',   pivot: PIVOT_YAW,
    role: 'lightring' },
  { file: 'torsoMeshMesh.obj',         attach: 'pitch', pivot: PIVOT_PITCH },
  { file: 'headMeshMesh.obj',          attach: 'roll',  pivot: PIVOT_ROLL  },
  { file: 'maskMeshMesh.obj',          attach: 'roll',  pivot: PIVOT_ROLL  },
  { file: 'screenMeshBillboardMesh.obj', attach: 'roll', pivot: PIVOT_ROLL,
    role: 'screen' },
];

export function createJiboRig(scene) {
  const root = new THREE.Group();
  root.name = 'jibo';
  scene.add(root);

  const yaw = new THREE.Group();   yaw.name   = 'yaw';
  yaw.position.y = PIVOT_YAW;
  root.add(yaw);

  const pitch = new THREE.Group(); pitch.name = 'pitch';
  pitch.position.y = PIVOT_PITCH - PIVOT_YAW;
  yaw.add(pitch);

  const roll = new THREE.Group();  roll.name  = 'roll';
  roll.position.y = PIVOT_ROLL - PIVOT_PITCH;
  pitch.add(roll);

  const groups = { root, yaw, pitch, roll };

  // Parts that we want handles to after the model finishes loading.
  const parts = { lightring: null, screen: null };

  function setYaw(rad)   { yaw.rotation.y   = rad; }
  function setPitch(rad) { pitch.rotation.x = rad; }
  function setRoll(rad)  { roll.rotation.z  = rad; }

  function setAllLeds(color) {
    if (!parts.lightring) return;
    // The lightring imports as a Group of one Mesh. Tint via a BasicMaterial.
    parts.lightring.traverse((o) => {
      if (o.isMesh) o.material.color.set(color);
    });
  }
  // Per-LED control isn't possible without a custom shader (the mesh is a
  // single ring), so for now setLed(i, ...) tints the whole ring too.
  // Preserved as part of the API so shim code can stay forward-compatible.
  function setLed(_i, color) { setAllLeds(color); }

  function setFaceColor(_color) { /* no-op: screen replaces this in M2 */ }

  function reset() {
    setYaw(0); setPitch(0); setRoll(0);
    setAllLeds(0x4ec9ff);
  }

  const ready = loadModel(groups, parts).then(() => reset());

  return {
    root,
    ready,
    ledCount: 1,               // single tintable ring for now
    setYaw, setPitch, setRoll,
    setLed, setAllLeds,
    setFaceColor,
    reset
  };
}

async function loadModel(groups, parts) {
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

    obj.position.y = -p.pivot;

    // Role-specific tweaks.
    if (p.role === 'lightring') {
      // Replace the lit Phong material with a Basic material so the ring
      // glows independent of scene lighting and is cheap to recolor.
      obj.traverse((o) => {
        if (o.isMesh) {
          o.material = new THREE.MeshBasicMaterial({ color: 0x4ec9ff });
        }
      });
      parts.lightring = obj;
    } else if (p.role === 'screen') {
      // Make the screen plane distinctly visible until M2 hangs an iframe
      // over it. Bright cyan placeholder, double-sided so we can see it
      // from behind during dev.
      obj.traverse((o) => {
        if (o.isMesh) {
          o.material = new THREE.MeshBasicMaterial({
            color: 0x1f2630, side: THREE.DoubleSide
          });
        }
      });
      parts.screen = obj;
    }

    groups[p.attach].add(obj);
  }));
}
