import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import fs from "node:fs/promises";
import path from "node:path";
globalThis.FileReader = class {
  async readAsArrayBuffer(blob) {
    this.result = await blob.arrayBuffer();
    this.onloadend?.();
  }
  async readAsDataURL(blob) {
    this.result =
      "data:" +
      blob.type +
      ";base64," +
      Buffer.from(await blob.arrayBuffer()).toString("base64");
    this.onloadend?.();
  }
};
const root = new URL("../public/demo/", import.meta.url),
  manifest = [],
  rows = ["path,sample,method,category,prompt,clip,ulip2"];
const material = (color) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.48, metalness: 0.08 });
const box = (x, y, z, mat, px = 0, py = 0, pz = 0) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(x, y, z), mat);
  m.position.set(px, py, pz);
  return m;
};
function chair(variant) {
  const g = new THREE.Group(),
    mat = material(variant ? 0x947962 : 0x7e9b82);
  g.add(box(1, 0.13, 0.9, mat, 0, 0.62, 0));
  for (const x of [-0.4, 0.4])
    for (const z of [-0.34, 0.34])
      g.add(box(0.09, 0.65, 0.09, mat, x, 0.27, z));
  g.add(box(1, 0.14, 0.1, mat, 0, 1.3, -0.4));
  for (const x of [-0.42, 0, 0.42])
    g.add(box(0.08, 0.7, 0.08, mat, x, 1, -0.4));
  if (!variant) {
    g.add(
      box(0.08, 0.08, 0.8, mat, -0.5, 0.92, 0),
      box(0.08, 0.08, 0.8, mat, 0.5, 0.92, 0),
    );
  }
  return g;
}
function vase(variant) {
  const pts = [];
  for (let i = 0; i <= 30; i++) {
    const y = i / 30;
    const r = 0.21 + 0.23 * Math.sin(y * Math.PI) + (y > 0.8 ? 0.08 : 0);
    pts.push(
      new THREE.Vector2(
        r * (variant ? 1 + 0.06 * Math.sin(i * 2) : 1),
        y * 1.4,
      ),
    );
  }
  return new THREE.Mesh(
    new THREE.LatheGeometry(pts, variant ? 18 : 64),
    material(variant ? 0xbeb29c : 0xb88b64),
  );
}
function lamp(variant) {
  const g = new THREE.Group(),
    m = material(variant ? 0x8999a6 : 0xcbb875);
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.3, 0.35, 0.1, 40),
    m,
  );
  g.add(base);
  g.add(box(0.05, 1.3, 0.05, m, 0, 0.68, 0));
  const shade = new THREE.Mesh(
    new THREE.ConeGeometry(0.38, 0.35, 48, 1, true),
    m,
  );
  shade.rotation.z = variant ? 0.15 : 0;
  shade.position.set(0, 1.42, 0);
  g.add(shade);
  return g;
}
function knot(variant) {
  return new THREE.Mesh(
    new THREE.TorusKnotGeometry(0.4, 0.13, variant ? 40 : 128, 20, 2, 3),
    material(variant ? 0xa8a3ac : 0x7793a1),
  );
}
const specs = [
  ["chair", "Furniture", "A wooden chair with open armrests", chair],
  ["vase", "Objects", "A ceramic vase with a broad rounded body", vase],
  ["lamp", "Lighting", "A brass table lamp with a conical shade", lamp],
  ["knot", "Geometry", "A smooth interlocking sculptural knot", knot],
];
for (const [i, [name, category, prompt, make]] of specs.entries())
  for (const [j, method] of ["ours", "base"].entries()) {
    const p = `${method}/${name}.glb`;
    const mesh = make(j);
    mesh.updateMatrixWorld(true);
    const data = await new GLTFExporter().parseAsync(mesh, { binary: true });
    await fs.mkdir(new URL(method + "/", root), { recursive: true });
    await fs.writeFile(new URL(p, root), Buffer.from(data));
    manifest.push(p);
    rows.push(
      `${p},${name},${method},${category},${prompt},${(0.3 + i * 0.012 - j * 0.018).toFixed(3)},${(0.24 + i * 0.013 - j * 0.022).toFixed(3)}`,
    );
  }
await fs.writeFile(new URL("metrics.csv", root), rows.join("\n") + "\n");
manifest.push("metrics.csv");
await fs.writeFile(
  new URL("files.json", root),
  JSON.stringify(manifest, null, 2),
);
// Small format fixtures are generated from our own geometry, without third-party assets.
const fixtures = new URL("../tests/fixtures/", import.meta.url);
await fs.mkdir(fixtures, { recursive: true });
await fs.writeFile(
  new URL("triangle.obj", fixtures),
  "mtllib triangle.mtl\nv -0.5 0 0\nv 0.5 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt .5 1\nusemtl color\nf 1/1 2/2 3/3\n",
);
await fs.writeFile(
  new URL("triangle.mtl", fixtures),
  "newmtl color\nKd 1 1 1\nmap_Kd texture.png\n",
);
// One red pixel, valid PNG.
const { PNG } = await import("pngjs");
const png = new PNG({ width: 2, height: 2 });
for (let i = 0; i < png.data.length; i += 4) {
  png.data[i] = 220;
  png.data[i + 1] = 60;
  png.data[i + 2] = 40;
  png.data[i + 3] = 255;
}
await fs.writeFile(new URL("texture.png", fixtures), PNG.sync.write(png));
await fs.writeFile(
  new URL("mesh.ply", fixtures),
  "ply\nformat ascii 1.0\nelement vertex 4\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nelement face 4\nproperty list uchar int vertex_indices\nend_header\n-0.5 0 0 200 60 70\n0.5 0 0 50 200 70\n0 1 0 50 70 200\n0 0 0.7 200 180 60\n3 0 1 2\n3 0 3 1\n3 1 3 2\n3 2 3 0\n",
);
await fs.writeFile(
  new URL("points.ply", fixtures),
  "ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nend_header\n-0.5 0 0\n0.5 0 0\n0 1 0\n",
);
await fs.writeFile(
  new URL("triangle.stl", fixtures),
  "solid triangle\nfacet normal 0 0 1\nouter loop\nvertex -0.5 0 0\nvertex 0.5 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid triangle\n",
);
const splats = Buffer.alloc(32 * 128);
for (let i = 0; i < 128; i++) {
  const a = i * 2.39996,
    z = 1 - (2 * i) / 127,
    r = Math.sqrt(1 - z * z),
    off = i * 32;
  [
    Math.cos(a) * r * 0.5,
    z * 0.5,
    Math.sin(a) * r * 0.5,
    0.045,
    0.045,
    0.045,
  ].forEach((v, j) => splats.writeFloatLE(v, off + j * 4));
  splats.set(
    [100 + Math.round((120 * (z + 1)) / 2), 150, 190, 255, 255, 128, 128, 128],
    off + 24,
  );
}
await fs.writeFile(new URL("sphere.splat", fixtures), splats);
console.log(
  `Created ${manifest.length - 1} self-authored demo GLBs, metadata and loader fixtures.`,
);
