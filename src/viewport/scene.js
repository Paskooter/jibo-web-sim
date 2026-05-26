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
  const defaultCamPos = new THREE.Vector3(0.45, 0.25, 0.45);
  const defaultLookAt = new THREE.Vector3(0, 0.09, 0);
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

  // Lighting
  scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x202028, 0.65));
  const key = new THREE.DirectionalLight(0xffffff, 1.0);
  key.position.set(1.5, 2.0, 1.0);
  scene.add(key);

  // Floor — a faint disc so the model doesn't float in the void. Sits at
  // the bottom of the base mesh (Y ~= -0.019) so Jibo appears to rest on it.
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(0.4, 64),
    new THREE.MeshStandardMaterial({ color: 0x141a22, roughness: 1 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.02;
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

  // Render loop
  let raf = 0;
  function tick() {
    controls.update();
    renderer.render(scene, camera);
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
    scene,
    camera,
    renderer,
    rig
  };
}
