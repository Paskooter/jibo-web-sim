// 3D viewport bootstrap.
//
// M0 goal: prove the import-map + Three.js plumbing by rendering a placeholder
// stand-in for Jibo's body (three cylinder segments stacked on a base) with
// OrbitControls. The real articulated Jibo geometry lands in M1.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createViewport(hostEl) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0e12);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  const defaultCamPos = new THREE.Vector3(0.6, 0.4, 0.6);
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

  // Lighting
  scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x202028, 0.65));
  const key = new THREE.DirectionalLight(0xffffff, 1.0);
  key.position.set(1.5, 2.0, 1.0);
  scene.add(key);

  // Floor — a faint disc so the placeholder doesn't float in the void.
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(0.4, 64),
    new THREE.MeshStandardMaterial({ color: 0x141a22, roughness: 1 })
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  // Placeholder Jibo: three stacked cylinders. This is *not* the real body —
  // it's an M0 stand-in so we can see the viewport working end-to-end. The
  // articulated model with the three actual motor joints lands in M1.
  const bodyGroup = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xe8eaed, roughness: 0.5, metalness: 0.05 });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.12, 0.06, 48), mat);
  base.position.y = 0.03;
  const mid = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.10, 0.08, 48), mat);
  mid.position.y = 0.10;
  const head = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.085, 0.12, 48), mat);
  head.position.y = 0.20;
  bodyGroup.add(base, mid, head);
  scene.add(bodyGroup);

  // Placeholder LED ring stub at the seam between mid and head.
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.082, 0.005, 8, 64),
    new THREE.MeshBasicMaterial({ color: 0x4ec9ff })
  );
  ring.position.y = 0.14;
  ring.rotation.x = Math.PI / 2;
  scene.add(ring);

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
    renderer
  };
}
