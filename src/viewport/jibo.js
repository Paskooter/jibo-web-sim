// Articulated Jibo rig — a faithful re-implementation of the legacy
// animation-utilities loader chain, driven by the original data files:
//
//   jibo_body.geom  — meshes (vertices are FRAME-LOCAL, not world coords)
//   jibo_body.skel  — the full skeleton frame tree
//   jibo_body.kin   — the ROTATION controls (the 3 motor DOFs) + COLOR control
//
// The pipeline mirrors the legacy loader:
//   - parse skeleton → buildSkeleton()
//   - load meshes and attach via plain .add()
//   - rotation control DOFs → setDof()
//   - geom loader sets DoubleSide on materials
//
// Two details the earlier implementation got wrong (and why it looked
// "crunched" with wrong motion):
//
//  1. QUATERNION INVERSE. Each stored wxyz quaternion is parsed as THREE
//     (x,y,z,w) and then *inverted* (switching from world-frame to body-frame
//     convention). Every rest orientation AND every DOF initial rotation goes
//     through this. Skipping the invert mis-orients every joint.
//
//  2. FRAME-LOCAL VERTICES + plain .add(). The .geom vertices live in each
//     mesh's skeleton-frame local space; the skeleton's frame transforms
//     place them in the world. Each mesh is attached to its named frame with
//     parent.add(mesh) — NOT Object3D.attach() (which would treat the verts
//     as world coords and collapse the whole model onto itself).
//
// The assembled skeleton is Z-up (matching the legacy renderer, which set
// camera.up = (0,0,1)). Our scene is Y-up, so we parent the model under a
// wrapper rotated -90° about X (body +Z → world +Y).

import * as THREE from 'three';
import { loadGeom } from './geom-loader.js';

const LEGACY_DIR = 'assets/jibo-legacy/';
const GEOM_FILE  = LEGACY_DIR + 'jibo_body.geom';
const SKEL_FILE  = LEGACY_DIR + 'jibo_body.skel';
const KIN_FILE   = LEGACY_DIR + 'jibo_body.kin';

// Stored as [w, x, y, z]; THREE wants (x, y, z, w); then inverse() to go
// from world- to body-frame convention.
function quatFromWXYZ([w, x, y, z]) {
  return new THREE.Quaternion(x, y, z, w).invert();
}

// Recursively build a tree of frames, each a THREE.Group carrying the
// frame's rest position + (inverted) orientation.
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

  // Rotation control update:
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
    // Lightring diffuse is black by default (driven by 3 LED color DOFs
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

  // --- Writhe mode (joke) ----------------------------------------------------
  // Inserts N extra body "vertebrae" between the bottom and middle sections.
  // Each vertebra is a clone of the bottomSection subtree MINUS the
  // middleSection subtree — so the meaty body-mass mesh (not just the thin
  // connector ring at the top of the middle) gets copied. Each vertebra is
  // stacked at the offset where the middleSection originally attached to the
  // bottom, so they connect rather than float as disjoint rings. The original
  // middleSection (and everything above — head/eye/screen) sits on top of
  // the last vertebra and continues to function as normal.
  //
  // Each vertebra writhes on its own sinusoidal yaw with a phase offset
  // propagating up the body so the whole chain wriggles like a worm.
  //
  // Trigger from the browser console:
  //   JIBO_WRITHE(10)         // 10 extra vertebrae, default spacing
  //   JIBO_WRITHE(15, 1.5)    // 15 vertebrae, 1.5x spacing (more stretched)
  //   JIBO_WRITHE(20, 0.8)    // 20 vertebrae, tighter packing
  const writheTickFns = [];
  function writhe(n, spacing) {
    const segments = Math.max(0, n | 0);
    const stretch = Number.isFinite(spacing) && spacing > 0 ? spacing : 1.0;
    const bottomCtl = controls['bottomSection_r'];
    const middleCtl = controls['middleSection_r'];
    const topCtl = controls['topSection_r'];
    if (!bottomCtl || !middleCtl || !topCtl) {
      console.warn('jibo: writhe — rig not ready yet, try again after the model loads');
      return;
    }
    const bottomFrame = bottomCtl.frame;
    const middleFrame = middleCtl.frame;

    // Recursive shallow-clone that prunes a specific subtree by node identity.
    // The cloned subtree shares geometry + materials with the original, so
    // adding 20 vertebrae costs almost nothing.
    function cloneSubtreeExcept(node, skipNode) {
      if (node === skipNode) return null;
      const clone = node.clone(false);
      for (const child of node.children) {
        const cc = cloneSubtreeExcept(child, skipNode);
        if (cc) clone.add(cc);
      }
      return clone;
    }

    // Reparent middleFrame out of bottomFrame so we can splice the new chain
    // in between. The original local offset is what each new vertebra will
    // use to stack — that's the bottomSection → middleSection joint offset
    // in bottomFrame's local space.
    const stackOffset = middleFrame.position.clone().multiplyScalar(stretch);
    bottomFrame.remove(middleFrame);

    let parent = bottomFrame;
    for (let i = 0; i < segments; i += 1) {
      const seg = cloneSubtreeExcept(bottomFrame, middleFrame);
      seg.name = `writhe_seg_${i}`;
      seg.position.copy(stackOffset);
      seg.quaternion.copy(bottomCtl.initialRotation);
      parent.add(seg);
      parent = seg;

      // Per-vertebra writhing — yaws around the middleSection axis (so each
      // vertebra writhes side-to-side, propagating the wave up the spine).
      // Phase offset 0.65 rad per segment, freq 0.45 Hz, amplitude 0.32 rad.
      const phase = i * 0.65;
      const freq = 0.45;
      const amp = 0.32;
      writheTickFns.push((tSec) => {
        const angle = Math.sin(tSec * 2 * Math.PI * freq + phase) * amp;
        const spin = new THREE.Quaternion().setFromAxisAngle(middleCtl.axis, angle);
        seg.quaternion.multiplyQuaternions(bottomCtl.initialRotation, spin);
      });
    }

    // The original middleSection (and everything above — head/eye/screen)
    // sits on top of the last vertebra.
    parent.add(middleFrame);
    console.log(`[jibo] writhing — added ${segments} extra vertebr${segments === 1 ? 'a' : 'ae'} at ${stretch}x spacing (reload to undo)`);
  }
  function tickWrithe(tSec) {
    for (const fn of writheTickFns) fn(tSec);
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
    //    are already in that frame's local space.
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
        // Render-target target; dark panel until the face overlay is mounted.
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
    writhe,
    tickWrithe,
  };
}
