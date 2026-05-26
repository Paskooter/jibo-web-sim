// Articulated Jibo rig — procedural geometry.
//
// Built from the canonical Jibo skeleton + kinematics in
// `sdk-archive/animation-utilities/res/geometry-config/P1.0/`
// (`jibo_body.skel`, `jibo_body.kin`).
//
// Three DOFs, all rotations about the joint's local +Y axis:
//
//   bottomSection_r  — child of rootBn
//   middleSection_r  — child of bottomSection
//   topSection_r     — child of middleSection
//
// The "look anywhere in 3D" capability comes from the *tilted rest-pose
// quaternions* on middleSection (+~13° about X) and topSection (-~22° about X).
// The three local-Y rotations are not parallel in world space, so the three
// motors couple to swing the head through 3D space.
//
// Geometry is procedural: a base, a pelvis bell, an LED ring, a tapered
// torso, and a head sphere with a flat angled face plate. Sized so each
// section's top meets the next joint's translation point from the skel.
// (Earlier attempts loaded the MIT mitmedialab/Jibo_Models OBJ set, but
// the head OBJ has 5 disconnected components — outer shell plus internal
// camera mounts and screen housing — which poked through the silhouette
// when rendered naively.)

import * as THREE from 'three';

// ---- Skeleton transforms (from jibo_body.skel) ----------------------------
// Quaternions stored as (w, x, y, z); Three.js wants (x, y, z, w), so swap.

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

// ---- Geometry parameters --------------------------------------------------
// All sizes are in meters. The Y-extent of each section ends where the
// next joint's translation starts, so the segments meet at the skel-
// defined seams.

const BASE_RADIUS_TOP    = 0.090;
const BASE_RADIUS_BOTTOM = 0.105;
const BASE_HEIGHT        = 0.020;

const PELVIS_BOTTOM_R    = 0.095;
const PELVIS_TOP_R       = 0.085;
const PELVIS_HEIGHT      = 0.046;     // matches middleSection.translation.y

const LED_RING_RADIUS    = 0.094;
const LED_RING_TUBE      = 0.0055;
const LED_RING_Y         = 0.014;

const TORSO_BOTTOM_R     = 0.082;
const TORSO_TOP_R        = 0.072;
const TORSO_HEIGHT       = 0.086;     // matches topSection.translation.y

const HEAD_RADIUS        = 0.090;
const HEAD_CENTER_Y      = 0.025;

const FACE_W             = 0.130;
const FACE_H             = 0.090;
const FACE_OFFSET_Z      = -0.080;
const FACE_OFFSET_Y      = 0.020;
const FACE_TILT_DEG      = -8;

const SCREEN_W           = 0.105;
const SCREEN_H           = 0.062;
const SCREEN_OFFSET_Z    = -0.0805;
const SCREEN_OFFSET_Y    = 0.015;

const BODY_COLOR         = 0xe8eaed;
const FACE_COLOR         = 0x05070a;
const SCREEN_COLOR       = 0x12161c;

// ---- Materials ------------------------------------------------------------

function bodyMat() {
  return new THREE.MeshStandardMaterial({
    color: BODY_COLOR, roughness: 0.55, metalness: 0.05
  });
}

// ---- Helpers --------------------------------------------------------------

function quatFromWXYZ([w, x, y, z]) {
  return new THREE.Quaternion(x, y, z, w);
}

function makeBaseDisc() {
  const g = new THREE.CylinderGeometry(
    BASE_RADIUS_TOP, BASE_RADIUS_BOTTOM, BASE_HEIGHT, 96
  );
  const m = new THREE.Mesh(g, bodyMat());
  m.position.y = -BASE_HEIGHT / 2;
  return m;
}

function makePelvis() {
  // Slightly bell-shaped: widest a hair below mid-height, narrower at top.
  const g = new THREE.CylinderGeometry(
    PELVIS_TOP_R, PELVIS_BOTTOM_R, PELVIS_HEIGHT, 96
  );
  const m = new THREE.Mesh(g, bodyMat());
  m.position.y = PELVIS_HEIGHT / 2;
  return m;
}

