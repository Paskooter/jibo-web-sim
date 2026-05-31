// Transient audio-event visualization — a sound "ping" at a world position.
//
// An expanding, fading sphere driven by the render loop. update(now) returns
// false once the animation has finished.

import * as THREE from 'three';

export function createAudioEvent(scene, position, { duration = 1300 } = {}) {
  const geometry = new THREE.SphereGeometry(1, 24, 16);
  const material = new THREE.MeshBasicMaterial({
    color: 0xff6a3c, transparent: true, opacity: 0.85, depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(position.x, position.y, position.z);
  scene.add(mesh);

  const start = (typeof performance !== 'undefined' ? performance : Date).now();

  function update(now) {
    const t = (now - start) / duration;       // 0..1
    if (t >= 1) return false;
    mesh.scale.setScalar(0.03 + t * 0.13);     // expand outward
    material.opacity = 0.85 * (1 - t);         // fade out
    return true;
  }

  function dispose() {
    scene.remove(mesh);
    geometry.dispose();
    material.dispose();
  }

  return { mesh, update, dispose };
}
