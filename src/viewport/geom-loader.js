// Loader for the legacy Jibo .geom JSON format.
//
// The .geom is a JSON file with header + content.meshes[], each entry having:
//   - name              (e.g. "headMeshMesh")
//   - skeletonFrameName (e.g. "headMesh") — the skel bone this mesh attaches to
//   - material          ({name, texture, ambient, specular, emissive, shininess, ...})
//   - position          (flat Float array: x, y, z, x, y, z, ...)
//   - normal            (flat Float array)
//   - textureCoordinates (flat Float array: u, v, u, v, ...)
//   - triangles         (flat Int array of vertex indices, groups of 3)
//
// Format reference:
// `sdk-archive/animation-utilities/src/ifr-geometry/loaders/ModelLoader.js`.
// Legacy renderer sets `defaultMaterial.side = THREE.DoubleSide` (see
// `sdk-archive/animation-utilities/src/animation-visualize/JiboBody.js:49`),
// so we mirror that here.

import * as THREE from 'three';

const TEXTURE_LOADER = new THREE.TextureLoader();

/**
 * Load a .geom JSON file plus its referenced textures, and build a flat list
 * of THREE.Mesh objects (one per mesh in the .geom).
 *
 * @param {string} geomURL       — URL of the .geom file
 * @param {string} resourceBase  — base URL for resolving relative texture refs
 *                                  inside the .geom (each mesh.material.texture
 *                                  is interpreted relative to this).
 * @returns {Promise<Array<{name, skeletonFrameName, mesh, material}>>}
 */
export async function loadGeom(geomURL, resourceBase) {
  const res = await fetch(geomURL);
  if (!res.ok) throw new Error(`geom fetch failed: ${res.status} ${geomURL}`);
  const geom = await res.json();

  if (geom.header?.fileType !== 'Meshes') {
    throw new Error(`unexpected .geom file type: ${geom.header?.fileType}`);
  }

  // Load every distinct texture once, in parallel.
  const texCache = new Map();
  const texPromises = [];
  for (const m of geom.content.meshes) {
    const tex = m.material?.texture;
    if (tex && !texCache.has(tex)) {
      const url = resolveURL(tex, resourceBase);
      const p = loadTexture(url).then((t) => { texCache.set(tex, t); });
      texPromises.push(p);
      texCache.set(tex, null); // placeholder so we don't queue twice
    }
  }
  await Promise.all(texPromises);

  // Build each mesh.
  return geom.content.meshes.map((md) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(md.position, 3));
    if (md.normal) {
      g.setAttribute('normal', new THREE.Float32BufferAttribute(md.normal, 3));
    }
    if (md.textureCoordinates) {
      g.setAttribute('uv', new THREE.Float32BufferAttribute(md.textureCoordinates, 2));
    }
    if (md.triangles) {
      g.setIndex(md.triangles);
    }
    if (!md.normal) g.computeVertexNormals();

    const material = makeMaterial(md.material, texCache);
    const mesh = new THREE.Mesh(g, material);
    mesh.name = md.name;
    return {
      name: md.name,
      skeletonFrameName: md.skeletonFrameName,
      mesh,
      material,
    };
  });
}

function loadTexture(url) {
  return new Promise((resolve, reject) => {
    TEXTURE_LOADER.load(url, (t) => {
      // Match the original look: linear/sRGB color space, mip-mapped.
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      resolve(t);
    }, undefined, reject);
  });
}

function makeMaterial(md, texCache) {
  // Phong, DoubleSide (per the legacy renderer). The .geom material has
  // ambient / specular / emissive / shininess; map_Kd is the diffuse texture.
  const mat = new THREE.MeshPhongMaterial({ side: THREE.DoubleSide });

  if (md.texture) {
    mat.map = texCache.get(md.texture);
  }
  if (md.diffuse)  mat.color.setRGB(md.diffuse[0],  md.diffuse[1],  md.diffuse[2]);
  if (md.specular) mat.specular.setRGB(md.specular[0], md.specular[1], md.specular[2]);
  if (md.emissive) mat.emissive.setRGB(md.emissive[0], md.emissive[1], md.emissive[2]);
  if (typeof md.shininess === 'number') mat.shininess = md.shininess;
  mat.name = md.name || 'jibo_material';
  return mat;
}

function resolveURL(ref, base) {
  if (/^[a-z]+:\/\//i.test(ref) || ref.startsWith('/')) return ref;
  if (!base.endsWith('/')) base += '/';
  return base + ref;
}
