import { localizedError as i18nError } from "./i18n.js";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { unzipSync, strFromU8 } from "fflate";
import { extension, normalizePath } from "./core.js";

export async function modelKind(file, path) {
  if (["splat", "ksplat"].includes(extension(path))) return "gaussian";
  if (extension(path) === "ply") {
    const header = await file.slice(0, 16000).text();
    if (
      /property float (?:f_dc_0|scale_0)/.test(header) &&
      /rot_0/.test(header)
    )
      return "gaussian";
  }
  return "mesh";
}
function resolver(path, files) {
  const base = path.includes("/")
      ? path.slice(0, path.lastIndexOf("/") + 1)
      : "",
    urls = [];
  const manager = new THREE.LoadingManager();
  const errors = [];
  let pending = false;
  const waiters = [];
  manager.onStart = () => {
    pending = true;
  };
  manager.onLoad = () => {
    pending = false;
    waiters.splice(0).forEach((resolve) => resolve());
  };
  manager.onError = (url) => errors.push(url);
  manager.setURLModifier((url) => {
    if (url.startsWith("data:") || url.startsWith("blob:")) return url;
    if (/^(https?:)?\/\//i.test(url)) {
      errors.push(url);
      throw i18nError("networkResource");
    }
    const decoded = decodeURIComponent(url).replace(/^\.\//, "");
    const resolved = normalizePath(
      decoded.startsWith("r3d:/")
        ? decoded.slice(5)
        : decoded.startsWith(base)
          ? decoded
          : base + decoded,
    );
    const f = files.get(resolved);
    if (!f) {
      errors.push(resolved);
      throw i18nError("missingResource", { path: resolved });
    }
    const blob = URL.createObjectURL(f);
    urls.push(blob);
    return blob;
  });
  return {
    manager,
    errors,
    base,
    ready() {
      return pending
        ? new Promise((resolve) => waiters.push(resolve))
        : Promise.resolve();
    },
    dispose() {
      urls.forEach(URL.revokeObjectURL);
    },
  };
}
function materialFor(geometry) {
  return new THREE.MeshStandardMaterial({
    color: geometry.hasAttribute("color") ? 0xffffff : 0x9eafb0,
    vertexColors: geometry.hasAttribute("color"),
    roughness: 0.65,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });
}
async function customBundle(file) {
  const zip = unzipSync(new Uint8Array(await file.arrayBuffer())),
    meta = JSON.parse(strFromU8(zip["scene.json"])),
    group = new THREE.Group();
  for (const p of meta.parts) {
    const g = new THREE.BufferGeometry();
    for (const [key, name, size] of [
      ["p", "position", 3],
      ["n", "normal", 3],
      ["c", "color", 3],
      ["u", "uv", 2],
    ]) {
      const bytes = zip[`${p.id}_${key}.bin`];
      if (bytes) {
        const a = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        );
        g.setAttribute(
          name,
          new THREE.BufferAttribute(new Float32Array(a), size),
        );
      }
    }
    const f = zip[`${p.id}_f.bin`];
    g.setIndex(
      new THREE.BufferAttribute(
        new Uint32Array(
          f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength),
        ),
        1,
      ),
    );
    let texture = null;
    if (p.texture) {
      const u = URL.createObjectURL(
        new Blob([zip[p.texture]], { type: "image/png" }),
      );
      try {
        texture = await new THREE.TextureLoader().loadAsync(u);
        texture.colorSpace = THREE.SRGBColorSpace;
      } finally {
        URL.revokeObjectURL(u);
      }
    }
    group.add(
      new THREE.Mesh(
        g,
        new THREE.MeshStandardMaterial({
          map: texture,
          vertexColors: g.hasAttribute("color"),
          color: new THREE.Color(...(p.factor || [1, 1, 1])),
          side: THREE.DoubleSide,
          roughness: 0.65,
        }),
      ),
    );
  }
  return group;
}
export async function loadMesh(record, files) {
  const file = files.get(record.path);
  if (!file) throw i18nError("missingModel", { path: record.path });
  const ext = extension(record.path),
    res = resolver(record.path, files);
  let object;
  try {
    if (/\.mesh\.zip$/i.test(record.path)) object = await customBundle(file);
    else if (ext === "glb" || ext === "gltf") {
      const loader = new GLTFLoader(res.manager);
      const data = ext === "glb" ? await file.arrayBuffer() : await file.text();
      const gltf = await loader.parseAsync(data, "");
      object = gltf.scene;
    } else if (ext === "obj") {
      const text = await file.text(),
        loader = new OBJLoader(res.manager),
        mtlName = text.match(/^mtllib\s+(.+)$/m)?.[1]?.trim();
      if (mtlName) {
        const path = normalizePath(res.base + mtlName);
        const mtl = files.get(path);
        if (!mtl) throw i18nError("missingMaterial", { path });
        const materialBase = path.includes("/")
          ? path.slice(0, path.lastIndexOf("/") + 1)
          : "";
        const materials = new MTLLoader(res.manager).parse(
          await mtl.text(),
          "r3d:/" + materialBase,
        );
        loader.setMaterials(materials);
      }
      object = loader.parse(text);
      // Wait for OBJ/MTL textures, including asynchronous image failures.
      const textures = [];
      object.traverse((o) => {
        if (o.material)
          for (const m of Array.isArray(o.material) ? o.material : [o.material])
            for (const v of Object.values(m))
              if (v?.isTexture) textures.push(v);
      });
      await res.ready();
      if (
        textures.some(
          (t) => !t.image || !(t.image.naturalWidth || t.image.width),
        )
      )
        throw i18nError("textureNotLoaded");
    } else if (ext === "ply" || ext === "stl") {
      const g = (ext === "ply" ? new PLYLoader() : new STLLoader()).parse(
        await file.arrayBuffer(),
      );
      if (!g.index && ext === "ply") {
        object = new THREE.Points(
          g,
          new THREE.PointsMaterial({
            color: g.hasAttribute("color") ? 0xffffff : 0x94aeab,
            size: 0.012,
            vertexColors: g.hasAttribute("color"),
          }),
        );
        object.userData.pointCloud = true;
      } else {
        if (!g.hasAttribute("normal")) g.computeVertexNormals();
        object = new THREE.Mesh(g, materialFor(g));
      }
    } else throw i18nError("unsupportedFormat", { format: ext });
    object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty() || !Number.isFinite(box.max.length()))
      throw i18nError("emptyModel");
    if (res.errors.length)
      throw i18nError("resourcesFailed", { paths: res.errors.join(", ") });
    return object;
  } catch (e) {
    if (object) disposeObject(object);
    throw e;
  } finally {
    res.dispose();
  }
}
export function disposeObject(object) {
  const materials = new Set(),
    textures = new Set(),
    geometries = new Set();
  object.traverse((o) => {
    if (o.geometry) geometries.add(o.geometry);
    for (const m of Array.isArray(o.material) ? o.material : [o.material])
      if (m) materials.add(m);
    for (const m of o.userData.studioMaterials || []) materials.add(m);
  });
  for (const g of geometries) g.dispose();
  for (const m of materials) {
    for (const v of Object.values(m)) if (v?.isTexture) textures.add(v);
    m.dispose();
  }
  for (const t of textures) t.dispose();
}