function makeLedRing() {
  const g = new THREE.TorusGeometry(LED_RING_RADIUS, LED_RING_TUBE, 16, 96);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x4ec9ff }));
  m.position.y = LED_RING_Y;
  m.rotation.x = Math.PI / 2;
  return m;
}

function makeTorso() {
  const g = new THREE.CylinderGeometry(
    TORSO_TOP_R, TORSO_BOTTOM_R, TORSO_HEIGHT, 96
  );
  const m = new THREE.Mesh(g, bodyMat());
  m.position.y = TORSO_HEIGHT / 2;
  return m;
}

function makeHead() {
  const group = new THREE.Group();

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(HEAD_RADIUS, 64, 48),
    bodyMat()
  );
  sphere.position.y = HEAD_CENTER_Y;
  group.add(sphere);

  // Face plate: dark glossy panel that hides the front of the head sphere
  // and gives Jibo his characteristic face.
  const facePlate = new THREE.Mesh(
    new THREE.BoxGeometry(FACE_W, FACE_H, 0.004),
    new THREE.MeshStandardMaterial({
      color: FACE_COLOR, roughness: 0.18, metalness: 0.3
    })
  );
  facePlate.position.set(0, HEAD_CENTER_Y + FACE_OFFSET_Y, FACE_OFFSET_Z);
  facePlate.rotation.x = THREE.MathUtils.degToRad(FACE_TILT_DEG);
  group.add(facePlate);

  // Screen (a slightly inset plane on the face). M2 will replace this
  // with an iframe overlay carrying the skill UI.
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(SCREEN_W, SCREEN_H),
    new THREE.MeshBasicMaterial({ color: SCREEN_COLOR, side: THREE.DoubleSide })
  );
  screen.position.set(0, HEAD_CENTER_Y + SCREEN_OFFSET_Y, SCREEN_OFFSET_Z);
  screen.rotation.x = THREE.MathUtils.degToRad(FACE_TILT_DEG);
  screen.name = 'screen';
  group.add(screen);

  return { group, screen };
}

// ---- Public API -----------------------------------------------------------

export function createJiboRig(scene) {
  const root = new THREE.Group();
  root.name = 'jibo';
  scene.add(root);

  // Joint groups, posed at rest. Each is initialized with its rest-pose
  // quaternion; articulating composes the DOF Y-axis rotation on top.
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

  // Geometry attached to joints. Base is fixed in root; everything else
  // hangs off the kinematic chain.
  joints.root.add(makeBaseDisc());

  joints.bottomSection.add(makePelvis());
  const ledMesh = makeLedRing();
  joints.bottomSection.add(ledMesh);

  joints.middleSection.add(makeTorso());

  const { group: headGroup, screen: screenMesh } =
    makeHead();
  joints.topSection.add(headGroup);

  // --- API ---

  function setDof(name, rad) {
    const dof = new THREE.Quaternion().setFromAxisAngle(DOF_AXIS, rad);
    joints[name].quaternion.copy(restQuats[name]).multiply(dof);
  }
  function setBottom(rad) { setDof('bottomSection', rad); }
  function setMiddle(rad) { setDof('middleSection', rad); }
  function setTop(rad)    { setDof('topSection',    rad); }

  function setLEDHex(hex) { ledMesh.material.color.set(hex); }
  function setLEDColor(r, g, b) {
    setLEDHex((Math.round(r * 255) << 16) |
              (Math.round(g * 255) << 8)  |
               Math.round(b * 255));
  }

  function reset() {
    setBottom(0); setMiddle(0); setTop(0);
    setLEDHex(0x4ec9ff);
  }
  reset();

  return {
    root,
    ready: Promise.resolve(),
    dofs: ['bottomSection_r', 'middleSection_r', 'topSection_r'],
    dofMin: -3.0543, dofMax: 3.0543, dofCyclic: true,
    setBottom, setMiddle, setTop, setDof,
    setLEDColor, setLEDHex,
    screen: screenMesh,
    reset,
  };
}
