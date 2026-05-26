// Articulated Jibo rig — a faithful re-implementation of the legacy
// animation-utilities loader chain, driven by the original source data:
//
//   jibo_body.geom  — meshes (vertices are FRAME-LOCAL, not world coords)
//   jibo_body.skel  — the full skeleton frame tree
//   jibo_body.kin   — the ROTATION controls (the 3 motor DOFs) + COLOR control
//
// This mirrors, file-for-file, the original pipeline in
// sdk-archive/animation-utilities:
//   - SkeletonLoader._parseSkeleton  → buildSkeleton()
//   - ArticulatedModelLoader._loadModel → mesh attach via plain .add()
//   - RotationControl.updateFromDOFVal  → setDof()
//   - JiboBody.load (defaultMaterial.side = DoubleSide) → geom-loader
//
// Two details the earlier implementation got wrong (and why it looked
// "crunched" with wrong motion):
//
//  1. QUATERNION INVERSE. BasicFrame.quaternionFromJson parses each stored
//     wxyz quaternion as THREE (x,y,z,w) and then *inverts* it ("switching
//     from world-frame to body-frame convention"). Every rest orientation
//     AND every DOF initial rotation goes through this. Skipping the invert
//     mis-orients every joint.
//
//  2. FRAME-LOCAL VERTICES + plain .add(). The .geom vertices live in each
//     mesh's skeleton-frame local space; the skeleton's frame transforms
//     place them in the world. The original attaches each mesh to its named
//     frame with parent.add(mesh) — NOT Object3D.attach() (which would treat
//     the verts as world coords and collapse the whole model onto itself).
//
// The assembled skeleton is Z-up (matching the original renderer, which set
// camera.up = (0,0,1) — see VisualizeImpl.js:421). Our scene is Y-up, so we
// parent the model under a wrapper rotated -90° about X (body +Z → world +Y).

import * as THREE from 'three';
import { loadGeom } from './geom-loader.js';

const LEGACY_DIR = 'assets/jibo-legacy/';
const GEOM_FILE  = LEGACY_DIR + 'jibo_body.geom';
const SKEL_FILE  = LEGACY_DIR + 'jibo_body.skel';
const KIN_FILE   = LEGACY_DIR + 'jibo_body.kin';

// BasicFrame.quaternionFromJson: stored as [w, x, y, z]; THREE wants
// (x, y, z, w); then inverse() to go from world- to body-frame convention.
function quatFromWXYZ([w, x, y, z]) {
  return new THREE.Quaternion(x, y, z, w).invert();
}

// SkeletonLoader._parseSkeleton: recursively build a tree of frames, each a
// THREE.Group carrying the frame's rest position + (inverted) orientation.
function buildSkeleton(node, frameMap) {
  const obj = new THREE.Group();
  obj.name = node.name;
  obj.position.fromArray(node.xyzTranslation);
  obj.quaternion.copy(quatFromWXYZ(node.wxyzRotation));
  frameMap[node.name] = obj;
  if (node.children) {
    for (const child of node.children) obj.add(buildSkeleton(child, frameMap));
  }
  return obj;
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${url}`);
  return res.json();
}

export function createJiboRig(scene) {
  // Wrapper converts the Z-up skeleton into our Y-up scene.
  const root = new THREE.Group();
  root.name = 'jibo';
  root.rotation.x = -Math.PI / 2;
  scene.add(root);

  // Refs resolved after load.
  const parts = { lightring: null, screen: null, byName: {} };
  const frameMap = {};       // frame name -> THREE.Group
  const controls = {};       // dofName -> { frame, axis, initialRotation }
  let dofMin = -3.0543, dofMax = 3.0543, dofCyclic = true;

  // RotationControl.updateFromDOFVal:
  //   frame.quaternion = initialRotation * quat(axis, dofValue)
  function setDof(dofName, rad) {
    const c = controls[dofName];
    if (!c) return;
    const spin = new THREE.Quaternion().setFromAxisAngle(c.axis, rad);
    c.frame.quaternion.multiplyQuaternions(c.initialRotation, spin);
  }
  const setBottom = (rad) => setDof('bottomSection_r', rad);
  const setMiddle = (rad) => setDof('middleSection_r', rad);
  const setTop    = (rad) => setDof('topSection_r',    rad);

  function setLEDHex(hex) {
    if (!parts.lightring) return;
    // Lightring diffuse is black in the source (driven by 3 LED color DOFs
    // in the legacy COLOR control); we drive emissive + color directly.
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

  const ready = (async () => {
    const [skel, kin, meshes] = await Promise.all([
      fetchJSON(SKEL_FILE),
      fetchJSON(KIN_FILE),
      loadGeom(GEOM_FILE, LEGACY_DIR),
    ]);

    // 1. Build the skeleton tree and mount it under the Y-up wrapper.
    const skeletonRoot = buildSkeleton(skel.content, frameMap);
    root.add(skeletonRoot);

    // 2. Attach each mesh to its named frame with plain .add() — the verts
    //    are already in that frame's local space (ArticulatedModelLoader).
    for (const { name, skeletonFrameName, mesh, material } of meshes) {
      const frame = frameMap[skeletonFrameName];
      if (!frame) {
        console.warn(`jibo: no skeleton frame "${skeletonFrameName}" for mesh ${name}`);
        continue;
      }

      if (name === 'lightringMeshMesh') {
        material.emissive.set(0x4ec9ff);
        material.color.set(0x4ec9ff);
        parts.lightring = mesh;
      } else if (name === 'screenMeshBillboardMesh') {
        // Render-target target in the legacy sim; dark panel until M2.
        material.map = null;
        material.emissive.set(0x12161c);
        material.color.set(0x12161c);
        parts.screen = mesh;
      }

      parts.byName[name] = mesh;
      frame.add(mesh);
    }

    // 3. Wire up the ROTATION controls from the kinematics file.
    for (const c of kin.content.controls) {
      if (c.controlType !== 'ROTATION') continue;
      const frame = frameMap[c.skeletonFrameName];
      if (!frame) continue;
      controls[c.dofName] = {
        frame,
        axis: new THREE.Vector3().fromArray(c.xyzRotationAxis).normalize(),
        initialRotation: quatFromWXYZ(c.wxyzQuatInitialRotation),
        min: c.min, max: c.max, isCyclic: !!c.isCyclic,
      };
      // Use the bottom (whole-body) control for the shared slider range.
      if (c.dofName === 'bottomSection_r') {
        dofMin = c.min; dofMax = c.max; dofCyclic = !!c.isCyclic;
      }
    }

    reset();
  })();

  return {
    root,
    ready,
    get dofMin() { return dofMin; },
    get dofMax() { return dofMax; },
    get dofCyclic() { return dofCyclic; },
    dofs: ['bottomSection_r', 'middleSection_r', 'topSection_r'],
    setBottom, setMiddle, setTop, setDof,
    setLEDColor, setLEDHex,
    setScreenHex,
    parts,
    frames: frameMap,
    reset,
  };
}
