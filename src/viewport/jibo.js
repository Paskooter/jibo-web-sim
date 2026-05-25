// Articulated Jibo rig.
//
// Joint hierarchy (nested groups; each child inherits its parent's transform):
//
//   scene
//   └── root                       (overall placement)
//       ├── base                   (fixed pedestal)
//       └── yaw                    (rotates around Y at the base seam)
//           ├── lowerShell         (visible piece between base and pitch pivot)
//           └── pitch              (rotates around X at the mid seam)
//               ├── upperShell     (visible piece between pitch and head pivot)
//               └── roll           (rotates around Z at the head seam)
//                   ├── head       (head shell)
//                   ├── facePlate  (flat angled disc where the screen will live)
//                   └── ledRing    (N segments, individually colorable)
//
// The three rotation groups (yaw / pitch / roll) are deliberately positioned
// AT the seam they pivot around, so their children render forward of that
// seam without offset math.
//
// This is geometry-only; no skill / shim binding yet. The shim layer in M2
// will call setYaw/setPitch/setRoll and the LED setters over postMessage.

import * as THREE from 'three';

const LED_COUNT = 12;
const SEAM_BASE_TOP   = 0.05;  // y of base/yaw seam
const SEAM_PITCH      = 0.13;  // y of yaw/pitch seam
const SEAM_ROLL       = 0.20;  // y of pitch/roll (head) seam

const SHELL_MAT = new THREE.MeshStandardMaterial({
  color: 0xe6e8eb, roughness: 0.55, metalness: 0.05
});
const FACE_MAT = new THREE.MeshStandardMaterial({
  color: 0x0a0c10, roughness: 0.35, metalness: 0.1
});

function makeShell(r1, r2, h, yCenter) {
  // Truncated cylinder, smooth-shaded.
  const geom = new THREE.CylinderGeometry(r2, r1, h, 64, 1, false);
  const mesh = new THREE.Mesh(geom, SHELL_MAT);
  mesh.position.y = yCenter;
  return mesh;
}

export function createJiboRig(scene) {
  const root = new THREE.Group();
  root.name = 'jibo';
  scene.add(root);

  // --- Base (fixed) ---
  const base = makeShell(0.11, 0.105, SEAM_BASE_TOP, SEAM_BASE_TOP / 2);
  base.name = 'base';
  root.add(base);

  // --- Yaw group ---
  const yaw = new THREE.Group();
  yaw.name = 'yaw';
  yaw.position.y = SEAM_BASE_TOP;
  root.add(yaw);

  // Lower shell (visible piece between yaw seam and pitch seam).
  // Its local y starts at 0 because we sit at SEAM_BASE_TOP via the yaw group.
  const lowerH = SEAM_PITCH - SEAM_BASE_TOP;
  const lowerShell = makeShell(0.105, 0.09, lowerH, lowerH / 2);
  lowerShell.name = 'lowerShell';
  yaw.add(lowerShell);

  // --- Pitch group ---
  const pitch = new THREE.Group();
  pitch.name = 'pitch';
  pitch.position.y = lowerH;          // sits at the pitch seam
  yaw.add(pitch);

  // Upper shell (between pitch seam and roll seam).
  const upperH = SEAM_ROLL - SEAM_PITCH;
  const upperShell = makeShell(0.09, 0.08, upperH, upperH / 2);
  upperShell.name = 'upperShell';
  pitch.add(upperShell);

  // --- Roll group ---
  const roll = new THREE.Group();
  roll.name = 'roll';
  roll.position.y = upperH;           // sits at the roll seam (head pivot)
  pitch.add(roll);

  // Head: a dome-ish shape — short truncated cone + cap.
  const headH = 0.08;
  const headShell = makeShell(0.08, 0.07, headH, headH / 2);
  headShell.name = 'head';
  roll.add(headShell);
  const headCap = new THREE.Mesh(
    new THREE.SphereGeometry(0.07, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2),
    SHELL_MAT
  );
  headCap.position.y = headH;
  roll.add(headCap);

  // Face plate: a dark angled disc on the front of the head. Tilted forward
  // ~15° so it faces a viewer sitting in front of Jibo, matching the real
  // robot's screen angle. This is the surface that the skill iframe will
  // eventually be perspective-projected onto.
  const facePlate = new THREE.Mesh(
    new THREE.CircleGeometry(0.058, 48),
    FACE_MAT
  );
  facePlate.name = 'facePlate';
  // Position on the front (+Z) face of the head.
  facePlate.position.set(0, headH * 0.55, 0.064);
  facePlate.rotation.x = THREE.MathUtils.degToRad(-15);  // tilt up toward viewer
  roll.add(facePlate);

  // --- LED ring ---
  // N flat boxes arranged around a circle at the lower seam. Each segment is
  // a separate material so we can set them independently. Sits at the yaw
  // seam (so it stays put when only the head moves).
  const ledRing = new THREE.Group();
  ledRing.name = 'ledRing';
  ledRing.position.y = SEAM_BASE_TOP + 0.002;   // just above the base
  root.add(ledRing);

  const ledRadius = 0.106;
  const ledSegW = (2 * Math.PI * ledRadius) / LED_COUNT * 0.85;
  const ledSegH = 0.008;
  const ledSegD = 0.004;
  const ledMaterials = [];
  for (let i = 0; i < LED_COUNT; i++) {
    const mat = new THREE.MeshBasicMaterial({ color: 0x202830 });
    ledMaterials.push(mat);
    const seg = new THREE.Mesh(
      new THREE.BoxGeometry(ledSegW, ledSegH, ledSegD),
      mat
    );
    const theta = (i / LED_COUNT) * Math.PI * 2;
    seg.position.set(Math.sin(theta) * ledRadius, 0, Math.cos(theta) * ledRadius);
    seg.lookAt(0, 0, 0);
    ledRing.add(seg);
  }

  // --- Public API ---

  function setYaw(rad)   { yaw.rotation.y   = rad; }
  function setPitch(rad) { pitch.rotation.x = rad; }
  function setRoll(rad)  { roll.rotation.z  = rad; }

  function setLed(i, color) {
    if (i < 0 || i >= LED_COUNT) return;
    ledMaterials[i].color.set(color);
  }

  function setAllLeds(color) {
    for (const m of ledMaterials) m.color.set(color);
  }

  function setFaceColor(color) {
    FACE_MAT.color.set(color);
  }

  function reset() {
    setYaw(0); setPitch(0); setRoll(0);
    setAllLeds(0x202830);
  }

  reset();

  return {
    root,
    ledCount: LED_COUNT,
    setYaw, setPitch, setRoll,
    setLed, setAllLeds,
    setFaceColor,
    reset
  };
}
