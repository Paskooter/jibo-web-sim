// 3D viewport bootstrap.
//
// M0 goal: prove the import-map + Three.js plumbing by rendering a placeholder
// stand-in for Jibo's body (three cylinder segments stacked on a base) with
// OrbitControls. The real articulated Jibo geometry lands in M1.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createJiboRig } from './jibo.js';

export function createViewport(hostEl) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0e12);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  // Jibo stands ~0.34 m tall, base resting at y≈0, face pointing +X.
  const defaultCamPos = new THREE.Vector3(0.42, 0.28, 0.42);
  const defaultLookAt = new THREE.Vector3(0, 0.15, 0);
  camera.position.copy(defaultCamPos);
  camera.lookAt(defaultLookAt);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(window.devicePixelRatio);
  hostEl.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(defaultLookAt);
  controls.enableDamping = true;
  controls.minDistance = 0.2;
  controls.maxDistance = 3;

  // Click-to-place: when a handler is registered we suspend orbit-rotate and
  // turn viewport clicks into a world point ~0.6 m down the camera ray.
  const raycaster = new THREE.Raycaster();
  let placementHandler = null;
  function setPlacement(handler) {
    placementHandler = handler || null;
    controls.enableRotate = !placementHandler;
  }
  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (!placementHandler) return;
    const r = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    const pt = raycaster.ray.origin.clone().add(raycaster.ray.direction.clone().multiplyScalar(0.6));
    placementHandler(pt);
  });

  // Lighting
  scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x202028, 0.65));
  const key = new THREE.DirectionalLight(0xffffff, 1.0);
  key.position.set(1.5, 2.0, 1.0);
  scene.add(key);

  // Floor — a faint disc so the model doesn't float in the void. The base
  // mesh bottom sits at y≈0 after the Z-up→Y-up wrapper, so rest it there.
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(0.4, 64),
    new THREE.MeshStandardMaterial({ color: 0x141a22, roughness: 1 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0;
  scene.add(floor);

  const rig = createJiboRig(scene);

  // Resize handling
  function resize() {
    const w = hostEl.clientWidth;
    const h = hostEl.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(hostEl);

  // Per-frame callbacks (e.g. the face overlay projection), run after render so
  // world matrices are up to date.
  const frameCallbacks = [];
  function onFrame(cb) { frameCallbacks.push(cb); }

  // Render loop
  let raf = 0;
  function tick() {
    controls.update();
    renderer.render(scene, camera);
    for (const cb of frameCallbacks) cb();
    raf = requestAnimationFrame(tick);
  }
  tick();

  function resetView() {
    camera.position.copy(defaultCamPos);
    controls.target.copy(defaultLookAt);
  }

  function dispose() {
    cancelAnimationFrame(raf);
    ro.disconnect();
    renderer.dispose();
  }

  return {
    threeRevision: THREE.REVISION,
    resetView,
    dispose,
    onFrame,
    setPlacement,
    scene,
    camera,
    renderer,
    rig
  };
}
